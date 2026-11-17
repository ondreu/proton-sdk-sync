import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/settings';
import {
    buildPdfPrintScript,
    copyToArrayBuffer,
    DEFAULT_EXPORT_FOLDER,
    DEFAULT_SHARE_EXPIRY_DAYS,
    effectiveExportFolder,
    exportPdfName,
    formatExportStamp,
    isExportPath,
    normalizeExportFolder,
    pickShareTarget,
    removeExportedShare,
    resolveExportPath,
    selectExpiredShares,
    selectJanitorDeletions,
    shareExpiration,
    upsertExportedShare,
    type ExportedShare,
} from '../src/sync/pdfShare';

const LINK = { url: 'https://drive.proton.me/urls/abc', hasPassword: false, downloads: 0 };

function share(path: string, expiresAt: number | null): ExportedShare {
    return { path, url: LINK.url, expiresAt, nodeUid: `node-${path}` };
}

describe('PDF export naming', () => {
    it('stamps filenames in local time, zero-padded', () => {
        assert.equal(formatExportStamp(new Date(2026, 0, 5, 9, 7)), '2026-01-05 0907');
        assert.equal(formatExportStamp(new Date(2026, 10, 17, 15, 30)), '2026-11-17 1530');
    });

    it('names exports after the note and the stamp', () => {
        assert.equal(exportPdfName('Meeting notes', new Date(2026, 10, 17, 15, 30)), 'Meeting notes 2026-11-17 1530.pdf');
    });

    it('numbers colliding exports instead of overwriting them', () => {
        const taken = new Set(['Exports/Note 2026-11-17 1530.pdf', 'Exports/Note 2026-11-17 1530 (2).pdf']);
        const exists = (path: string): boolean => taken.has(path);
        assert.equal(
            resolveExportPath('Exports', 'Note 2026-11-17 1530.pdf', exists),
            'Exports/Note 2026-11-17 1530 (3).pdf',
        );
    });

    it('uses the free name when there is no collision', () => {
        assert.equal(resolveExportPath('Exports', 'Note 2026-11-17 1530.pdf', () => false), 'Exports/Note 2026-11-17 1530.pdf');
    });

    it('falls back to the default folder when the setting is blank', () => {
        assert.equal(resolveExportPath('  ', 'Note.pdf', () => false), `${DEFAULT_EXPORT_FOLDER}/Note.pdf`);
        assert.equal(resolveExportPath('/Exports/', 'Note.pdf', () => false), 'Exports/Note.pdf');
    });

    it('normalizes the folder setting', () => {
        assert.equal(normalizeExportFolder('  /Exports/ '), 'Exports');
        assert.equal(effectiveExportFolder(''), DEFAULT_EXPORT_FOLDER);
        assert.equal(effectiveExportFolder('  My PDFs '), 'My PDFs');
    });
});

describe('PDF export expiry', () => {
    it('counts days from now, and gives no date for zero', () => {
        assert.equal(shareExpiration(0, 1_000), undefined);
        assert.equal(shareExpiration(-1, 1_000), undefined);
        assert.equal(shareExpiration(30, 1_000)?.getTime(), 1_000 + 30 * 86_400_000);
    });

    it('reuses an existing link instead of making a second one', () => {
        assert.equal(pickShareTarget(null), 'create');
        assert.equal(pickShareTarget(LINK), 'reuse');
    });

    it('selects only links past their expiry', () => {
        const shares = [share('Exports/a.pdf', 1_000), share('Exports/b.pdf', 3_000), share('Exports/c.pdf', null)];
        assert.deepEqual(
            selectExpiredShares(shares, 2_000).map((entry) => entry.path),
            ['Exports/a.pdf'],
        );
    });
});

describe('PDF export settings', () => {
    it('defaults to the export folder, a 30-day expiry and daily cleanup', () => {
        assert.equal(DEFAULT_SETTINGS.exportFolder, 'Exports');
        assert.equal(DEFAULT_SETTINGS.shareExpiryDays, 30);
        assert.equal(DEFAULT_SETTINGS.autoDeleteExpiredExports, true);
        assert.deepEqual(DEFAULT_SETTINGS.exportedShares, []);
        assert.equal(DEFAULT_EXPORT_FOLDER, 'Exports');
        assert.equal(DEFAULT_SHARE_EXPIRY_DAYS, 30);
    });
});

describe('PDF export registry', () => {
    it('replaces the entry when a path is exported again', () => {
        const first = upsertExportedShare([], share('Exports/a.pdf', 1_000));
        const second = upsertExportedShare(first, share('Exports/a.pdf', 2_000));
        assert.equal(second.length, 1);
        assert.equal(second[0]?.expiresAt, 2_000);
    });

    it('forgets entries that were cleaned up', () => {
        const shares = [share('Exports/a.pdf', 1_000), share('Exports/b.pdf', 1_000)];
        assert.deepEqual(
            removeExportedShare(shares, 'Exports/a.pdf').map((entry) => entry.path),
            ['Exports/b.pdf'],
        );
    });
});

describe('PDF export janitor', () => {
    it('deletes expired exports inside the export folder', () => {
        const shares = [share('Exports/old.pdf', 1_000), share('Exports/fresh.pdf', 3_000)];
        assert.deepEqual(
            selectJanitorDeletions(shares, 2_000, 'Exports').map((entry) => entry.path),
            ['Exports/old.pdf'],
        );
    });

    it('refuses paths outside the export folder, even when expired', () => {
        const shares = [
            share('Notes/precious.md', 1_000),
            share('../outside.pdf', 1_000),
            share('Exports-backup/copy.pdf', 1_000),
            share('Exports', 1_000),
        ];
        assert.deepEqual(selectJanitorDeletions(shares, 2_000, 'Exports'), []);
    });

    it('keeps links that never expire', () => {
        assert.deepEqual(selectJanitorDeletions([share('Exports/old.pdf', null)], 2_000, 'Exports'), []);
    });

    it('knows what counts as an export', () => {
        assert.equal(isExportPath('Exports', 'Exports/a.pdf'), true);
        assert.equal(isExportPath('Exports', 'Notes/a.pdf'), false);
        assert.equal(isExportPath('Exports', 'Exports-backup/a.pdf'), false);
    });
});

describe('PDF print script', () => {
    it('embeds the title and markup as JSON so content cannot break out', () => {
        const html = '<h1>hi</h1><img src="x" onerror="alert(1)">';
        const script = buildPdfPrintScript('My "note"', html);
        assert.ok(script.includes(`document.title=${JSON.stringify('My "note"')}`));
        assert.ok(script.includes(`document.body.innerHTML=${JSON.stringify(html)}`));
        assert.ok(script.includes('createElement'));
    });
});

describe('PDF bytes', () => {
    it('copies buffer pools into an exact-sized buffer', () => {
        const pool = new Uint8Array(16);
        pool.set([1, 2, 3], 8);
        const view = pool.subarray(8, 11);
        const copy = copyToArrayBuffer(view);
        assert.equal(copy.byteLength, 3);
        assert.deepEqual([...new Uint8Array(copy)], [1, 2, 3]);
    });

    it('passes an ArrayBuffer through', () => {
        const buffer = new Uint8Array([4, 5]).buffer;
        assert.equal(copyToArrayBuffer(buffer), buffer);
    });
});
