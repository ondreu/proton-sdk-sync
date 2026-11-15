import type { Logger } from '../util/logger';
import type { DriveIO } from './drive';
import { isTextPath } from './media';
import { mergeThreeWay } from './merge';
import { conflictCopyPath } from './paths';
import type { ConflictPolicy, ConflictReason, LocalState, RemoteState, SyncBase } from './types';

export type ConflictContext = {
    path: string;
    reason: ConflictReason;
    base?: SyncBase;
    local?: LocalState;
    remote?: RemoteState;
    /** Reads the local file's text, called only when a merge is attempted. */
    readLocalText: () => Promise<string>;
};

export type Resolution =
    /** Push the local copy; the remote one is superseded. */
    | { action: 'take-local' }
    /** Pull the remote copy; the local one is superseded. */
    | { action: 'take-remote' }
    /** Write these merged bytes locally, then upload them. */
    | { action: 'take-merged'; content: ArrayBuffer }
    /**
     * Keep both versions. `keepAtPath` says which one stays under the original
     * name; the other is written to `copyPath` beside it. Both are then synced,
     * so every device ends up holding the pair.
     */
    | { action: 'keep-both'; keepAtPath: 'local' | 'remote'; copyPath: string }
    /** Leave the file alone and wait for the user. */
    | { action: 'defer'; note: string };

export type ResolverOptions = {
    policy: ConflictPolicy;
    deviceName: string;
    /**
     * Whether a `prefer-*` policy leaves a sibling copy of the losing side.
     *
     * Only consulted when the two versions hold the same bytes, which need no
     * copy. Differing versions are always kept, whatever this says: the losing
     * side is then the only copy of that text.
     */
    keepConflictCopies: boolean;
    /**
     * Whether a `prefer-*` policy may discard the losing side at all.
     *
     * True everywhere a copy can be read again. False only for the config
     * folder, whose files are settled by rule: Obsidian and its plugins read
     * them by name, so a copy beside one is a file nothing would ever open.
     */
    keepLosingSide?: boolean;
};

/**
 * Turns a detected conflict into a concrete plan.
 *
 * `reconcile` deliberately stops at "these two versions disagree"; this is
 * where the user's policy is applied. The engine performs the resulting file
 * operations, so everything here is either a decision or the content work a
 * decision needs.
 *
 * The bias throughout is that no version of the user's text disappears without
 * them having asked for that: the default policy keeps both copies, and every
 * other policy that discards a side is honoured only because it was chosen
 * explicitly.
 */
export class ConflictResolver {
    constructor(
        private readonly drive: DriveIO,
        private readonly options: ResolverOptions,
        private readonly logger: Logger,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async resolve(context: ConflictContext): Promise<Resolution> {
        const { policy } = this.options;

        // A conflict between an edit and a deletion is not a choice between two
        // versions of the text — one side has no text at all. Merging is
        // meaningless and keeping "both" would just recreate the file, so the
        // surviving edit always wins, whatever the policy. The deletion can be
        // repeated; the lost edit cannot be recovered.
        if (context.reason === 'deleted-remotely-modified-locally') {
            this.logger.info(`"${context.path}" was deleted elsewhere but edited here; keeping the local edit`);
            return { action: 'take-local' };
        }
        if (context.reason === 'deleted-locally-modified-remotely') {
            this.logger.info(`"${context.path}" was deleted here but edited elsewhere; restoring the remote edit`);
            return { action: 'take-remote' };
        }

        switch (policy) {
            case 'manual':
                return { action: 'defer', note: 'Waiting for you to choose a version' };

            case 'prefer-local':
                return this.oneSided('local', context);

            case 'prefer-remote':
                return this.oneSided('remote', context);

            case 'prefer-newest':
                return this.byModificationTime(context);

            case 'merge': {
                const merged = await this.tryMerge(context);
                if (merged) {
                    return merged;
                }
                return this.keepBoth(context);
            }

            case 'keep-both':
            default:
                return this.keepBoth(context);
        }
    }

    /**
     * A one-sided policy: the chosen side takes the original filename, and the
     * other is kept beside it whenever the two differ. Where the content
     * differs the losing side is the only copy of that text, so it is written
     * out whatever `keepConflictCopies` says; that setting covers the case
     * where the versions are the same, which needs no copy.
     */
    private oneSided(winner: 'local' | 'remote', context: ConflictContext): Resolution {
        const differs = context.local !== undefined && context.remote !== undefined && context.local.hash !== context.remote.hash;
        const keepLoser = differs ? (this.options.keepLosingSide ?? true) : this.options.keepConflictCopies;
        if (!keepLoser) {
            return { action: winner === 'local' ? 'take-local' : 'take-remote' };
        }
        return this.keepBoth(context, winner);
    }

    private byModificationTime(context: ConflictContext): Resolution {
        const localTime = context.local?.mtime;
        const remoteTime = context.remote?.mtime;

        if (localTime === undefined || remoteTime === undefined) {
            // Drive only carries a modification time if the uploading client
            // recorded one. With nothing to compare, fall back to keeping both
            // rather than picking arbitrarily.
            this.logger.info(`"${context.path}": no comparable modification times, keeping both versions`);
            return this.keepBoth(context);
        }
        if (localTime === remoteTime) {
            return this.keepBoth(context);
        }
        return localTime > remoteTime ? this.oneSided('local', context) : this.oneSided('remote', context);
    }

    /**
     * Try to reconcile the two versions line by line.
     *
     * Needs the common ancestor, which is not stored locally but is still on
     * Drive as the revision the last sync recorded. When that revision has been
     * pruned, or either side is binary, or the edits overlap, this returns null
     * and the caller keeps both copies instead.
     */
    private async tryMerge(context: ConflictContext): Promise<Resolution | null> {
        const { base, local, remote, path } = context;
        if (!base || !remote || !isMergeable(path, local, remote)) {
            return null;
        }

        let baseText: string | null;
        let remoteText: string | null;
        let localText: string;
        try {
            const [baseBytes, remoteBytes] = await Promise.all([
                this.drive.downloadRevision(base.remoteRevisionUid),
                // The revision the conflict was found on, not whatever is
                // active by now, so the merge sees the version it decided on.
                this.drive.downloadRevision(remote.revisionUid),
            ]);
            baseText = decodeUtf8(baseBytes);
            remoteText = decodeUtf8(remoteBytes);
            localText = await context.readLocalText();
        } catch (error) {
            this.logger.info(`Could not fetch the common ancestor of "${path}" to merge it`, error);
            return null;
        }

        if (baseText === null || remoteText === null) {
            // A note saved in a legacy encoding has no replacement character in
            // the file: decoding it with the errors smoothed over would merge
            // U+FFFD into the text and write that back. Both copies stay.
            this.logger.info(`Could not merge "${path}": it is not UTF-8 text; keeping both versions`);
            return null;
        }

        const result = mergeThreeWay(baseText, localText, remoteText);
        if (!result.merged) {
            this.logger.info(`Could not merge "${path}" (${result.reason}); keeping both versions`);
            return null;
        }

        this.logger.info(`Merged concurrent edits to "${path}"`);
        return { action: 'take-merged', content: new TextEncoder().encode(result.text).buffer };
    }

    /**
     * Local keeps the original filename by default: it is the version the user
     * may have open in an editor right now, and having it replaced underneath
     * them is the one outcome that feels like the plugin lost their work even
     * when nothing was lost.
     */
    private keepBoth(context: ConflictContext, keepAtPath: 'local' | 'remote' = 'local'): Resolution {
        return {
            action: 'keep-both',
            keepAtPath,
            copyPath: conflictCopyPath(context.path, this.options.deviceName, this.now()),
        };
    }
}

/** Above this, a merge is declined before anything is downloaded. */
export const MAX_MERGE_BYTES = 4 * 1024 * 1024;

/**
 * Only text is worth fetching two revisions of to attempt a merge. An image or
 * a video would be downloaded twice, decoded as text, and declined anyway.
 */
function isMergeable(path: string, local: LocalState | undefined, remote: RemoteState): boolean {
    return isTextPath(path) && (local?.size ?? 0) <= MAX_MERGE_BYTES && (remote.size ?? 0) <= MAX_MERGE_BYTES;
}

/**
 * `data` as text, or null when it is not valid UTF-8.
 *
 * The bytes are taken at their word rather than with the errors replaced: a
 * file saved in cp1252 or Latin-2 would otherwise come back full of U+FFFD,
 * which a merge cannot tell apart from text the user wrote.
 */
function decodeUtf8(data: ArrayBuffer): string | null {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        return null;
    }
}
