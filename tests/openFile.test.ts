import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App, TFile } from 'obsidian';

import { openVaultFile } from '../src/ui/openFile';

/** An app that knows the files named in `paths`, and records what is done through it. */
function fakeApp(paths: string[]) {
    const opened: string[] = [];
    const asked: string[] = [];
    const revealed: number[] = [];
    const fileFor = (path: string) => ({ path }) as TFile;
    const leaves = [{ openFile: async (file: TFile) => void opened.push(file.path) }];
    const app = {
        vault: {
            getFileByPath: (path: string) => {
                asked.push(path);
                return paths.includes(path) ? fileFor(path) : null;
            },
        },
        workspace: {
            getLeaf: () => leaves[0],
            revealLeaf: async () => void revealed.push(1),
            // The bug was using this: it creates what is missing and reads
            // `#`/`^` as a reference into another note.
            openLinkText: () => {
                throw new Error('openLinkText must not be used to open a path');
            },
        },
    };
    return { app: app as unknown as App, opened, asked, revealed };
}

describe('openVaultFile', () => {
    it('opens a file the vault has, in the leaf in view', async () => {
        const { app, opened, revealed } = fakeApp(['notes/a.md']);
        assert.equal(await openVaultFile(app, 'notes/a.md'), true);
        assert.deepEqual(opened, ['notes/a.md']);
        assert.equal(revealed.length, 1);
    });

    it('does not create a file the vault no longer has', async () => {
        const { app, opened, revealed } = fakeApp([]);
        assert.equal(await openVaultFile(app, 'gone.md'), false);
        assert.deepEqual(opened, []);
        assert.equal(revealed.length, 0);
    });

    it('takes the name as a path, not as a link with a heading or block', async () => {
        const { app, opened, asked } = fakeApp(['odd/note #2 ^block.md']);
        assert.equal(await openVaultFile(app, 'odd/note #2 ^block.md'), true);
        assert.deepEqual(asked, ['odd/note #2 ^block.md']);
        assert.deepEqual(opened, ['odd/note #2 ^block.md']);
    });
});
