import {
    DriveEventType,
    NodeType,
    RevisionState,
    NodeWithSameNameExistsValidationError,
    type NodeEntity,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';
import type { App } from 'obsidian';

import { DEVICES_FOLDER, type PluginSettings } from '../settings';
import { PathBatcher } from '../util/debounce';
import type { Logger } from '../util/logger';
import { Limiter, runPooled } from '../util/pool';
import { ConflictResolver, MAX_MERGE_BYTES } from './conflicts';
import type { DeviceRegistry } from './devices';
import { isTextPath } from './media';
import { mergeThreeWay } from './merge';
import { DriveIO, sharedWithOthers, type NodeLocation, type RemoteTree, type ShareLink, type UploadSource } from './drive';
import {
    basename,
    conflictCopyPath,
    isWithin,
    joinPath,
    PathFilter,
    parentPath,
    replacePrefix,
    splitExtension,
    vaultSpelling,
} from './paths';
import { reconcile, removesRemote } from './reconcile';
import type { SyncState } from './state';
import type { ConflictPolicy, ConflictReason, LocalState, RemoteState, SyncAction } from './types';
import { FileTooLargeError, LARGE_FILE_BYTES, VaultIO } from './vault';
import { EditorBusyError, LocalChangedError, RemoteChangedError } from './engine/errors';
import { CaseClashes } from './engine/caseClashes';
import { monotonicNow } from './engine/clock';
import { followLocalRenames, type LocalRenameHost } from './engine/localRenames';
import { planFirstSync } from './engine/planning';
import { PollScheduler } from './engine/pollScheduler';
import { PassProgress } from './engine/progress';
import { TransferPace } from './engine/transferPace';
import {
    baseOf,
    byDepth,
    errorMessage,
    formatWait,
    isOffline,
    megabytes,
    needsTransfer,
    scopeKeyOf,
    transferSize,
} from './engine/helpers';

export * from './engine/types';
import {
    DESKTOP,
    type ConflictEvent,
    type DeletedItem,
    type EngineEnvironment,
    type EngineHooks,
    type NoteSyncState,
    type NoteVersion,
    type OpenEditor,
    type PendingChange,
    type PendingMassDelete,
    type PendingReason,
    type SyncPlan,
    type SyncStatus,
    type SyncSummary,
    type TransferAction,
    type VaultScope,
} from './engine/types';

/** Items listed in "Recently deleted", at most. */
const MAX_DELETED_LISTED = 50;

/** Versions of a note listed in its history, at most. */
const MAX_NOTE_VERSIONS = 50;

/** Paths listed in a held mass deletion, at most; the count says how many there really are. */
const MAX_MASS_DELETE_LISTED = 50;

/** The config folder is walked this often at most, and no more often than twice the last quiet gap. */
const CONFIG_SCAN_MIN_MS = 2 * 60_000;
const CONFIG_SCAN_MAX_MS = 5 * 60_000;

/** The "Not synced yet" list is rebuilt at most once per this, while nothing it is built from changes. */
const PENDING_REFRESH_MS = 10_000;

/** Deletions a pass holds, and whether the user let them through; see {@link SyncEngine.holdMassDelete}. */
type MassDeleteHold = {
    /** Every path the pass would have removed from Drive. */
    paths: string[];
    /** Set once the user said to go ahead: the next pass carries them out. */
    approved: boolean;
};

type PendingRename = { from: string; to: string; isFolder: boolean };

/** One node event from Drive, reduced to what is needed to place it. */
type NodeChange = { nodeUid: string; parentNodeUid: string | undefined };

/** What one pass knows about the Drive side of the paths it is reconciling. */
type RemoteView = {
    /** Paths to reconcile. Differs from the paths asked about when a file turned out to have moved. */
    paths: Set<string>;
    states: Map<string, RemoteState | undefined>;
    /**
     * Paths whose Drive side could not be established, left alone until it
     * can. Absence is never inferred from a failed lookup: a file missing from
     * Drive is deleted from the vault, so "missing" has to be a fact.
     */
    skip: Set<string>;
};

/** How long a continuously-edited file may hold up everything else. */
const MAX_BATCH_WAIT_MS = 15_000;

/**
 * Files checked at once in a pass. Checking is local work, a stat and at most
 * a hash, so it runs well above the transfer limit: a full sync of a large
 * vault is mostly files that turn out unchanged, and they should not queue
 * behind the few that need an upload.
 */
const SCAN_CONCURRENCY = 8;




/**
 * A full sync, walking the whole Drive folder, runs at least this often even
 * when start-up can catch up from the event feed instead; a safety net for
 * anything the events and the local scan could miss.
 */
const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60_000;
/**
 * The daily walk waits for a quiet moment: this long without changes, or the
 * window hidden. Only past twice the interval is it run at start-up regardless,
 * for a device that is never left alone long enough.
 */
const IDLE_WALK_AFTER_MS = 5 * 60_000;
const STARTUP_WALK_AFTER_MS = 2 * FULL_SYNC_INTERVAL_MS;



/** How many times a path is decided again when its file changes under a transfer, before it waits for the next pass. */
const MAX_REDECIDE = 3;

/** Transferred first, so a first sync is usable long before the attachments arrive. */
const NOTE_EXTENSIONS = new Set(['.md', '.canvas', '.base', '.txt']);

/**
 * Drives the sync: watches both sides, decides what each change means through
 * `reconcile`, and carries out the result.
 *
 * Two loops feed it. Local edits arrive as vault events and are batched, so a
 * burst of autosaves becomes one upload. Remote changes arrive as Drive events,
 * polled on a timer - the Drive API offers no push channel, so a remote edit
 * becomes visible here one poll interval after it lands, not instantly.
 *
 * Everything funnels through a single queue: two overlapping passes over the
 * same path would race between deciding what to do and doing it.
 */
export class SyncEngine {
    private readonly vault: VaultIO;
    private readonly batcher: PathBatcher;

    private drive: DriveIO | null = null;
    private filter: PathFilter;
    /**
     * Whether other people can write to the synced folder. Assumed until Drive
     * says otherwise, so that config which runs code is never synced on the
     * strength of a check that has not happened yet.
     */
    private folderShared = true;
    private resolver: ConflictResolver | null = null;

    private rootUid: string | null = null;
    private treeEventScopeId: string | null = null;

    private running = false;
    private status: SyncStatus = 'signed-out';
    /**
     * Why the synced folder is missing, when it is: in Drive's trash, or gone
     * altogether (deleted for good, or no longer shared with this account).
     * Retrying paths cannot help then, so nothing syncs; see {@link rootNode}.
     */
    private folderMissing: 'trashed' | 'gone' | null = null;
    /**
     * Why each path in the retry queue last failed, so the sync panel can say
     * more than how often. Kept in memory only: after a restart a path shows
     * its count alone until it fails again.
     */
    private readonly failureReasons = new Map<string, string>();
    private lastSyncedAt: number | null = null;
    private lastError: string | null = null;
    private paused = false;
    /** A full sync was asked for while the network was held; it runs once it is not. */
    private deferredFullSync = false;
    /**
     * The current pass: files checked out of the total, and the transfers it
     * found, weighed by their size, done out of queued; see {@link progressFraction}.
     */
    /** How far the current pass is; see {@link PassProgress}. */
    private readonly progress: PassProgress;
    /** How many transfers run at once; see {@link TransferPace}. */
    private readonly pace: TransferPace;
    /** When Drive is checked next; see {@link PollScheduler}. */
    private readonly polls: PollScheduler;
    /** Paths with a transfer under way, and what each transfer does. */
    private readonly inFlight = new Map<string, TransferAction>();
    /**
     * Drive revisions merged into an open editor, by path. When the editor
     * saves, the note differs from its base on both sides, which reads as a
     * conflict; but the local text already holds that revision's changes, so
     * it is simply uploaded. See {@link downloadIntoEditor}.
     */
    private readonly mergedIntoEditor = new Map<string, string>();
    /** Paths left alone for being over a size limit, with their size. */
    private readonly tooLarge = new Map<string, number>();
    /** What {@link updateSettings} compares against to spot a change of scope. */
    private scopeKey: string;
    /**
     * Local states worked out by {@link plan}, reused by the first sync that
     * follows it while the files are unchanged, so nothing is hashed twice.
     */
    private readonly plannedLocal = new Map<string, LocalState>();
    /** Records a rename could explain but this device cannot read; see `followLocalRenames`. */
    private readonly unverifiableRenames = new Set<string>();
    /** Settings files downloaded by the first sync now running; null when this is not a first sync. */
    private adoptingSettings: string[] | null = null;
    /**
     * Set once a first sync has put Drive's settings in place. Until Obsidian
     * reloads, it still runs on the settings it started with, and would write
     * those back over the downloaded files at its next save; uploading them
     * would then replace the settings on Drive with a new vault's defaults. So
     * settings files only come down, never go up, for the rest of the session.
     */
    private settingsHeld = false;
    /** Letter-case clashes; see {@link CaseClashes}. */
    private readonly cases: CaseClashes;

    private queue: Promise<void> = Promise.resolve();
    /** A poll is queued or running; only one at a time. */
    private polling = false;
    /**
     * The signal every transfer of this run reads; aborted by {@link stop}.
     *
     * Kept after the abort: a pass already under way keeps checking it, and it
     * must read "aborted", not "no signal at all", for the rest of the run.
     */
    private abortController: AbortController | null = null;
    /**
     * Bumped by every start and stop. A pass that began under an older one has
     * outlived its engine and must not write the state or the status of the
     * current one; see {@link stale}.
     */
    private generation = 0;
    /** The start under way, so two unlock paths cannot start the engine twice; see {@link start}. */
    private starting: Promise<void> | null = null;
    /** Deletions held for a decision; see {@link holdMassDelete}. */
    private massDelete: MassDeleteHold | null = null;
    /**
     * Paths incremental passes found to be deleting from Drive, counted
     * together for one poll window: a folder evicted file by file arrives as a
     * batch at a time, and none of them is over the threshold on its own. Kept
     * apart from the hold itself so that a batch of one path cannot describe
     * the state of the vault; see {@link holdMassDelete}.
     */
    private readonly batchDeletes = new Set<string>();
    /** The last summary reported through `onChange`, so an unchanged one is not reported again. */
    private reported: string | null = null;
    /** The last "Not synced yet" list, and what it was built from; see {@link pendingChanges}. */
    private pendingCache: { signature: string; value: PendingChange[] } | null = null;
    /** When a full sync finished, on the monotonic clock; see {@link dailyWalkDue}. */
    private lastFullSyncMono: number | null = null;
    /** When the config folder was last walked, on the monotonic clock, and how long to wait before the next; see {@link pollConfigFolder}. */
    private configScanAt: number | null = null;
    private configScanGap = CONFIG_SCAN_MIN_MS;

    /** Renames seen in the current tick, applied together; see {@link onVaultRename}. */
    private pendingRenames: PendingRename[] = [];
    private renameTimer: number | null = null;
    /** Policies chosen for single files in the conflicts dialog; see {@link resolveConflict}. */
    private readonly policyOverrides = new Map<string, ConflictPolicy>();
    /** Folders deleted locally, whose Drive counterpart is removed once their files have been. */
    private readonly pendingFolderDeletes = new Set<string>();
    /**
     * Paths this pass queued for a retry without failing, a Drive revision
     * that moved under it, say; so finishing the pass does not clear what it
     * just queued.
     */
    private readonly heldForRetry = new Set<string>();
    /** Paths that failed one at a time during the pass; see {@link noteItemFailure}. */
    private readonly itemFailures = new Set<string>();

    /**
     * Paths that differ from another path only in letter case, found by the
     * last full sync; see {@link findCaseCollisions}.
     */
    private caseCollisions = new Set<string>();

    /** Folder path to node uid, rebuilt on every full sync. */
    private readonly folderUids = new Map<string, string>();

    /** The vault's device list, whose changes the event feed passes on rather than syncs; see {@link watchDevices}. */
    private devices: DeviceRegistry | null = null;

    constructor(
        app: App,
        private readonly state: SyncState,
        private settings: PluginSettings,
        private readonly logger: Logger,
        private readonly hooks: EngineHooks,
        private readonly scope: VaultScope,
        private readonly environment: EngineEnvironment = DESKTOP,
    ) {
        this.vault = new VaultIO(
            app,
            logger.getLogger('vault'),
            scope.pluginDir === null ? null : `${scope.pluginDir}/downloads`,
            () => this.sizeLimitBytes(),
        );
        this.filter = this.createFilter(settings);
        this.scopeKey = scopeKeyOf(settings);
        this.progress = new PassProgress(() => this.report());
        this.cases = new CaseClashes({
            state,
            filter: () => this.filter,
            vault: this.vault,
            drive: () => this.drive!,
            environment,
            configDir: scope.configDir,
            logger,
            findRemoteFolder: (path) => this.findRemoteFolder(path),
            findByName: (path) => this.findByName(path, new Map()),
            reportConflict: (event) => this.reportConflict(event),
            noteFailure: (path, error, what) => this.noteItemFailure(path, error, what),
        });
        this.pace = new TransferPace(() => this.settings.transferConcurrency, logger);
        this.polls = new PollScheduler({
            baseSeconds: () => this.settings.remotePollSeconds,
            isHidden: () => this.environment.isHidden?.() ?? false,
            onDue: () => this.runPoll(),
        });
        this.batcher = new PathBatcher(settings.uploadDebounceMs, MAX_BATCH_WAIT_MS, (paths) => {
            void this.enqueue(() => this.processPaths(new Set(paths)));
        });
    }

    getSummary(): SyncSummary {
        const pendingMassDelete = this.pendingMassDelete();
        return {
            status: this.status,
            lastSyncedAt: this.lastSyncedAt,
            lastError: this.lastError,
            conflicts: this.state.conflicts().length,
            progress: this.progress.counts(),
            progressFraction: this.progress.fraction(),
            transfer: this.progress.largestTransfer(),
            pending: this.pendingChanges().length,
            ...(pendingMassDelete !== undefined && { pendingMassDelete }),
        };
    }

    /**
     * Deletions a pass held back, for the dialog that asks about them. Absent
     * when there is nothing held, and while the deletes it asked about run.
     */
    pendingMassDelete(): PendingMassDelete | undefined {
        const held = this.massDelete;
        if (held === null || held.approved) {
            return undefined;
        }
        return { count: held.paths.length, paths: held.paths.slice(0, MAX_MASS_DELETE_LISTED) };
    }

    /**
     * Carry out the deletions a pass held back.
     *
     * Another full pass, with the guard open for this decision, so every path
     * is decided again before it is deleted: a file that came back in the
     * meantime is uploaded, not trashed.
     */
    async approveMassDelete(): Promise<void> {
        const held = this.massDelete;
        if (held === null || held.approved) {
            return;
        }
        held.approved = true;
        this.report();
        try {
            await this.syncNow();
        } finally {
            if (this.massDelete === held) {
                this.massDelete = null;
            }
            this.report();
        }
    }

    /**
     * Keep the held files on Drive, and bring them back into the vault.
     *
     * The other answer, and the one that recovers an unmounted card or a folder
     * emptied outside Obsidian: Drive still has the files, so they are
     * downloaded again and their records reset to what comes down.
     */
    async denyMassDelete(): Promise<void> {
        const held = this.massDelete;
        if (held === null) {
            return;
        }
        this.massDelete = null;
        // The batch that produced the hold is answered too; leaving it would
        // let the next incremental pass rebuild the same question out of
        // deletions that have already been carried out.
        this.batchDeletes.clear();
        this.report();
        if (!this.drive || !this.rootUid) {
            return;
        }
        await this.enqueue(async () => {
            const generation = this.generation;
            const listed = new Map<string, Map<string, NodeEntity>>();
            for (const path of held.paths) {
                if (generation !== this.generation) {
                    return;
                }
                try {
                    const record = this.state.get(path);
                    if (record?.type === 'folder') {
                        // A folder held for deletion: it is still on Drive, so
                        // it is simply kept here too.
                        await this.vault.ensureFolder(path);
                        this.state.setSynced(path, record.nodeUid, 'folder');
                        continue;
                    }
                    const remote = await this.findByName(path, listed);
                    if (remote === undefined) {
                        // Gone from Drive as well; nothing to bring back.
                        this.state.delete(path);
                        continue;
                    }
                    await this.download(path, remote.nodeUid, remote.revisionUid, remote, undefined);
                } catch (error) {
                    this.noteItemFailure(path, error, 'Could not bring back');
                }
            }
            await this.state.flush();
            this.report();
        });
    }

    /**
     * Every path that is not in sync right now, and why: what the panel lists
     * under "Not synced yet", so that nothing fails to sync without the user
     * being able to see it. A path is listed once, under the most immediate
     * reason.
     *
     * Memoised: the panel and the current-note indicator ask for this on every
     * progress tick and every vault event, and it is built from a walk over
     * every record, retry and clash. The result is reused while nothing it is
     * built from has changed — the state's generation, the transfers in
     * flight, the batch waiting out its debounce — and for a few seconds while
     * the only thing that moves is a retry's countdown.
     */
    pendingChanges(now = Date.now()): PendingChange[] {
        const signature = this.pendingSignature(now);
        if (this.pendingCache !== null && this.pendingCache.signature === signature) {
            return this.pendingCache.value;
        }
        const value = this.buildPendingChanges(now);
        this.pendingCache = { signature, value };
        return value;
    }

    /** Everything {@link pendingChanges} is built from, cheap enough to compute on every call. */
    private pendingSignature(now: number): string {
        return JSON.stringify([
            this.state.generation(),
            Math.floor(now / PENDING_REFRESH_MS),
            this.networkHeld(),
            [...this.inFlight],
            this.batcher.pendingPaths(),
            [...this.tooLarge],
            [...this.caseCollisions],
        ]);
    }

    private buildPendingChanges(now: number): PendingChange[] {
        const found = new Map<string, PendingChange>();
        const add = (path: string, reason: PendingReason, detail?: string) => {
            if (!found.has(path)) {
                found.set(path, { path, reason, ...(detail !== undefined && { detail }) });
            }
        };
        const held = this.networkHeld();
        for (const [path, transfer] of this.inFlight) {
            found.set(path, { path, reason: 'transferring', transfer });
        }
        for (const { path } of this.state.conflicts()) {
            add(path, 'conflict');
        }
        for (const retry of this.state.retryEntries()) {
            if (held) {
                add(retry.path, 'wifi');
            } else if (retry.attempts === 0) {
                add(retry.path, 'waiting');
            } else {
                const next = retry.after <= now ? 'with the next check' : `in ${formatWait(retry.after - now)}`;
                const reason = this.failureReasons.get(retry.path);
                const count = `failed ${retry.attempts} time${retry.attempts === 1 ? '' : 's'}`;
                add(retry.path, 'retrying', `${reason ? `${count}: ${reason}` : count}; next try ${next}`);
            }
        }
        for (const path of this.batcher.pendingPaths()) {
            add(path, held ? 'wifi' : 'waiting');
        }
        for (const [path, bytes] of this.tooLarge) {
            add(path, 'too-large', `${megabytes(bytes)} MB`);
        }
        for (const path of this.caseCollisions) {
            add(path, this.cases.unstorable(path) ? 'windows-name' : 'name-clash');
        }
        return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
    }

    /**
     * Whether one note is in sync, for the current-note indicator. `stat` is
     * the file's size and mtime as the vault reports them now; a note whose
     * file no longer matches what the last sync recorded has changes not yet
     * synced, even if nothing has queued them (while paused, say).
     */
    noteSyncState(path: string, stat: { size: number; mtime: number } | null): NoteSyncState {
        if (this.filter.isExcludedWithAncestors(path)) {
            return 'excluded';
        }
        if (this.pendingChanges().some((change) => change.path === path)) {
            return 'pending';
        }
        const base = this.state.get(path)?.base;
        if (!base || (stat !== null && (stat.size !== base.size || stat.mtime !== base.localMtime))) {
            return 'pending';
        }
        return 'synced';
    }

    isPaused(): boolean {
        return this.paused;
    }

    /** Whether Drive can be asked for a note's versions, the trash and share links: started, and not stopped since. */
    isConnected(): boolean {
        return this.running && this.drive !== null;
    }

    /** Seconds until Drive is next checked for changes, at the pace of the moment; see {@link PollScheduler.interval}. */
    pollSeconds(): number {
        return this.polls.interval();
    }

    /**
     * Follow the vault's device list in `registry`, or stop with null. Its
     * folder is never part of the vault, so changes to it in the event feed
     * are passed on through `onDevicesChanged` rather than synced, without the
     * lookups an unknown change would cost. The folder is learned from the
     * listing of a full sync, or when another device makes it.
     */
    watchDevices(registry: DeviceRegistry | null): void {
        this.devices = registry;
    }

    /** Apply changed settings without a restart, resyncing if the scope changed. */
    updateSettings(settings: PluginSettings): void {
        // Compared against a snapshot, not the previous object: the plugin
        // mutates one settings object in place and hands the same one back.
        const scopeKey = scopeKeyOf(settings);
        const scopeChanged = scopeKey !== this.scopeKey;
        this.scopeKey = scopeKey;

        this.settings = settings;
        this.filter = this.createFilter(settings);
        this.batcher.setDelay(settings.uploadDebounceMs);
        this.resolver = this.drive ? this.createResolver(this.drive, settings.conflictPolicy) : null;

        if (this.running && scopeChanged && !this.paused) {
            void this.syncNow();
        }
    }

    /**
     * Start syncing with `client` and `rootUid`.
     *
     * Single-flight: two unlock paths can fire at once — the remembered unlock
     * and the PIN form — and a second start would build a second Drive client
     * under a pass already running, and sweep away the downloads that pass is
     * writing. Both callers join the start already under way.
     */
    start(client: ProtonDriveClient, rootUid: string): Promise<void> {
        if (this.starting !== null) {
            this.logger.debug('A start is already under way; joining it');
            return this.starting;
        }
        const running = this.startOnce(client, rootUid);
        const starting = running.finally(() => {
            // Only if this start is still the one in force: a stop clears it,
            // and a start asked for since owns the field now.
            if (this.starting === starting) {
                this.starting = null;
            }
        });
        this.starting = starting;
        return starting;
    }

    private async startOnce(client: ProtonDriveClient, rootUid: string): Promise<void> {
        // A new run: passes from before belong to an older generation.
        const generation = ++this.generation;
        this.drive = new DriveIO(client, this.logger.getLogger('drive'), () => this.sizeLimitBytes());
        this.resolver = this.createResolver(this.drive, this.settings.conflictPolicy);
        this.rootUid = rootUid;
        this.running = true;
        this.folderMissing = null;
        this.failureReasons.clear();
        this.massDelete = null;
        this.batchDeletes.clear();
        // A new session: nothing has been walked, in the terms this session
        // measures time in.
        this.lastFullSyncMono = null;
        this.configScanAt = null;
        this.configScanGap = CONFIG_SCAN_MIN_MS;
        this.paused = this.settings.paused;
        this.abortController = new AbortController();
        // Opening Obsidian is activity: check at the active pace for a while.
        this.polls.noteActivity();
        // Nothing is downloading yet, so anything left in there is from a run
        // that ended mid-download.
        await this.vault.sweepDownloads();

        // A stop, or a new start, may have happened while that ran: from here
        // the engine belongs to it, and nothing of this one may be reported.
        if (!this.stillStarting(generation)) {
            return;
        }
        if (this.paused) {
            // Nothing runs until resume, which starts with a full sync and so
            // needs nothing primed here.
            this.setStatus('paused');
            return;
        }
        if (this.settings.syncOnStartup) {
            await this.enqueue(() => this.startupSync());
        } else {
            // The event scope is only known once the root node has been read,
            // and without it there is nothing to poll.
            await this.enqueue(() => this.primeEventScope());
        }
        if (!this.stillStarting(generation)) {
            return;
        }
        if (!this.settings.syncOnStartup) {
            this.setStatus('idle');
        }
        this.scheduleRemotePoll();
    }

    /** Whether a start that captured `generation` is still the engine's own; see {@link startOnce}. */
    private stillStarting(generation: number): boolean {
        return this.running && generation === this.generation;
    }

    /**
     * Stop, and let the pass of the moment finish.
     *
     * The abort signal is not dropped: a transfer already under way keeps
     * reading it, and must read "aborted" for the rest of this run, not "no
     * signal". The generation is bumped first, so the pass that was running
     * when the plugin unloaded cannot write its state over the next instance's
     * — and the queue is awaited before the state is flushed, so nothing is
     * still writing when this resolves.
     */
    async stop(): Promise<void> {
        this.running = false;
        this.generation++;
        // A start that has not finished belongs to the run being stopped: it
        // must not go on to enqueue a pass, or report a status, for the next
        // one. Cleared here so a start asked for now is not made to join it.
        const starting = this.starting;
        this.starting = null;
        this.batcher.cancel();
        this.polls.cancel();
        if (this.renameTimer !== null) {
            window.clearTimeout(this.renameTimer);
            this.renameTimer = null;
        }
        this.progress.stop();
        this.pendingRenames = [];
        this.pendingFolderDeletes.clear();
        this.plannedLocal.clear();
        this.unverifiableRenames.clear();
        // A decision about deletions belongs to the run that found them: with
        // the engine stopped there is nothing to approve, and the panel must
        // not offer it.
        this.massDelete = null;
        this.batchDeletes.clear();
        this.deferredFullSync = false;
        this.abortController?.abort();
        await starting?.catch(() => undefined);
        await this.queue.catch(() => undefined);
        await this.state.flush();
    }

    /**
     * Hold everything: no watching, no polling. A pass already running is
     * left to finish, since stopping a transfer halfway gains nothing.
     *
     * Edits made while paused are not tracked one by one; the full sync that
     * {@link resume} starts with finds them all, the same way a sync after a
     * restart does.
     */
    pause(): void {
        if (this.paused) {
            return;
        }
        this.paused = true;
        this.batcher.cancel();
        this.pendingRenames = [];
        this.polls.cancel();
        if (this.renameTimer !== null) {
            window.clearTimeout(this.renameTimer);
        }
        this.renameTimer = null;
        this.logger.info('Sync paused');
        this.setStatus(this.status === 'syncing' ? 'syncing' : 'paused');
    }

    /** Pick up where {@link pause} left off, with a full sync to catch up. */
    async resume(): Promise<void> {
        if (!this.paused) {
            return;
        }
        this.paused = false;
        this.logger.info('Sync resumed');
        if (!this.running) {
            return;
        }
        this.setStatus('idle');
        await this.syncNow();
        this.scheduleRemotePoll();
    }

    /** Queue a full reconciliation of both sides. */
    async syncNow(): Promise<void> {
        return this.enqueue(async () => {
            await this.fullSync();
        });
    }

    /** Re-examine one path now. */
    async syncPath(path: string): Promise<void> {
        return this.enqueue(() => this.processPaths(new Set([path])));
    }

    /**
     * Settle a conflict the user decided on, with the policy they picked, for
     * that one file.
     *
     * The choice goes through the normal sync of the path rather than a
     * separate code path, so a manual resolution gets exactly the checks an
     * automatic one does. The policy applies to this pass over this path
     * only: every other pass, and every other conflicted file, keeps the
     * user's setting.
     */
    async resolveConflict(path: string, policy: ConflictPolicy): Promise<void> {
        return this.enqueue(async () => {
            this.state.clearConflict(path);
            this.policyOverrides.set(path, policy);
            try {
                await this.processPaths(new Set([path]));
            } finally {
                this.policyOverrides.delete(path);
            }
        });
    }

    // -- vault events ----------------------------------------------------

    /** Whether local and remote changes are being followed right now. */
    private get watching(): boolean {
        return this.running && this.settings.autoSync && !this.paused;
    }

    onVaultChange(path: string): void {
        if (!this.watching) {
            return;
        }
        if (this.vault.isSelfWrite(path) || this.filter.isExcludedWithAncestors(path)) {
            return;
        }
        this.batcher.add(path);
        this.polls.noteActivity();
    }

    onVaultFolderDelete(path: string): void {
        if (!this.watching) {
            return;
        }
        if (this.vault.isSelfWrite(path) || this.filter.isExcludedWithAncestors(path)) {
            return;
        }
        // Handled after the files inside it, which arrive as their own
        // deletions; the batch is what brings the two together.
        this.pendingFolderDeletes.add(path);
        this.batcher.add(path);
    }

    /**
     * A file or folder was renamed or moved in the vault.
     *
     * Carried to Drive as a rename of the same node, not as a deletion plus an
     * upload. Obsidian names every new note "Untitled" and the user renames it
     * seconds later - often after its first upload - so a rename that was not
     * followed on Drive left the old name there and brought it back into the
     * vault on the next pass. Keeping the node also keeps its revision history.
     *
     * Renaming a folder produces one event for the folder and one for every
     * item inside it, all in the same tick. They are gathered and applied
     * together so the folder can move as one node on Drive, whichever order
     * Obsidian reports them in.
     */
    onVaultRename(oldPath: string, newPath: string, isFolder: boolean): void {
        if (!this.watching) {
            return;
        }
        if (this.vault.isSelfWrite(oldPath) || this.vault.isSelfWrite(newPath)) {
            return;
        }

        const oldExcluded = this.filter.isExcludedWithAncestors(oldPath);
        const newExcluded = this.filter.isExcludedWithAncestors(newPath);
        if (oldExcluded && newExcluded) {
            return;
        }
        if (oldExcluded || newExcluded) {
            // Across the exclusion boundary a rename is, as far as Drive is
            // concerned, a creation or a deletion.
            if (!isFolder) {
                this.batcher.add(oldExcluded ? newPath : oldPath);
            } else if (!oldExcluded) {
                this.onVaultFolderDelete(oldPath);
                for (const record of this.state.entries()) {
                    if (record.type === 'file' && isWithin(record.path, oldPath)) {
                        this.batcher.add(record.path);
                    }
                }
            }
            return;
        }

        this.batcher.rename(oldPath, newPath);
        this.pendingRenames.push({ from: oldPath, to: newPath, isFolder });
        if (this.renameTimer === null) {
            this.renameTimer = window.setTimeout(() => {
                this.renameTimer = null;
                const renames = this.pendingRenames.splice(0);
                void this.enqueue(() => this.applyLocalRenames(renames));
            }, 0);
        }
    }

    // -- the two sync passes ---------------------------------------------

    /**
     * Compare the whole vault with the whole Drive folder. Resolves whether it
     * got to the end: false when it failed, was stopped, or could not start.
     */
    private async fullSync(): Promise<boolean> {
        const generation = this.generation;
        const drive = this.drive;
        const rootUid = this.rootUid;
        if (!this.running) {
            // Queued before a stop: its engine is gone, and every write it
            // would make belongs to a run that is over.
            return false;
        }
        if (!drive || !rootUid) {
            this.setStatus('not-configured');
            return false;
        }
        if (this.networkHeld()) {
            this.deferredFullSync = true;
            this.setStatus('waiting-for-wifi');
            return false;
        }
        this.deferredFullSync = false;

        this.setStatus('syncing');
        try {
            this.adoptingSettings = this.state.paths().length === 0 ? [] : null;

            // Where the event feed stands, taken before the listing, so that
            // a change made while the tree is walked is still replayed by the
            // next poll rather than skipped over.
            const root = await this.rootNode();
            if (root === null) {
                return false;
            }
            const scopeId = root.treeEventScopeId;
            await this.refreshSharing(() => drive.sharedWithOthers(rootUid));
            if (this.state.getEventCursor(scopeId) === null) {
                const latest = await drive.latestEventId(scopeId);
                if (latest !== null) {
                    this.state.setEventCursor(scopeId, latest);
                }
            }

            const tree = await drive.listTree(rootUid, (path) => !this.filter.isExcluded(path));
            drive.logSkipped(tree);
            this.treeEventScopeId = tree.treeEventScopeId;

            this.folderUids.clear();
            this.folderUids.set('', rootUid);
            for (const [path, uid] of tree.folders) {
                this.folderUids.set(path, uid);
            }
            const devicesFolder = tree.folders.get(DEVICES_FOLDER);
            if (devicesFolder !== undefined) {
                this.devices?.knowFolder(devicesFolder);
            }

            // Before anything is compared by path, make sure the paths agree:
            // a note renamed on another device has to be renamed here first,
            // or it reads as one file deleted and an unrelated one created.
            await this.followRemoteMoves(tree);
            const unreadable = this.unreadablePaths(tree);
            const { skip, goneFolders } = await this.verifyMissingNodes(tree);
            for (const path of unreadable) {
                skip.add(path);
            }

            const local = await this.vault.list((path) => !this.filter.isExcluded(path));
            await this.vault.removeLegacyPartialDownloads(local.files);
            await this.cases.settleTree(tree, local);
            const locallyDeletedFolders = await this.syncFolders(local.folders, tree, goneFolders);
            // Renames this device made but never carried to Drive: paused,
            // locked, closed too soon, or made outside Obsidian altogether.
            await followLocalRenames(this.renameHost(), local.files, tree);

            const paths = new Set<string>();
            for (const path of local.files) {
                if (!this.filter.isExcludedWithAncestors(path)) {
                    paths.add(path);
                }
            }
            for (const path of tree.files.keys()) {
                if (!this.filter.isExcludedWithAncestors(path)) {
                    paths.add(path);
                }
            }
            // Paths the last sync knew about that are now absent from both
            // sides still need visiting, so their records are retired.
            for (const record of this.state.entries()) {
                if (record.type === 'file' && !this.filter.isExcludedWithAncestors(record.path)) {
                    paths.add(record.path);
                }
            }

            this.caseCollisions = (await this.cases.isCaseInsensitive()) ? this.cases.findCollisions(paths) : new Set();
            // A pass that would remove a great many files from Drive is held
            // instead, and the user asked; see holdMassDelete. The paths it
            // holds are left out of this pass entirely.
            const localFiles = new Set(local.files);
            const held = await this.holdMassDelete(paths, tree.files, {
                deletedFolders: locallyDeletedFolders,
                absent: (path) => !localFiles.has(path),
            });
            for (const path of held) {
                paths.delete(path);
            }
            const failed: string[] = [];
            if (this.adoptingSettings) {
                // A first sync settles the config folder before anything
                // else. Obsidian needs a reload to apply settings, plugins and
                // themes from Drive, and asking for it now, while the vault is
                // still nearly empty, makes the reload quick and spares
                // Obsidian and its plugins indexing every note twice. The
                // state is saved first, so a reload loses none of it; the
                // notes then continue, or resume after the reload.
                const settingsPaths = new Set([...paths].filter((path) => this.filter.isConfigPath(path)));
                failed.push(...(await this.reconcileAll(settingsPaths, tree.files, skip)));
                await this.state.flush();
                this.announceAdoptedSettings();
                for (const path of settingsPaths) {
                    paths.delete(path);
                }
            }
            failed.push(...(await this.reconcileAll(paths, tree.files, skip)));
            await this.cleanUpDeletedFolders(goneFolders, locallyDeletedFolders, held);
            this.plannedLocal.clear();

            // A stale pass has outlived its engine: nothing it settled may be
            // written over the state of the one that replaced it.
            if (this.stale(generation)) {
                return false;
            }

            // A full pass settles everything earlier polls could not, so only
            // what failed in it, or could not be established, stays queued.
            const itemFailures = [...this.itemFailures];
            this.state.clearRetries();
            for (const path of [...this.failureReasons.keys()]) {
                if (!failed.includes(path) && !itemFailures.includes(path)) {
                    this.failureReasons.delete(path);
                }
            }
            for (const path of [...failed, ...skip, ...itemFailures]) {
                this.state.retry(path);
            }
            this.itemFailures.clear();
            // Queued during this pass without failing, a Drive revision that
            // moved under it, say: still to be retried.
            for (const path of this.heldForRetry) {
                this.state.retry(path, { backoff: false });
            }
            this.heldForRetry.clear();
            this.state.setLastFullSync(Date.now());
            this.lastFullSyncMono = monotonicNow();
            this.configScanGap = CONFIG_SCAN_MIN_MS;

            this.lastSyncedAt = Date.now();
            this.lastError = null;
            this.setStatus('idle');
            return true;
        } catch (error) {
            if (this.stale(generation)) {
                return false;
            }
            this.reportFailure('Full sync failed', error);
            return false;
        } finally {
            this.adoptingSettings = null;
            if (!this.stale(generation)) {
                await this.state.flush();
            }
        }
    }

    /**
     * Sync on start-up, from where the last session left off when it can.
     *
     * Walking the whole Drive folder on every launch costs a request per
     * folder, slows the first sync on a phone, and is the pattern Proton's
     * guidelines ask third-party clients to avoid. When the saved state is
     * usable it is not needed: Drive's event feed, read from the saved cursor,
     * lists every remote change since, and a scan of the vault, which costs
     * only local stats, finds every local one. The full walk is kept for when
     * those two cannot tell the whole story: no state or cursor yet, the event
     * feed not being followed (Auto sync off), a recorded file or folder gone
     * from the vault (a rename or deletion made while Obsidian was closed,
     * which the walk's rename detection handles), a new folder, and once a day
     * regardless. If Drive can no longer replay from the cursor, it says so
     * with a TreeRefresh event and the poll falls back to the walk.
     */
    private async startupSync(): Promise<void> {
        const drive = this.drive;
        const rootUid = this.rootUid;
        const lastFull = this.state.getLastFullSync();
        if (
            !drive ||
            !rootUid ||
            this.state.paths().length === 0 ||
            !this.settings.autoSync ||
            this.networkHeld() ||
            this.settings.fullSyncOnStartup ||
            lastFull === null ||
            Date.now() - lastFull > STARTUP_WALK_AFTER_MS
        ) {
            await this.fullSync();
            return;
        }

        let scopeId: string;
        try {
            const root = await this.rootNode();
            if (root === null) {
                return;
            }
            scopeId = root.treeEventScopeId;
        } catch {
            // Let the full sync report it, and set the status to match.
            await this.fullSync();
            return;
        }
        if (this.state.getEventCursor(scopeId) === null) {
            await this.fullSync();
            return;
        }

        const scan = await this.scanLocalChanges();
        if (scan === null) {
            await this.fullSync();
            return;
        }
        this.logger.info(`Catching up from the last session: ${scan.size} local change(s), then Drive's events`);
        this.treeEventScopeId = scopeId;
        this.folderUids.set('', rootUid);

        if (scan.size > 0) {
            await this.processPaths(scan);
        }
        await this.pollRemoteEvents();
        // Caught up, unless one of the steps reported a problem in the status.
        if (this.status === 'syncing' || this.status === 'idle') {
            this.lastSyncedAt = Date.now();
            this.lastError = null;
            this.setStatus('idle');
        }
    }

    /**
     * Local files that changed since their last sync, by size and mtime, or
     * null when the vault changed in a way only a full sync handles: a
     * recorded file or folder gone, or a folder with no record.
     */
    private async scanLocalChanges(): Promise<Set<string> | null> {
        const included = (path: string) => !this.filter.isExcludedWithAncestors(path);
        const local = await this.vault.list((path) => !this.filter.isExcluded(path));
        const files = local.files.filter(included);
        const present = new Set([...files, ...local.folders]);

        for (const record of this.state.entries()) {
            if (!present.has(record.path) && included(record.path)) {
                return null;
            }
        }
        if (local.folders.some((folder) => included(folder) && this.state.get(folder)?.type !== 'folder')) {
            return null;
        }

        const changed = new Set<string>();
        await runPooled(
            files.map((path) => async () => {
                const base = this.state.get(path)?.base;
                const stat = await this.vault.stat(path);
                if (!base || !stat || stat.size !== base.size || stat.mtime !== base.localMtime) {
                    changed.add(path);
                }
            }),
            SCAN_CONCURRENCY,
            (error, index) => {
                this.logger.debug(`Could not check "${files[index]}"`, error);
                changed.add(files[index]);
            },
        );
        return changed;
    }

    /**
     * Reconcile a specific set of paths, resolving each side on demand.
     *
     * Used for both local and remote events. The remote side is looked up per
     * node rather than by listing the tree, which is what keeps steady-state
     * syncing down to a couple of requests per changed file.
     */
    private async processPaths(
        paths: Set<string>,
        confirmedAbsent: Set<string> = new Set(),
        /** Paths whose Drive side could not be established, and is not inferred; see {@link RemoteView.skip}. */
        unconfirmed: Set<string> = new Set(),
    ): Promise<void> {
        if (!this.drive || !this.rootUid || !this.running) {
            return;
        }
        const generation = this.generation;
        if (this.folderMissing !== null) {
            // The full sync that runs once the folder is back covers these.
            return;
        }
        if (this.networkHeld()) {
            for (const path of paths) {
                this.state.retry(path, { backoff: false });
            }
            this.setStatus('waiting-for-wifi');
            return;
        }

        paths = await this.cases.settleIn(paths);

        this.setStatus('syncing');
        try {
            const files = new Set(
                [...paths].filter(
                    (path) => this.state.get(path)?.type !== 'folder' && !this.pendingFolderDeletes.has(path),
                ),
            );
            const view = await this.lookupRemote(files, confirmedAbsent);
            const skip = new Set([...view.skip, ...unconfirmed]);
            // A batch that would remove a great many files from Drive is held,
            // as in a full pass: an unmounted card produces its deletions as
            // events, not as a walk. A batch is not the whole state, so it can
            // only add to a hold, and its deletions are counted with the ones
            // this poll window's earlier batches reported.
            for (const path of await this.holdMassDelete(view.paths, view.states, { full: false })) {
                view.paths.delete(path);
            }
            const failed = new Set(await this.reconcileAll(view.paths, view.states, skip));
            for (const path of new Set([...paths, ...view.paths])) {
                if (failed.has(path) || skip.has(path)) {
                    this.state.retry(path);
                } else if (!this.heldForRetry.has(path)) {
                    this.state.clearRetry(path);
                    this.failureReasons.delete(path);
                }
            }
            this.heldForRetry.clear();
            await this.applyLocalFolderDeletes();

            if (this.stale(generation)) {
                return;
            }
            this.lastSyncedAt = Date.now();
            this.lastError = null;
            this.setStatus('idle');
        } catch (error) {
            if (this.stale(generation)) {
                return;
            }
            for (const path of paths) {
                this.state.retry(path);
                this.failureReasons.set(path, errorMessage(error));
            }
            this.reportFailure('Sync failed', error);
        } finally {
            if (!this.stale(generation)) {
                await this.state.flush();
            }
        }
    }

    /**
     * Decide and carry out every path, returning the ones that failed.
     *
     * Deciding is cheap and runs {@link SCAN_CONCURRENCY} wide; only the
     * paths that need Drive queue for one of the user's transfer slots, notes
     * first. A file that changes while it waits is decided again, so the
     * wait never turns into acting on a stale decision.
     */
    private async reconcileAll(
        paths: Set<string>,
        remoteStates: Map<string, RemoteState | undefined>,
        skip: Set<string> = new Set(),
    ): Promise<string[]> {
        const ordered = [...paths]
            .filter((path) => !skip.has(path) && !this.caseCollisions.has(path))
            .sort(this.transferOrder(remoteStates));
        for (const path of skip) {
            this.logger.debug(`Leaving "${path}" alone: could not confirm its state on Drive`);
        }

        const transfers = new Limiter(() => this.pace.current());
        const limit = this.sizeLimitBytes();
        this.progress.begin(ordered.length);

        // Deciding runs in parallel, but paths take their place in the
        // transfer queue strictly in `ordered` order: each waits for the one
        // before it to be queued or found to need nothing. Without this, a
        // large attachment decided a moment sooner would take a slot ahead of
        // the notes the ordering is there to put first.
        let previousQueued: Promise<void> = Promise.resolve();
        const work = ordered.map((path) => {
            const turn = previousQueued;
            let markQueued!: () => void;
            previousQueued = new Promise<void>((resolve) => (markQueued = resolve));

            return async () => {
                let checked = false;
                // Counted as checked once decided, not once transferred: most
                // files need nothing, and counting them only at the end of a
                // pass full of transfers would leave the bar idle and then jump.
                const markChecked = () => {
                    if (!checked) {
                        checked = true;
                        this.progress.checked();
                    }
                };
                let weight = 0;
                try {
                    if (this.state.isConflicted(path) && this.settings.conflictPolicy === 'manual') {
                        // Left for the user; acting now would undo a pending decision.
                        return;
                    }
                    let decision = await this.decide(path, remoteStates.get(path), limit);
                    markChecked();
                    await turn;
                    if (!decision) {
                        return;
                    }
                    if (needsTransfer(decision.action)) {
                        weight = Math.max(1, transferSize(decision.action, decision.local, decision.remote));
                        this.progress.queued(weight);
                    }
                    if (!needsTransfer(decision.action)) {
                        markQueued();
                        await this.applyAction(path, decision.action, decision.local, decision.remote);
                        return;
                    }
                    const action = decision.action.type;
                    const transferOne = async () => {
                        if (decision && (await this.localMoved(path, decision.local))) {
                            decision = await this.decide(path, remoteStates.get(path), limit);
                        }
                        for (let attempt = 1; decision; attempt++) {
                            if (needsTransfer(decision.action)) {
                                // Decided again, it may now go the other way.
                                this.inFlight.set(path, decision.action.type);
                            }
                            try {
                                await this.applyAction(path, decision.action, decision.local, decision.remote);
                                return;
                            } catch (error) {
                                if (error instanceof RemoteChangedError || error instanceof EditorBusyError) {
                                    // Decided against a version of the Drive
                                    // file that is no longer current; the
                                    // event for the new one brings it back.
                                    this.logger.info(error.message);
                                    this.state.retry(path, { backoff: false });
                                    this.heldForRetry.add(path);
                                    return;
                                }
                                if (!(error instanceof LocalChangedError) || attempt >= MAX_REDECIDE) {
                                    throw error;
                                }
                                // Saved again while the transfer ran: decide
                                // afresh, which usually makes it a conflict.
                                this.logger.info(error.message);
                                decision = await this.decide(path, remoteStates.get(path), limit);
                            }
                        }
                    };
                    // `run` claims its place synchronously, so the next path
                    // may go as soon as it has been called.
                    const transfer = transfers.run(async () => {
                        this.inFlight.set(path, action);
                        try {
                            await transferOne();
                        } finally {
                            this.inFlight.delete(path);
                            this.pace.afterTransfer();
                        }
                    });
                    markQueued();
                    await transfer;
                } finally {
                    markQueued();
                    markChecked();
                    if (weight > 0) {
                        this.progress.transferred(weight);
                    }
                }
            };
        });

        const failed: string[] = [];
        try {
            await runPooled(work, SCAN_CONCURRENCY, (error, index) => {
                this.logger.error(`Failed to sync "${ordered[index]}"`, error);
                this.lastError = errorMessage(error);
                this.failureReasons.set(ordered[index], errorMessage(error));
                failed.push(ordered[index]);
            });
        } finally {
            this.progress.end();
        }
        return failed;
    }

    /** What to do with one path, or null when it is to be left alone this pass. */
    private async decide(
        path: string,
        remote: RemoteState | undefined,
        limit: number,
    ): Promise<{ action: SyncAction; local: LocalState | undefined; remote: RemoteState | undefined } | null> {
        const record = this.state.get(path);
        const planned = this.plannedLocal.get(path);
        const known = record?.base ?? (planned && { hash: planned.hash, size: planned.size, localMtime: planned.mtime });

        let local: LocalState | undefined;
        try {
            local = await this.vault.getState(path, known);
        } catch (error) {
            if (error instanceof FileTooLargeError) {
                this.logger.info(`Skipping "${path}": ${megabytes(error.size)} MB exceeds the configured limit`);
                this.tooLarge.set(path, error.size);
                return null;
            }
            throw error;
        }
        if (local && local.size > limit) {
            this.logger.info(`Skipping "${path}": ${megabytes(local.size)} MB exceeds the configured limit`);
            this.tooLarge.set(path, local.size);
            return null;
        }

        const action = reconcile({
            path,
            ...(record?.base !== undefined && { base: record.base }),
            ...(local !== undefined && { local }),
            ...(remote !== undefined && { remote }),
        });
        if (action.type === 'delete-remote' && local === undefined && this.unverifiableRenames.has(path)) {
            // The file is gone from here, but a same-sized file that could not
            // be read might be it under a new name; see `followLocalRenames`.
            // Trashing the node would take it off every other device, so it
            // waits. A path with no such candidate is simply deleted, which is
            // what a user deleting a large file expects.
            this.logger.info(`Leaving "${path}" on Drive: it is missing here, and a file of the same size could not be read`);
            return null;
        }
        if (remote?.size !== undefined && remote.size > limit && (action.type === 'download' || action.type === 'conflict')) {
            this.logger.info(`Leaving "${path}" on Drive: ${megabytes(remote.size)} MB exceeds this device's limit`);
            this.tooLarge.set(path, remote.size);
            return null;
        }
        this.tooLarge.delete(path);
        if (
            this.settingsHeld &&
            this.filter.isConfigPath(path) &&
            (action.type === 'upload' || action.type === 'delete-remote' || action.type === 'conflict')
        ) {
            this.logger.debug(`Holding "${path}" until Obsidian reloads with the settings from Drive`);
            return null;
        }
        return { action, local, remote };
    }

    /** Whether the file is no longer what `local` described: edited, created or removed since. */
    private async localMoved(path: string, local: LocalState | undefined): Promise<boolean> {
        const stat = await this.vault.stat(path);
        if (!local || !stat) {
            return (local === undefined) !== (stat === undefined);
        }
        return stat.size !== local.size || stat.mtime !== local.mtime;
    }

    /** Notes before everything else, then smaller before larger where the size is known. */
    private transferOrder(remoteStates: Map<string, RemoteState | undefined>): (a: string, b: string) => number {
        const rank = (path: string) => (NOTE_EXTENSIONS.has(splitExtension(path).extension.toLowerCase()) ? 0 : 1);
        const size = (path: string) =>
            remoteStates.get(path)?.size ?? this.state.get(path)?.base?.size ?? Number.MAX_SAFE_INTEGER;
        return (a, b) => rank(a) - rank(b) || size(a) - size(b);
    }

    // -- carrying out a decision -----------------------------------------

    private async applyAction(
        path: string,
        action: SyncAction,
        local: LocalState | undefined,
        remote: RemoteState | undefined,
    ): Promise<void> {
        switch (action.type) {
            case 'noop':
                return;

            case 'forget':
                this.state.delete(path);
                return;

            case 'adopt':
                if (local) {
                    this.state.setSynced(path, action.nodeUid, 'file', baseOf(local, action.revisionUid));
                }
                return;

            case 'upload':
                if (local) {
                    await this.upload(path, remote);
                }
                return;

            case 'download':
                await this.download(path, action.nodeUid, action.revisionUid, remote, local);
                return;

            case 'delete-local':
                // Checked again right before the delete: an edit saved since
                // the decision turns this into a conflict, which keeps it.
                if (await this.localMoved(path, local)) {
                    throw new LocalChangedError(path);
                }
                this.logger.info(`Removing "${path}", deleted on another device`);
                await this.vault.trash(path);
                this.state.delete(path);
                return;

            case 'delete-remote':
                await this.assertRemoteUnchanged(path, action.nodeUid);
                this.logger.info(`Removing "${path}" from Drive, deleted locally`);
                await this.drive!.trashNode(action.nodeUid);
                this.state.delete(path);
                return;

            case 'conflict':
                await this.handleConflict(path, action.reason, local, remote);
                return;
        }
    }

    /**
     * Upload the file's current content, as a new revision of the node it is
     * paired with or as a new file. The base records what was actually sent,
     * which is not necessarily what the reconcile saw a moment earlier.
     */
    private async upload(path: string, remote: RemoteState | undefined): Promise<void> {
        const { source, local } = await this.vault.openUpload(path);
        const progress = this.progress.track(path, 'upload', source.size);
        try {
            await this.sendUpload(path, remote, source, local, progress.onProgress);
        } finally {
            progress.end();
        }
    }

    private async sendUpload(
        path: string,
        remote: RemoteState | undefined,
        source: UploadSource,
        local: LocalState,
        onProgress: ((bytes: number) => void) | undefined,
    ): Promise<void> {
        const drive = this.drive!;
        const signal = this.abortController?.signal;

        const record = this.state.get(path);
        const nodeUid = remote?.nodeUid ?? record?.nodeUid;
        if (nodeUid) {
            const previousRevision = remote?.revisionUid ?? record?.base?.remoteRevisionUid;
            const previousHash = record?.base?.hash;
            // Drive cannot refuse an upload because another one just landed,
            // so ask first: if another device uploaded since this decision,
            // decide again, which merges or keeps both, instead of uploading
            // over its edit and rescuing it afterwards. The rescue below stays
            // for an upload that lands in the moment between.
            if (previousRevision !== undefined) {
                const latest = await drive.latestRevisionUid(nodeUid);
                if (latest !== null && latest !== previousRevision) {
                    throw new RemoteChangedError(path);
                }
            }
            const result = await drive.uploadRevision(nodeUid, source, signal, onProgress);
            this.state.setSynced(path, result.nodeUid, 'file', baseOf(local, result.revisionUid));
            this.logger.debug(`Uploaded "${path}"`);
            if (previousRevision) {
                await this.rescueSupersededEdits(path, nodeUid, previousRevision, result.revisionUid, [
                    local.hash,
                    previousHash,
                ]);
            }
            return;
        }

        const parentUid = await this.ensureRemoteFolder(parentPath(path));
        let result: { nodeUid: string; revisionUid: string };
        try {
            result = await this.uploadOverStaleDraft(path, parentUid, source, signal, onProgress);
        } catch (error) {
            // Another device created a file under the same name since this
            // pass looked. That is the both-created conflict, found late.
            if (error instanceof NodeWithSameNameExistsValidationError && !error.isUnfinishedUpload) {
                const existing = await this.findByName(path, new Map());
                if (existing?.hash === local.hash) {
                    // The same bytes, from another device: nothing to resolve.
                    this.state.setSynced(path, existing.nodeUid, 'file', baseOf(local, existing.revisionUid));
                    return;
                }
                if (existing) {
                    await this.handleConflict(path, 'both-created', local, existing);
                    return;
                }
            }
            throw error;
        }
        this.state.setSynced(path, result.nodeUid, 'file', baseOf(local, result.revisionUid));
        this.logger.debug(`Uploaded "${path}"`);
    }

    /**
     * Keep an edit that another device uploaded while this one was uploading.
     *
     * Drive has no conditional upload, so when two devices save the same note
     * within the same few seconds, both uploads succeed and the later one
     * silently becomes the current version. Nothing is lost on Drive, since
     * the earlier revision stays in the history, but nobody would ever look
     * there. So the superseded edit is written beside the note as a conflict
     * copy, exactly as if the conflict had been seen before the upload.
     */
    private async rescueSupersededEdits(
        path: string,
        nodeUid: string,
        previousRevision: string,
        uploadedRevision: string,
        /** Content that costs nothing to supersede: what was just uploaded, and the version it was based on. */
        knownHashes: (string | undefined)[],
    ): Promise<void> {
        let superseded;
        try {
            superseded = await this.drive!.revisionsBetween(nodeUid, previousRevision, uploadedRevision);
        } catch (error) {
            this.logger.debug(`Could not check the revision history of "${path}"`, error);
            return;
        }
        const lost = superseded
            .filter((revision) => !knownHashes.includes(revision.claimedDigests?.sha1))
            .at(-1);
        if (!lost) {
            return;
        }

        const copyPath = await this.availablePath(conflictCopyPath(path, this.settings.deviceName, new Date()));
        this.logger.warn(`"${path}" was saved on another device during this upload; keeping that version as "${copyPath}"`);
        await this.fetchInto(copyPath, lost.uid, lost.claimedSize, lost.claimedModificationTime?.getTime(), undefined);
        await this.uploadAsNewFile(copyPath);
        this.reportConflict({ path, reason: 'both-modified', outcome: 'kept-both', copyPath });
    }

    /**
     * Upload a new file, replacing an unfinished upload of the same name that
     * another installation left on Drive.
     *
     * Such a draft is invisible in Drive's apps and holds no content anyone
     * can read, but it holds the name: the SDK clears drafts this client made
     * and refuses ones made by any other, so a device that quit mid-upload,
     * or this one before its installation id changed, would otherwise block
     * the file for good, failing on every pass. Overriding it is safe even if
     * the other device is still uploading: its upload then fails, and its
     * next pass finds this file and treats it as a both-created conflict, so
     * both versions are kept.
     */
    private async uploadOverStaleDraft(
        path: string,
        parentUid: string,
        source: UploadSource,
        signal: AbortSignal | undefined,
        onProgress: ((bytes: number) => void) | undefined,
    ): Promise<{ nodeUid: string; revisionUid: string }> {
        const drive = this.drive!;
        try {
            return await drive.uploadNewFile(parentUid, basename(path), source, signal, onProgress);
        } catch (error) {
            if (!(error instanceof NodeWithSameNameExistsValidationError && error.isUnfinishedUpload)) {
                throw error;
            }
            this.logger.warn(`An unfinished upload from another device was holding "${path}" on Drive; replacing it`);
            return drive.uploadNewFile(parentUid, basename(path), source, signal, onProgress, true);
        }
    }

    /** Upload a file that has no node on Drive yet, such as a fresh conflict copy. */
    private async uploadAsNewFile(path: string): Promise<void> {
        const { source, local } = await this.vault.openUpload(path);
        const parentUid = await this.ensureRemoteFolder(parentPath(path));
        const result = await this.drive!.uploadNewFile(parentUid, basename(path), source, this.abortController?.signal);

        this.state.setSynced(path, result.nodeUid, 'file', baseOf(local, result.revisionUid));
    }

    /**
     * Download the revision the decision was made on, not whatever is active
     * by the time the transfer starts: the bytes, their timestamp and the
     * revision recorded as the new base then all describe the same version,
     * and a newer one is an ordinary remote change for the next pass.
     * `local` is what the decision saw here; see {@link fetchInto}.
     */
    private async download(
        path: string,
        nodeUid: string,
        revisionUid: string,
        remote: RemoteState | undefined,
        local: LocalState | undefined,
    ): Promise<void> {
        const editor =
            isTextPath(path) && (remote?.size ?? 0) <= MAX_MERGE_BYTES ? (this.environment.openEditor?.(path) ?? null) : null;
        if (editor) {
            await this.downloadIntoEditor(path, editor, nodeUid, revisionUid, remote, local);
            return;
        }
        const written = await this.fetchInto(path, revisionUid, remote?.size, remote?.mtime, local);
        this.state.setSynced(path, nodeUid, 'file', baseOf(written, revisionUid));
        if (this.adoptingSettings && this.filter.isConfigPath(path)) {
            this.adoptingSettings.push(path);
        }
        if (path === `${this.scope.configDir}/community-plugins.json`) {
            await this.keepSelfEnabled(path);
        }
        this.logger.debug(`Downloaded "${path}"`);
    }

    /**
     * Write a node's current content, or one specific revision, to a vault
     * path.
     *
     * Large files, and files whose size Drive does not report, are streamed to
     * disk where the platform allows it; the rest are small enough to buffer,
     * which lets Obsidian's adapter do the write and keeps the file cache in
     * step.
     */
    /**
     * Bring a new version of a note into the editor it is open in.
     *
     * Writing the file underneath an open editor races Obsidian's own save of
     * what is being typed: whichever lands last wins, and the other is lost
     * without a conflict. So with nothing unsaved, the editor is given the new
     * text first, as an edit that keeps the cursor where it was, and then the
     * file is written. With unsaved typing, nothing is written: the new version
     * is merged into the editor three ways (the file on disk the typing
     * started from, the editor's text, and Drive's), and once Obsidian saves
     * the merged text it goes up like any edit. Typing that overlaps the new
     * version is left alone, and the conflict policy settles it after the save.
     */
    private async downloadIntoEditor(
        path: string,
        editor: OpenEditor,
        nodeUid: string,
        revisionUid: string,
        remote: RemoteState | undefined,
        local: LocalState | undefined,
    ): Promise<void> {
        const data = await this.drive!.downloadRevision(revisionUid, this.abortController?.signal);
        if (await this.localMoved(path, local)) {
            throw new LocalChangedError(path);
        }
        const remoteText = new TextDecoder().decode(data);
        const diskText = local ? await this.vault.readText(path) : '';
        const editorText = editor.text();

        if (editorText === diskText) {
            if (editorText !== remoteText) {
                editor.replace(remoteText);
            }
            const written = await this.vault.writeBinary(path, data, remote?.mtime);
            this.state.setSynced(path, nodeUid, 'file', baseOf(written, revisionUid));
            this.logger.debug(`Downloaded "${path}" into its open editor`);
            return;
        }

        const merged = mergeThreeWay(diskText, editorText, remoteText);
        if (!merged.merged) {
            throw new EditorBusyError(path, false);
        }
        editor.replace(merged.text);
        this.mergedIntoEditor.set(path, revisionUid);
        throw new EditorBusyError(path, true);
    }

    /**
     * Write one revision's content to a vault path.
     *
     * Large files, and files whose size Drive does not report, are streamed to
     * disk where the platform allows it; the rest are small enough to buffer,
     * which lets Obsidian's adapter do the write and keeps the file cache in
     * step.
     *
     * `expected` is the local file the decision was made on, undefined for a
     * path that must not exist yet. It is checked again after the bytes have
     * arrived and right before they replace anything, because a download can
     * take long enough for the user to save the same note in the meantime; that
     * edit would otherwise be overwritten without trace. A mismatch abandons the
     * write with a {@link LocalChangedError}, and the caller decides again.
     */
    private async fetchInto(
        path: string,
        revisionUid: string,
        size: number | undefined,
        mtime: number | undefined,
        expected: LocalState | undefined,
    ): Promise<LocalState> {
        const drive = this.drive!;
        const signal = this.abortController?.signal;
        const { onProgress, end } = this.progress.track(path, 'download', size);

        try {
            if (size === undefined || size > LARGE_FILE_BYTES) {
                const file = await this.vault.openDownload(path);
                if (file) {
                    try {
                        await drive.downloadRevisionTo(revisionUid, file.sink, signal, onProgress);
                        if (await this.localMoved(path, expected)) {
                            throw new LocalChangedError(path);
                        }
                        return await file.commit(mtime);
                    } catch (error) {
                        await file.abort();
                        throw error;
                    }
                }
            }

            const data = await drive.downloadRevision(revisionUid, signal, onProgress);
            if (await this.localMoved(path, expected)) {
                throw new LocalChangedError(path);
            }
            return await this.vault.writeBinary(path, data, mtime);
        } finally {
            end();
        }
    }

    /**
     * Before trashing a node: is it still on the revision the decision saw?
     * Another device may have uploaded an edit since, and trashing it then
     * would send that edit to Drive's trash, and every device would delete it.
     */
    private async assertRemoteUnchanged(path: string, nodeUid: string): Promise<void> {
        const expected = this.state.get(path)?.base?.remoteRevisionUid;
        if (expected === undefined) {
            return;
        }
        const node = await this.drive!.getNode(nodeUid);
        if (node.activeRevision?.uid !== expected) {
            throw new RemoteChangedError(path);
        }
    }

    private async handleConflict(
        path: string,
        reason: ConflictReason,
        local: LocalState | undefined,
        remote: RemoteState | undefined,
    ): Promise<void> {
        const record = this.state.get(path);
        if (reason === 'both-modified' && local && remote && this.mergedIntoEditor.get(path) === remote.revisionUid) {
            // The local text is the editor's merge of this very revision, now
            // saved: it holds both sides' changes, so it simply goes up.
            this.mergedIntoEditor.delete(path);
            this.logger.info(`Uploading "${path}", saved with the changes from Drive merged in`);
            await this.upload(path, remote);
            this.state.clearConflict(path);
            return;
        }
        this.logger.warn(`Conflict on "${path}" (${reason})`);

        const resolution = await this.resolverFor(path, reason).resolve({
            path,
            reason,
            ...(record?.base !== undefined && { base: record.base }),
            ...(local !== undefined && { local }),
            ...(remote !== undefined && { remote }),
            readLocalText: () => this.vault.readText(path),
        });

        switch (resolution.action) {
            case 'defer':
                this.state.setConflict(path, { detectedAt: Date.now(), reason });
                this.logger.warn(`"${path}" needs a decision: ${resolution.note}`);
                this.reportConflict({ path, reason, outcome: 'deferred' });
                return;

            case 'take-local':
                if (local) {
                    if (!remote) {
                        // The node this path used to map to was trashed on
                        // Drive. Uploading a revision to it would either fail or
                        // resurrect the file inside the trash, so the stale
                        // record is dropped and the edit goes up as a new file.
                        this.state.delete(path);
                    }
                    await this.upload(path, remote);
                    this.state.clearConflict(path);
                    this.reportConflict({ path, reason, outcome: 'kept-local' });
                }
                return;

            case 'take-remote':
                if (remote) {
                    await this.download(path, remote.nodeUid, remote.revisionUid, remote, local);
                    this.state.clearConflict(path);
                    this.reportConflict({ path, reason, outcome: 'kept-remote' });
                }
                return;

            case 'take-merged': {
                // The merge read the note a while ago, before two downloads.
                // Typing saved since would be lost under it: decide again.
                if (await this.localMoved(path, local)) {
                    throw new LocalChangedError(path);
                }
                // Open in an editor, the merge goes in as an edit, so it does
                // not race Obsidian's own save; with unsaved typing in the
                // editor, nothing is written until that is saved.
                const editor = this.environment.openEditor?.(path) ?? null;
                if (editor) {
                    if (editor.text() !== (await this.vault.readText(path))) {
                        throw new EditorBusyError(path, false);
                    }
                    editor.replace(new TextDecoder().decode(resolution.content));
                }
                await this.vault.writeBinary(path, resolution.content);
                await this.upload(path, remote);
                this.state.clearConflict(path);
                this.reportConflict({ path, reason, outcome: 'merged' });
                return;
            }

            case 'keep-both': {
                const copyPath = await this.availablePath(resolution.copyPath);
                if (await this.keepBoth(path, copyPath, resolution.keepAtPath, local, remote, reason)) {
                    this.reportConflict({ path, reason, outcome: 'kept-both', copyPath });
                }
                return;
            }
        }
    }

    /**
     * Write both versions into the vault and push both to Drive.
     *
     * The copy is uploaded here rather than left to the next pass so the other
     * devices see it straight away. A conflict copy that exists on only one
     * machine is the kind of thing a user discovers a week later.
     */
    private async keepBoth(
        path: string,
        copyPath: string,
        keepAtPath: 'local' | 'remote',
        local: LocalState | undefined,
        remote: RemoteState | undefined,
        reason: ConflictReason,
    ): Promise<boolean> {
        if (keepAtPath === 'local') {
            if (!remote) {
                return false;
            }
            await this.fetchInto(copyPath, remote.revisionUid, remote.size, remote.mtime, undefined);
            await this.uploadAsNewFile(copyPath);
            if (local) {
                await this.upload(path, remote);
            }
        } else {
            if (!local) {
                return false;
            }
            await this.vault.copy(path, copyPath);
            await this.uploadAsNewFile(copyPath);
            if (remote) {
                await this.download(path, remote.nodeUid, remote.revisionUid, remote, local);
            }
        }

        this.state.clearConflict(path);
        this.logger.warn(`Kept both versions of "${path}" (${reason}); the other copy is at "${copyPath}"`);
        return true;
    }

    /** `path`, or the first "name 2.ext", "name 3.ext"… that is free, so a copy never overwrites another. */
    private async availablePath(path: string): Promise<string> {
        if (!(await this.vault.exists(path))) {
            return path;
        }
        const { stem, extension } = splitExtension(path);
        for (let n = 2; ; n++) {
            const candidate = `${stem} ${n}${extension}`;
            if (!(await this.vault.exists(candidate))) {
                return candidate;
            }
        }
    }

    // -- renames made in the vault ----------------------------------------

    private async applyLocalRenames(renames: PendingRename[]): Promise<void> {
        if (!this.drive || !this.rootUid || !this.running) {
            return;
        }
        if (this.networkHeld()) {
            // Too many paths to carry over one by one; a full sync on Wi-Fi
            // sees the result of every rename.
            this.deferredFullSync = true;
            this.setStatus('waiting-for-wifi');
            return;
        }

        const touched = new Set<string>();
        const applied: PendingRename[] = [];
        const carriedByParent = (rename: PendingRename) =>
            applied.some(
                (done) => isWithin(rename.from, done.from) && replacePrefix(rename.from, done.from, done.to) === rename.to,
            );

        // Folders first, shallowest first: once a folder has moved on Drive,
        // everything inside it has moved too, and the renames reported for its
        // contents are already satisfied.
        const folders = renames.filter((rename) => rename.isFolder).sort((a, b) => byDepth(a.from, b.from));
        for (const rename of folders) {
            if (carriedByParent(rename)) {
                continue;
            }
            let uid: string | undefined;
            try {
                uid = await this.findRemoteFolder(rename.from);
            } catch (error) {
                this.logger.warn(`Could not look up folder "${rename.from}" on Drive`, error);
            }
            if (!uid) {
                // Never reached Drive; the files inside are handled one by one.
                continue;
            }
            try {
                await this.moveRemoteNode(uid, rename.to);
            } catch (error) {
                this.logger.warn(`Could not rename folder "${rename.from}" on Drive; moving its files instead`, error);
                continue;
            }
            this.state.renameFolder(rename.from, rename.to);
            this.renameKnownFolders(rename.from, rename.to);
            this.folderUids.set(rename.to, uid);
            this.state.setSynced(rename.to, uid, 'folder');
            applied.push(rename);
            this.logger.info(`Renamed folder "${rename.from}" to "${rename.to}" on Drive`);

            for (const record of this.state.entries()) {
                if (record.type === 'file' && isWithin(record.path, rename.to)) {
                    touched.add(record.path);
                }
            }
        }

        for (const rename of renames.filter((rename) => !rename.isFolder)) {
            touched.add(rename.to);
            if (carriedByParent(rename)) {
                continue;
            }
            const record = this.state.get(rename.from);
            if (record?.type !== 'file') {
                // Not on Drive yet: the reconcile below uploads it under its
                // new name, and there is nothing under the old one to remove.
                continue;
            }
            try {
                await this.moveRemoteNode(record.nodeUid, rename.to);
                this.state.rename(rename.from, rename.to);
                this.logger.info(`Renamed "${rename.from}" to "${rename.to}" on Drive`);
            } catch (error) {
                // Typically a name already taken on Drive. Falling back to
                // delete-and-upload still converges; it only costs the history.
                this.logger.warn(`Could not rename "${rename.from}" on Drive; uploading it under the new name`, error);
                touched.add(rename.from);
            }
        }

        await this.processPaths(touched);
    }

    /** Put a node at the Drive location matching a vault path: same parent folder, same name. */
    private async moveRemoteNode(nodeUid: string, toPath: string): Promise<void> {
        const drive = this.drive!;
        const parentUid = await this.ensureRemoteFolder(parentPath(toPath));
        const node = await drive.getNode(nodeUid);
        if (node.trashTime !== undefined) {
            throw new Error('it is in the Drive trash');
        }
        if (node.parentUid !== parentUid) {
            await drive.moveNode(nodeUid, parentUid);
        }
        const name = basename(toPath);
        if (drive.nameOf(node) !== name) {
            await drive.renameNode(nodeUid, name);
        }
    }

    // -- renames and moves made on Drive ----------------------------------

    /**
     * Bring vault paths in line with nodes that were renamed or moved on Drive
     * since the last sync, using the tree just listed.
     */
    private async followRemoteMoves(tree: RemoteTree): Promise<void> {
        // Folders first, shallowest first, so that by the time the files are
        // checked, those inside a moved folder are already where Drive has them.
        const folderUids = this.state
            .entries()
            .filter((record) => record.type === 'folder')
            .sort((a, b) => byDepth(a.path, b.path))
            .map((record) => record.nodeUid);
        for (const uid of folderUids) {
            const record = this.state.getByNodeUid(uid);
            const remotePath = tree.nodePaths.get(uid);
            if (
                record?.type === 'folder' &&
                remotePath !== undefined &&
                remotePath !== record.path &&
                !this.filter.isExcludedWithAncestors(record.path)
            ) {
                try {
                    await this.followRemoteMove(record.path, remotePath, 'folder');
                } catch (error) {
                    // One folder that cannot be moved here — a handle held open
                    // on Windows — is recorded and the pass goes on.
                    this.noteItemFailure(record.path, error, 'Could not follow the rename of');
                }
            }
        }

        for (const record of this.state.entries()) {
            const remotePath = tree.nodePaths.get(record.nodeUid);
            if (
                record.type !== 'file' ||
                remotePath === undefined ||
                remotePath === record.path ||
                this.filter.isExcludedWithAncestors(record.path)
            ) {
                continue;
            }
            try {
                await this.followRemoteMove(record.path, remotePath, 'file');
            } catch (error) {
                this.noteItemFailure(record.path, error, 'Could not follow the rename of');
            }
        }
    }

    /**
     * Rename a vault path to follow its node on Drive. Returns false, leaving
     * the vault untouched, when that is not safe.
     *
     * The unsafe case is a destination that is already taken here. The file
     * is then detached from its node, so it goes up again under its current
     * name and both copies survive, rather than one replacing the other.
     */
    private async followRemoteMove(fromPath: string, toPath: string, type: 'file' | 'folder'): Promise<boolean> {
        if (this.filter.isExcludedWithAncestors(toPath)) {
            // Moved somewhere this device does not sync. The file has left the
            // vault as far as the sync is concerned, so the local copy goes
            // with it: keeping it would upload it again under its old name on
            // the next pass, putting it back on Drive beside the move.
            if (type === 'file') {
                await this.detachExcluded(fromPath);
            }
            return false;
        }

        const caseOnly = fromPath.toLowerCase() === toPath.toLowerCase();
        const occupied =
            (caseOnly ? await this.vault.existsExactly(toPath) : await this.vault.exists(toPath)) ||
            this.state.get(toPath) !== undefined;
        if (occupied) {
            this.logger.info(
                `"${fromPath}" was renamed to "${toPath}" on another device, but "${toPath}" already exists here; ` +
                    'keeping both',
            );
            if (type === 'file') {
                this.state.delete(fromPath);
            }
            return false;
        }

        if (await this.vault.exists(fromPath)) {
            await this.vault.rename(fromPath, toPath);
        }
        if (type === 'folder') {
            this.state.renameFolder(fromPath, toPath);
            this.renameKnownFolders(fromPath, toPath);
        } else {
            this.state.rename(fromPath, toPath);
        }
        this.logger.info(`Renamed "${fromPath}" to "${toPath}", as on another device`);
        return true;
    }

    /**
     * Files Drive listed but cannot serve a revision of.
     *
     * `listTree` leaves a file out of its `files` map when the node has no
     * active revision — an upload that never finished, or metadata that could
     * not be decrypted — but keeps its path in `nodePaths`. Compared by path
     * alone, such a file looks deleted on Drive, and the vault copy would be
     * removed. It is there, so it is left alone until Drive can say what it
     * holds.
     */
    private unreadablePaths(tree: RemoteTree): Set<string> {
        const unreadable = new Set<string>();
        for (const record of this.state.entries()) {
            const listed = tree.nodePaths.get(record.nodeUid);
            if (record.type === 'file' && listed === record.path && !tree.files.has(record.path)) {
                this.logger.debug(`Leaving "${record.path}" alone: Drive lists it without a revision this device can read`);
                unreadable.add(record.path);
            }
        }
        return unreadable;
    }

    /**
     * Drop a file that moved on Drive into a path this device does not sync.
     *
     * Nothing is lost: the file is on Drive, in the excluded place, and every
     * device that does not exclude it keeps it. What is removed here is this
     * device's copy and its record, since leaving either behind would upload
     * the file again under the name it no longer has.
     *
     * Unless it was edited here since the last sync: that edit is nowhere else,
     * so the file stays and goes up again as a new one — which is what the
     * local copy is for.
     */
    private async detachExcluded(path: string): Promise<void> {
        const base = this.state.get(path)?.base;
        let local: LocalState | undefined;
        try {
            local = base === undefined ? undefined : await this.vault.getState(path, base);
        } catch (error) {
            // Over this device's limit, or not readable at all: whether it holds
            // edits this device alone has cannot be told, so nothing is removed.
            // The record stays too, so the next pass tries again rather than
            // uploading the file back under its old name.
            this.noteItemFailure(path, error, 'Could not check');
            return;
        }
        this.state.delete(path);
        if (base !== undefined && local !== undefined && local.hash !== base.hash) {
            this.logger.info(`Kept "${path}": it was moved on Drive to a path this device does not sync, and has edits here`);
            return;
        }
        try {
            if (await this.vault.exists(path)) {
                await this.vault.trash(path);
                this.logger.info(`Removed "${path}": it was moved on Drive to a path this device does not sync`);
            }
        } catch (error) {
            this.noteItemFailure(path, error, 'Could not remove');
        }
    }

    /**
     * Establish what happened to recorded nodes the tree listing did not
     * contain.
     *
     * Not being in the listing is not the same as being deleted: the node may
     * have moved out of the synced folder, sit under a name that could not be
     * decrypted, or the lookup may simply have failed. Only a node Drive
     * confirms as gone, or as in the trash, lets the reconcile delete the local
     * file; everything else is kept, and uploaded again when it has no node.
     */
    private async verifyMissingNodes(tree: RemoteTree): Promise<{ skip: Set<string>; goneFolders: Set<string> }> {
        const skip = new Set<string>();
        const goneFolders = new Set<string>();
        const insideGoneFolder = (path: string) => [...goneFolders].some((folder) => isWithin(path, folder));

        const missing = this.state
            .entries()
            .filter((record) => !tree.nodePaths.has(record.nodeUid) && !this.filter.isExcludedWithAncestors(record.path));

        // Folders first: trashing a folder on Drive takes everything inside it
        // along, and one lookup of the folder settles all of it.
        const folders = missing.filter((record) => record.type === 'folder').sort((a, b) => byDepth(a.path, b.path));
        const staleFolders: string[] = [];
        for (const record of folders) {
            if (insideGoneFolder(record.path)) {
                continue;
            }
            const location = await this.tryLocate(record.nodeUid);
            if (location?.kind === 'deleted') {
                goneFolders.add(record.path);
            } else if (location?.kind === 'outside' || location?.kind === 'at') {
                // Alive, but not where this vault's folder is. Its record must
                // go, or uploads would keep landing in a folder nobody syncs;
                // the files inside are settled one by one below.
                staleFolders.push(record.path);
            }
        }
        // A folder's contents do not all go with it: a file moved out a moment
        // before the trash is still there, under another folder, and is not
        // this device's to delete. Being inside a folder Drive confirmed gone
        // says nothing about the file itself, so every one of them is settled
        // in one lookup, exactly as the incremental path does; only a child
        // that went with its folder may be reconciled as deleted. Settled
        // before the folders are forgotten: their records carry the uids the
        // lookup needs, subfolders' included.
        const childrenInGoneFolders = missing.filter((record) => record.type === 'file' && insideGoneFolder(record.path));
        const goneWithFolder = new Set(
            (await this.childrenGoneWith([...goneFolders], childrenInGoneFolders))
                .filter((child) => child.gone)
                .map((child) => child.path),
        );

        for (const path of [...goneFolders, ...staleFolders]) {
            this.forgetFolder(path);
        }

        for (const record of missing) {
            if (record.type !== 'file') {
                continue;
            }
            if (insideGoneFolder(record.path)) {
                if (goneWithFolder.has(record.path)) {
                    // Confirmed gone with the folder. Absence established; the
                    // reconcile chooses between deleting the local copy and
                    // keeping a local edit.
                    continue;
                }
                // Alive somewhere else, or not answered for: left for its own
                // path to settle, so the folder cleanup finds it still here.
                skip.add(record.path);
                continue;
            }
            const location = await this.tryLocate(record.nodeUid);
            switch (location?.kind) {
                case 'deleted':
                    // Absence confirmed; the reconcile chooses between deleting
                    // the local copy and keeping a local edit.
                    break;
                case 'outside':
                    this.logger.info(`"${record.path}" was moved out of the synced Drive folder; uploading it again`);
                    this.state.delete(record.path);
                    break;
                case 'at':
                    if (!this.filter.isExcludedWithAncestors(location.path)) {
                        // In the synced tree but not in the listing: a gap in
                        // the listing, left for the next walk to settle.
                        skip.add(record.path);
                        break;
                    }
                    // Moved into a path this device does not sync; see
                    // {@link detachExcluded}.
                    await this.detachExcluded(record.path);
                    break;
                default:
                    // In a folder that could not be read, or the lookup failed.
                    skip.add(record.path);
            }
        }

        return { skip, goneFolders };
    }

    /** What rename detection needs; see {@link followLocalRenames}. */
    private renameHost(): LocalRenameHost {
        return {
            state: this.state,
            filter: () => this.filter,
            vault: this.vault,
            plannedLocal: this.plannedLocal,
            unverifiableRenames: this.unverifiableRenames,
            moveRemoteNode: (nodeUid, toPath) => this.moveRemoteNode(nodeUid, toPath),
            logger: this.logger,
        };
    }

    /** A node's location, or null when Drive could not be asked. */
    private async tryLocate(nodeUid: string): Promise<NodeLocation | null> {
        try {
            return await this.drive!.locate(nodeUid, this.rootUid!);
        } catch (error) {
            this.logger.debug(`Could not locate node ${nodeUid}`, error);
            return null;
        }
    }

    // -- folders ----------------------------------------------------------

    /**
     * Give both sides every folder the other has, and report folders that
     * were deleted locally since the last sync.
     *
     * Folders carry no content, so nothing else in the sync would ever create
     * an empty one, and an empty folder is usually structure the user set up
     * deliberately before writing into it.
     */
    private async syncFolders(
        localFolders: string[],
        tree: RemoteTree,
        goneFolders: Set<string>,
    ): Promise<Map<string, string>> {
        const localSet = new Set(localFolders);

        // Shallowest first, so a parent exists before its children need it.
        for (const path of [...localSet].sort(byDepth)) {
            if (this.filter.isExcludedWithAncestors(path) || this.folderUids.has(path)) {
                continue;
            }
            if ([...goneFolders].some((folder) => isWithin(path, folder))) {
                // Deleted on Drive. Whether it survives here is decided once
                // the files inside it have been reconciled.
                continue;
            }
            try {
                await this.ensureRemoteFolder(path);
            } catch (error) {
                // One folder that cannot be made on Drive does not fail the
                // pass; its files fail on their own if it is really needed.
                this.noteItemFailure(path, error, 'Could not create the folder');
            }
        }

        const locallyDeleted = new Map<string, string>();
        for (const [path, uid] of [...tree.folders].sort(([a], [b]) => byDepth(a, b))) {
            if (this.filter.isExcludedWithAncestors(path)) {
                continue;
            }
            const record = this.state.get(path);
            if (localSet.has(path)) {
                // Remembered so later passes can find it without a listing.
                if (record?.nodeUid !== uid) {
                    this.state.setSynced(path, uid, 'folder');
                }
                continue;
            }
            if (record?.type === 'folder' && record.nodeUid === uid) {
                // Synced before and gone now: deleted here.
                locallyDeleted.set(path, uid);
                continue;
            }
            try {
                await this.vault.ensureFolder(path);
                this.state.setSynced(path, uid, 'folder');
            } catch (error) {
                // A name this filesystem refuses, say: recorded for a retry
                // rather than stopping the rest of the folders.
                this.noteItemFailure(path, error, 'Could not create the folder');
            }
        }
        return locallyDeleted;
    }

    /**
     * Decide whether this pass may delete, and hold it back when it would
     * remove a great many files at once.
     *
     * The case is a vault that lost a folder whole: an unmounted SD card, a
     * folder a cloud client evicted, a directory emptied outside Obsidian.
     * Every file in it reads as deleted, and following that trashes the Drive
     * copies, which every other device then copies. Above
     * `massDeleteThreshold` the deletions are kept for a decision instead; the
     * paths are returned so the pass can leave them alone.
     *
     * Only a full pass may replace or clear the hold: it is the only pass that
     * sees every path, so its count is the one that describes the state. An
     * incremental pass sees a batch, and a batch that happens to hold nothing
     * would otherwise clear a hold the walk made and turn the panel's decision
     * into a no-op. It counts its deletions with those earlier batches reported
     * in the same poll window ({@link batchDeletes}), so a folder evicted file
     * by file is still held once the total crosses the threshold, and it can
     * only ever add to a hold.
     *
     * `absent` answers whether the vault still has the file. A full pass knows
     * that from its listing; an incremental one asks the filesystem, which is
     * a handful of stats for a batch of changed paths.
     */
    private async holdMassDelete(
        paths: Iterable<string>,
        remote: Map<string, RemoteState | undefined>,
        {
            full = true,
            deletedFolders = new Map<string, string>(),
            absent = async (path: string) => !(await this.vault.exists(path)),
        }: {
            /** Whether this pass saw every path, as the walk does. */
            full?: boolean;
            /** Folders the listing has and the vault has not, by path and node uid. */
            deletedFolders?: Map<string, string>;
            /** Whether the vault still has the file. */
            absent?: (path: string) => boolean | Promise<boolean>;
        } = {},
    ): Promise<Set<string>> {
        // A full pass starts the count over: what earlier batches saw is part
        // of what it has now seen for itself.
        if (full) {
            this.batchDeletes.clear();
        }
        const threshold = this.settings.massDeleteThreshold;
        if (threshold <= 0) {
            this.massDelete = null;
            return new Set();
        }
        if (this.massDelete?.approved) {
            return new Set();
        }

        const files: string[] = [];
        for (const path of paths) {
            const record = this.state.get(path);
            const remoteState = remote.get(path);
            if (record?.base === undefined || remoteState === undefined) {
                continue;
            }
            if (await absent(path)) {
                if (this.unverifiableRenames.has(path)) {
                    // A rename this device cannot rule out; decide() keeps it.
                    continue;
                }
                if (removesRemote(reconcile({ path, base: record.base, remote: remoteState }))) {
                    files.push(path);
                }
            }
        }
        // Folders the listing has and the vault has not, but only those that
        // will really go: one still holding files this device does not delete
        // is skipped by cleanUpDeletedFolders, and counting it would leave a
        // decision that carrying out can never settle.
        const folders: string[] = [];
        for (const [path, uid] of deletedFolders) {
            try {
                if (await this.drive!.hasLiveChildren(uid)) {
                    continue;
                }
            } catch (error) {
                // Not counted this pass: a folder that cannot be checked must
                // not hold the whole walk, and counting it could promise a
                // deletion that never happens.
                this.logger.warn(`Could not check whether "${path}" still holds files`, error);
                continue;
            }
            folders.push(path);
        }
        const deletions = [...files, ...folders];

        if (full) {
            if (deletions.length <= threshold) {
                // Nothing to hold, and a hold from an earlier pass no longer
                // describes this state, so it goes with it.
                this.massDelete = null;
                return new Set();
            }
            this.massDelete = { paths: deletions, approved: false };
            this.noteHeldDeletions(deletions.length, threshold);
            return new Set(this.massDelete.paths);
        }

        for (const path of deletions) {
            this.batchDeletes.add(path);
        }
        // A decision already carried out leaves no record, and holding that
        // path would be a promise the panel could not keep: only what is still
        // to be deleted is held. The count that decides is the whole window's,
        // including the batches whose deletions went through before it.
        const outstanding = [...this.batchDeletes].filter((path) => this.state.get(path) !== undefined);
        const seen = Math.max(this.batchDeletes.size, this.massDelete?.paths.length ?? 0);
        if (seen <= threshold) {
            return new Set();
        }
        // Added to the hold rather than replacing it: a later batch cannot know
        // about the deletions the earlier ones held. Only paths still to be
        // deleted stay in it — a file that came back, or whose record is gone,
        // is no longer part of the question, and holding it would keep it out
        // of every pass until the next full walk.
        const held: string[] = [];
        for (const path of new Set([...(this.massDelete?.paths ?? []), ...outstanding])) {
            if (this.state.get(path) === undefined) {
                continue;
            }
            if (await absent(path)) {
                held.push(path);
            }
        }
        if (held.length === 0) {
            this.massDelete = null;
            return new Set();
        }
        if (this.massDelete === null) {
            this.massDelete = { paths: held, approved: false };
            this.noteHeldDeletions(held.length, threshold);
        } else {
            this.massDelete.paths = held;
        }
        return new Set(this.massDelete.paths);
    }

    private noteHeldDeletions(count: number, threshold: number): void {
        this.logger.warn(
            `Holding ${count} deletion(s): more than the ${threshold} a pass removes without asking. ` +
                'Approve them in the sync panel, or keep the files on Drive.',
        );
    }

    /**
     * Carry folder deletions across once their contents have been reconciled.
     *
     * Only an emptied folder is removed. Anything still inside a folder that
     * was deleted on the other side is an edit the deletion would have
     * discarded; the reconcile has already restored it, and the folder stays
     * with it. A folder the mass-delete guard holds is left where it is; see
     * {@link holdMassDelete}.
     */
    private async cleanUpDeletedFolders(
        goneFolders: Set<string>,
        locallyDeleted: Map<string, string>,
        held: Set<string> = new Set(),
    ): Promise<void> {
        for (const path of [...goneFolders].sort((a, b) => byDepth(b, a))) {
            await this.removeLocalFolderIfEmpty(path);
        }

        for (const [path, uid] of [...locallyDeleted].sort(([a], [b]) => byDepth(b, a))) {
            if (held.has(path)) {
                continue;
            }
            try {
                if (await this.vault.exists(path)) {
                    continue;
                }
                if (await this.drive!.hasLiveChildren(uid)) {
                    continue;
                }
                await this.drive!.trashNode(uid);
                this.forgetFolder(path);
                this.logger.info(`Removed folder "${path}" from Drive, deleted locally`);
            } catch (error) {
                // One folder that cannot be removed does not fail the pass, and
                // is queued so the next one tries again rather than waiting for
                // another full walk to find it still there. It goes into the
                // folder queue as well: a retry keyed on a folder path is never
                // read back as a file, so the state retry alone would be
                // cleared without the folder being touched.
                this.pendingFolderDeletes.add(path);
                this.noteItemFailure(path, error, 'Could not remove folder');
            }
        }
    }

    /** Folders deleted in the vault since the last pass; see {@link onVaultFolderDelete}. */
    private async applyLocalFolderDeletes(): Promise<void> {
        for (const path of [...this.pendingFolderDeletes].sort((a, b) => byDepth(b, a))) {
            if (this.state.entries().some((record) => record.type === 'file' && isWithin(record.path, path))) {
                // Its files' own deletions have not reached Drive yet; they
                // arrive in a later batch, and the folder waits for them.
                continue;
            }
            try {
                if (await this.vault.exists(path)) {
                    // Back in the vault: there is nothing to remove.
                    this.pendingFolderDeletes.delete(path);
                    continue;
                }
                const uid = await this.findRemoteFolder(path);
                if (!uid) {
                    // Never reached Drive, so nothing is there to remove.
                    this.pendingFolderDeletes.delete(path);
                    continue;
                }
                if (await this.drive!.hasLiveChildren(uid)) {
                    this.logger.info(`Kept folder "${path}" on Drive: it still holds files this device has not synced`);
                    continue;
                }
                await this.drive!.trashNode(uid);
                this.forgetFolder(path);
                this.pendingFolderDeletes.delete(path);
                this.logger.info(`Removed folder "${path}" from Drive, deleted locally`);
            } catch (error) {
                // Kept pending, and queued for a retry: dropping it here left
                // the folder on Drive until the next full walk noticed it.
                this.noteItemFailure(path, error, 'Could not remove folder');
            }
        }
    }

    private async removeLocalFolderIfEmpty(path: string): Promise<void> {
        try {
            if ((await this.vault.exists(path)) && !(await this.vault.hasFiles(path))) {
                await this.vault.trash(path);
                this.logger.info(`Removed folder "${path}", deleted on another device`);
            }
        } catch (error) {
            this.logger.warn(`Could not remove folder "${path}"`, error);
        }
    }

    /** The Drive folder for a vault path, creating it and its parents if needed. */
    private async ensureRemoteFolder(path: string): Promise<string> {
        const known = this.knownFolderUid(path);
        if (known) {
            this.folderUids.set(path, known);
            return known;
        }

        const parentUid = await this.ensureRemoteFolder(parentPath(path));
        const name = basename(path);

        let uid: string;
        try {
            uid = await this.drive!.createFolder(parentUid, name);
        } catch (error) {
            // Another device may have created it between our listing and now.
            const existing = await this.findChildFolder(parentUid, name);
            if (!existing) {
                throw error;
            }
            uid = existing;
        }

        this.folderUids.set(path, uid);
        this.state.setSynced(path, uid, 'folder');
        return uid;
    }

    /** The Drive folder for a vault path if it exists, without creating anything. */
    private async findRemoteFolder(path: string): Promise<string | undefined> {
        const known = this.knownFolderUid(path);
        if (known) {
            return known;
        }
        const parentUid = await this.findRemoteFolder(parentPath(path));
        if (!parentUid) {
            return undefined;
        }
        const uid = await this.findChildFolder(parentUid, basename(path));
        if (uid) {
            this.folderUids.set(path, uid);
        }
        return uid ?? undefined;
    }

    private knownFolderUid(path: string): string | undefined {
        if (path === '') {
            return this.rootUid ?? undefined;
        }
        const known = this.folderUids.get(path);
        if (known) {
            return known;
        }
        const record = this.state.get(path);
        return record?.type === 'folder' ? record.nodeUid : undefined;
    }

    private renameKnownFolders(fromPath: string, toPath: string): void {
        for (const [path, uid] of [...this.folderUids]) {
            if (isWithin(path, fromPath)) {
                this.folderUids.delete(path);
                this.folderUids.set(replacePrefix(path, fromPath, toPath), uid);
            }
        }
    }

    /** Drop every folder uid at or below `path`, so the next upload there creates a fresh folder. */
    private forgetFolder(path: string): void {
        for (const known of [...this.folderUids.keys()]) {
            if (isWithin(known, path)) {
                this.folderUids.delete(known);
            }
        }
        for (const record of this.state.entries()) {
            if (record.type === 'folder' && isWithin(record.path, path)) {
                this.state.delete(record.path);
            }
        }
    }

    private async findChildFolder(parentUid: string, name: string): Promise<string | null> {
        for await (const child of this.drive!.iterateChildren(parentUid)) {
            if (child.name === name && child.node.type === NodeType.Folder) {
                return child.node.uid;
            }
        }
        return null;
    }

    // -- resolving remote state for a set of paths -------------------------

    /**
     * The Drive side of a set of paths, for an incremental pass.
     *
     * Recorded files are looked up by node, all in one request, which also
     * reveals renames made on another device: a node whose name or folder no
     * longer matches its record is followed to its new path before anything
     * is compared. Paths with no usable record are found by listing their
     * parent folder.
     */
    private async lookupRemote(paths: Set<string>, confirmedAbsent: Set<string>): Promise<RemoteView> {
        const drive = this.drive!;
        const view: RemoteView = { paths: new Set(), states: new Map(), skip: new Set() };
        const byName: string[] = [];
        const byUid = new Map<string, string>();

        for (const path of paths) {
            view.paths.add(path);
            const record = this.state.get(path);
            if (confirmedAbsent.has(path)) {
                view.states.set(path, undefined);
            } else if (record?.type === 'file') {
                byUid.set(record.nodeUid, path);
            } else {
                byName.push(path);
            }
        }

        let nodes = new Map<string, NodeEntity | null>();
        if (byUid.size > 0) {
            try {
                nodes = await drive.lookupNodes([...byUid.keys()]);
            } catch (error) {
                this.logger.warn('Could not look up changed files on Drive', error);
                for (const path of byUid.values()) {
                    view.skip.add(path);
                }
            }
        }

        for (const [uid, path] of byUid) {
            if (view.skip.has(path)) {
                continue;
            }
            if (!nodes.has(uid)) {
                // Not answered for, which is not the same as reported missing.
                view.skip.add(path);
                continue;
            }
            const node = nodes.get(uid);
            if (!node || node.trashTime !== undefined) {
                // Gone, but another device may have put a new file under the
                // same name, which a listing will find.
                byName.push(path);
                continue;
            }
            if (this.isAtPath(node, path)) {
                view.states.set(path, drive.toRemoteState(node));
                continue;
            }

            const location = await this.tryLocate(uid);
            switch (location?.kind) {
                case 'deleted':
                    view.states.set(path, undefined);
                    break;
                case 'outside':
                    this.logger.info(`"${path}" was moved out of the synced Drive folder; uploading it again`);
                    this.state.delete(path);
                    view.states.set(path, undefined);
                    break;
                case 'at':
                    if (location.path === path) {
                        view.states.set(path, drive.toRemoteState(node));
                    } else {
                        if (await this.followRemoteMove(path, location.path, 'file')) {
                            view.paths.delete(path);
                        } else {
                            view.states.set(path, undefined);
                        }
                        view.paths.add(location.path);
                        view.states.set(location.path, drive.toRemoteState(node));
                    }
                    break;
                default:
                    view.skip.add(path);
            }
        }

        const listed = new Map<string, Map<string, NodeEntity>>();
        for (const path of byName) {
            try {
                view.states.set(path, await this.findByName(path, listed));
            } catch (error) {
                this.logger.warn(`Could not look up "${path}" on Drive`, error);
                view.skip.add(path);
            }
        }

        return view;
    }

    /** Whether a node still sits where the vault path says: same name, same folder. */
    private isAtPath(node: NodeEntity, path: string): boolean {
        if (this.drive!.nameOf(node) !== basename(path)) {
            return false;
        }
        const expectedParent = this.knownFolderUid(parentPath(path));
        return expectedParent === undefined || node.parentUid === expectedParent;
    }

    /** Find a file on Drive by its path, listing each parent folder at most once per pass. */
    private async findByName(
        path: string,
        listedParents: Map<string, Map<string, NodeEntity>>,
    ): Promise<RemoteState | undefined> {
        const parent = parentPath(path);
        let children = listedParents.get(parent);
        if (!children) {
            const parentUid = this.knownFolderUid(parent);
            if (parentUid === undefined) {
                // The parent folder does not exist on Drive yet, so neither can
                // anything inside it.
                return undefined;
            }
            children = new Map();
            for await (const child of this.drive!.iterateChildren(parentUid)) {
                children.set(child.name, child.node);
            }
            listedParents.set(parent, children);
        }

        const node = children.get(basename(path));
        return node ? this.drive!.toRemoteState(node) : undefined;
    }

    // -- remote event polling ---------------------------------------------

    /** Read the root node just to learn its event scope. */
    private async primeEventScope(): Promise<void> {
        try {
            const root = await this.drive!.getNode(this.rootUid!);
            this.treeEventScopeId = root.treeEventScopeId;
            this.folderUids.set('', this.rootUid!);
            await this.refreshSharing(() => this.drive!.sharedWithOthers(this.rootUid!));
        } catch (error) {
            this.reportFailure('Could not read the synced folder', error);
        }
    }

    /**
     * Check Drive now instead of at the next interval: when the app returns to
     * the foreground, or the network comes back. On mobile especially, where
     * the app is suspended in the background and its timers with it, this is
     * what makes a note edited elsewhere show up on opening the app.
     */
    pollNow(): void {
        if (!this.running || this.polling || this.paused) {
            return;
        }
        this.runPoll();
    }

    /**
     * Push edits that are still waiting out the debounce. Called when the app
     * goes to the background, since a mobile OS may suspend or kill it before
     * the timer fires.
     */
    flushPendingEdits(): void {
        this.batcher.flush();
    }

    private scheduleRemotePoll(): void {
        if (!this.running || this.paused) {
            return;
        }
        this.polls.schedule();
    }

    /**
     * Whether the daily walk of the whole Drive folder is due now: a day since
     * the last one, and a quiet moment to run it in, so it never holds up a
     * sync the user is waiting for.
     *
     * Elapsed time is measured on the monotonic clock once this session has run
     * a walk of its own: `lastFullSyncAt` is wall time, and a clock set back a
     * day would otherwise hide the walk for a day longer. `now` is wall time
     * only for the case where this session has never walked.
     */
    private dailyWalkDue(now = Date.now(), mono = monotonicNow()): boolean {
        const last = this.state.getLastFullSync();
        if (last === null) {
            return false;
        }
        const lastMono = this.lastFullSyncMono;
        // Whichever clock says longer: a clock set back cannot hide a walk that
        // is due, and a walk this session ran cannot be undone by a state file
        // written earlier.
        const since = lastMono === null ? now - last : Math.max(now - last, mono - lastMono);
        if (since <= FULL_SYNC_INTERVAL_MS) {
            return false;
        }
        return this.polls.quietFor(mono) > IDLE_WALK_AFTER_MS || (this.environment.isHidden?.() ?? false);
    }

    /** Seconds until the next check of Drive; see {@link PollScheduler}. */
    pollIntervalSeconds(now = monotonicNow()): number {
        return this.polls.interval(now);
    }

    private runPoll(): void {
        this.polls.cancel();
        this.polling = true;
        void this.enqueue(async () => {
            if (this.deferredFullSync || this.dailyWalkDue()) {
                await this.fullSync();
                return;
            }
            await this.pollRemoteEvents();
            await this.pollConfigFolder();
        }).finally(() => {
            this.polling = false;
            this.scheduleRemotePoll();
        });
    }

    /**
     * Ask Drive what changed since the last event that was processed.
     *
     * Event-based rather than a repeated tree walk, which Proton's guidelines
     * for third-party clients require: a recursive listing on a timer is the
     * behaviour that gets an account rate-limited.
     */
    private async pollRemoteEvents(): Promise<void> {
        const drive = this.drive;
        const scopeId = this.treeEventScopeId;
        if (!drive || !this.running || !this.settings.autoSync) {
            return;
        }
        const generation = this.generation;
        if (this.folderMissing !== null && !this.networkHeld()) {
            await this.recheckMissingFolder();
            return;
        }
        if (!scopeId) {
            return;
        }
        if (this.networkHeld()) {
            // The cursor stays put, so these events are read once allowed.
            this.setStatus('waiting-for-wifi');
            return;
        }
        if (this.status === 'waiting-for-wifi') {
            this.setStatus('idle');
        }

        const cursor = this.state.getEventCursor(scopeId);
        const events: NodeChange[] = [];
        let lastEventId: string | null = null;
        let needsFullSync = false;
        let readError: unknown = null;

        try {
            for await (const event of drive.iterateEvents(scopeId, cursor ?? undefined, this.abortController?.signal)) {
                if (
                    event.type === DriveEventType.NodeCreated ||
                    event.type === DriveEventType.NodeUpdated ||
                    event.type === DriveEventType.NodeDeleted
                ) {
                    events.push({ nodeUid: event.nodeUid, parentNodeUid: event.parentNodeUid });
                } else if (event.type === DriveEventType.TreeRefresh) {
                    // Drive can no longer replay from the cursor. The only
                    // way back to a known-good state is a full comparison.
                    needsFullSync = true;
                }
                // `FastForward` needs nothing but the cursor it carries: Drive
                // sends it for a first poll and when nothing happened.
                lastEventId = event.eventId;
            }
        } catch (error) {
            // Events read before the failure are still good; handle them and
            // resume from the last one next time.
            readError = error;
        }

        // The folder itself moved to the trash or was deleted: stop here, with
        // the cursor where it was, rather than handle its contents as gone.
        if (readError === null && events.some((event) => event.nodeUid === this.rootUid)) {
            try {
                if ((await this.rootNode()) === null) {
                    await this.state.flush();
                    return;
                }
            } catch (error) {
                readError = error;
            }
        }

        // A full sync asked for by Drive, or a change that could not be looked
        // up, is not settled until it has run: the cursor stays where it was,
        // so the next poll reads the same events again, even after a restart.
        const settled = needsFullSync ? await this.fullSync() : await this.applyRemoteEvents(events);
        if (this.stale(generation)) {
            // Stopped while this ran: its cursor and its state belong to a run
            // that is over.
            return;
        }
        // Only now: a cursor saved before its events were handled would skip
        // them for good if the app closed in between.
        if (lastEventId !== null && settled) {
            this.state.setEventCursor(scopeId, lastEventId);
        }
        if (readError !== null) {
            this.reportFailure('Could not read Drive events', readError);
        } else if (this.status === 'idle' && settled) {
            // Drive was checked and all it had is in: synced as of now, even
            // when nothing changed. Without this a quiet vault would read as
            // not synced for hours, however often Drive is checked.
            this.lastSyncedAt = Date.now();
            this.report();
        }
        await this.state.flush();
    }

    /**
     * Sync what a batch of Drive events changed. Resolves false when a change
     * could not be looked up, so that the batch is read again on the next poll.
     */
    private async applyRemoteEvents(changes: NodeChange[]): Promise<boolean> {
        // A poll is a window of its own: the deletions it reports are counted
        // together, and the count starts over with the next poll. See
        // {@link batchDeletes}.
        this.batchDeletes.clear();
        const paths = new Set(this.state.dueRetries());
        const confirmedAbsent = new Set<string>();
        /** Files whose fate could not be established: left alone, and retried. */
        const skip = new Set<string>();
        const goneFolders: string[] = [];
        let settled = true;

        // The device list's files are not the vault's: passed on, not synced.
        const events = changes.filter((event) => !(this.devices?.takeChange(event) ?? false));
        if (events.length < changes.length) {
            this.hooks.onDevicesChanged?.();
        }

        const nodeUids = [...new Set(events.map((event) => event.nodeUid))];
        // Folders before files: a folder renamed or trashed on Drive changes
        // the path of everything recorded inside it.
        const folderEvents = nodeUids
            .map((uid) => this.state.getByNodeUid(uid))
            .filter((record) => record?.type === 'folder')
            .sort((a, b) => byDepth(a!.path, b!.path))
            .map((record) => record!.nodeUid);
        for (const uid of folderEvents) {
            await this.followRemoteFolder(uid, paths, confirmedAbsent, skip, goneFolders);
        }

        for (const event of events) {
            if (folderEvents.includes(event.nodeUid)) {
                continue;
            }
            const path = await this.pathForEvent(event);
            if (path === undefined) {
                settled = false;
                continue;
            }
            if (path !== null && path !== '' && !this.filter.isExcludedWithAncestors(path)) {
                paths.add(path);
            }
        }

        if (paths.size > 0) {
            this.logger.debug(`${paths.size} path(s) changed on Drive`);
            this.polls.noteActivity();
            await this.processPaths(paths, confirmedAbsent, skip);
        }
        for (const path of goneFolders.sort((a, b) => byDepth(b, a))) {
            await this.removeLocalFolderIfEmpty(path);
        }
        return settled;
    }

    /** React to an event on a recorded folder: follow a rename, or take in a deletion. */
    private async followRemoteFolder(
        uid: string,
        paths: Set<string>,
        confirmedAbsent: Set<string>,
        skip: Set<string>,
        goneFolders: string[],
    ): Promise<void> {
        const record = this.state.getByNodeUid(uid);
        if (!record) {
            return;
        }
        const filesWithin = (folder: string) =>
            this.state.entries().filter((entry) => entry.type === 'file' && isWithin(entry.path, folder));

        const location = await this.tryLocate(uid);
        switch (location?.kind) {
            case 'deleted':
                for (const file of await this.childrenGoneWith([record.path], filesWithin(record.path))) {
                    if (file.gone) {
                        confirmedAbsent.add(file.path);
                    } else {
                        skip.add(file.path);
                    }
                    paths.add(file.path);
                }
                this.forgetFolder(record.path);
                goneFolders.push(record.path);
                return;
            case 'outside':
                // Moved out of the synced folder: its files are no longer on
                // Drive as far as this vault is concerned. They are detached,
                // so they go up again into a fresh folder rather than as new
                // revisions into one nobody syncs.
                this.logger.info(`Folder "${record.path}" was moved out of the synced Drive folder; uploading it again`);
                for (const file of filesWithin(record.path)) {
                    this.state.delete(file.path);
                    paths.add(file.path);
                }
                this.forgetFolder(record.path);
                return;
            case 'at':
                if (location.path !== record.path && (await this.followRemoteMove(record.path, location.path, 'folder'))) {
                    for (const file of filesWithin(location.path)) {
                        paths.add(file.path);
                    }
                }
                return;
            default:
                // Could not be located this time; try again on the next poll.
                for (const file of filesWithin(record.path)) {
                    this.state.retry(file.path);
                }
        }
    }

    /**
     * Which of a trashed folder's recorded files went to the trash with it.
     *
     * The trash takes a folder's contents, but not always all of them: a file
     * moved out a moment before the folder was trashed is still there, under
     * another folder, and is not this device's to delete. One batched lookup
     * settles it — a child still under one of the folders, or itself in the
     * trash, is gone; one that has moved elsewhere is not, and is left alone
     * until its own event says what happened. A lookup that fails settles
     * nothing: absence is never inferred from it.
     *
     * `folderPaths` is the folders the trash took. The full walk passes every
     * one it confirmed deleted, so their children are settled at once; the
     * incremental path passes the one folder whose event it read. Folders
     * recorded inside them went with the trash as well, and their uids count
     * too, or a file in a subfolder would be taken for one that moved out.
     */
    private async childrenGoneWith(
        folderPaths: string[],
        children: { path: string; nodeUid: string }[],
    ): Promise<{ path: string; gone: boolean }[]> {
        if (children.length === 0) {
            return [];
        }
        const folderUids = new Set(
            this.state
                .entries()
                .filter(
                    (record) =>
                        record.type === 'folder' && folderPaths.some((folder) => isWithin(record.path, folder)),
                )
                .map((record) => record.nodeUid),
        );
        let found: Map<string, NodeEntity | null>;
        try {
            found = await this.drive!.lookupNodes(children.map((child) => child.nodeUid));
        } catch (error) {
            this.logger.warn(
                `Could not check what the trash took with ${folderPaths.map((path) => `"${path}"`).join(', ')}`,
                error,
            );
            return children.map((child) => ({ path: child.path, gone: false }));
        }
        return children.map((child) => {
            if (!found.has(child.nodeUid)) {
                // Not answered for, which is not the same as gone.
                return { path: child.path, gone: false };
            }
            const node = found.get(child.nodeUid) ?? null;
            // Gone for good, in the trash itself, or still under one of the
            // folders that took it there.
            const gone = node === null || node.trashTime !== undefined || folderUids.has(node.parentUid ?? '');
            return { path: child.path, gone };
        });
    }

    /**
     * The vault path an event is about, or null when it concerns nothing here.
     *
     * The event feed covers the whole Drive volume, not just the synced
     * folder, so a busy Drive elsewhere - a photo backup, say - produces a
     * steady stream of events for unrelated nodes. Those are recognised by
     * their parent and dropped without a request. A new folder inside the
     * synced one is recorded as soon as it is seen, so that the events for
     * its contents, which come after it, are recognised in turn.
     */
    /**
     * The vault path an event is about: null when there is nothing to
     * reconcile, and undefined when Drive could not be asked, which is not the
     * same as being told the node is gone.
     */
    private async pathForEvent(event: NodeChange): Promise<string | null | undefined> {
        const known = this.state.getByNodeUid(event.nodeUid);
        if (known) {
            return known.path;
        }
        if (event.parentNodeUid !== undefined && !this.isKnownFolderUid(event.parentNodeUid)) {
            return null;
        }
        const location = await this.tryLocate(event.nodeUid);
        if (location === null) {
            this.logger.warn('Could not look up a change on Drive; trying again on the next check');
            return undefined;
        }
        if (location.kind !== 'at' || location.path === '') {
            // Deleted before we asked, or outside the synced folder. Either
            // way there is nothing to reconcile.
            return null;
        }
        if (location.node.type === NodeType.Folder) {
            // A new folder spelled like an existing one but for letter case,
            // or in other Unicode characters, would land inside it here; give
            // it a name of its own first.
            const path = await this.cases.resolve(location.path, this.cases.claimants([]));
            if (vaultSpelling(path) !== path) {
                // Could not be renamed; made here, it would be another folder's twin.
                return null;
            }
            if (!this.filter.isExcludedWithAncestors(path)) {
                await this.vault.ensureFolder(path);
                this.folderUids.set(path, location.node.uid);
                this.state.setSynced(path, location.node.uid, 'folder');
            } else if (location.path === DEVICES_FOLDER && this.devices) {
                // Another device has just started the vault's device list.
                this.devices.knowFolder(location.node.uid);
                this.hooks.onDevicesChanged?.();
            }
            return null;
        }
        return location.path;
    }

    private isKnownFolderUid(uid: string): boolean {
        if (uid === this.rootUid) {
            return true;
        }
        const record = this.state.getByNodeUid(uid);
        return record?.type === 'folder' || [...this.folderUids.values()].includes(uid);
    }

    /**
     * Pick up changes in the config folder.
     *
     * Obsidian raises no vault events for its own config folder, so a changed
     * theme or a newly installed plugin would otherwise wait for the next full
     * sync. Cheap: only size and mtime are compared against the last sync,
     * and nothing is read unless one of them moved.
     *
     * Not on every poll, though. Walking `.obsidian` means listing every
     * folder under it, plugins included, and a poll comes every thirty
     * seconds; on a phone that is the most expensive thing the sync does in a
     * quiet vault. A walk that found nothing doubles the wait before the next,
     * up to {@link CONFIG_SCAN_MAX_MS}, and any change puts it back to
     * {@link CONFIG_SCAN_MIN_MS}.
     */
    private async pollConfigFolder(): Promise<void> {
        const { configDir } = this.scope;
        if (!this.running || !this.settings.autoSync || this.filter.isExcludedWithAncestors(configDir)) {
            return;
        }
        const now = monotonicNow();
        if (this.configScanAt !== null && now - this.configScanAt < this.configScanGap) {
            return;
        }
        this.configScanAt = now;

        const changed = new Set<string>();
        try {
            const listing = await this.vault.list((path) => !this.filter.isExcluded(path), configDir);
            const present = new Set<string>();
            for (const path of listing.files) {
                if (this.filter.isExcludedWithAncestors(path) || this.vault.isSelfWrite(path)) {
                    continue;
                }
                present.add(path);
                const base = this.state.get(path)?.base;
                const stat = await this.vault.stat(path);
                if (stat && (!base || base.size !== stat.size || base.localMtime !== stat.mtime)) {
                    changed.add(path);
                }
            }
            for (const record of this.state.entries()) {
                if (
                    record.type === 'file' &&
                    isWithin(record.path, configDir) &&
                    !present.has(record.path) &&
                    !this.filter.isExcludedWithAncestors(record.path)
                ) {
                    changed.add(record.path);
                }
            }
        } catch (error) {
            this.logger.debug('Could not scan the config folder', error);
            return;
        }

        this.configScanGap =
            changed.size > 0 ? CONFIG_SCAN_MIN_MS : Math.min(this.configScanGap * 2, CONFIG_SCAN_MAX_MS);
        if (changed.size > 0) {
            this.logger.debug(`${changed.size} config file(s) changed`);
            await this.processPaths(changed);
        }
    }

    // -- plumbing ----------------------------------------------------------

    private createFilter(settings: PluginSettings): PathFilter {
        return new PathFilter(
            settings.excludePatterns,
            settings.syncObsidianConfig,
            this.scope.configDir,
            this.scope.pluginDir,
            this.folderShared,
            this.environment.caseInsensitive === true,
        );
    }

    /**
     * Ask Drive whether the folder is shared, and narrow or widen the filter
     * to match. Runs with every full sync, so a folder shared after it was
     * chosen is caught on the next one. A failed check keeps the folder
     * treated as shared: that only holds back plugin files for a pass, while
     * the opposite mistake could run a collaborator's code.
     */
    private async refreshSharing(check: () => Promise<boolean>): Promise<void> {
        let shared = true;
        try {
            shared = await check();
        } catch (error) {
            this.logger.warn(`Could not check whether the synced folder is shared; treating it as shared: ${String(error)}`);
        }
        if (shared !== this.folderShared) {
            this.folderShared = shared;
            this.filter = this.createFilter(this.settings);
        }
    }

    private createResolver(
        drive: DriveIO,
        policy: ConflictPolicy,
        overrides: { keepConflictCopies?: boolean; keepLosingSide?: boolean } = {},
    ): ConflictResolver {
        return new ConflictResolver(
            drive,
            {
                policy,
                deviceName: this.settings.deviceName,
                keepConflictCopies: overrides.keepConflictCopies ?? this.settings.keepConflictCopies,
                keepLosingSide: overrides.keepLosingSide ?? true,
            },
            this.logger.getLogger('conflicts'),
        );
    }

    /**
     * The user's policy for notes; a fixed one for the config folder.
     *
     * Conflict copies are the right answer for notes and the wrong one for
     * settings: Obsidian would never read `app (conflict ….json`, and a
     * plugin folder full of them is clutter nobody asked for. A config file
     * that appeared on both sides is almost always a new device joining with
     * its default settings, so Drive's established copy wins; one edited on
     * both sides takes the most recent edit.
     */
    private resolverFor(path: string, reason: ConflictReason): ConflictResolver {
        const override = this.policyOverrides.get(path);
        if (override) {
            return this.createResolver(this.drive!, override);
        }
        if (!this.filter.isConfigPath(path)) {
            return this.resolver!;
        }
        return this.createResolver(this.drive!, reason === 'both-created' ? 'prefer-remote' : 'prefer-newest', {
            keepConflictCopies: false,
            keepLosingSide: false,
        });
    }

    /** The smallest size limit in force on this device, in bytes; Infinity for none. */
    private sizeLimitBytes(): number {
        const limits = [this.settings.maxFileSizeMb];
        if (this.environment.isMobile) {
            limits.push(this.settings.mobileMaxFileSizeMb);
        }
        const active = limits.filter((mb) => mb > 0);
        return active.length === 0 ? Infinity : Math.min(...active) * 1024 * 1024;
    }

    /** Whether the "Wi-Fi only" setting is holding the sync right now. */
    private networkHeld(): boolean {
        return this.settings.wifiOnly && this.environment.isMobile && this.environment.isMetered();
    }

    /** Hold local settings changes and ask for a reload, if the first sync took settings from Drive. */
    private announceAdoptedSettings(): void {
        const adopted = this.adoptingSettings ?? [];
        this.adoptingSettings = null;
        if (adopted.length === 0) {
            return;
        }
        this.settingsHeld = true;
        this.logger.info(
            `Took ${adopted.length} settings file(s) from Drive; settings changes here are held until Obsidian reloads`,
        );
        this.hooks.onSettingsAdopted?.(adopted.sort((a, b) => a.localeCompare(b)));
    }

    /**
     * Make sure a downloaded list of enabled plugins still includes this one.
     *
     * Obsidian decides which plugins to load from `community-plugins.json`.
     * Taking Drive's copy wholesale, as a joining device does, would switch
     * this plugin off at the next reload whenever that copy lacks it (written
     * before it was installed, say), and with it the sync. Adding it back only
     * ever keeps it on; the corrected list is uploaded by the next pass like
     * any local edit, so Drive's copy stops lacking it.
     */
    private async keepSelfEnabled(path: string): Promise<void> {
        const id = this.scope.pluginId;
        if (!id) {
            return;
        }
        let enabled: unknown;
        try {
            enabled = JSON.parse(await this.vault.readText(path));
        } catch (error) {
            this.logger.warn(`Could not read "${path}" to check this plugin is still enabled`, error);
            return;
        }
        if (!Array.isArray(enabled) || enabled.includes(id)) {
            return;
        }
        enabled.push(id);
        await this.vault.writeBinary(path, new TextEncoder().encode(JSON.stringify(enabled, null, 2)).buffer);
        this.logger.warn(`Drive's list of enabled plugins did not include this one; added it back so syncing stays on`);
    }

    /**
     * Tell the user about a conflict, unless it was in the config folder.
     *
     * Settings files are settled by a fixed rule, Drive's copy when a device
     * joins and the newest edit otherwise, and never leave a copy to look at.
     * A notice for them only reads as something having gone wrong: on a new
     * device every default settings file would be listed as a conflict.
     */
    private reportConflict(event: ConflictEvent): void {
        if (this.filter.isConfigPath(event.path)) {
            this.logger.info(`Settings file "${event.path}" differed on both sides (${event.reason}): ${event.outcome}`);
            return;
        }
        this.hooks.onConflict(event);
    }

    /** Transfers allowed at once right now. */
    currentTransferLimit(): number {
        return this.pace.current();
    }

    /**
     * Serialises passes so two of them cannot interleave on the same path.
     *
     * The run a task belongs to is captured here, at the moment it is queued:
     * a pass queued before a stop would otherwise start after it, capture the
     * new generation from inside {@link fullSync}, and write to Drive for an
     * engine that no longer exists.
     */
    private enqueue(task: () => Promise<void>): Promise<void> {
        const generation = this.generation;
        const running = this.running;
        this.queue = this.queue
            .catch(() => undefined)
            .then(() => {
                if (!running || !this.running || generation !== this.generation) {
                    // Queued for a run that is over, or not started yet. There
                    // is nothing to do, and nothing to report.
                    return;
                }
                return task();
            });
        return this.queue;
    }

    /**
     * The synced folder, or null when it is missing: in Drive's trash, deleted
     * for good, or no longer shared with this account. A missing folder stops
     * the sync until it is back, rather than every path failing on its own,
     * uploads landing in the trash, or the same error repeating each poll.
     * A failed lookup throws, as before.
     *
     * The SDK answers from its cache until Drive's events say otherwise, so a
     * folder trashed while Obsidian was closed can look present until the
     * events are read; the event for the folder itself brings it here.
     */
    private async rootNode(): Promise<NodeEntity | null> {
        const rootUid = this.rootUid!;
        const found = await this.drive!.lookupNodes([rootUid]);
        if (!found.has(rootUid)) {
            throw new Error('Drive did not answer for the synced folder');
        }
        const node = found.get(rootUid) ?? null;
        if (node === null || node.trashTime !== undefined) {
            this.markFolderMissing(node === null ? 'gone' : 'trashed', node?.treeEventScopeId);
            return null;
        }
        if (this.folderMissing !== null) {
            this.logger.info('The synced Drive folder is back; syncing again');
            this.folderMissing = null;
            this.lastError = null;
        }
        return node;
    }

    private markFolderMissing(kind: 'trashed' | 'gone', scopeId?: string): void {
        if (scopeId !== undefined) {
            // Kept so its events can still be read, which is how a folder
            // restored from the trash is noticed; see recheckMissingFolder.
            this.treeEventScopeId = scopeId;
        }
        const message =
            kind === 'trashed'
                ? 'The Drive folder this vault syncs with is in the trash on Proton Drive'
                : 'The Drive folder this vault syncs with no longer exists, or is no longer shared with you';
        if (this.folderMissing !== kind) {
            this.logger.warn(`${message}; nothing syncs until it is restored or another folder is chosen`);
        }
        this.folderMissing = kind;
        this.lastError = message;
        this.setStatus('folder-missing');
    }

    /**
     * While the synced folder is missing: read Drive's events, which is what
     * brings the SDK's copy of the folder up to date, and look again. A folder
     * restored from the trash gets a full sync, which also picks up anything
     * changed here in the meantime. The events are only read, not applied, and
     * the cursor stays put.
     */
    private async recheckMissingFolder(): Promise<void> {
        const drive = this.drive!;
        const scopeId = this.treeEventScopeId;
        try {
            if (scopeId !== null) {
                const cursor = this.state.getEventCursor(scopeId) ?? undefined;
                for await (const event of drive.iterateEvents(scopeId, cursor, this.abortController?.signal)) {
                    void event;
                }
            }
            if ((await this.rootNode()) !== null) {
                await this.fullSync();
            }
        } catch (error) {
            this.logger.debug('Could not check on the missing Drive folder', error);
        }
    }

    private reportFailure(message: string, error: unknown): void {
        this.logger.error(message, error);
        this.lastError = errorMessage(error);
        this.setStatus(isOffline(error) ? 'offline' : 'error');
    }

    private setStatus(status: SyncStatus): void {
        if (this.folderMissing !== null) {
            // Nothing else is true until the folder is back or replaced.
            status = 'folder-missing';
        }
        this.status = status === 'idle' && this.paused ? 'paused' : status;
        this.report();
    }

    /**
     * Report the summary, unless it is the one already reported.
     *
     * The panel rebuilds on every report, and the engine reports on every
     * progress tick. Skipping the ones that would render exactly what is
     * already there keeps that work off the UI thread, which is what the panel
     * and the note indicators cost on a phone.
     */
    private report(): void {
        const summary = this.getSummary();
        const key = JSON.stringify(summary);
        if (key === this.reported) {
            return;
        }
        this.reported = key;
        this.hooks.onChange(summary);
    }

    /** Whether a pass that captured `generation` has outlived its engine; see {@link generation}. */
    private stale(generation: number): boolean {
        return generation !== this.generation;
    }

    /**
     * Note that one path failed this pass, without failing the rest of it.
     *
     * A file locked by another program on Windows — EBUSY on a rename — used to
     * fail the whole full sync at the same point on every attempt, leaving
     * everything after it unsynced. Now it is recorded for a retry and the pass
     * goes on; see {@link itemFailures}.
     */
    private noteItemFailure(path: string, error: unknown, what: string): void {
        this.logger.warn(`${what} "${path}"`, error);
        this.failureReasons.set(path, errorMessage(error));
        this.itemFailures.add(path);
        this.state.retry(path);
    }

    // -- read-only views for the UI ----------------------------------------

    /** What a first sync against `rootUid` would do, without doing any of it; see {@link planFirstSync}. */
    async plan(client: ProtonDriveClient, rootUid: string): Promise<SyncPlan> {
        // The preview runs before the engine starts; it needs the same
        // answer on sharing that the sync itself will use.
        await this.refreshSharing(() => sharedWithOthers(client, rootUid));
        return planFirstSync(
            {
                logger: this.logger,
                filter: () => this.filter,
                vault: this.vault,
                state: this.state,
                plannedLocal: this.plannedLocal,
                sizeLimitBytes: () => this.sizeLimitBytes(),
            },
            client,
            rootUid,
        );
    }

    /**
     * A note's versions in Drive's revision history, newest first, at most
     * {@link MAX_NOTE_VERSIONS}. Null when the note is not on Drive yet.
     */
    async noteVersions(path: string): Promise<NoteVersion[] | null> {
        const drive = this.drive;
        if (!drive) {
            throw new Error('Not connected to Proton Drive');
        }
        const record = this.state.get(path);
        if (record?.type !== 'file') {
            return null;
        }
        const revisions = await drive.listRevisions(record.nodeUid);
        return revisions.slice(0, MAX_NOTE_VERSIONS).map((revision, index) => ({
            uid: revision.uid,
            created: revision.creationTime.getTime(),
            ...(revision.claimedSize !== undefined && { size: revision.claimedSize }),
            // Older clients' listings may not say which is active; the newest is.
            active: revision.state === undefined ? index === 0 : revision.state === RevisionState.Active,
        }));
    }

    /** A note's public link on Drive, if it has one. */
    async noteShareLink(path: string): Promise<ShareLink | null> {
        return this.connectedDrive().shareLink(this.nodeUidOf(path));
    }

    /** Give a note a public link, read-only, optionally with a password and an expiry. */
    async createNoteShareLink(path: string, options: { password?: string; expiration?: Date }): Promise<ShareLink> {
        return this.connectedDrive().createShareLink(this.nodeUidOf(path), options);
    }

    /** Remove a note's public link. */
    async removeNoteShareLink(path: string): Promise<void> {
        await this.connectedDrive().removeShareLink(this.nodeUidOf(path));
    }

    /**
     * The Drive node uid of a synced path, or null when it is not on Drive
     * yet. The export flow polls this until the engine has uploaded the PDF.
     */
    nodeUidFor(path: string): string | null {
        const record = this.state.get(path);
        return record?.type === 'file' ? record.nodeUid : null;
    }

    /**
     * Remove a public link by node uid. Used for exports whose vault path may
     * already be gone, where resolving through the path no longer works.
     */
    async removeShareLinkByNodeUid(nodeUid: string): Promise<void> {
        await this.connectedDrive().removeShareLink(nodeUid);
    }

    /**
     * Files of this vault in Drive's trash, most recently deleted first, at
     * most {@link MAX_DELETED_LISTED}. The trash covers the whole account, so
     * an item is listed only when its folder can be placed in the vault: the
     * synced folder itself, a folder this device has a record of, or a trashed
     * folder that can in turn be placed.
     */
    async recentlyDeleted(): Promise<DeletedItem[]> {
        const drive = this.connectedDrive();
        const trashed = await drive.listTrashed();
        const byUid = new Map(trashed.map((node) => [node.uid, node]));
        const folderPath = (uid: string): string | null => {
            if (uid === this.rootUid) {
                return '';
            }
            const record = this.state.getByNodeUid(uid);
            if (record?.type === 'folder') {
                return record.path;
            }
            return [...this.folderUids].find(([, known]) => known === uid)?.[0] ?? null;
        };
        const pathOf = (node: NodeEntity, depth = 0): string | null => {
            const name = drive.nameOf(node);
            if (name === undefined || node.parentUid === undefined || depth > 32) {
                return null;
            }
            const known = folderPath(node.parentUid);
            if (known !== null) {
                return joinPath(known, name);
            }
            const trashedParent = byUid.get(node.parentUid);
            const parent = trashedParent ? pathOf(trashedParent, depth + 1) : null;
            return parent === null ? null : joinPath(parent, name);
        };

        const items: DeletedItem[] = [];
        for (const node of trashed) {
            if (node.type !== NodeType.File || node.trashTime === undefined) {
                continue;
            }
            const path = pathOf(node);
            if (path === null || this.filter.isExcludedWithAncestors(path)) {
                continue;
            }
            // A file inside a trashed folder comes back with that folder.
            const chain = [node];
            for (let parent = byUid.get(node.parentUid ?? ''); parent; parent = byUid.get(parent.parentUid ?? '')) {
                chain.unshift(parent);
            }
            const top = chain[0];
            const size = node.activeRevision?.claimedSize;
            items.push({
                uid: node.uid,
                path,
                deleted: node.trashTime.getTime(),
                ...(size !== undefined && { size }),
                restoreUids: chain.map((each) => each.uid),
                ...(top !== node && { withFolder: pathOf(top) ?? undefined }),
            });
        }
        // Drive lists a trashed folder, not each file in it, when the folder
        // went to the trash as a whole (from Proton's apps, say). Such a folder
        // is listed for itself, so its notes are not missing from the list.
        const restoring = new Set(items.map((item) => item.restoreUids[0]));
        for (const node of trashed) {
            const parentTrashed = node.parentUid !== undefined && byUid.has(node.parentUid);
            if (node.type !== NodeType.Folder || node.trashTime === undefined || parentTrashed || restoring.has(node.uid)) {
                continue;
            }
            const path = pathOf(node);
            if (path === null || this.filter.isExcludedWithAncestors(path)) {
                continue;
            }
            items.push({ uid: node.uid, path, deleted: node.trashTime.getTime(), restoreUids: [node.uid], isFolder: true });
        }
        return items.sort((a, b) => b.deleted - a.deleted).slice(0, MAX_DELETED_LISTED);
    }

    /** Take an item out of Drive's trash; the next check brings it back into the vault. */
    async restoreDeleted(item: DeletedItem): Promise<void> {
        await this.connectedDrive().restoreNodes(item.restoreUids);
        this.logger.info(`Restored "${item.path}" from Drive's trash`);
        this.pollNow();
    }

    private connectedDrive(): DriveIO {
        if (!this.drive) {
            throw new Error('Not connected to Proton Drive');
        }
        return this.drive;
    }

    /** The Drive node of a synced file. */
    private nodeUidOf(path: string): string {
        const record = this.state.get(path);
        if (record?.type !== 'file') {
            throw new Error('This note is not on Proton Drive yet; wait for it to sync');
        }
        return record.nodeUid;
    }

    /** The content of one version from {@link noteVersions}. */
    async readVersion(revisionUid: string): Promise<ArrayBuffer> {
        if (!this.drive) {
            throw new Error('Not connected to Proton Drive');
        }
        return this.drive.downloadRevision(revisionUid);
    }

    /**
     * Identifies what a note's history listing depends on: the note, and the
     * revision its last sync recorded. When that changes, the listing is stale.
     */
    versionsKey(path: string): string {
        return `${path}@${this.state.get(path)?.base?.remoteRevisionUid ?? ''}`;
    }

    /**
     * The Drive version of a file, for comparing it with the local one. Null
     * when there is no such file on Drive.
     */
    async readRemoteVersion(path: string, maxBytes: number): Promise<ArrayBuffer | null> {
        const drive = this.drive;
        if (!drive) {
            throw new Error('Not connected to Proton Drive');
        }
        const record = this.state.get(path);
        let remote: RemoteState | undefined;
        if (record?.type === 'file') {
            const node = await drive.getNode(record.nodeUid);
            remote = node.trashTime === undefined ? drive.toRemoteState(node) : undefined;
        }
        remote ??= await this.findByName(path, new Map());
        if (!remote) {
            return null;
        }
        if (remote.size !== undefined && remote.size > maxBytes) {
            throw new Error(`The Drive version is too large to compare (${megabytes(remote.size)} MB)`);
        }
        return drive.downloadFile(remote.nodeUid);
    }
}
