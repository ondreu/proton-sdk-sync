import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fsp, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { Platform } from 'obsidian';

import { DEFAULT_MOBILE_MAX_FILE_BYTES, defaultSizeLimit, FileTooLargeError, LARGE_FILE_BYTES, VaultIO } from '../src/sync/vault';
import { Logger } from '../src/util/logger';
import { diskVault, exposeNodeRequire } from './support/diskAdapter';

const SILENT = new Logger('error');
const MB = 1024 * 1024;

type TestAdapter = {
    readBinary: (path: string) => Promise<ArrayBuffer>;
    writeBinary: (path: string, data: ArrayBuffer, options?: { mtime?: number }) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
};

/**
 * The disk stand-in, with the calls Obsidian's adapter has and it leaves out.
 *
 * On a phone the adapter is the only way to a file, so a replacement there has
 * to be a write and a rename; without these the test would only exercise the
 * fallback that writes in place.
 */
function completeAdapter(disk: ReturnType<typeof diskVault>): TestAdapter {
    const adapter = (disk.app as unknown as { vault: { adapter: TestAdapter } }).vault.adapter;
    adapter.rename = (from: string, to: string) => fsp.rename(disk.full(from), disk.full(to));
    return adapter;
}

describe('VaultIO on mobile', () => {
    const disk = diskVault();
    let vault: VaultIO;

    before(() => {
        // Even with a `require` in reach, mobile must not touch Node.
        exposeNodeRequire();
        (Platform as { isDesktopApp: boolean }).isDesktopApp = false;
        (Platform as { isMobile: boolean }).isMobile = true;
        completeAdapter(disk);
        vault = new VaultIO(disk.app, SILENT);
    });
    after(() => disk.cleanup());

    it('downloads into memory instead of streaming to disk', async () => {
        assert.equal(await vault.openDownload('clip.mp4'), null);
    });

    it('reads large files whole through the adapter', async () => {
        writeFileSync(disk.full('clip.mp4'), Buffer.alloc(LARGE_FILE_BYTES + 1, 1));
        const { source } = await vault.openUpload('clip.mp4');
        assert.equal(source.replay, true);
        assert.equal(source.size, LARGE_FILE_BYTES + 1);
    });

    it('starts with the 200 MB cap the settings start with', () => {
        assert.equal(defaultSizeLimit(), DEFAULT_MOBILE_MAX_FILE_BYTES);
        assert.equal(DEFAULT_MOBILE_MAX_FILE_BYTES / MB, 200);
    });

    it('skips a file over the cap without reading a byte of it', async () => {
        writeFileSync(disk.full('video.mov'), '');
        truncateSync(disk.full('video.mov'), 300 * MB);
        const adapter = completeAdapter(disk);
        const readBinary = adapter.readBinary.bind(adapter);
        let reads = 0;
        adapter.readBinary = (path: string) => {
            reads++;
            return readBinary(path);
        };

        await assert.rejects(vault.getState('video.mov'), (error: unknown) => {
            assert.ok(error instanceof FileTooLargeError);
            assert.equal(error.size, 300 * MB);
            assert.equal(error.limit, DEFAULT_MOBILE_MAX_FILE_BYTES);
            return true;
        });
        await assert.rejects(vault.openUpload('video.mov'), FileTooLargeError);

        assert.equal(reads, 0, 'nothing was read, hashed or held in memory');
    });

    it('syncs the file once the cap is raised over it', async () => {
        const bytes = Buffer.alloc(2 * MB, 7);
        writeFileSync(disk.full('talk.mp4'), bytes);

        const tight = new VaultIO(disk.app, SILENT, null, () => MB);
        await assert.rejects(tight.getState('talk.mp4'), FileTooLargeError);

        const raised = new VaultIO(disk.app, SILENT, null, () => 3 * MB);
        const state = await raised.getState('talk.mp4');
        assert.equal(state?.hash, createHash('sha1').update(bytes).digest('hex'));

        const { source, local } = await raised.openUpload('talk.mp4');
        assert.equal(source.size, 2 * MB);
        assert.equal(local.hash, state?.hash);
    });

    it('writes through a temporary file, and renames it over the target', async () => {
        writeFileSync(disk.full('note.md'), 'the version from before');
        const adapter = completeAdapter(disk);
        const calls: string[] = [];
        const writeBinary = adapter.writeBinary.bind(adapter);
        const rename = adapter.rename.bind(adapter);
        adapter.writeBinary = (path: string, data: ArrayBuffer, options?: { mtime?: number }) => {
            calls.push(`write ${path}`);
            return writeBinary(path, data, options);
        };
        adapter.rename = (from: string, to: string) => {
            calls.push(`rename ${from} -> ${to}`);
            return rename(from, to);
        };

        const state = await vault.writeBinary('note.md', new TextEncoder().encode('the new version').buffer);

        assert.deepEqual(calls, ['write .note.md.proton-sync.tmp', 'rename .note.md.proton-sync.tmp -> note.md']);
        assert.equal(readFileSync(disk.full('note.md'), 'utf8'), 'the new version');
        assert.equal(state.hash, createHash('sha1').update('the new version').digest('hex'));
    });

    it('holds a path briefly where it cannot look at the file afterwards', async () => {
        await vault.writeBinary('hidden/typed.md', new TextEncoder().encode('from Drive').buffer);
        // No index entry and no filesystem to ask: the hold is the only answer.
        assert.equal(vault.isSelfWrite('hidden/typed.md'), true);
    });
});
