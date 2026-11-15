import { Platform, TFile, type App, type DataAdapter, type TAbstractFile } from 'obsidian';

import { DEFAULT_MOBILE_MAX_FILE_MB } from '../settings';
import { sha1Hex } from '../util/hash';
import type { Logger } from '../util/logger';
import type { UploadSource } from './drive';
import { mediaTypeOf } from './media';
import { ancestorPaths, basename, joinPath, parentPath, staysInVault } from './paths';
import { imageThumbnails } from './thumbnails';
import type { LocalState, SyncBase } from './types';

/**
 * Above this size a file is streamed from and to disk instead of being held in
 * memory whole. Videos and large PDFs are the usual attachments that cross it;
 * reading a multi-gigabyte recording into a single buffer is how a renderer
 * process runs out of memory, and Node refuses buffers over 2 GiB outright.
 */
export const LARGE_FILE_BYTES = 32 * 1024 * 1024;

/**
 * The size at which a phone or tablet refuses to read a file at all, in bytes.
 *
 * Kept equal to the value `mobileMaxFileSizeMb` starts with: the engine passes
 * its own limit in (see {@link defaultSizeLimit}), and this is what anything
 * that does not say gets, so a device cannot be made to read a whole video into
 * memory by a missing setting.
 */
export const DEFAULT_MOBILE_MAX_FILE_BYTES = DEFAULT_MOBILE_MAX_FILE_MB * 1024 * 1024;

/** The limit a caller that says nothing gets: the mobile default on a phone, none on the desktop. */
export function defaultSizeLimit(): number {
    return Platform.isMobile ? DEFAULT_MOBILE_MAX_FILE_BYTES : Infinity;
}

/**
 * Thrown before a file over the size limit is read or downloaded.
 *
 * The caller is expected to leave the path alone and say why, not to retry:
 * the file is not going to get smaller, and reading it is what the limit is
 * there to prevent. Nothing has been read when this is thrown.
 */
export class FileTooLargeError extends Error {
    constructor(
        readonly path: string,
        /** The file's size, in bytes. */
        readonly size: number,
        /** The limit it is over, in bytes. */
        readonly limit: number,
    ) {
        super(`"${path}" is ${megabytes(size)} MB, over this device's limit of ${megabytes(limit)} MB`);
        this.name = 'FileTooLargeError';
    }
}

/** Read size when streaming. Matches Drive's block size, so each read feeds one block. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** How long a path stays held as ours when nothing can say what the file looks like; see {@link VaultIO.claims}. */
const SELF_WRITE_HOLD_MS = 2000;

/**
 * What tells one version of a file from the next: its size and modification
 * time, and the change time and inode where the platform reports them.
 */
export type FileStamp = {
    size: number;
    mtime: number;
    /**
     * When the inode last changed, from the filesystem itself. Not Obsidian's
     * `Stat.ctime`, which is when the file was created.
     */
    ctime?: number;
    ino?: number;
};

/**
 * Whether two looks at a file found the same version of it.
 *
 * Size and mtime alone miss an edit on FAT and exFAT, where mtime moves in
 * two-second steps: two saves inside one step leave both unchanged. A change
 * time or an inode that moved says the file was written again. A field the
 * platform does not report is no opinion either way, so nothing is lost where
 * neither is available.
 */
export function sameVersion(a: FileStamp, b: FileStamp): boolean {
    if (a.size !== b.size || a.mtime !== b.mtime) {
        return false;
    }
    if (a.ctime !== undefined && b.ctime !== undefined && a.ctime !== b.ctime) {
        return false;
    }
    return !(a.ino !== undefined && b.ino !== undefined && a.ino !== b.ino);
}

/** A size for a log line or an error message, in whole megabytes. */
function megabytes(bytes: number): number {
    return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

/** What we left at a path, so the vault event for it can be told from a user's edit; see {@link VaultIO.claims}. */
type Claim =
    /** The file we wrote, as it looked when we finished. */
    | { kind: 'version'; stamp: FileStamp }
    /** We moved or removed it, so nothing of ours is at that path any more. */
    | { kind: 'gone' }
    /** Nothing could say what the path looks like, so it is held for a moment instead. */
    | { kind: 'until'; until: number };

type DesktopModules = {
    fs: typeof import('fs').promises;
    /**
     * The same module unsynchronised, for the one question that has to be
     * answered without awaiting: whether the file a vault event names is still
     * the one this plugin wrote.
     */
    sync: typeof import('fs');
    createHash: typeof import('crypto').createHash;
};

let desktopModules: DesktopModules | null | undefined;

/**
 * Node's `fs` and `crypto`, which only exist on desktop.
 *
 * Loaded on first use rather than imported: on Android and iOS there is no
 * Node, and a top-level `require('fs')` would stop the plugin from loading at
 * all. Without them, files are read and written whole through the adapter.
 */
function nodeModules(): DesktopModules | null {
    if (desktopModules === undefined) {
        desktopModules = null;
        if (Platform.isDesktopApp) {
            try {
                desktopModules = {
                    fs: (window.require('fs') as typeof import('fs')).promises,
                    sync: window.require('fs') as typeof import('fs'),
                    createHash: (window.require('crypto') as typeof import('crypto')).createHash,
                };
            } catch {
                // Not reachable from this renderer; stay on the adapter.
            }
        }
    }
    return desktopModules;
}

/** Where a download lands before it is complete. */
export type FileSink = {
    sink: WritableStream<Uint8Array>;
    /** Move the finished download into place and report the state it landed in. */
    commit: (mtime?: number) => Promise<LocalState>;
    /** Throw the partial download away. */
    abort: () => Promise<void>;
};

/**
 * The vault side of the sync: listing, reading and writing files.
 *
 * Changes to files Obsidian indexes go through its Vault API, as Obsidian's
 * plugin guidelines ask: it runs file operations one after another and keeps
 * its cache in step, and deleting through `FileManager.trashFile` honours the
 * user's "Deleted files" setting. Paths it does not index, the config folder
 * and anything else whose name starts with a dot, go through the adapter, the
 * only API that can reach them. Reads and listings use the adapter
 * throughout, since only it sees those paths and reports mtimes.
 */
export class VaultIO {
    private readonly adapter: DataAdapter;

    /**
     * Paths this plugin is writing right now.
     *
     * Obsidian reports our own writes back through the same vault events a user
     * edit produces. Without this, every download would immediately look like a
     * local change and be uploaded straight back — a loop that ends in an
     * unbounded chain of revisions.
     *
     * Counted rather than a plain set, so that two overlapping operations on
     * the same path cannot release each other's hold early.
     */
    private readonly writing = new Map<string, number>();

    /**
     * Paths we have finished writing, moving or removing, and what we left
     * there.
     *
     * The event for one of our own operations arrives after it, so the hold
     * above is already gone by then; this is what tells the event apart from a
     * real edit. A timer cannot: it drops both alike, and a user who types into
     * a note in the seconds after it was downloaded loses that edit. So the
     * claim is settled by looking at the path when the event names it — the
     * same version we wrote is our echo, anything else is the user's.
     */
    private readonly claims = new Map<string, Claim>();

    /**
     * What {@link getState} last saw of each path in this session, so that a
     * file written again with its size and mtime put back is still noticed;
     * see {@link sameVersion}.
     */
    private readonly lastSeen = new Map<string, FileStamp>();

    constructor(
        private readonly app: App,
        private readonly logger: Logger,
        /**
         * Where a download, or any file being replaced, is written until
         * complete: inside the plugin's own folder, which never syncs, so a
         * write cut short by a crash leaves nothing in the vault and is swept at
         * the next start; see {@link sweepDownloads}. Null puts them beside
         * their target.
         */
        private readonly downloadsDir: string | null = null,
        /**
         * The largest file this device will read, in bytes; Infinity for none.
         *
         * The engine supplies the user's setting (see `SyncEngine.sizeLimitBytes`).
         * Left unsaid, it is the platform's own default — see
         * {@link defaultSizeLimit} — so a phone is never asked to read a whole
         * video because a setting went missing.
         */
        private readonly sizeLimit: () => number = defaultSizeLimit,
    ) {
        this.adapter = app.vault.adapter;
    }

    /**
     * Refuse a path that would lead outside the vault, before anything
     * touches the disk with it. Names from Drive are checked where they are
     * read (see `isSafeName`); this is the last line, for every path the sync
     * reads or writes, whatever it came from.
     */
    private checked(path: string): string {
        if (!staysInVault(path, Platform.isWin)) {
            throw new Error(`Refusing ${JSON.stringify(path)}: it would lead outside the vault`);
        }
        return path;
    }

    /** The file or folder at `path` as Obsidian indexes it, or null for a path it does not index. */
    private indexed(path: string): TAbstractFile | null {
        return this.app.vault.getAbstractFileByPath?.(path) ?? null;
    }

    /** Remove downloads left unfinished by an earlier run. */
    async sweepDownloads(): Promise<void> {
        if (this.downloadsDir === null || !(await this.adapter.exists(this.downloadsDir))) {
            return;
        }
        try {
            const listing = await this.adapter.list(this.downloadsDir);
            for (const file of listing.files) {
                await this.adapter.remove(file);
            }
            if (listing.files.length > 0) {
                this.logger.info(`Removed ${listing.files.length} unfinished download(s) from an earlier session`);
            }
        } catch (error) {
            this.logger.warn('Could not clear unfinished downloads', error);
        }
    }

    /**
     * Remove partial downloads left beside their targets by versions that
     * wrote them there, among the files of a vault listing.
     */
    async removeLegacyPartialDownloads(files: string[]): Promise<void> {
        for (const path of files) {
            if (/^\.[^/]*\.proton-sync\.tmp$/.test(basename(path)) && staysInVault(path, Platform.isWin)) {
                try {
                    await this.adapter.remove(path);
                    this.logger.info(`Removed "${path}", a download left unfinished by an older version`);
                } catch (error) {
                    this.logger.debug(`Could not remove "${path}"`, error);
                }
            }
        }
    }

    /** True for a path we are writing, or one inside a folder we are moving. */
    isSelfWrite(path: string): boolean {
        return this.isOurs(path) || ancestorPaths(path).some((ancestor) => this.isOurs(ancestor));
    }

    /**
     * Whether an event at this path is the echo of something this plugin did.
     *
     * Answered without awaiting, from the file itself where the platform can be
     * asked and from Obsidian's index of it where it cannot, so the answer is
     * about the file as the event finds it rather than about how long ago we
     * last touched the path.
     */
    private isOurs(path: string): boolean {
        if (this.writing.has(path)) {
            return true;
        }
        const claim = this.claims.get(path);
        if (claim === undefined) {
            return false;
        }
        switch (claim.kind) {
            case 'until':
                if (Date.now() < claim.until) {
                    return true;
                }
                break;
            case 'gone':
                // We moved or removed it. Anything reported at the path now is
                // the echo of that, unless something is there again.
                if (!this.existsNow(path)) {
                    return true;
                }
                break;
            case 'version': {
                const now = this.stampNow(path);
                if (now !== undefined && sameVersion(claim.stamp, now)) {
                    return true;
                }
                break;
            }
        }
        // Written again since we finished: the user's edit, not our echo.
        this.claims.delete(path);
        return false;
    }

    /**
     * Every file and folder in the vault, as vault-relative paths.
     *
     * Folders are returned as well as files so that an empty folder the user
     * created still reaches the other devices — it has no file to carry it.
     */
    async list(
        shouldDescend: (folderPath: string) => boolean,
        from = '',
    ): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        const queue = [this.checked(from)];

        while (queue.length > 0) {
            const folder = queue.pop()!;
            let listing;
            try {
                listing = await this.adapter.list(folder);
            } catch (error) {
                this.logger.warn(`Could not list "${folder}"`, error);
                continue;
            }
            files.push(...listing.files);
            for (const subfolder of listing.folders) {
                if (shouldDescend(subfolder)) {
                    folders.push(subfolder);
                    queue.push(subfolder);
                }
            }
        }

        return { files, folders };
    }

    async exists(path: string): Promise<boolean> {
        return this.adapter.exists(this.checked(path));
    }

    /**
     * Whether this exact path exists, letter case included.
     *
     * `exists` goes through the filesystem, which on Windows, macOS and iOS
     * answers yes for `note.md` when only `Note.md` is there. Renaming one to
     * the other is legitimate; the parent listing tells the two apart.
     */
    async existsExactly(path: string): Promise<boolean> {
        const parent = parentPath(this.checked(path));
        if (parent !== '' && !(await this.adapter.exists(parent))) {
            return false;
        }
        const listing = await this.adapter.list(parent);
        return listing.files.includes(path) || listing.folders.includes(path);
    }

    /** Size and mtime, without reading the content. Undefined for a missing path or a folder. */
    async stat(path: string): Promise<{ size: number; mtime: number } | undefined> {
        const stat = await this.adapter.stat(this.checked(path));
        return stat && stat.type === 'file' ? { size: stat.size, mtime: stat.mtime } : undefined;
    }

    /** Whether a folder holds any file at all, however deep. Empty subfolders do not count. */
    async hasFiles(path: string): Promise<boolean> {
        const listing = await this.adapter.list(this.checked(path));
        if (listing.files.length > 0) {
            return true;
        }
        for (const folder of listing.folders) {
            if (await this.hasFiles(folder)) {
                return true;
            }
        }
        return false;
    }

    /** Copy a file within the vault, without reading it into memory. */
    async copy(fromPath: string, toPath: string): Promise<void> {
        this.checked(fromPath);
        this.checked(toPath);
        this.holdSelfWrite(toPath);
        try {
            await this.ensureFolder(parentPath(toPath));
            const file = this.indexed(fromPath);
            if (file instanceof TFile && !isHidden(toPath)) {
                await this.app.vault.copy(file, toPath);
            } else {
                await this.adapter.copy(fromPath, toPath);
            }
        } finally {
            this.releaseSelfWrite(toPath);
        }
    }

    /**
     * Current local state of a path, or undefined if it is gone.
     *
     * `knownBase` is an optimisation, not a shortcut: when size and mtime still
     * match what the last sync recorded, the file cannot have changed in a way
     * that matters and the digest is reused instead of re-reading the bytes.
     * A full vault scan on a large vault is otherwise dominated by hashing.
     *
     * On a filesystem whose mtime moves in two-second steps, a save can land
     * without moving either number; the change time this session saw last is
     * what catches it.
     */
    async getState(
        path: string,
        knownBase?: Pick<SyncBase, 'hash' | 'size' | 'localMtime'>,
    ): Promise<LocalState | undefined> {
        const stat = await this.adapter.stat(this.checked(path));
        if (!stat || stat.type !== 'file') {
            this.lastSeen.delete(path);
            return undefined;
        }
        this.checkSize(path, stat.size);

        const stamp: FileStamp = { size: stat.size, mtime: stat.mtime, ...(await this.nodeStamp(path)) };
        const seen = this.lastSeen.get(path);
        this.lastSeen.set(path, stamp);

        if (
            knownBase &&
            sameVersion({ size: knownBase.size, mtime: knownBase.localMtime }, stamp) &&
            (seen === undefined || sameVersion(seen, stamp))
        ) {
            return { hash: knownBase.hash, size: stat.size, mtime: stat.mtime };
        }

        const fullPath = this.fullPath(path);
        if (stat.size > LARGE_FILE_BYTES && fullPath) {
            return { hash: await hashFile(fullPath), size: stat.size, mtime: stat.mtime };
        }
        const data = await this.adapter.readBinary(path);
        return { hash: await sha1Hex(data), size: stat.size, mtime: stat.mtime };
    }

    /**
     * Refuse a file over the size limit, before anything of it is read.
     *
     * Checked against the size the filesystem reports, so it costs one stat and
     * no memory; see {@link FileTooLargeError} for what the caller is expected
     * to do about it.
     */
    private checkSize(path: string, size: number): void {
        const limit = this.sizeLimit();
        if (size > limit) {
            throw new FileTooLargeError(path, size, limit);
        }
    }

    /**
     * The change time and inode number of a file, which the adapter's stat does
     * not carry. Undefined off the desktop, where there is nothing to ask.
     */
    private async nodeStamp(path: string): Promise<Pick<FileStamp, 'ctime' | 'ino'> | undefined> {
        const fullPath = this.fullPath(path);
        const modules = nodeModules();
        if (fullPath === null || modules === null) {
            return undefined;
        }
        try {
            const stat = await modules.fs.stat(fullPath);
            return { ctime: Math.round(stat.ctimeMs), ino: stat.ino };
        } catch {
            return undefined;
        }
    }

    /**
     * What the path looks like right now, without awaiting: the filesystem
     * where the desktop can reach it, else Obsidian's own stat of the file,
     * which the event being judged has just updated.
     */
    private stampNow(path: string): FileStamp | undefined {
        const fullPath = this.fullPath(path);
        const modules = nodeModules();
        if (fullPath !== null && modules !== null) {
            try {
                const stat = modules.sync.statSync(fullPath);
                return stat.isFile()
                    ? { size: stat.size, mtime: Math.round(stat.mtimeMs), ctime: Math.round(stat.ctimeMs), ino: stat.ino }
                    : undefined;
            } catch {
                return undefined;
            }
        }
        const file = this.indexed(path);
        const stat = file instanceof TFile ? file.stat : undefined;
        return stat === undefined ? undefined : { size: stat.size, mtime: stat.mtime };
    }

    /** Whether anything is at this path now, asked as cheaply as the platform allows. */
    private existsNow(path: string): boolean {
        if (this.indexed(path) !== null) {
            return true;
        }
        const fullPath = this.fullPath(path);
        const modules = nodeModules();
        if (fullPath === null || modules === null) {
            // No index entry and no filesystem to ask: on a phone, a path
            // Obsidian does not track, with nothing to compare against.
            return false;
        }
        try {
            return modules.sync.existsSync(fullPath);
        } catch {
            return false;
        }
    }

    /**
     * Everything an upload needs, from one read of the file.
     *
     * The digest and size sent to Drive are computed from the very bytes being
     * sent, not taken from an earlier scan: an attachment still being written
     * by another program, or a note saved again mid-sync, would otherwise go up
     * with a digest that does not match its content, which Drive rejects.
     * Returns the state the upload describes, which is what the sync base must
     * record.
     */
    async openUpload(path: string): Promise<{ source: UploadSource; local: LocalState }> {
        const stat = await this.adapter.stat(this.checked(path));
        if (!stat || stat.type !== 'file') {
            throw new Error(`"${path}" no longer exists`);
        }
        this.checkSize(path, stat.size);
        const mediaType = mediaTypeOf(path);
        const fullPath = this.fullPath(path);

        if (stat.size > LARGE_FILE_BYTES && fullPath) {
            // Hashed in a first pass because the SDK wants the digest up front.
            // If the file changes between the passes, Drive's integrity check
            // fails the upload and the next sync retries it.
            const hash = await hashFile(fullPath);
            return {
                source: {
                    mediaType,
                    size: stat.size,
                    sha1: hash,
                    modificationTime: new Date(stat.mtime),
                    thumbnails: [],
                    stream: () => streamFile(fullPath),
                    replay: false,
                },
                local: { hash, size: stat.size, mtime: stat.mtime },
            };
        }

        const data = await this.adapter.readBinary(path);
        const hash = await sha1Hex(data);
        return {
            source: {
                mediaType,
                size: data.byteLength,
                sha1: hash,
                modificationTime: new Date(stat.mtime),
                // Thumbnails are a convenience for Drive's own apps, which make
                // their own when missing; on a phone, decoding every image to
                // make one costs battery and time for nothing the user sees.
                thumbnails: Platform.isMobile ? [] : await imageThumbnails(data, mediaType),
                stream: () => streamOf(data),
                replay: true,
            },
            local: { hash, size: data.byteLength, mtime: stat.mtime },
        };
    }

    /**
     * A destination for a streamed download.
     *
     * Bytes go to a temporary file of our own — inside the plugin folder where
     * there is one — and are renamed into place only once the download has
     * completed and verified, so an interrupted transfer never leaves a
     * truncated video where the real one was. The dot prefix keeps Obsidian from
     * indexing a partial file that sits beside its target, and the `.tmp` suffix
     * keeps the sync from picking it up; the plugin folder is never synced at
     * all.
     *
     * Returns null on mobile, or when the vault is not on a local filesystem,
     * in which case the caller downloads into memory instead.
     */
    async openDownload(path: string): Promise<FileSink | null> {
        const target = this.fullPath(this.checked(path));
        const tempPath = this.tempPathFor(path);
        const temp = this.fullPath(tempPath);
        if (!target || !temp) {
            return null;
        }

        const { fs, createHash } = nodeModules()!;
        await this.ensureFolder(parentPath(path));
        await this.ensureFolder(parentPath(tempPath));
        const handle = await fs.open(temp, 'w');
        const digest = createHash('sha1');
        let size = 0;
        let closed = false;
        const close = async () => {
            if (!closed) {
                closed = true;
                await handle.close();
            }
        };

        const sink = new WritableStream<Uint8Array>({
            async write(chunk) {
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
                    offset += bytesWritten;
                }
                digest.update(chunk);
                size += chunk.byteLength;
            },
        });

        return {
            sink,
            commit: async (mtime?: number) => {
                // Flushed to the disk before it takes the target's name: a
                // rename that outlived the bytes behind it would leave a
                // plausible-looking empty file where a video was.
                await handle.sync().catch((error: unknown) => this.logger.debug('Could not flush the download to the disk', error));
                await close();
                this.holdSelfWrite(path);
                try {
                    if (mtime !== undefined) {
                        await fs.utimes(temp, new Date(), new Date(mtime));
                    }
                    await moveFile(fs, temp, target);
                    const stat = await this.adapter.stat(path);
                    return {
                        hash: digest.digest('hex'),
                        size: stat?.size ?? size,
                        mtime: stat?.mtime ?? mtime ?? Date.now(),
                    };
                } finally {
                    this.releaseSelfWrite(path);
                }
            },
            abort: async () => {
                await close().catch(() => undefined);
                await fs.unlink(temp).catch(() => undefined);
            },
        };
    }

    /**
     * Move a file or folder within the vault, to follow a rename made on
     * another device.
     *
     * Goes through the adapter, not `FileManager.renameFile`: the latter would
     * also rewrite every link to the file, but the device that did the rename
     * has already rewritten them, and those edits arrive through the sync.
     * Rewriting them here as well would turn every remote rename into a
     * conflict on each linking note.
     */
    async rename(fromPath: string, toPath: string): Promise<void> {
        this.checked(fromPath);
        this.checked(toPath);
        this.holdSelfWrite(fromPath);
        this.holdSelfWrite(toPath);
        try {
            await this.ensureFolder(parentPath(toPath));
            // `Vault.rename`, unlike `FileManager.renameFile`, leaves links alone.
            const file = this.indexed(fromPath);
            if (file && !isHidden(toPath)) {
                await this.app.vault.rename(file, toPath);
            } else {
                await this.adapter.rename(fromPath, toPath);
            }
        } finally {
            this.releaseSelfWrite(fromPath, 'gone');
            this.releaseSelfWrite(toPath);
        }
    }

    async readText(path: string): Promise<string> {
        return this.adapter.read(this.checked(path));
    }

    /**
     * Write a file, creating any missing folders, and report the state it
     * landed in.
     *
     * The returned stat is read back rather than assumed: Obsidian may not honour
     * the requested mtime exactly, and the engine has to record the mtime the
     * file actually has or its next scan will see a spurious local change.
     */
    async writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalState> {
        this.checked(path);
        this.holdSelfWrite(path);
        try {
            await this.ensureFolder(parentPath(path));
            await this.writeFile(path, data, mtime);

            const stat = await this.adapter.stat(path);
            return {
                hash: await sha1Hex(data),
                size: stat?.size ?? data.byteLength,
                mtime: stat?.mtime ?? mtime ?? Date.now(),
            };
        } finally {
            this.releaseSelfWrite(path);
        }
    }

    /**
     * Put the bytes at a path without ever leaving a half-written file there.
     *
     * A path Obsidian does not have yet is created through the Vault API, which
     * is what keeps its cache in step, and where a crash can only leave a file
     * that was not there before. Everything else — a note being replaced, a
     * config file, a path the index has not caught up with — is written to a
     * file of our own and renamed over the target, so a write cut short leaves
     * the previous version whole instead of a truncated note that the next pass
     * uploads or merges into.
     */
    private async writeFile(path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
        const options = mtime !== undefined ? { mtime } : undefined;
        const file = this.indexed(path);
        if (!(file instanceof TFile) && !isHidden(path) && !(await this.adapter.exists(path))) {
            try {
                await this.app.vault.createBinary(path, data, options);
                return;
            } catch (error) {
                this.logger.debug(`Could not create "${path}" through the vault; writing it directly`, error);
            }
        }
        await this.replaceFile(path, data, options);
    }

    /**
     * Write to a file of our own, flush it to the disk where the platform
     * allows it, and only then give it the target's name in one rename.
     *
     * On the desktop the temporary file and the rename go through Node, which
     * can fsync: a crash or a flat battery leaves the old file untouched. On a
     * phone there is no Node, and the adapter does the two steps; where even its
     * rename is refused, the bytes are written in place, which is what every
     * write did before and no worse than that.
     */
    private async replaceFile(path: string, data: ArrayBuffer, options?: { mtime?: number }): Promise<void> {
        const tempPath = this.tempPathFor(path);
        await this.ensureFolder(parentPath(tempPath));
        const temp = this.fullPath(tempPath);
        const target = this.fullPath(path);
        if (temp && target) {
            const { fs } = nodeModules()!;
            await writeAndFlush(fs, temp, data);
            if (options?.mtime !== undefined) {
                await fs.utimes(temp, new Date(), new Date(options.mtime));
            }
            await this.ensureFolder(parentPath(path));
            await moveFile(fs, temp, target);
            return;
        }
        await this.adapter.writeBinary(tempPath, data, options);
        await this.ensureFolder(parentPath(path));
        try {
            await this.adapter.rename(tempPath, path);
        } catch (error) {
            // Renaming onto a file that is already there is not something every
            // platform's adapter allows.
            this.logger.debug(`Could not move "${tempPath}" into place; writing "${path}" in place`, error);
            await this.adapter.remove(tempPath).catch(() => undefined);
            await this.adapter.writeBinary(path, data, options);
        }
    }

    /**
     * Where a file of ours lands before it takes its place in the vault: inside
     * the plugin's own folder, which never syncs, so a write cut short leaves
     * nothing to upload and is swept at the next start; see
     * {@link sweepDownloads}. Beside the target when there is no such folder.
     */
    private tempPathFor(path: string): string {
        return this.downloadsDir === null
            ? joinPath(parentPath(path), `.${basename(path)}.proton-sync.tmp`)
            : joinPath(this.downloadsDir, `${crypto.randomUUID()}.tmp`);
    }

    async ensureFolder(path: string): Promise<void> {
        if (this.checked(path) === '') {
            return;
        }
        for (const folder of [...ancestorPaths(path), path]) {
            if (!(await this.adapter.exists(folder))) {
                try {
                    await this.adapter.mkdir(folder);
                } catch (error) {
                    // A concurrent write may have created it first.
                    if (!(await this.adapter.exists(folder))) {
                        throw error;
                    }
                }
            }
        }
    }

    /**
     * Delete a path, as a deletion arriving from another device.
     *
     * A file Obsidian indexes goes where the user chose for deleted files, as
     * if they had deleted it themselves. Anything else, such as a settings file
     * in the config folder, goes to the system trash where the OS can still
     * recover it, falling back to the vault's own trash, and to a hard delete
     * only when neither is available.
     */
    async trash(path: string): Promise<void> {
        this.checked(path);
        this.holdSelfWrite(path);
        try {
            // Where Obsidian indexes it, the way the user chose in Files and
            // links → Deleted files: system trash, the vault's .trash, or gone.
            const file = this.indexed(path);
            if (file) {
                await this.app.fileManager.trashFile(file);
                return;
            }
            await this.adapter.trashSystem(path).then(async (trashed) => {
                if (!trashed) {
                    await this.adapter.trashLocal(path);
                }
            });
        } catch (error) {
            this.logger.warn(`Could not trash "${path}", removing it instead`, error);
            await this.adapter.remove(path);
        } finally {
            this.releaseSelfWrite(path, 'gone');
        }
    }

    private holdSelfWrite(path: string): void {
        this.writing.set(path, (this.writing.get(path) ?? 0) + 1);
    }

    /**
     * End the hold, leaving behind what the path looks like now so that the
     * vault event the operation produces can be told from an edit of the user's
     * own; see {@link claims}.
     */
    private releaseSelfWrite(path: string, outcome: 'written' | 'gone' = 'written'): void {
        const count = (this.writing.get(path) ?? 1) - 1;
        if (count > 0) {
            this.writing.set(path, count);
            return;
        }
        this.writing.delete(path);
        this.claims.set(path, this.claimFor(path, outcome));
    }

    private claimFor(path: string, outcome: 'written' | 'gone'): Claim {
        if (outcome === 'gone') {
            return { kind: 'gone' };
        }
        const stamp = this.stampNow(path);
        if (stamp !== undefined) {
            return { kind: 'version', stamp };
        }
        // Nothing here can say what the file looks like — on a phone, a path
        // Obsidian does not index — so the event for the write, which arrives
        // within a second of it, is caught by a short hold instead.
        return { kind: 'until', until: Date.now() + SELF_WRITE_HOLD_MS };
    }

    /** Absolute path on disk, when the vault lives on a local filesystem that Node can reach. */
    private fullPath(path: string): string | null {
        if (!nodeModules()) {
            return null;
        }
        const adapter = this.adapter as DataAdapter & { getFullPath?: (normalizedPath: string) => string };
        return typeof adapter.getFullPath === 'function' ? adapter.getFullPath(path) : null;
    }
}

async function* readChunks(fullPath: string): AsyncGenerator<Uint8Array, void> {
    const handle = await nodeModules()!.fs.open(fullPath, 'r');
    try {
        while (true) {
            const buffer = new Uint8Array(CHUNK_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
            if (bytesRead === 0) {
                return;
            }
            yield bytesRead === CHUNK_BYTES ? buffer : buffer.slice(0, bytesRead);
        }
    } finally {
        await handle.close();
    }
}

async function hashFile(fullPath: string): Promise<string> {
    const digest = nodeModules()!.createHash('sha1');
    for await (const chunk of readChunks(fullPath)) {
        digest.update(chunk);
    }
    return digest.digest('hex');
}

/**
 * A file as a web stream, built on the renderer's own `ReadableStream` rather
 * than Node's `Readable.toWeb`: the SDK pipes it through the renderer's stream
 * classes, which do not accept Node's implementation of the same interface.
 */
function streamFile(fullPath: string): ReadableStream<Uint8Array> {
    const chunks = readChunks(fullPath);
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { value, done } = await chunks.next();
            if (done) {
                controller.close();
            } else {
                controller.enqueue(value);
            }
        },
        async cancel() {
            await chunks.return(undefined);
        },
    });
}

function streamOf(data: ArrayBuffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(data));
            controller.close();
        },
    });
}

/** Whether Obsidian leaves a path out of its index: anything inside a folder, or named, with a leading dot. */
function isHidden(path: string): boolean {
    return path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Write a buffer to a file and flush it to the disk, where the platform has
 * fsync.
 *
 * Flushing is what makes the rename that follows worth anything: without it the
 * directory entry can be on the disk while the bytes it points at are not.
 */
async function writeAndFlush(fs: DesktopModules['fs'], fullPath: string, data: ArrayBuffer): Promise<void> {
    const handle = await fs.open(fullPath, 'w');
    try {
        const bytes = new Uint8Array(data);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
            offset += bytesWritten;
        }
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Move a finished download into place. A rename where it can be, which is
 * atomic; a copy and delete when the temporary file sits on another
 * filesystem than the target, as a vault folder that is a link elsewhere can.
 */
async function moveFile(fs: DesktopModules['fs'], from: string, to: string): Promise<void> {
    try {
        await fs.rename(from, to);
    } catch (error) {
        if ((error as { code?: string }).code !== 'EXDEV') {
            throw error;
        }
        await fs.copyFile(from, to);
        await fs.unlink(from);
    }
}
