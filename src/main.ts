// Must be first: the SDK and its crypto reach for runtime APIs that older
// Electron builds lack, and they fail deep inside a transfer rather than at
// load time.
import './polyfills';

import { getRuntime } from './runtime';
import {
    apiVersion,
    type App,
    Component,
    MarkdownRenderer,
    MarkdownView,
    Notice,
    Platform,
    Plugin,
    setIcon,
    setTooltip,
    TAbstractFile,
    TFile,
    TFolder,
} from 'obsidian';

import { Credentials } from './proton/credentials';
import { PIN_ITERATIONS, PinProtectedSlot, RememberedUnlock } from './proton/pinLock';
import { ConflictHistory } from './sync/conflictHistory';
import {
    decryptLegacySession,
    encryptedStorage,
    migrateSecret,
    ObsidianSecretSlot,
    SafeStorageFileSlot,
    type SecretSlot,
} from './proton/secretStore';
import { ProtonSession } from './proton/session';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings';
import { FolderPickerModal, type ChosenFolder } from './ui/folderPickerModal';
import { DeviceList, DeviceRegistry, nextRequestAt, type DeviceRequest, type FolderMemory } from './sync/devices';
import { DriveIO, sharedWithOthers } from './sync/drive';
import { SyncEngine, type ConflictEvent, type OpenEditor, type SyncPlan, type SyncSummary } from './sync/engine';
import { errorMessage } from './sync/engine/helpers';
import {
    buildExportedShare,
    EXPORT_JANITOR_INTERVAL_MS,
    EXPORT_NODE_POLL_MS,
    EXPORT_NODE_WAIT_MS,
    isExportPath,
    janitorEntryPlan,
    normalizeExportFolder,
    resolveExportPath,
    sanitizeExportedShares,
    exportPdfName,
    sanitizeExportHtml,
    selectExpiredShares,
    selectJanitorDeletions,
    shareExpiration,
    upsertExportedShare,
} from './sync/pdfShare';
import { SyncState } from './sync/state';
import { formatLogEntries, Logger, setLogShowsNames } from './util/logger';
import { ActivityWatch } from './ui/activity';
import { compareConflictCopyOf, compareWithConflictCopy, conflictPairsFor, versionComparison } from './ui/compare';
import { showConflictNotice } from './ui/conflictNotice';
import { ConflictsModal } from './ui/conflictsModal';
import { DeviceRemovedModal, DevicesModal } from './ui/devicesModal';
import { FirstSyncModal } from './ui/firstSyncModal';
import { MassDeleteModal } from './ui/massDeleteModal';
import { openVaultFile } from './ui/openFile';
import { PinFormModal, UnlockModal } from './ui/pinModals';
import { ReloadModal } from './ui/reloadModal';
import { CONFLICT_POLICIES, ProtonDriveSyncSettingsTab } from './ui/settingsTab';
import { ExportPdfModal, SharedPdfsModal, ShareLinkModal } from './ui/exportModal';
import { SetupModal } from './ui/setupModal';
import { ShareModal } from './ui/shareModal';
import { StatusBar } from './ui/statusBar';
import { SYNC_PANEL_VIEW, SyncPanelView } from './ui/syncPanel';
import {
    type NoteIndicator,
    noteIndicator,
    statusIcon,
    statusLabel,
    statusSpins,
    syncNowResult,
} from './ui/syncStatus';

/** The plugin's own handles; see runtime.ts for why they are not on the instance. */
const runtime = getRuntime();

/** Where 0.1.0 kept the session; migrated into secret storage on first load. */
const LEGACY_SESSION_FILE = 'session.json';
const STATE_FILE = 'sync-state.json';
/** The session, encrypted by the OS keystore; never in the vault's plain sight or in secret storage. */
const SESSION_SECRET_FILE = 'session.bin';
/** The PIN-unlock material, same treatment. */
const UNLOCK_SECRET_FILE = 'unlock.bin';
const CONFLICT_HISTORY_FILE = 'conflict-history.json';
/** Local-storage key for the installation id; see {@link ProtonDriveSyncPlugin.installationId}. */
const CLIENT_UID_KEY = 'proton-sdk-sync-client-uid';
/**
 * Local-storage key for the last request from the device list this device
 * acted on; see {@link DeviceList}. Kept with the installation id rather than
 * in the settings, which another sync tool might copy to a different device.
 */
const HANDLED_REQUEST_KEY = 'proton-sdk-sync-device-request-handled';
/** Where the device list's folder was found, so a start need not search the synced folder for it. */
const DEVICES_FOLDER_KEY = 'proton-sdk-sync-devices-folder';

/** Conflicts found within this long of each other share one notice. */
const CONFLICT_NOTICE_DELAY_MS = 1500;

/** How often the status bar's "synced 5m ago" is brought up to date. */
const STATUS_REFRESH_MS = 30_000;

/**
 * How often a paused device checks the device list for a request, such as
 * being resumed. Paused, it reads none of Drive's changes, which is how it
 * learns of one otherwise; a couple of small reads every two minutes is all
 * this costs, and only while paused.
 */
const PAUSED_REQUEST_CHECK_MS = 2 * 60_000;

/** How often the PIN's time limit is checked while Obsidian is open. */
const LOCK_CHECK_MS = 15_000;
/** How often, at most, a remembered unlock's expiry is pushed back while Obsidian is in use. */
const REMEMBER_SAVE_MS = 60_000;

/**
 * The Network Information API, where the WebView has it: Android does, iOS
 * does not. Only `type` is used, to tell cellular from Wi-Fi.
 */
type NetworkConnection = {
    type?: string;
    addEventListener(type: 'change', listener: () => void): void;
    removeEventListener(type: 'change', listener: () => void): void;
};

function networkConnection(): NetworkConnection | undefined {
    return (navigator as Navigator & { connection?: NetworkConnection }).connection;
}

/** The sliver of Electron's `<webview>` the PDF export uses. */
type PdfWebview = HTMLElement & {
    executeJavaScript(code: string): Promise<unknown>;
    printToPDF(options: { printBackground?: boolean; pageSize?: string }): Promise<Uint8Array>;
};

/** Resolve once the webview's page has loaded, so the note can be injected. */
/**
 * Poll until the injected page has text and its images have settled. A fixed
 * delay would be guesswork, and requestAnimationFrame never fires offscreen.
 */
function mimeForExtension(extension: string): string {
    switch (extension.toLowerCase()) {
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'webp':
            return 'image/webp';
        case 'svg':
            return 'image/svg+xml';
        case 'bmp':
            return 'image/bmp';
        case 'avif':
            return 'image/avif';
        default:
            return 'application/octet-stream';
    }
}

/** Reject instead of waiting forever on an Electron/SDK call that never settles. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                window.clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                window.clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

export default class ProtonDriveSyncPlugin extends Plugin {
    // Obsidian declares `settings?: unknown` on Plugin; this narrows it.
    declare settings: PluginSettings;
    /** Where the Proton session is kept, encrypted with the user's PIN if they set one. */
    /** The stored session is PIN-protected and has not been unlocked in this run. */
    locked = false;
    /** Whether a PIN protects the stored session; cached for the settings tab, which renders synchronously. */
    pinEnabled = false;
    private unlocking: Promise<boolean> | null = null;
    /** The connect in flight; see {@link connect}. */
    private connecting: Promise<void> | null = null;
    /** The unlocked PIN key, kept across restarts when the PIN has a time limit. */
    private rememberedUnlock!: RememberedUnlock;
    /** Last time the user did anything in Obsidian; measures "away" for the PIN's time limit. */
    private lastActivity = Date.now();
    /**
     * What counts as "did something", in every Obsidian window: the PIN's time
     * limit must not run out while the user works in a pop-out, whose clicks
     * never reach this window's document.
     */
    private readonly activity = new ActivityWatch(() => this.onActivity());
    private lastRememberSave = 0;
    private settingsTab: ProtonDriveSyncSettingsTab | null = null;
    /** What the settings tab last rendered from; see {@link refreshSettingsTab}. */
    private settingsTabKey = '';
    /** A rebuild was skipped because the user was typing; see {@link refreshSettingsTab}. */
    private settingsTabDirty = false;
    /** This device's place in the vault's device list; see {@link DeviceList}. */
    /** This installation's id: the SDK's client id, and the device's id on the device list. */
    /** The device list is off because the vault is shared with other people; see {@link openDeviceList}. */
    private devicesOffForSharing = false;

    private statusBar!: StatusBar;
    /** The ribbon icon standing in for the status bar on mobile; null on desktop. */
    private ribbonIcon: HTMLElement | null = null;
    /** The sync-state button added to each note's header on mobile; see {@link updateNoteIndicators}. */
    private readonly noteActions = new WeakMap<MarkdownView, HTMLElement>();
    /**
     * The same buttons, kept in a list as well.
     *
     * A view's header belongs to the view, which outlives the plugin: Obsidian
     * does not take the buttons down when the plugin unloads, so an update
     * left one behind per note and the next load added another. The weak map
     * cannot be walked, so the removal registered below needs this list.
     */
    private readonly noteActionEls = new Set<HTMLElement>();
    /** What the status bar, ribbon icon and panel currently show. */
    private summary!: SyncSummary;
    private conflictNoticeTimer: number | null = null;
    /** Malformed exported-share entries dropped while loading the settings. */
    private droppedExportedShares = 0;

    override async onload(): Promise<void> {
        await this.loadSettings();

        runtime.logger = new Logger(this.settings.logLevel);
        if (this.droppedExportedShares > 0) {
            runtime.logger.warn(
                `Dropped ${this.droppedExportedShares} malformed exported-share registry entries; ` +
                    'they are never unshared or trashed.',
            );
        }
        // After the workspace is ready, so the first start of the day does not
        // delay anything the user is waiting for.
        setLogShowsNames(this.settings.logShowsNames ?? false);
        this.statusBar = new StatusBar(this.addStatusBarItem(), {
            syncNow: () => void this.syncNowOrSetUp(),
            togglePause: () => void this.setPaused(!this.settings.paused),
            showConflicts: () => new ConflictsModal(this.app, this).open(),
            openPanel: () => void this.openPanel(),
            openSettings: () => this.openSettings(),
        });
        this.registerView(
            SYNC_PANEL_VIEW,
            (leaf) =>
                new SyncPanelView(leaf, {
                    summary: () => this.summary,
                    pendingChanges: () => runtime.engine.pendingChanges(),
                    activeNote: () => this.app.workspace.getActiveFile()?.path ?? null,
                    canListVersions: () => this.isConfigured() && !this.locked && runtime.engine.isConnected(),
                    versionsKey: (path) => runtime.engine.versionsKey(path),
                    noteVersions: (path) => runtime.engine.noteVersions(path),
                    compareVersion: (path, version) => versionComparison(this, path, version),
                    shareNote: (path) => this.shareNote(path),
                    recentlyDeleted: () => runtime.engine.recentlyDeleted(),
                    restoreDeleted: async (item) => {
                        await runtime.engine.restoreDeleted(item);
                        new Notice(`Restored "${item.path}"; it is back in the vault after the next check.`);
                    },
                    pollSeconds: () => runtime.engine.pollSeconds(),
                    sharedBy: () => this.settings.remoteFolderSharedBy,
                    openFile: (path) => void this.openPath(path),
                    reviewMassDelete: () => this.reviewMassDelete(),
                    syncNow: () => void this.syncNowOrSetUp(),
                    togglePause: () => void this.setPaused(!this.settings.paused),
                    showConflicts: () => new ConflictsModal(this.app, this).open(),
                    openSettings: () => this.openSettings(),
                }),
        );
        // Obsidian's mobile app has no status bar, so there the ribbon, which
        // it shows in the sidebar and the ribbon menu, carries the status.
        if (Platform.isMobile) {
            this.ribbonIcon = this.addRibbonIcon('refresh-cw', 'Proton-SDK-Sync', () => void this.openPanel());
            // The note-header buttons are added to views that belong to the
            // app, not to the plugin, and survive its unload; take them down
            // with the plugin or every update leaves one more per note.
            this.register(() => this.removeNoteActions());
        }
        this.registerInterval(window.setInterval(() => this.refreshStatus(), STATUS_REFRESH_MS));
        this.registerInterval(
            window.setInterval(() => {
                if (this.settings.paused && this.devicesAvailable()) {
                    void this.checkDeviceRequests();
                }
            }, PAUSED_REQUEST_CHECK_MS),
        );
        // Expired exports are cleaned up once a day; see runExportJanitor.
        this.registerInterval(window.setInterval(() => void this.runExportJanitor(), EXPORT_JANITOR_INTERVAL_MS));

        const clientUid = this.installationId();
        runtime.clientUid = clientUid;
        const protonLogger = runtime.logger.getLogger('proton');
        // The session goes into an encrypted file of our own when the OS can
        // encrypt at all, so that it is not sitting in the one namespace every
        // other plugin can read; Obsidian's secret storage stays the home on
        // mobile, where there is no keystore and no Node. See SECURITY.md.
        const safeStorage = encryptedStorage(protonLogger);
        const secretSession = new ObsidianSecretSlot(
            this.app.secretStorage,
            `proton-sdk-sync-session-${clientUid}`,
        );
        const secretUnlock = new ObsidianSecretSlot(this.app.secretStorage, `proton-sdk-sync-unlock-${clientUid}`);
        // The previous plugin kept these under its own id; adopt them once so
        // switching over does not sign anyone out.
        const legacySession = new ObsidianSecretSlot(
            this.app.secretStorage,
            `proton-drive-sync-session-${clientUid}`,
        );
        const legacyUnlock = new ObsidianSecretSlot(this.app.secretStorage, `proton-drive-sync-unlock-${clientUid}`);
        const sessionInner: SecretSlot = safeStorage
            ? new SafeStorageFileSlot(this.app.vault.adapter, this.pluginFile(SESSION_SECRET_FILE), safeStorage)
            : secretSession;
        const unlockInner: SecretSlot = safeStorage
            ? new SafeStorageFileSlot(this.app.vault.adapter, this.pluginFile(UNLOCK_SECRET_FILE), safeStorage)
            : secretUnlock;
        // Upgrading: move what an older version left in secret storage, so
        // nobody is signed out and the old, readable copy goes away.
        await migrateSecret(legacySession, sessionInner);
        await migrateSecret(legacyUnlock, unlockInner);
        runtime.sessionSlot = new PinProtectedSlot(sessionInner, PIN_ITERATIONS, () => Date.now(), {
            isSet: () => this.settings.pinProtected,
            set: (value) => {
                this.settings.pinProtected = value;
                void this.saveSettings();
            },
        });
        this.rememberedUnlock = new RememberedUnlock(unlockInner, () => Date.now(), { encryptedOnly: true });
        if (!this.settings.pinProtected && (await runtime.sessionSlot.protection()) === 'pin') {
            // A PIN set before this version was recorded nowhere; without the
            // record, an unreadable envelope reads as "no PIN" and may be
            // overwritten in the clear.
            this.settings.pinProtected = true;
            await this.saveSettings();
        }
        const credentials = new Credentials(
            runtime.sessionSlot,
            {
                adapter: this.app.vault.adapter,
                path: this.pluginFile(LEGACY_SESSION_FILE),
                decrypt: (payload) => decryptLegacySession(payload, protonLogger),
            },
            protonLogger,
        );
        runtime.session = new ProtonSession(credentials, clientUid, protonLogger, () => runtime.state.cursorsFingerprint());
        // The metadata cache keeps only nodes the vault syncs; see
        // persistentCache.nodeScope.
        runtime.session.setNodeSource(() => this.cacheScopeNodes());
        runtime.state = new SyncState(
            this.app.vault.adapter,
            this.pluginFile(STATE_FILE),
            runtime.logger.getLogger('state'),
            // The Drive cache is only valid at the event position it was saved
            // at, so it is saved whenever the state, and its cursor, are.
            () => void runtime.session.flushCache(),
        );
        runtime.conflictHistory = new ConflictHistory(
            this.app.vault.adapter,
            this.pluginFile(CONFLICT_HISTORY_FILE),
            runtime.logger.getLogger('conflicts'),
        );
        await runtime.conflictHistory.load();
        runtime.engine = new SyncEngine(
            this.app,
            runtime.state,
            this.settings,
            runtime.logger.getLogger('sync'),
            {
                onChange: (summary) => this.onSyncChange(summary),
                onConflict: (event) => this.onConflict(event),
                onSettingsAdopted: (paths) => this.onSettingsAdopted(paths),
                onDevicesChanged: () => void this.checkDeviceRequests(),
            },
            { configDir: this.app.vault.configDir, pluginDir: this.pluginDir(), pluginId: this.manifest.id },
            {
                isMobile: Platform.isMobileApp,
                windows: Platform.isWin,
                // Patterns in the settings mean what the filesystem under the
                // vault means: on a case-insensitive one, `Templates` and
                // `templates` are the same folder.
                caseInsensitive: Platform.isWin || Platform.isMacOS || Platform.isIosApp,
                isMetered: () => networkConnection()?.type === 'cellular',
                isHidden: () => activeDocument.visibilityState === 'hidden',
                openEditor: (path) => this.openEditor(path),
            },
        );
        // A real end of session — the refresh token is gone, not merely a
        // timeout — stops the engine. Otherwise it keeps trying with a client
        // that can no longer authenticate, and the status bar says "idle" while
        // nothing syncs.
        runtime.session.setSessionEndedHandler(() => {
            void runtime.engine.stop();
            this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
            new Notice(
                'Proton-SDK-Sync: the Proton session ended. Sign in again in the plugin settings.',
                15000,
            );
        });

        runtime.devices = new DeviceList(
            {
                self: () => ({
                    id: runtime.clientUid,
                    name: this.settings.deviceName,
                    platform: platformName(),
                    pluginVersion: this.manifest.version,
                    account: runtime.session.accountEmail ?? null,
                }),
                handled: () => this.handledRequestAt(),
                setHandled: (at) => this.app.saveLocalStorage(HANDLED_REQUEST_KEY, at),
            },
            runtime.logger.getLogger('devices'),
        );

        // Until connect() says otherwise: a stored sign-in is being restored,
        // which can take a few seconds, and "Sign in" would be wrong meanwhile.
        this.summary = { ...runtime.engine.getSummary(), status: 'connecting' };
        this.settingsTab = new ProtonDriveSyncSettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);
        this.settingsTab.containerEl.addEventListener('focusout', () => {
            // After the focus has landed somewhere else, not before.
            window.setTimeout(() => {
                if (!this.settingsTabDirty || this.settingsTab?.containerEl.contains(activeDocument.activeElement)) {
                    return;
                }
                this.settingsTabDirty = false;
                this.settingsTab?.update();
            }, 0);
        });
        this.registerCommands();
        this.registerVaultEvents();
        this.registerLifecycleEvents();

        // Deferred until the workspace is ready so a first sync does not
        // compete with Obsidian opening the vault, and so the flood of vault
        // events Obsidian emits while indexing is not mistaken for user edits.
        this.app.workspace.onLayoutReady(() => {
            void this.connect().then(() => {
                if (!this.settings.onboardingComplete) {
                    this.openSetup();
                }
                void this.runExportJanitor();
            });
        });
    }

    override onunload(): void {
        if (this.conflictNoticeTimer !== null) {
            window.clearTimeout(this.conflictNoticeTimer);
        }
        // Close the state first: stop() flushes it, and on a reload the next
        // instance has often loaded and written that same file already, so a
        // late flush from this one would put an older snapshot on disk. Closing
        // here makes that flush a no-op; it costs the last second of records,
        // which the next pass derives again.
        runtime.state.close();
        // Obsidian does not wait for unload, so the pass in flight is aborted
        // and then awaited here. `stop` bumps the generation and aborts
        // synchronously, so nothing of this instance lands in the meantime.
        void runtime.engine.stop();
        runtime.devices.open(null);
        void this.rememberUnlock();
    }

    openSetup(): void {
        new SetupModal(this.app, this).open();
    }

    /** After a successful sign-in: start syncing, unless told not to. */
    async onSignedIn(options: { connect?: boolean } = {}): Promise<void> {
        if (options.connect ?? true) {
            await this.reconnect();
        }
    }

    /** Point the vault at a Drive folder and, unless told not to, start syncing with it. */
    async setRemoteFolder(folder: ChosenFolder, options: { connect?: boolean } = {}): Promise<void> {
        const changed = folder.uid !== this.settings.remoteFolderUid;
        this.settings.remoteFolderUid = folder.uid;
        this.settings.remoteFolderPath = folder.path;
        this.settings.remoteFolderSharedBy = folder.sharedBy;
        if (changed && folder.shared && this.settings.syncObsidianConfig) {
            // A shared vault is used by several people: syncing the config
            // folder would hand each of them everyone else's theme, plugins
            // and hotkeys. Off by default; the setting can turn it back on.
            this.settings.syncObsidianConfig = false;
            this.notify('settings and plugins are not synced with a shared folder; turn this back on in the settings if you want them.');
        }
        await this.saveSettings();

        if (changed) {
            // The sync state describes the old folder, and reconciling against
            // a different tree with it would read as mass deletions on both
            // sides.
            await runtime.engine.stop();
            await runtime.state.reset();
            await runtime.session.clearCache();
        }
        if (options.connect ?? true) {
            await this.reconnect();
        }
    }

    isConfigured(): boolean {
        return runtime.session.isSignedIn() && Boolean(this.settings.remoteFolderUid);
    }

    /** Forget the sync state and compare everything afresh. Stops first, so no pass writes into the cleared state. */
    async rebuildState(): Promise<void> {
        await runtime.engine.stop();
        await runtime.state.reset();
        await runtime.session.clearCache();
        await this.connect();
    }

    /**
     * Pause or resume, remembering the choice across restarts.
     *
     * Resuming into a sync that has never run (paused from the first-sync
     * preview, say) shows the preview again, since nothing has changed that
     * would make it less of a surprise.
     */
    async setPaused(paused: boolean, request?: DeviceRequest): Promise<void> {
        if (request && this.settings.paused === paused) {
            // Asked from another device for what is already the case.
            return;
        }
        this.settings.paused = paused;
        await this.saveSettings();
        if (paused) {
            runtime.engine.pause();
            this.notify(request ? requestNotice(request) : 'syncing paused.');
            return;
        }
        if (
            this.isConfigured() &&
            runtime.state.paths().length === 0 &&
            !(await this.confirmFirstSync(runtime.state.wasLost()))
        ) {
            this.settings.paused = true;
            await this.saveSettings();
            return;
        }
        this.notify(request ? requestNotice(request) : 'syncing resumed.');
        await runtime.engine.resume();
    }

    // -- PIN ---------------------------------------------------------------

    /**
     * Ask for the PIN. Resolves true once the session is unlocked; false when
     * the user closed the prompt, or chose to forget a lost PIN, which leaves
     * them signed out.
     */
    private unlock(): Promise<boolean> {
        this.unlocking ??= new Promise<boolean>((resolve) => {
            new UnlockModal(this.app, {
                verify: (pin) => runtime.sessionSlot.unlock(pin),
                forget: () => runtime.sessionSlot.forget(),
                waitSeconds: async () => Math.ceil((await runtime.sessionSlot.attemptState()).retryAfterMs / 1000),
                onDone: (result) => {
                    if (result === 'unlocked') {
                        this.locked = false;
                        this.markActive();
                        void this.rememberUnlock();
                    } else if (result === 'forgotten') {
                        this.locked = false;
                        this.pinEnabled = false;
                        void this.rememberedUnlock.clear();
                        this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
                        this.notify('the locked sign-in was deleted. Sign in again to keep syncing.');
                    }
                    resolve(result === 'unlocked');
                },
            }).open();
        }).finally(() => {
            this.unlocking = null;
        });
        return this.unlocking;
    }

    /** Set up, change or remove the PIN, after asking for the current one where there is one. */
    managePin(mode: 'set' | 'change' | 'remove', onDone?: () => void): void {
        new PinFormModal(this.app, {
            mode,
            verify: (pin) => runtime.sessionSlot.verify(pin),
            apply: async (newPin) => {
                if (mode === 'remove') {
                    await runtime.sessionSlot.removePin();
                } else if (newPin !== null) {
                    await runtime.sessionSlot.setPin(newPin);
                }
                this.pinEnabled = mode !== 'remove';
                this.markActive();
                // A new PIN means a new key, and no PIN means nothing to remember.
                await this.rememberUnlock();
                this.refreshSettingsTab();
                this.notify(
                    mode === 'set'
                        ? 'PIN set. Obsidian will ask for it when it starts.'
                        : mode === 'change'
                          ? 'PIN changed.'
                          : 'PIN removed.',
                );
            },
            onDone: () => onDone?.(),
        }).open();
    }

    /**
     * Whether the unlocked key has anywhere encrypted to wait out a time limit.
     *
     * Without a keystore — mobile, or a Linux desktop falling back to Electron's
     * `basic_text` — the key would sit in the clear, so the setting is not
     * offered and the PIN is asked for whenever Obsidian starts.
     */
    canRememberPin(): boolean {
        return this.rememberedUnlock.canRemember();
    }

    /** The time limit for the PIN changed in the settings. */
    async onPinLockAfterChanged(): Promise<void> {
        this.markActive();
        await this.rememberUnlock();
    }

    private markActive(): void {
        this.lastActivity = Date.now();
    }

    /** The PIN has a time limit, and it has run out since the user last did anything. */
    private lockDue(): boolean {
        const minutes = this.settings.pinLockAfterMinutes;
        return (
            minutes > 0 &&
            this.pinEnabled &&
            !this.locked &&
            runtime.session.isSignedIn() &&
            Date.now() - this.lastActivity >= minutes * 60_000
        );
    }

    /** Something happened in Obsidian: lock if the time limit ran out first, otherwise restart the clock. */
    private onActivity(): void {
        if (this.lockDue()) {
            void this.lockNow();
            return;
        }
        this.markActive();
        if (Date.now() - this.lastRememberSave >= REMEMBER_SAVE_MS) {
            void this.rememberUnlock();
        }
    }

    /**
     * Keep the unlocked key until the time limit runs out, counted from the
     * last activity, so reopening Obsidian within it does not ask for the PIN;
     * or delete it, when there is no time limit or nothing unlocked.
     */
    private async rememberUnlock(): Promise<void> {
        const minutes = this.settings.pinLockAfterMinutes;
        const key = runtime.sessionSlot.exportKey();
        if (minutes <= 0 || !this.pinEnabled || this.locked || key === null) {
            await this.rememberedUnlock.clear();
            return;
        }
        this.lastRememberSave = Date.now();
        await this.rememberedUnlock.save(key, this.lastActivity + minutes * 60_000);
    }

    /**
     * The time limit ran out: stop syncing, drop the session from memory, and
     * ask for the PIN. The session stays stored, encrypted, and nothing else
     * is lost; unlocking picks up where it left off.
     */
    private async lockNow(): Promise<void> {
        if (this.locked) {
            return;
        }
        this.locked = true;
        runtime.logger.info(`Locked after ${this.settings.pinLockAfterMinutes} minute(s) away`);
        // The keys go first: stop() waits for the pass to unwind, which can take
        // a while, and a PIN that has expired should end access now rather than
        // after the current download finishes.
        this.closeDeviceList();
        runtime.session.lock();
        runtime.sessionSlot.lock();
        await runtime.engine.stop();
        await this.rememberedUnlock.clear();
        this.showStatus({ ...runtime.engine.getSummary(), status: 'locked' });
        await this.connect();
    }

    /** Resolve true once the user has entered the right PIN, or straight away when there is none. */
    private confirmPin(purpose: string): Promise<boolean> {
        if (!this.pinEnabled) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            new PinFormModal(this.app, {
                mode: 'confirm',
                purpose,
                // Proving the PIN for a sign-out must not unlock the slot: the
                // user can still cancel, and the interface would then say
                // "locked" over a session whose key is in memory.
                verify: (pin) => runtime.sessionSlot.verifyOnly(pin),
                apply: async () => undefined,
                onDone: resolve,
            }).open();
        });
    }

    /** Sign out, with the PIN first when there is one; see {@link endSession}. */
    async signOut(): Promise<void> {
        if (!(await this.confirmPin('sign out'))) {
            return;
        }
        const revoked = await this.endSession();
        this.notify(
            revoked
                ? 'signed out, and the session was ended on Proton.'
                : 'signed out on this device, but Proton could not be reached to end the session. ' +
                      'Revoke it under account.proton.me → Security → Sessions if you need it gone now.',
        );
        await this.reconnect();
    }

    /**
     * End the session on Proton's side before forgetting it here. Resolves
     * whether Proton confirmed it.
     *
     * The chosen Drive folder, and the sync state that describes it, go too.
     * Both belong to the account being signed out of, and the next sign-in
     * may be a different one, where that folder id means nothing, or the
     * same account wanting a different folder. Nothing is deleted on Drive
     * or in the vault; signing in again and choosing a folder starts a fresh
     * first sync, which pairs up files that already match.
     */
    private async endSession(): Promise<boolean> {
        await runtime.engine.stop();
        this.closeDeviceList();
        const { revoked } = await runtime.session.signOut();
        this.pinEnabled = false;
        await this.rememberedUnlock.clear();
        this.settings.remoteFolderUid = null;
        this.settings.remoteFolderPath = null;
        this.settings.remoteFolderSharedBy = null;
        await this.saveSettings();
        await runtime.state.reset();
        this.refreshSettingsTab();
        return revoked;
    }

    /** Everything this device logged recently, with enough context to go in a bug report. */

    async copyLog(): Promise<void> {
        const header = [
            `Proton-SDK-Sync ${this.manifest.version}`,
            `Obsidian ${apiVersion}, ${Platform.isMobileApp ? 'mobile' : 'desktop'}`,
            `Status: ${runtime.engine.getSummary().status}`,
            '',
        ];
        await navigator.clipboard.writeText(header.join('\n') + formatLogEntries(runtime.logger.getEntries()));
        new Notice('Sync log copied. It lists file names; check it before sharing.');
    }

    notify(message: string): void {
        new Notice(`Proton-SDK-Sync: ${message}`);
    }

    /**
     * Bring the sync up, if there is both a session and a chosen folder.
     *
     * Called on load and again whenever the user signs in or picks a folder,
     * so the plugin becomes active without a reload. Several unlock paths run
     * into it at once — the status bar, the command, the settings tab, a
     * layout-ready start — and two passes together start the engine twice:
     * the second start's sweep of unfinished downloads deletes the first
     * pass's temporary file out from under it. One pass, and the callers that
     * arrive meanwhile wait for it.
     */
    async connect(): Promise<void> {
        if (this.connecting !== null) {
            return this.connecting;
        }
        const pass = this.connectOnce().finally(() => {
            if (this.connecting === pass) {
                this.connecting = null;
            }
        });
        this.connecting = pass;
        return pass;
    }

    /** One attempt at the connection; failures are reported here, not thrown at a caller that joined. */
    private async connectOnce(): Promise<void> {
        try {
            await this.connectSession();
        } catch (error) {
            // Nothing above expects to fail; without this the status would
            // keep saying "Connecting".
            runtime.logger.error('Could not start syncing', error);
            this.showStatus({ ...runtime.engine.getSummary(), status: 'error', lastError: errorMessage(error) });
        }
    }

    private async connectSession(): Promise<void> {
        this.pinEnabled = (await runtime.sessionSlot.protection()) === 'pin';
        this.locked = await runtime.sessionSlot.isLocked();
        if (this.locked && this.settings.pinLockAfterMinutes > 0) {
            // Unlocked within the time limit before Obsidian last closed.
            const remembered = await this.rememberedUnlock.load();
            if (remembered !== null && (await runtime.sessionSlot.unlockWithKey(remembered))) {
                this.locked = false;
                this.markActive();
            }
        }
        if (this.locked) {
            this.showStatus({ ...runtime.engine.getSummary(), status: 'locked' });
            if (!(await this.unlock())) {
                return;
            }
        }
        this.showStatus({ ...runtime.engine.getSummary(), status: 'connecting' });
        try {
            await runtime.session.init();
        } catch (error) {
            runtime.logger.error('Could not restore the Proton session', error);
            this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
            return;
        }

        if (!runtime.session.isSignedIn()) {
            this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
            return;
        }
        if (!this.settings.remoteFolderUid) {
            this.showStatus({ ...runtime.engine.getSummary(), status: 'not-configured' });
            return;
        }

        await runtime.state.load(runtime.session.accountEmail ?? null, this.settings.remoteFolderUid);
        if (runtime.state.wasLost() || runtime.state.paths().length === 0) {
            // A sync starting from nothing must not trust anything cached
            // about how Drive used to look.
            await runtime.session.clearCache();
        } else {
            await runtime.session.validateCache(runtime.state.cursorsFingerprint());
        }
        // Before anything syncs: what other devices asked of this one.
        if (!(await this.openDeviceList(this.settings.remoteFolderUid))) {
            return;
        }
        if (
            !this.settings.paused &&
            runtime.state.paths().length === 0 &&
            !(await this.confirmFirstSync(runtime.state.wasLost()))
        ) {
            this.settings.paused = true;
            await this.saveSettings();
        }
        await runtime.engine.start(runtime.session.getClient(), this.settings.remoteFolderUid);
        // The folders above the synced one are read on every start but never
        // reach the state, so the cache has to be told about them separately.
        await this.rememberCacheParents(this.settings.remoteFolderUid);
    }

    /**
     * The node uids the saved Drive cache may keep entries for.
     *
     * The state accounts for every note and folder in the vault. It does not
     * account for the synced folder itself, the folders above it, or the
     * `.devices` folder — all read on every start, so all worth keeping. The
     * files inside `.devices` are admitted by their parent tag rather than by
     * this set; see `nodeScope`.
     */
    private cacheScopeNodes(): Set<string> {
        const uids = new Set<string>(runtime.state.entries().map((record) => record.nodeUid));
        for (const uid of runtime.cacheParents) {
            uids.add(uid);
        }
        const devices = this.rememberedDevicesFolder();
        if (devices !== null) {
            uids.add(devices);
        }
        return uids;
    }

    /** The synced folder and its parents, so the cache keeps them between starts. */
    private async rememberCacheParents(rootUid: string | undefined): Promise<void> {
        const parents = new Set<string>();
        if (rootUid) {
            parents.add(rootUid);
            try {
                for (const node of await runtime.session.getClient().getNodeHierarchy(rootUid)) {
                    parents.add(node.uid);
                }
            } catch (error) {
                runtime.logger.debug('Could not list the folders above the synced one', error);
            }
        }
        const devices = this.rememberedDevicesFolder();
        if (devices !== null) {
            parents.add(devices);
        }
        runtime.cacheParents = parents;
        // The scope is memoised for a minute; hand it the fuller set now.
        runtime.session.setNodeSource(() => this.cacheScopeNodes());
    }

    /**
     * Before a first sync that mixes two sets of files, show what it will do
     * and let the user hold off. Resolves true to go ahead.
     *
     * Goes ahead without asking when one side is empty or both already agree,
     * and also when the preview itself fails: a first sync has no record of
     * earlier state, so it can add and keep copies but never delete.
     *
     * A vault holding nothing but its config folder counts as empty. That is
     * what a vault created a minute ago looks like: Obsidian's default
     * settings and this plugin, nothing the user would miss when Drive's
     * settings replace them.
     */
    private async confirmFirstSync(stateLost = false): Promise<boolean> {
        const rootUid = this.settings.remoteFolderUid;
        if (!rootUid) {
            return true;
        }
        this.showStatus({ ...runtime.engine.getSummary(), status: 'syncing' });

        let plan: SyncPlan;
        try {
            plan = await runtime.engine.plan(runtime.session.getClient(), rootUid);
        } catch (error) {
            if (stateLost) {
                // Without the record of the last sync and without a preview,
                // going ahead would bring deletions back unseen. Hold off.
                runtime.logger.error('Could not preview the sync after the sync state was lost; pausing', error);
                this.notify('the record of the last sync could not be read, so syncing is paused. Resume it to try again.');
                return false;
            }
            runtime.logger.warn('Could not preview the first sync; going ahead, since it deletes nothing', error);
            return true;
        }
        const changes = plan.uploads.length + plan.downloads.length + plan.conflicts.length + plan.removals.length;
        // A lost state is shown whenever there is anything to sync at all: the
        // user had a sync history and has to hear that it is gone.
        const worthAsking = stateLost
            ? plan.localFiles + plan.remoteFiles > 0
            : plan.localNotes > 0 && plan.remoteFiles > 0 && changes > 0;
        if (!worthAsking) {
            return true;
        }

        const folderName = this.settings.remoteFolderPath ?? 'the Drive folder';
        const policy = CONFLICT_POLICIES[this.settings.conflictPolicy];
        return new Promise((resolve) => {
            new FirstSyncModal(this.app, plan, folderName, policy.toLowerCase(), resolve, stateLost).open();
        });
    }

    /**
     * Drive's Obsidian settings are now in this vault, but Obsidian keeps
     * running on the ones it loaded at startup, with the plugins, themes and
     * snippets that came with them, until it reloads.
     */
    private onSettingsAdopted(paths: string[]): void {
        new ReloadModal(this.app, paths, () => this.reloadApp()).open();
    }

    private reloadApp(): void {
        const commands = (this.app as App & { commands?: { executeCommandById(id: string): boolean } }).commands;
        if (!commands?.executeCommandById('app:reload')) {
            window.location.reload();
        }
    }

    private async syncNowOrSetUp(): Promise<void> {
        if (this.locked) {
            await this.connect();
            return;
        }
        if (!this.isConfigured()) {
            this.openSetup();
            return;
        }
        if (this.summary.status === 'folder-missing') {
            this.chooseFolder();
            return;
        }
        await runtime.engine.syncNow();
    }

    /**
     * Open a vault file the panel names, by its path.
     *
     * `openLinkText` resolves a link, not a path: it creates the note when it
     * is missing, so tapping a file that was waiting to be deleted brought it
     * back empty, and it reads `#` and `^` in a name as a heading or block
     * reference, opening a different note. A file the panel lists is a path,
     * and one that is gone should say so.
     */
    private async openPath(path: string): Promise<void> {
        if (!(await openVaultFile(this.app, path))) {
            this.notify(`"${path}" is not in the vault any more, so there is nothing to open.`);
        }
    }

    /**
     * Compare everything against Drive now, and say what actually happened.
     *
     * The settings tab used to say "finished" whatever came back, which it
     * said just as readily for a pass that never ran — locked, no folder,
     * held for Wi-Fi — or one that stopped on an error. What the pass ended
     * in is what the notice reports.
     */
    async syncNowAndReport(): Promise<void> {
        if (this.locked) {
            this.notify(syncNowResult({ ...runtime.engine.getSummary(), status: 'locked' }));
            return;
        }
        if (!this.isConfigured()) {
            this.notify(syncNowResult({ ...runtime.engine.getSummary(), status: 'not-configured' }));
            return;
        }
        if (!runtime.engine.isConnected()) {
            // The engine is stopped — locked, signed out, or between runs — and
            // a pass asked for now would be dropped, so do not report one.
            this.notify('Nothing was compared: syncing is not running right now.');
            return;
        }
        await runtime.engine.syncNow();
        this.notify(syncNowResult(runtime.engine.getSummary()));
    }

    /** Pick another Drive folder for the vault, as the settings tab does. */
    private chooseFolder(): void {
        new FolderPickerModal(
            this.app,
            runtime.session.getClient(),
            (folder) => void this.setRemoteFolder(folder),
            runtime.logger.getLogger('folder-picker'),
        ).open();
    }

    private openSettings(): void {
        const setting = (this.app as App & { setting?: { open(): void; openTabById(id: string): void } }).setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
    }

    /** Tear the sync down and bring it back with the current configuration. */
    async reconnect(): Promise<void> {
        await runtime.engine.stop();
        await this.connect();
    }

    // -- device list -------------------------------------------------------

    /**
     * Open the vault's device list, and act on a request left for this device
     * since it last looked. Resolves false when that was to remove it: it has
     * signed out, and there is nothing to sync.
     *
     * Off for a vault in someone else's Drive or shared with others, whose
     * devices would otherwise see this one, and could pause or remove it.
     */
    private async openDeviceList(rootUid: string): Promise<boolean> {
        const client = runtime.session.getClient();
        const logger = runtime.logger.getLogger('devices');
        let registry: DeviceRegistry | null = null;
        let shared = this.settings.remoteFolderSharedBy !== null;
        if (!shared) {
            registry = new DeviceRegistry(new DriveIO(client, logger), rootUid, logger, this.devicesFolderMemory(rootUid));
            // Both hold up the sync, so they run side by side; the list read
            // here is dropped if the folder turns out to be shared.
            [shared] = await Promise.all([
                sharedWithOthers(client, rootUid).catch((error: unknown) => {
                    logger.warn('Could not check whether the folder is shared; the device list stays off for now', error);
                    return true;
                }),
                registry.prepare(),
            ]);
            if (shared) {
                registry = null;
            }
        }
        runtime.devices.open(registry);
        runtime.engine.watchDevices(registry);
        this.devicesOffForSharing = shared;

        const request = await runtime.devices.pendingRequest();
        if (!request) {
            return true;
        }
        if (request.state === 'removed') {
            await this.removedByAnotherDevice(request);
            return false;
        }
        // The sync has not started: it starts from the setting.
        if (this.settings.paused !== (request.state === 'paused')) {
            this.settings.paused = request.state === 'paused';
            await this.saveSettings();
            this.notify(requestNotice(request));
        }
        return true;
    }

    /** The `.devices` folder remembered from last time, if any; read on every start. */
    private rememberedDevicesFolder(): string | null {
        const saved = this.app.loadLocalStorage(DEVICES_FOLDER_KEY) as { rootUid?: unknown; uid?: unknown } | null;
        return typeof saved?.uid === 'string' ? saved.uid : null;
    }

    /** Where this vault found the device list's folder last time, for the folder it syncs with. */
    private devicesFolderMemory(rootUid: string): FolderMemory {
        return {
            load: () => {
                const saved = this.app.loadLocalStorage(DEVICES_FOLDER_KEY) as { rootUid?: unknown; uid?: unknown } | null;
                return saved?.rootUid === rootUid && typeof saved.uid === 'string' ? saved.uid : null;
            },
            save: (uid) => this.app.saveLocalStorage(DEVICES_FOLDER_KEY, { rootUid, uid }),
        };
    }

    private closeDeviceList(): void {
        runtime.devices.open(null);
        runtime.engine.watchDevices(null);
        this.devicesOffForSharing = false;
    }

    /** The device list changed on Drive while syncing: act on a new request for this device, if there is one. */
    private async checkDeviceRequests(): Promise<void> {
        const request = await runtime.devices.pendingRequest();
        if (!request) {
            return;
        }
        if (request.state === 'removed') {
            await this.removedByAnotherDevice(request);
            return;
        }
        await this.setPaused(request.state === 'paused', request);
    }

    /**
     * Another device removed this one from the vault's device list: say so on
     * the list, sign out, and explain. Signing in again is what brings it back;
     * the request stays handled, so it is not acted on a second time.
     */
    private async removedByAnotherDevice(request: DeviceRequest): Promise<void> {
        runtime.logger.warn(`Removed from the device list by "${request.byName || request.by}"; signing out`);
        await runtime.devices.recordRemoved();
        await this.endSession();
        this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
        new DeviceRemovedModal(this.app, request, () => this.openSetup()).open();
    }

    /** Whether the vault's device list can be shown: synced with an own folder that is not shared, and connected. */
    devicesAvailable(): boolean {
        return runtime.devices.current !== null && runtime.engine.isConnected() && !this.locked;
    }

    /** Every device syncing the vault, with ways to pause, resume or remove the others. */
    showDevices(): void {
        const registry = runtime.devices.current;
        if (!registry || !this.devicesAvailable()) {
            this.notify(
                this.devicesOffForSharing
                    ? 'the device list is off for a vault shared with other people.'
                    : 'sign in, choose a Drive folder and unlock to see the devices syncing this vault.',
            );
            return;
        }
        new DevicesModal(this.app, {
            selfId: runtime.clientUid,
            list: () => registry.list(),
            ask: async (entry, state) => {
                // Read again, in case another device asked something since
                // the dialog listed it: a request has to come after it.
                const [record, request] = await Promise.all([registry.record(entry.id), registry.request(entry.id)]);
                await registry.ask(entry.id, {
                    state,
                    at: nextRequestAt({ record, request }),
                    by: runtime.clientUid,
                    byName: this.settings.deviceName,
                });
            },
            forget: (id) => registry.forget(id),
        }).open();
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        runtime.logger.setLevel(this.settings.logLevel);
        runtime.engine.updateSettings(this.settings);
        // The device name may have changed, which the device list shows.
        runtime.devices.noteChange();
    }

    private async loadSettings(): Promise<void> {
        const stored = (await this.loadData()) as Partial<PluginSettings> | null;
        // The id changed with the name, so Obsidian hands a fresh data.json
        // even to someone who has used the previous plugin for months. Reading
        // its settings once spares them choosing the folder, the exclusions and
        // the PIN timing again.
        const adopted = stored === null ? await this.adoptPreviousSettings() : null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? adopted);

        let changed = false;
        // The registry is plain JSON: validate it, or a hand-edited or
        // corrupt entry (a non-array, an entry without a path) throws inside
        // the janitor and silently stops the cleanup. Malformed entries are
        // dropped without touching Drive or the vault; the count is warned
        // about once the logger exists in onload.
        const droppedBefore = this.droppedExportedShares;
        const registry = sanitizeExportedShares(this.settings.exportedShares, () => {
            this.droppedExportedShares += 1;
        });
        if (this.droppedExportedShares !== droppedBefore) {
            changed = true;
        }
        this.settings.exportedShares = registry;
        // Installations configured before the setup assistant existed have
        // no use for it.
        if (stored?.onboardingComplete === undefined && stored?.remoteFolderUid) {
            this.settings.onboardingComplete = true;
            changed = true;
        }

        // 0.1.0 kept the installation id here; it now lives in local storage.
        const legacy = this.settings as { clientUid?: unknown };
        if ('clientUid' in legacy) {
            if (typeof legacy.clientUid === 'string' && legacy.clientUid && !this.storedInstallationId()) {
                this.app.saveLocalStorage(CLIENT_UID_KEY, legacy.clientUid);
            }
            delete legacy.clientUid;
            changed = true;
        }
        // Filled in on first run rather than in the defaults, because it names
        // this device's conflict copies from then on.
        if (!this.settings.deviceName) {
            this.settings.deviceName = defaultDeviceName();
            changed = true;
        }
        if (changed) {
            await this.saveData(this.settings);
        }
    }

    /**
     * Settings left by the plugin this one replaces, read once.
     *
     * Best effort: a missing or unreadable file only means the defaults, and
     * the logger does not exist yet at this point in the start, so a failure is
     * deliberately quiet.
     */
    private async adoptPreviousSettings(): Promise<Partial<PluginSettings> | null> {
        const path = `${this.app.vault.configDir}/plugins/proton-drive-sync/data.json`;
        try {
            if (!(await this.app.vault.adapter.exists(path))) {
                return null;
            }
            return JSON.parse(await this.app.vault.adapter.read(path)) as Partial<PluginSettings>;
        } catch {
            return null;
        }
    }

    private registerCommands(): void {
        this.addCommand({
            id: 'sync-now',
            icon: 'refresh-cw',
            name: 'Sync now',
            callback: () => void this.syncNowOrSetUp(),
        });

        this.addCommand({
            id: 'open-setup',
            icon: 'wand',
            name: 'Open setup assistant',
            callback: () => this.openSetup(),
        });

        this.addCommand({
            id: 'show-conflicts',
            icon: 'alert-circle',
            name: 'Show sync conflicts',
            callback: () => new ConflictsModal(this.app, this).open(),
        });

        this.addCommand({
            id: 'show-devices',
            icon: 'monitor-smartphone',
            name: 'Show devices syncing this vault',
            callback: () => this.showDevices(),
        });

        this.addCommand({
            id: 'pause-sync',
            icon: 'pause-circle',
            name: 'Pause syncing',
            checkCallback: (checking) => {
                if (this.settings.paused) {
                    return false;
                }
                if (!checking) {
                    void this.setPaused(true);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'resume-sync',
            icon: 'play-circle',
            name: 'Resume syncing',
            checkCallback: (checking) => {
                if (!this.settings.paused) {
                    return false;
                }
                if (!checking) {
                    void this.setPaused(false);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'compare-conflict-copy',
            icon: 'git-compare',
            name: 'Compare with conflict copy',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || conflictPairsFor(this.app, file).length === 0) {
                    return false;
                }
                if (!checking) {
                    compareConflictCopyOf(this.app, file);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'copy-share-link',
            icon: 'link',
            name: 'Copy Proton Drive share link',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || !this.isConfigured() || this.locked) {
                    return false;
                }
                if (!checking) {
                    this.shareNote(file.path);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'export-pdf-share',
            icon: 'link',
            name: 'Export note to PDF and share',
            checkCallback: (checking) => {
                if (!Platform.isDesktop || !Platform.isDesktopApp) {
                    return false;
                }
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'md' || !this.isConfigured() || this.locked) {
                    return false;
                }
                if (!checking) {
                    this.openExportModal(file);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'manage-shared-pdfs',
            icon: 'links',
            name: 'Manage shared PDFs',
            callback: () => this.openSharedPdfsModal(),
        });

        // A file deleted by hand takes its link with it; do not wait for expiry.
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                void this.forgetDeletedShare(file.path);
            }),
        );

        this.addCommand({
            id: 'share-file',
            icon: 'share',
            name: 'Share file with a Proton link',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension === 'md' || !this.isConfigured() || this.locked) {
                    return false;
                }
                if (!checking) {
                    this.openShareFileModal(file);
                }
                return true;
            },
        });

        // The same export from a note's context menu.
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (
                    file instanceof TFile &&
                    file.extension === 'md' &&
                    Platform.isDesktop &&
                    Platform.isDesktopApp &&
                    this.isConfigured() &&
                    !this.locked
                ) {
                    menu.addItem((item) =>
                        item
                            .setTitle('Export note to PDF and share')
                            .setIcon('link')
                            .onClick(() => this.openExportModal(file)),
                    );
                } else if (
                    file instanceof TFile &&
                    file.extension !== 'md' &&
                    this.isConfigured() &&
                    !this.locked
                ) {
                    menu.addItem((item) =>
                        item
                            .setTitle('Share file with a Proton link')
                            .setIcon('share')
                            .onClick(() => this.openShareFileModal(file)),
                    );
                }
            }),
        );

        this.addCommand({
            id: 'unlock',
            icon: 'lock-open',
            name: 'Unlock with PIN',
            checkCallback: (checking) => {
                if (!this.locked) {
                    return false;
                }
                if (!checking) {
                    void this.connect();
                }
                return true;
            },
        });

        this.addCommand({
            id: 'open-panel',
            icon: 'cloud',
            name: 'Open sync panel',
            callback: () => void this.openPanel(),
        });

        this.addCommand({
            id: 'copy-log',
            icon: 'clipboard-copy',
            name: 'Copy sync log',
            callback: () => void this.copyLog(),
        });
    }

    /** The note's public link on Drive, with Copy and Stop sharing, or a form to make one. */
    shareNote(path: string): void {
        new ShareModal(this.app, path, {
            load: () => runtime.engine.noteShareLink(path),
            create: (options) => runtime.engine.createNoteShareLink(path, options),
            remove: () => runtime.engine.removeNoteShareLink(path),
        }).open();
    }

    /**
     * Render a note to PDF, save it into the export folder, and share it with
     * a view-only public link, which is copied to the clipboard.
     *
     * Desktop only: the PDF is rendered through Electron's webview, which the
     * mobile app does not have. Only the exported PDF ever gets a public
     * link; there is deliberately no way to share a note itself from here. An
     * existing link for the export is reused rather than making a second one.
     */
    /** Ask for the link lifetime first; nothing is rendered before the answer. */
    openExportModal(file: TFile): void {
        new ExportPdfModal(this.app, {
            noteName: file.basename,
            defaultDays: this.settings.shareExpiryDays,
            onConfirm: (days) => void this.exportNoteToPdfAndShare(file.path, days),
        }).open();
    }

    /** List the exported PDFs that are still shared; stop sharing or delete. */
    openSharedPdfsModal(): void {
        const entries = sanitizeExportedShares(this.settings.exportedShares, (entry) => {
            runtime.logger.warn('Dropping a malformed exported-share entry.', entry);
        });
        const drop = (entry: { path: string; nodeUid: string }): void => {
            this.settings.exportedShares = this.settings.exportedShares.filter(
                (item) => !(item.path === entry.path && item.nodeUid === entry.nodeUid),
            );
        };
        new SharedPdfsModal(this.app, {
            entries,
            onStopSharing: async (entry) => {
                await runtime.engine.removeShareLinkByNodeUid(entry.nodeUid);
                drop(entry);
                await this.saveSettings();
            },
            onDelete: async (entry) => {
                if (!isExportPath(this.settings.exportFolder, entry.path)) {
                    throw new Error('that path is outside the export folder, so it was left alone');
                }
                const file = this.app.vault.getAbstractFileByPath(entry.path);
                if (file instanceof TFile) {
                    await this.app.fileManager.trashFile(file);
                }
                try {
                    await runtime.engine.removeShareLinkByNodeUid(entry.nodeUid);
                } catch {
                    // The link dies with the file on Drive; the registry entry
                    // still has to go, or it would be retried forever.
                }
                drop(entry);
                await this.saveSettings();
            },
        }).open();
    }


    /** A PDF just appeared from Obsidian's exporter: share it as an export. */
    private async shareExportedPdf(file: TFile, expiryDays: number): Promise<void> {
        try {
            new Notice('Uploading the PDF…');
            const nodeUid = await this.waitForExportNodeUid(file.path);
            new Notice('Creating the share link…');
            const expiration = shareExpiration(expiryDays);
            const link = await withTimeout(
                runtime.engine.createNoteShareLink(file.path, expiration ? { expiration } : {}),
                30000,
                'creating the share link timed out',
            );
            this.settings.exportedShares = upsertExportedShare(
                this.settings.exportedShares,
                buildExportedShare(file.path, link, runtime.engine.nodeUidFor(file.path) ?? nodeUid, 'export'),
            );
            await this.saveSettings();
            new ShareLinkModal(this.app, {
                url: link.url,
                filePath: file.path,
                expiresAt: link.expiration?.getTime() ?? null,
            }).open();
        } catch (error) {
            new Notice(`Could not share the PDF: ${errorMessage(error)}`);
        }
    }

    /** Share any vault file (an image, a PDF, a zip) with a view-only link. */
    openShareFileModal(file: TFile): void {
        new ExportPdfModal(this.app, {
            noteName: file.name,
            defaultDays: this.settings.shareExpiryDays,
            title: 'Share file with a link',
            intro: `“${file.name}” will get a view-only public link. The file stays in the vault and on Drive; only the link expires.`,
            confirmText: 'Create link',
            onConfirm: (days) => void this.shareFileWithLink(file.path, days),
        }).open();
    }

    async shareFileWithLink(sourcePath: string, expiryDays: number | null): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) {
            new Notice('That file is not in the vault any more.');
            return;
        }
        if (!this.isConfigured() || this.locked || !runtime.engine.isConnected()) {
            new Notice('Sign in and wait for the sync to connect before sharing.');
            return;
        }
        try {
            new Notice('Waiting for the file to reach Drive…');
            const nodeUid = await this.waitForExportNodeUid(sourcePath);
            const expiration = shareExpiration(expiryDays === null ? 0 : expiryDays);
            new Notice('Creating the share link…');
            const link = await withTimeout(
                runtime.engine.createNoteShareLink(sourcePath, expiration ? { expiration } : {}),
                30000,
                'creating the share link timed out',
            );
            if (link.hasPassword) {
                new Notice('That file already has a password-protected link; remove the password on Drive first.');
                return;
            }
            this.settings.exportedShares = upsertExportedShare(
                this.settings.exportedShares,
                buildExportedShare(sourcePath, link, runtime.engine.nodeUidFor(sourcePath) ?? nodeUid, 'attachment'),
            );
            await this.saveSettings();
            new ShareLinkModal(this.app, {
                url: link.url,
                filePath: sourcePath,
                expiresAt: link.expiration?.getTime() ?? null,
            }).open();
        } catch (error) {
            new Notice(`Could not share this file: ${errorMessage(error)}`);
        }
    }

    /** Drop the registry entry (and best-effort link) when its file is deleted. */
    private async forgetDeletedShare(path: string): Promise<void> {
        const entry = this.settings.exportedShares.find((item) => item.path === path);
        if (entry === undefined) {
            return;
        }
        try {
            await runtime.engine.removeShareLinkByNodeUid(entry.nodeUid);
        } catch {
            // The node is gone on Drive too, so the link is dead either way.
        }
        this.settings.exportedShares = this.settings.exportedShares.filter((item) => item !== entry);
        try {
            await this.saveSettings();
        } catch (error) {
            runtime.logger.warn('Could not save the registry after a file was deleted.', error);
        }
    }

    /** At expiry an attachment keeps its bytes: only the link goes. */
    private async expireAttachmentShares(): Promise<void> {
        const now = Date.now();
        const due = selectExpiredShares(sanitizeExportedShares(this.settings.exportedShares, () => undefined), now).filter(
            (entry) => (entry.kind ?? 'export') === 'attachment',
        );
        if (due.length === 0) {
            return;
        }
        const connected = this.isConfigured() && !this.locked && runtime.engine.isConnected();
        let changed = false;
        for (const entry of due) {
            if (connected) {
                try {
                    await runtime.engine.removeShareLinkByNodeUid(entry.nodeUid);
                } catch (error) {
                    runtime.logger.warn('Could not remove an expired attachment link; it is kept for the next run.', error);
                    continue;
                }
            }
            this.settings.exportedShares = this.settings.exportedShares.filter((item) => item !== entry);
            changed = true;
        }
        if (changed) {
            try {
                await this.saveSettings();
            } catch (error) {
                runtime.logger.warn('Could not save the registry after expiring attachment links.', error);
            }
        }
    }

    async exportNoteToPdfAndShare(sourcePath?: string, expiryDays: number | null | undefined = undefined): Promise<void> {
        if (!Platform.isDesktop || !Platform.isDesktopApp) {
            new Notice('Exporting a note to PDF needs the desktop app.');
            return;
        }
        const file =
            sourcePath !== undefined
                ? this.app.vault.getAbstractFileByPath(sourcePath)
                : this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== 'md') {
            new Notice('Open a note first, then export it.');
            return;
        }
        if (!this.isConfigured() || this.locked || !runtime.engine.isConnected()) {
            new Notice('Sign in and wait for the sync to connect before exporting.');
            return;
        }
        const expiry = expiryDays === null ? 0 : (expiryDays ?? this.settings.shareExpiryDays);
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view === null || view.file?.path !== file.path) {
            new Notice('Open the note first, then export it.');
            return;
        }
        await this.ensureExportFolder(this.settings.exportFolder);
        const exportPath = resolveExportPath(
            this.settings.exportFolder,
            exportPdfName(file.basename),
            (path) => this.app.vault.getAbstractFileByPath(path) !== null,
        );
        try {
            new Notice('Rendering the PDF…');
            const pdf = await withTimeout(this.renderNoteToPdf(file), 60000, 'rendering the PDF timed out');
            const buffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
            const previous = this.app.vault.getAbstractFileByPath(exportPath);
            if (previous instanceof TFile) {
                await this.app.vault.modifyBinary(previous, buffer);
            } else {
                await this.app.vault.createBinary(exportPath, buffer);
            }
            const written = this.app.vault.getAbstractFileByPath(exportPath);
            if (!(written instanceof TFile)) {
                throw new Error('the PDF was not written to the vault');
            }
            await this.shareExportedPdf(written, expiry);
        } catch (error) {
            new Notice(`Could not export this note: ${errorMessage(error)}`);
        }
    }

    /**
     * Render a note to PDF in a throwaway BrowserWindow.
     *
     * `<webview>` printing returned blank pages and its guest cannot reach
     * `ipcRenderer`; `MarkdownView.printToPdf()` always opens a save dialog.
     * The Electron remote module is available in Obsidian, so the rendered
     * HTML goes into a hidden window and its `webContents.printToPDF` writes
     * the bytes — no dialog, no webview.
     */
    /**
     * Turn embedded files into bytes the hidden window can show: images become
     * data URLs (an `app://` URL does not resolve from a data-URL page), and
     * embedded notes are rendered recursively, up to a small depth.
     */
    private async inlineEmbeds(root: HTMLElement, sourcePath: string, component: Component, depth: number): Promise<void> {
        const images = Array.from(root.querySelectorAll('img'));
        let budget = 25 * 1024 * 1024;
        for (const img of images) {
            const src = img.getAttribute('src');
            if (!src || /^(https?:|data:|blob:)/i.test(src)) {
                continue;
            }
            const target = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
            if (!(target instanceof TFile) || budget <= 0) {
                continue;
            }
            const data = await this.app.vault.readBinary(target);
            if (data.byteLength > budget) {
                continue;
            }
            budget -= data.byteLength;
            const mime = mimeForExtension(target.extension);
            img.setAttribute('src', `data:${mime};base64,${Buffer.from(data).toString('base64')}`);
        }
        if (depth >= 3) {
            return;
        }
        for (const embed of Array.from(root.querySelectorAll('.internal-embed[src], .markdown-embed[src]'))) {
            const link = embed.getAttribute('src');
            if (!link) {
                continue;
            }
            const target = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
            if (!(target instanceof TFile) || target.extension !== 'md') {
                continue;
            }
            const markdown = await this.app.vault.read(target);
            const inner = createDiv();
            await MarkdownRenderer.render(this.app, markdown, inner, target.path, component);
            await this.inlineEmbeds(inner, target.path, component, depth + 1);
            embed.empty();
            embed.appendChild(inner);
        }
    }

    private async renderNoteToPdf(note: TFile): Promise<Uint8Array> {
        const nodeRequire = (window as unknown as { require: (module: string) => unknown }).require;
        const electron = nodeRequire('electron') as {
            remote?: {
                BrowserWindow?: new (options: Record<string, unknown>) => {
                    loadURL(url: string): Promise<void>;
                    webContents: { printToPDF(options: Record<string, unknown>): Promise<Uint8Array> };
                    destroy(): void;
                };
            };
        };
        const BrowserWindow = electron.remote?.BrowserWindow;
        if (BrowserWindow === undefined) {
            throw new Error('Electron remote is not available in this build');
        }
        const markdown = await this.app.vault.read(note);
        const component = new Component();
        const rendered = createDiv();
        try {
            await MarkdownRenderer.render(this.app, markdown, rendered, note.path, component);
            await this.inlineEmbeds(rendered, note.path, component, 0);
            const css =
                'html,body{margin:0;padding:24px;background:#fff;color:#000;font-family:var(--font-text, sans-serif);}' +
                'img{max-width:100%;}pre,code{white-space:pre-wrap;word-break:break-word;}' +
                'table{border-collapse:collapse;}th,td{border:1px solid #ccc;padding:4px 8px;}' +
                '.internal-embed,.markdown-embed{display:block;border-left:2px solid #ddd;padding-left:10px;margin:8px 0;}' +
                '.markdown-embed-title{font-weight:600;margin-bottom:4px;}';
            const html =
                `<!doctype html><html><head><meta charset="utf-8">` +
                `<base href="app://obsidian.md/"><style>${css}</style></head><body>` +
                sanitizeExportHtml(rendered.innerHTML) +
                `</body></html>`;
            const win = new BrowserWindow({
                show: false,
                width: 800,
                height: 600,
                webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
            });
            try {
                await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
                await new Promise((resolve) => window.setTimeout(resolve, 300));
                const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
                return new Uint8Array(pdf);
            } finally {
                win.destroy();
            }
        } finally {
            component.unload();
        }
    }

    /** Create the export folder (and its parents) when it does not exist yet. */
    /** Create the export folder (and its parents) when it does not exist yet. */
    private async ensureExportFolder(folder: string): Promise<void> {
        const clean = normalizeExportFolder(folder);
        if (clean === '') {
            return;
        }
        let path = '';
        for (const segment of clean.split('/')) {
            path = path === '' ? segment : `${path}/${segment}`;
            if (this.app.vault.getAbstractFileByPath(path) === null) {
                await this.app.vault.createFolder(path);
            }
        }
    }

    /**
     * Print the webview through Obsidian's `print-to-pdf` IPC: the main
     * process prints the sender's webContents and writes it to `filepath`,
     * then signals back. The host-side `webview.printToPDF` returned blank
     * pages; this is the path the built-in export takes.
     */
    private async printWebviewToPdf(webview: PdfWebview): Promise<Uint8Array> {
        const nodeRequire = (window as unknown as { require: (module: string) => unknown }).require;
        const os = nodeRequire('node:os') as { tmpdir(): string };
        const fs = nodeRequire('node:fs/promises') as {
            stat(path: string): Promise<{ size: number }>;
            readFile(path: string): Promise<Uint8Array>;
            unlink(path: string): Promise<void>;
        };
        const path = nodeRequire('node:path') as { join(...parts: string[]): string };
        const target = path.join(os.tmpdir(), `pss-export-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
        await webview.executeJavaScript(
            `(() => {` +
                `  const { ipcRenderer } = require('electron');` +
                `  ipcRenderer.send('print-to-pdf', { filepath: ${JSON.stringify(target)}, printBackground: true, pageSize: 'A4' });` +
                `  return true;` +
                `})()`,
        );
        const deadline = Date.now() + 30000;
        for (;;) {
            try {
                const stat = await fs.stat(target);
                if (stat.size > 0) {
                    break;
                }
            } catch {
                // Not written yet.
            }
            if (Date.now() > deadline) {
                throw new Error('printing the PDF timed out');
            }
            await new Promise((resolve) => window.setTimeout(resolve, 200));
        }
        const bytes = await fs.readFile(target);
        await fs.unlink(target).catch(() => undefined);
        return new Uint8Array(bytes);
    }

    /**
     * Render a note's Markdown to PDF bytes through a hidden Electron webview.
     *
     * The page starts at `app://obsidian.md/help.html` — its origin is what
     * lets the webview reach the vault's local resources — then the rendered
     * note replaces the body for `printToPDF`. Embedded images are pointed at
     * their local resource URLs first; anything the renderer already resolved
     * rides on its own output.
     */
    /** Wait until the engine has uploaded a path and its record names the Drive node. */
    private async waitForExportNodeUid(path: string): Promise<string> {
        const deadline = Date.now() + EXPORT_NODE_WAIT_MS;
        for (;;) {
            const nodeUid = runtime.engine.nodeUidFor(path);
            if (nodeUid !== null) {
                return nodeUid;
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    'the exported PDF has not synced to Proton Drive yet; ' +
                        'share it from the sync panel once it has',
                );
            }
            await new Promise((resolve) => window.setTimeout(resolve, EXPORT_NODE_POLL_MS));
        }
    }

    /**
     * Trash expired exported PDFs, and drop their links. Runs on load and
     * once a day.
     *
     * Only registry entries strictly inside the export folder are ever
     * touched, so a misconfigured folder cannot delete notes — not even the
     * folder itself counts. A link is only removed once its file is gone one
     * way or the other: trashed just now, or already gone. If trashing fails
     * the entry is kept for the next run, never dropped, so a transient
     * failure cannot strand a live link the janitor will never revisit.
     * Trashing goes through the file manager, so the user's deletion
     * preference (Obsidian trash, system trash) is honoured — a deliberate
     * deviation from the "Obsidian trash only" spec, which the plugin-review
     * lint forbids enforcing here. Either way the sync carries the deletion
     * to Drive, where the link dies with the file.
     */
    async runExportJanitor(): Promise<void> {
        await this.expireAttachmentShares();
        if (!this.settings.autoDeleteExpiredExports) {
            return;
        }
        const folder = this.settings.exportFolder;
        const registry = sanitizeExportedShares(this.settings.exportedShares, (entry) => {
            runtime.logger.warn('Dropping a malformed exported-share entry; it is never unshared or trashed.', entry);
        });
        const now = Date.now();
        const due = selectJanitorDeletions(registry, now, folder);
        if (due.length === 0) {
            if (registry.length !== this.settings.exportedShares.length) {
                this.settings.exportedShares = registry;
                try {
                    await this.saveSettings();
                } catch (error) {
                    runtime.logger.warn('Could not save the cleaned export registry.', error);
                }
            }
            return;
        }
        const connected = this.isConfigured() && !this.locked && runtime.engine.isConnected();
        const removed = new Set<string>();
        let trashFailures = 0;
        for (const entry of due) {
            // One bad entry must never stop the run.
            try {
                const file = this.app.vault.getAbstractFileByPath(entry.path);
                const plan = janitorEntryPlan(
                    isExportPath(folder, entry.path),
                    file instanceof TFile ? 'file' : file === null || file === undefined ? 'gone' : 'other',
                );
                if (plan === 'leave') {
                    continue;
                }
                if (plan === 'trash-then-unshare') {
                    // The plan says `file` above; re-checked so the trash
                    // call narrows instead of casting.
                    if (!(file instanceof TFile)) {
                        continue;
                    }
                    try {
                        // The user's trash preference (Obsidian or system): the review lint forbids forcing one.
                        await this.app.fileManager.trashFile(file);
                    } catch {
                        // Kept, retried next run; counted for one summary
                        // warning below instead of one line per entry.
                        trashFailures += 1;
                        continue;
                    }
                }
                if (connected) {
                    try {
                        await runtime.engine.removeShareLinkByNodeUid(entry.nodeUid);
                    } catch (error) {
                        runtime.logger.warn(`Could not remove the expired share link for "${entry.path}"`, error);
                        continue;
                    }
                }
                removed.add(entry.path);
            } catch (error) {
                runtime.logger.warn('Could not clean up an expired export; it is kept for the next run.', error);
            }
        }
        if (trashFailures > 0) {
            runtime.logger.warn(
                `Kept ${trashFailures} expired export(s): trashing failed; will retry on the next run.`,
            );
        }
        const next = registry.filter((share) => !removed.has(share.path));
        if (next.length !== this.settings.exportedShares.length) {
            this.settings.exportedShares = next;
            try {
                await this.saveSettings();
            } catch (error) {
                runtime.logger.warn('Could not save the cleaned export registry.', error);
            }
        }
    }

    private registerVaultEvents(): void {
        const { vault } = this.app;

        this.registerEvent(vault.on('create', (file) => this.onFileChanged(file)));
        this.registerEvent(vault.on('modify', (file) => this.onFileChanged(file)));
        this.registerEvent(
            vault.on('delete', (file) => {
                if (file instanceof TFolder) {
                    runtime.engine.onVaultFolderDelete(file.path);
                } else {
                    this.onFileChanged(file);
                }
            }),
        );
        this.registerEvent(
            vault.on('rename', (file, oldPath) => {
                runtime.engine.onVaultRename(oldPath, file.path, file instanceof TFolder);
            }),
        );
    }

    private onFileChanged(file: TAbstractFile): void {
        // Folder creation arrives here too; it is handled by the full sync,
        // since an empty folder has no content to upload.
        if (file instanceof TFile) {
            runtime.engine.onVaultChange(file.path);
        }
    }

    private onSyncChange(summary: SyncSummary): void {
        const held = summary.pendingMassDelete?.count ?? 0;
        if (held > 0 && (this.summary.pendingMassDelete?.count ?? 0) === 0) {
            this.notify(
                `${held} item(s) in the Drive folder are not in this vault any more. Nothing has been deleted on ` +
                    'Drive: open the sync panel to keep them or trash them.',
            );
        }
        if (summary.status === 'folder-missing' && this.summary.status !== 'folder-missing') {
            this.notify(
                `${summary.lastError ?? 'the Drive folder this vault syncs with is missing'}. Nothing syncs until it is ` +
                    'restored on Proton Drive, or another folder is chosen: click the status bar item, or Choose folder in the sync panel.',
            );
        }
        this.showStatus(summary);
        runtime.devices.noteStatus(summary);
    }

    /** Show a summary everywhere the sync's state appears. */
    private showStatus(summary: SyncSummary): void {
        this.summary = summary;
        this.statusBar.update(summary);
        this.updateNoteIndicators();
        this.refreshSettingsTab();
        if (this.ribbonIcon) {
            setIcon(this.ribbonIcon, statusIcon(summary));
            this.ribbonIcon.toggleClass('proton-sdk-sync-spin', statusSpins(summary));
            setTooltip(this.ribbonIcon, `Proton-SDK-Sync: ${statusLabel(summary)}`);
        }
        for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW)) {
            if (leaf.view instanceof SyncPanelView) {
                leaf.view.update(summary);
            }
        }
    }

    /**
     * Rebuild the settings tab when something it shows has changed.
     *
     * Obsidian reads a tab's setting definitions when the tab is added, at
     * plugin load, and again only when the plugin calls `update()`; opening
     * the settings just redraws what it read then. At load the saved sign-in
     * has not been restored yet, so without this the tab would keep showing
     * a vault signed in last week as signed out, and hide what depends on
     * being signed in, such as the PIN. Keyed, so the progress updates that
     * arrive several times a second during a sync do not rebuild it each time.
     */
    refreshSettingsTab(): void {
        if (!this.settingsTab) {
            return;
        }
        const key = JSON.stringify([
            runtime.session.isSignedIn(),
            runtime.session.accountEmail,
            this.locked,
            this.pinEnabled,
            this.settings.remoteFolderUid,
            this.settings.remoteFolderPath,
            this.settings.conflictPolicy,
            this.summary?.conflicts,
        ]);
        if (key === this.settingsTabKey) {
            return;
        }
        this.settingsTabKey = key;
        // A rebuild replaces the fields, so doing it while someone is typing in
        // one of them (the exclude patterns, a size limit) drops the caret. Wait
        // until the tab loses focus, then show what changed.
        if (this.settingsTab.containerEl.contains(activeDocument.activeElement)) {
            this.settingsTabDirty = true;
            return;
        }
        this.settingsTab.update();
    }

    /** Re-show the current summary, so "synced 5m ago" keeps counting. */
    private refreshStatus(): void {
        if (this.summary) {
            this.showStatus(this.summary);
        }
    }

    /**
     * Show whether the note in view is in sync: a pulsing dot beside the
     * status-bar icon on desktop, green when it is and red when it has changes
     * not synced yet; on mobile, where there is no status bar, the same dot as
     * a button in each note's header, which turns into a spinning sync icon
     * while that note transfers and opens the sync panel when tapped. Hidden
     * when there is no sync to speak of: signed out, no folder, or locked.
     */
    private updateNoteIndicators(): void {
        const shown = this.isConfigured() && !this.locked;
        const active = this.app.workspace.getActiveFile();
        this.statusBar.setNote(shown && active ? this.indicatorFor(active) : null);
        for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW)) {
            if (leaf.view instanceof SyncPanelView) {
                leaf.view.noteChanged();
            }
        }

        if (!Platform.isMobile) {
            return;
        }
        // A closed view took its button with it; the list should stay as long
        // as the notes that are open.
        for (const el of this.noteActionEls) {
            if (!el.isConnected) {
                this.noteActionEls.delete(el);
            }
        }
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) {
                continue;
            }
            let action = this.noteActions.get(view);
            if (!shown) {
                action?.hide();
                continue;
            }
            if (!action) {
                action = view.addAction('circle', 'Sync status', () => void this.openPanel());
                action.addClass('proton-sdk-sync-note-action');
                this.noteActions.set(view, action);
                this.noteActionEls.add(action);
            }
            action.show();
            renderNoteAction(action, this.indicatorFor(view.file));
        }
    }

    /** Take the per-note header buttons down; registered to run when the plugin unloads. */
    private removeNoteActions(): void {
        for (const action of this.noteActionEls) {
            action.remove();
        }
        this.noteActionEls.clear();
    }

    /**
     * The editor a note is open in, for the engine to bring a downloaded
     * version in through it instead of writing under it.
     */
    private openEditor(path: string): OpenEditor | null {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === path) {
                const editor = view.editor;
                return {
                    text: () => editor.getValue(),
                    replace: (next) => {
                        // Only the part that differs is replaced, so the
                        // editor maps the cursor and selection through the
                        // change instead of resetting them.
                        const current = editor.getValue();
                        if (current === next) {
                            return;
                        }
                        let start = 0;
                        while (start < current.length && start < next.length && current[start] === next[start]) {
                            start++;
                        }
                        let end = 0;
                        while (
                            end < current.length - start &&
                            end < next.length - start &&
                            current[current.length - 1 - end] === next[next.length - 1 - end]
                        ) {
                            end++;
                        }
                        editor.replaceRange(
                            next.slice(start, next.length - end),
                            editor.offsetToPos(start),
                            editor.offsetToPos(current.length - end),
                        );
                    },
                };
            }
        }
        return null;
    }

    /**
     * Bring back an earlier version of a note: write it into the note, so the
     * sync uploads it as a new version and every safeguard of an ordinary edit
     * applies. Through the editor when the note is open, so the cursor stays
     * and nothing typed meanwhile is written over; else through the vault.
     */
    async restoreVersion(path: string, data: ArrayBuffer): Promise<void> {
        const file = this.app.vault.getFileByPath(path);
        if (!file) {
            throw new Error('the note no longer exists');
        }
        const editor = this.openEditor(path);
        if (editor) {
            editor.replace(new TextDecoder().decode(data));
            return;
        }
        await this.app.vault.modifyBinary(file, data);
    }

    /** Whether a note has changes that have not reached Drive yet. */
    hasUnsyncedChanges(path: string): boolean {
        const file = this.app.vault.getFileByPath(path);
        const stat = file ? { size: file.stat.size, mtime: file.stat.mtime } : null;
        return runtime.engine.noteSyncState(path, stat) === 'pending';
    }

    private indicatorFor(file: TFile): NoteIndicator {
        const state = runtime.engine.noteSyncState(file.path, { size: file.stat.size, mtime: file.stat.mtime });
        return noteIndicator(
            state,
            runtime.engine.pendingChanges().find((change) => change.path === file.path),
        );
    }

    /**
     * Ask about deletions a pass held back.
     *
     * Nothing is deleted until the answer is "trash": the modal's default is to
     * keep the files on Drive and download them back, which is what recovers an
     * unmounted card or a folder emptied outside Obsidian.
     */
    reviewMassDelete(): void {
        const pending = runtime.engine.pendingMassDelete();
        if (!pending) {
            return;
        }
        new MassDeleteModal(this.app, pending, (choice) => {
            if (choice === 'trash') {
                void runtime.engine.approveMassDelete();
            } else if (choice === 'keep') {
                void runtime.engine.denyMassDelete();
            }
        }).open();
    }

    /** Reveal the sync panel, opening it in the right sidebar if it is not open yet. */
    async openPanel(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(SYNC_PANEL_VIEW)[0];
        if (!leaf) {
            const created = workspace.getRightLeaf(false);
            if (!created) {
                return;
            }
            await created.setViewState({ type: SYNC_PANEL_VIEW, active: true });
            leaf = created;
        }
        await workspace.revealLeaf(leaf);
    }

    /**
     * Collect conflicts briefly before telling the user, so a sync that finds
     * twenty of them shows one notice, not twenty.
     */
    private onConflict(event: ConflictEvent): void {
        void runtime.conflictHistory.add(event);
        runtime.pendingConflicts.push(event);
        if (this.conflictNoticeTimer !== null) {
            return;
        }
        this.conflictNoticeTimer = window.setTimeout(() => {
            this.conflictNoticeTimer = null;
            showConflictNotice(this.app, runtime.pendingConflicts.splice(0), {
                reviewConflicts: () => new ConflictsModal(this.app, this).open(),
                compare: (path, copyPath) => compareWithConflictCopy(this.app, path, copyPath),
            });
        }, CONFLICT_NOTICE_DELAY_MS);
    }

    /**
     * Keep the plugin in step with the app's lifecycle.
     *
     * Leaving the app pushes pending edits out at once, because a mobile OS
     * may suspend or kill it before the debounce timer fires. Returning to it,
     * or getting the network back, checks Drive straight away instead of
     * waiting out a poll interval that may have been frozen in the background.
     */
    private registerLifecycleEvents(): void {
        // The current-note indicator follows the note in view and its edits.
        const update = () => this.updateNoteIndicators();
        this.registerEvent(this.app.workspace.on('active-leaf-change', update));
        this.registerEvent(this.app.workspace.on('layout-change', update));
        this.registerEvent(this.app.workspace.on('file-open', update));
        this.registerEvent(this.app.vault.on('modify', update));

        this.registerDomEvent(activeDocument, 'visibilitychange', () => {
            if (activeDocument.visibilityState === 'hidden') {
                runtime.engine.flushPendingEdits();
                // The OS may close the app from the background; save the
                // expiry as it stands.
                void this.rememberUnlock();
                return;
            }
            // Back from the background, perhaps after longer than the PIN's
            // time limit: timers do not run there, so check now.
            if (this.lockDue()) {
                void this.lockNow();
                return;
            }
            this.markActive();
            runtime.engine.pollNow();
        });

        // Using Obsidian restarts the PIN's clock, in this window and in any
        // pop-out: a pop-out is a window of its own, and a click there never
        // reaches this document.
        this.activity.watch(window);
        this.registerEvent(this.app.workspace.on('window-open', (win) => this.activity.watch(win.win)));
        this.registerEvent(this.app.workspace.on('window-close', (win) => this.activity.unwatch(win.win)));
        this.register(() => this.activity.stop());
        this.registerInterval(
            window.setInterval(() => {
                if (this.lockDue()) {
                    void this.lockNow();
                }
            }, LOCK_CHECK_MS),
        );
        this.registerDomEvent(window, 'online', () => runtime.engine.pollNow());

        // Moving between Wi-Fi and mobile data, for the "Wi-Fi only" setting.
        const connection = networkConnection();
        if (connection) {
            const onChange = () => runtime.engine.pollNow();
            connection.addEventListener('change', onChange);
            this.register(() => connection.removeEventListener('change', onChange));
        }
    }

    /**
     * Stable per-installation id, handed to the SDK.
     *
     * Drive marks an in-progress upload with the uid of the client that started
     * it. Keeping ours stable lets the SDK recognise a draft this installation
     * abandoned - after a crash, say - and clean it up on its own, instead of
     * stopping to ask whether another device's upload may be overwritten.
     *
     * Kept in Obsidian's local storage, which is per vault and per device,
     * rather than in `data.json`: a vault copied to a new device by hand
     * carries its `data.json` along, and two devices sharing one id could
     * discard each other's uploads in progress.
     */
    private installationId(): string {
        const stored = this.storedInstallationId();
        if (stored) {
            return stored;
        }
        const id = crypto.randomUUID();
        this.app.saveLocalStorage(CLIENT_UID_KEY, id);
        return id;
    }

    /**
     * The last device request acted on.
     *
     * The marker moved with the plugin id; seeding it from the old key stops
     * the first start after the switch from re-applying a pause or resume that
     * another device asked for weeks ago.
     */
    private handledRequestAt(): number {
        const stored = Number(this.app.loadLocalStorage(HANDLED_REQUEST_KEY));
        if (Number.isFinite(stored) && stored > 0) {
            return stored;
        }
        const legacy = Number(this.app.loadLocalStorage('proton-drive-sync-device-request-handled'));
        if (!Number.isFinite(legacy) || legacy <= 0) {
            return 0;
        }
        this.app.saveLocalStorage(HANDLED_REQUEST_KEY, legacy);
        return legacy;
    }

    private storedInstallationId(): string | null {
        const stored = this.app.loadLocalStorage(CLIENT_UID_KEY) as unknown;
        if (typeof stored === 'string' && stored) {
            return stored;
        }
        // The previous plugin stored this under its own id. Adopting it keeps
        // this device's entry in the shared device list instead of adding a twin.
        const legacy = this.app.loadLocalStorage('proton-drive-sync-client-uid') as unknown;
        if (typeof legacy === 'string' && legacy) {
            this.app.saveLocalStorage(CLIENT_UID_KEY, legacy);
            return legacy;
        }
        return null;
    }

    private pluginDir(): string {
        return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    }

    private pluginFile(name: string): string {
        return `${this.pluginDir()}/${name}`;
    }
}

/** What makes a conflict copy identifiable: the hostname on desktop, the platform on mobile. */
function defaultDeviceName(): string {
    if (Platform.isIosApp) {
        return Platform.isTablet ? 'iPad' : 'iPhone';
    }
    if (Platform.isAndroidApp) {
        return Platform.isTablet ? 'Android tablet' : 'Android phone';
    }
    try {
        const os = window.require('os') as { hostname(): string };
        return os.hostname();
    } catch {
        return 'this device';
    }
}

/** What the device list shows this device as running on. */
function platformName(): string {
    if (Platform.isIosApp) {
        return Platform.isTablet ? 'iPad' : 'iPhone';
    }
    if (Platform.isAndroidApp) {
        return Platform.isTablet ? 'Android tablet' : 'Android phone';
    }
    if (Platform.isMacOS) {
        return 'macOS';
    }
    if (Platform.isWin) {
        return 'Windows';
    }
    return Platform.isLinux ? 'Linux' : 'Desktop';
}

/** A pause or resume asked from another device, as this device's notice puts it. */
function requestNotice(request: DeviceRequest): string {
    const by = request.byName ? `"${request.byName}"` : 'another device';
    return `syncing on this device was ${request.state === 'paused' ? 'paused' : 'resumed'} from ${by}.`;
}

/** The mobile header button: a spinning sync icon while the note transfers, else the dot. */
function renderNoteAction(action: HTMLElement, note: NoteIndicator): void {
    action.empty();
    action.toggleClass('proton-sdk-sync-spin', note.transferring);
    if (note.transferring) {
        setIcon(action, 'refresh-cw');
    } else {
        action.createSpan({ cls: `proton-sdk-sync-note-dot mod-${note.state}` });
    }
    setTooltip(action, note.text);
    action.setAttr('aria-label', note.text);
}
