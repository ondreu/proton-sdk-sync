import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync, readdirSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DEFAULT_SETTINGS } from '../src/settings';
import {
    DEFAULT_MOBILE_MAX_FILE_BYTES,
    defaultSizeLimit,
    FileTooLargeError,
    LARGE_FILE_BYTES,
    sameVersion,
    VaultIO,
} from '../src/sync/vault';
import { Logger } from '../src/util/logger';
import { diskVault, exposeNodeRequire } from './support/diskAdapter';

const SILENT = new Logger('error');
const MB = 1024 * 1024;

/** The bytes of a string, as the adapter hands them over. */
function encode(text: string): ArrayBuffer {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer as ArrayBuffer;
}

/** Count the reads a vault makes, so a file that is refused can be shown never to be read. */
function countReads(app: object): { reads: number } {
    const adapter = (app as { vault: { adapter: { readBinary: (path: string) => Promise<ArrayBuffer> } } }).vault.adapter;
    const readBinary = adapter.readBinary.bind(adapter);
    const counter = { reads: 0 };
    adapter.readBinary = (path: string) => {
        counter.reads++;
        return readBinary(path);
    };
    return counter;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value);
    }
    return Buffer.concat(chunks);
}

describe('VaultIO — paths that would lead out of the vault', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('refuses to stream, write, read or move anything outside the vault', async () => {
        const name = `escaped-${process.pid}.txt`;
        const outside = disk.full(`../${name}`);
        writeFileSync(disk.full('note.md'), 'in the vault');

        for (const attempt of [
            () => vault.openDownload(`../${name}`),
            () => vault.writeBinary(`a/../../${name}`, new ArrayBuffer(4)),
            () => vault.getState(`../${name}`),
            () => vault.openUpload(`x/../../${name}`),
            () => vault.ensureFolder('..'),
            () => vault.rename('note.md', `../${name}`),
            () => vault.copy('note.md', `../${name}`),
        ]) {
            await assert.rejects(attempt, /outside the vault/);
        }
        assert.equal(existsSync(outside), false);
        assert.equal(readFileSync(disk.full('note.md'), 'utf8'), 'in the vault');
    });
});

describe('VaultIO on desktop', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('streams a large file up in chunks, with the digest of what is sent', async () => {
        const bytes = Buffer.alloc(LARGE_FILE_BYTES + 12_345, 7);
        bytes.write('video', 0);
        writeFileSync(disk.full('clip.mp4'), bytes);

        const { source, local } = await vault.openUpload('clip.mp4');

        assert.equal(source.replay, false, 'streamed, not buffered');
        assert.equal(source.mediaType, 'video/mp4');
        assert.equal(source.size, bytes.byteLength);
        assert.equal(source.sha1, createHash('sha1').update(bytes).digest('hex'));
        assert.equal(local.hash, source.sha1);
        assert.ok((await readAll(source.stream())).equals(bytes));
        assert.equal((await vault.getState('clip.mp4'))?.hash, source.sha1);
    });

    it('buffers a small file, so an upload can be retried from it', async () => {
        writeFileSync(disk.full('note.md'), 'hello');
        const { source } = await vault.openUpload('note.md');
        assert.equal(source.replay, true);
        assert.equal((await readAll(source.stream())).toString(), 'hello');
        assert.equal((await readAll(source.stream())).toString(), 'hello');
    });

    it('lands a download only once complete, with the requested mtime', async () => {
        const file = await vault.openDownload('media/movie.mkv');
        assert.ok(file);
        const writer = file.sink.getWriter();
        await writer.write(new TextEncoder().encode('part one, '));
        assert.equal(existsSync(disk.full('media/movie.mkv')), false, 'nothing at the target mid-download');
        await writer.write(new TextEncoder().encode('part two'));
        await writer.close();

        const state = await file.commit(1_700_000_000_000);

        assert.equal(readFileSync(disk.full('media/movie.mkv'), 'utf8'), 'part one, part two');
        assert.equal(state.hash, createHash('sha1').update('part one, part two').digest('hex'));
        assert.equal(Math.round(statSync(disk.full('media/movie.mkv')).mtimeMs), 1_700_000_000_000);
        assert.deepEqual(readdirSync(disk.full('media')), ['movie.mkv'], 'temp file gone');
    });

    it('leaves nothing behind when a download is abandoned', async () => {
        writeFileSync(disk.full('keep.pdf'), 'original');
        const file = await vault.openDownload('keep.pdf');
        const writer = file!.sink.getWriter();
        await writer.write(new TextEncoder().encode('partial'));
        await file!.abort();

        assert.equal(readFileSync(disk.full('keep.pdf'), 'utf8'), 'original');
        assert.equal(
            readdirSync(disk.root).some((name) => name.endsWith('.tmp')),
            false,
        );
    });
});

describe('VaultIO — unfinished downloads (issue #6)', () => {
    const disk = diskVault();
    const DOWNLOADS = '.obsidian/plugins/proton-drive-sync/downloads';
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT, DOWNLOADS);
    });
    after(() => disk.cleanup());

    it('writes a download in progress to the plugin’s folder, not beside its target', async () => {
        const file = await vault.openDownload('media/talk.mp4');
        const writer = file!.sink.getWriter();
        await writer.write(new TextEncoder().encode('partial'));

        assert.equal(readdirSync(disk.full(DOWNLOADS)).length, 1);
        assert.deepEqual(readdirSync(disk.full('media')), []);

        await writer.close();
        await file!.commit();
        assert.equal(readFileSync(disk.full('media/talk.mp4'), 'utf8'), 'partial');
        assert.deepEqual(readdirSync(disk.full(DOWNLOADS)), []);
    });

    it('clears downloads a crash left unfinished', async () => {
        writeFileSync(disk.full(`${DOWNLOADS}/left-behind.tmp`), 'half a video');
        await vault.sweepDownloads();
        assert.deepEqual(readdirSync(disk.full(DOWNLOADS)), []);
    });

    it('removes partial downloads older versions left beside their targets', async () => {
        writeFileSync(disk.full('.big.mov.proton-sync.tmp'), 'half');
        writeFileSync(disk.full('keep.tmp'), 'not ours');
        await vault.removeLegacyPartialDownloads(['.big.mov.proton-sync.tmp', 'keep.tmp']);
        assert.equal(existsSync(disk.full('.big.mov.proton-sync.tmp')), false);
        assert.equal(existsSync(disk.full('keep.tmp')), true);
    });
});

describe('VaultIO — the size limit (F05)', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('has no limit on the desktop, where a large file is streamed rather than held', async () => {
        assert.equal(defaultSizeLimit(), Infinity);
        assert.equal(DEFAULT_SETTINGS.maxFileSizeMb, 0);

        // Sparse: a 200 MB file that costs nothing to make and is read in
        // chunks, as a video of that size would be.
        writeFileSync(disk.full('huge.bin'), '');
        truncateSync(disk.full('huge.bin'), DEFAULT_MOBILE_MAX_FILE_BYTES);

        const state = await vault.getState('huge.bin');

        assert.equal(state?.size, DEFAULT_MOBILE_MAX_FILE_BYTES, 'read, not refused');
    });

    it('reads a file under the limit once it is raised over it', async () => {
        writeFileSync(disk.full('clip.mp4'), Buffer.alloc(2 * MB, 3));
        const tight = new VaultIO(disk.app, SILENT, null, () => MB);
        await assert.rejects(tight.getState('clip.mp4'), FileTooLargeError);

        const raised = new VaultIO(disk.app, SILENT, null, () => 3 * MB);
        const state = await raised.getState('clip.mp4');

        assert.equal(state?.hash, createHash('sha1').update(Buffer.alloc(2 * MB, 3)).digest('hex'));
        assert.equal((await raised.openUpload('clip.mp4')).source.size, 2 * MB);
    });

    it('starts the mobile cap at 200 MB, from the one number the settings use', () => {
        assert.equal(DEFAULT_MOBILE_MAX_FILE_BYTES, DEFAULT_SETTINGS.mobileMaxFileSizeMb * MB);
        assert.equal(DEFAULT_SETTINGS.mobileMaxFileSizeMb, 200);
    });
});

describe('VaultIO — a write that only lands whole (F11)', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('leaves the file as it was when the rename never happens', async () => {
        writeFileSync(disk.full('note.md'), 'the version from before the crash');
        const rename = fsp.rename;
        fsp.rename = async () => {
            throw Object.assign(new Error('the disk went away between the write and the rename'), { code: 'EIO' });
        };
        try {
            await assert.rejects(vault.writeBinary('note.md', encode('the version that never landed')));
        } finally {
            fsp.rename = rename;
        }

        assert.equal(
            readFileSync(disk.full('.note.md.proton-sync.tmp'), 'utf8'),
            'the version that never landed',
            'the whole file was written; only the rename that would have replaced the note failed',
        );
        assert.equal(readFileSync(disk.full('note.md'), 'utf8'), 'the version from before the crash');
    });

    it('replaces the file whole, and creates a missing one, when nothing goes wrong', async () => {
        writeFileSync(disk.full('note.md'), 'old');
        const state = await vault.writeBinary('note.md', encode('new'), 1_700_000_000_000);
        assert.equal(readFileSync(disk.full('note.md'), 'utf8'), 'new');
        assert.equal(state.hash, createHash('sha1').update('new').digest('hex'));
        assert.ok(Math.abs(statSync(disk.full('note.md')).mtimeMs - 1_700_000_000_000) < 2, 'the requested mtime');

        await vault.writeBinary('folder/fresh.md', encode('fresh'));
        assert.equal(readFileSync(disk.full('folder/fresh.md'), 'utf8'), 'fresh');
        assert.deepEqual(readdirSync(disk.full('folder')), ['fresh.md'], 'no temporary file left behind');
    });
});

describe('VaultIO — telling our own write from an edit (F15)', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('takes the file it wrote for its own, and any later version for the user’s', async () => {
        await vault.writeBinary('typed.md', encode('from Drive'), 1_700_000_000_000);
        assert.equal(vault.isSelfWrite('typed.md'), true, 'the event for our own write is ours');

        writeFileSync(disk.full('typed.md'), 'typed into right after');

        assert.equal(vault.isSelfWrite('typed.md'), false, 'a real edit is not swallowed');
    });

    it('does not swallow an edit that put the size and the mtime back', async () => {
        await vault.writeBinary('same-size.md', encode('aaaa'), 1_700_000_000_000);
        assert.equal(vault.isSelfWrite('same-size.md'), true);

        // What a save on a filesystem with two-second mtime resolution leaves
        // behind: the same size, the same mtime, a new change time.
        await delay(5);
        const mtime = statSync(disk.full('same-size.md')).mtime;
        writeFileSync(disk.full('same-size.md'), 'bbbb');
        utimesSync(disk.full('same-size.md'), new Date(), mtime);

        assert.equal(vault.isSelfWrite('same-size.md'), false);
    });
});

describe('VaultIO — the quick check and the change time (F29)', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        exposeNodeRequire();
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('re-reads a file written again with its size and mtime put back', async () => {
        writeFileSync(disk.full('same.md'), 'first version');
        const first = await vault.getState('same.md');
        assert.ok(first);

        await delay(5);
        const mtime = statSync(disk.full('same.md')).mtime;
        writeFileSync(disk.full('same.md'), 'FIRST VERSION');
        utimesSync(disk.full('same.md'), new Date(), mtime);

        const again = await vault.getState('same.md', { hash: first.hash, size: first.size, localMtime: first.mtime });

        assert.equal(again?.size, first.size, 'size and mtime alone would call this unchanged');
        assert.equal(again?.mtime, first.mtime);
        assert.notEqual(again?.hash, first.hash, 'the change time gave it away');
    });

    it('keeps the shortcut where nothing has been written since', async () => {
        writeFileSync(disk.full('calm.md'), 'unchanged');
        const first = await vault.getState('calm.md');
        assert.ok(first);

        const again = await vault.getState('calm.md', { hash: first.hash, size: first.size, localMtime: first.mtime });

        assert.equal(again?.hash, first.hash);
    });

    it('treats a field the platform does not report as no opinion', () => {
        assert.equal(sameVersion({ size: 1, mtime: 2 }, { size: 1, mtime: 2 }), true);
        assert.equal(sameVersion({ size: 1, mtime: 2, ctime: 3 }, { size: 1, mtime: 2 }), true);
        assert.equal(sameVersion({ size: 1, mtime: 2, ctime: 3 }, { size: 1, mtime: 2, ctime: 4 }), false);
        assert.equal(sameVersion({ size: 1, mtime: 2, ino: 7 }, { size: 1, mtime: 2, ino: 8 }), false);
        assert.equal(sameVersion({ size: 1, mtime: 2, ctime: 3, ino: 7 }, { size: 1, mtime: 2, ctime: 3, ino: 7 }), true);
        assert.equal(sameVersion({ size: 2, mtime: 2 }, { size: 1, mtime: 2 }), false);
        assert.equal(sameVersion({ size: 1, mtime: 3 }, { size: 1, mtime: 2 }), false);
    });
});

