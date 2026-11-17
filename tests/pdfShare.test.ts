import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/settings';
import {
    buildExportedShare,
    buildPdfPrintScript,
    copyToArrayBuffer,
    DEFAULT_EXPORT_FOLDER,
    DEFAULT_SHARE_EXPIRY_DAYS,
    effectiveExportFolder,
    exportPdfName,
    exportPrecheckRefusal,
    formatExportStamp,
    isExportPath,
    janitorEntryPlan,
    MAX_EXPORTED_SHARES,
    normalizeExportFolder,
    normalizeVaultPath,
    removeExportedShare,
    resolveExportPath,
    sanitizeExportedShares,
    sanitizeExportHtml,
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

    it('builds the registry entry from the returned link, not a computed date', () => {
        const expiration = new Date(2_000_000);
        const withExpiry = buildExportedShare('Exports/a.pdf', { ...LINK, expiration }, 'node-a');
        assert.equal(withExpiry.url, LINK.url);
        assert.equal(withExpiry.expiresAt, 2_000_000);
        assert.equal(withExpiry.nodeUid, 'node-a');
        const withoutExpiry = buildExportedShare('Exports/a.pdf', LINK, 'node-a');
        assert.equal(withoutExpiry.expiresAt, null);
    });

    it('selects only links past their expiry', () => {
        const shares = [share('Exports/a.pdf', 1_000), share('Exports/b.pdf', 3_000), share('Exports/c.pdf', null)];
        assert.deepEqual(
            selectExpiredShares(shares, 2_000).map((entry) => entry.path),
            ['Exports/a.pdf'],
        );
    });
});

describe('PDF export prechecks', () => {
    it('refuses before rendering when the sync is paused', () => {
        assert.ok(exportPrecheckRefusal({ paused: true, excluded: false }) !== null);
    });

    it('refuses before rendering when the export path is excluded', () => {
        assert.ok(exportPrecheckRefusal({ paused: false, excluded: true }) !== null);
    });

    it('goes ahead when neither applies', () => {
        assert.equal(exportPrecheckRefusal({ paused: false, excluded: false }), null);
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

    it('caps the registry instead of growing forever', () => {
        const shares: ExportedShare[] = [];
        for (let n = 0; n < MAX_EXPORTED_SHARES; n++) {
            shares.push(share(`Exports/${n}.pdf`, null));
        }
        const next = upsertExportedShare(shares, share('Exports/new.pdf', null), 5_000);
        assert.equal(next.length, MAX_EXPORTED_SHARES);
        assert.ok(!next.some((entry) => entry.path === 'Exports/0.pdf'));
        assert.ok(next.some((entry) => entry.path === 'Exports/new.pdf'));
    });

    it('evicts expired entries before live ones when capped', () => {
        const shares: ExportedShare[] = [share('Exports/expired.pdf', 1_000)];
        for (let n = 1; n < MAX_EXPORTED_SHARES; n++) {
            shares.push(share(`Exports/${n}.pdf`, null));
        }
        const next = upsertExportedShare(shares, share('Exports/new.pdf', null), 5_000);
        assert.equal(next.length, MAX_EXPORTED_SHARES);
        assert.ok(!next.some((entry) => entry.path === 'Exports/expired.pdf'));
        assert.ok(next.some((entry) => entry.path === 'Exports/1.pdf'));
    });

    it('drops malformed entries instead of throwing', () => {
        const dropped: unknown[] = [];
        assert.deepEqual(sanitizeExportedShares({}, (entry) => dropped.push(entry)), []);
        assert.equal(dropped.length, 1);
        assert.deepEqual(
            sanitizeExportedShares(
                [
                    share('Exports/a.pdf', 1_000),
                    { path: undefined, url: LINK.url, expiresAt: 1_000, nodeUid: 'x' },
                    { path: 'Exports/b.pdf', url: 42, expiresAt: 1_000, nodeUid: 'y' },
                    { path: 'Exports/c.pdf', url: LINK.url, expiresAt: Number.NaN, nodeUid: 'z' },
                    null,
                ],
                (entry) => dropped.push(entry),
            ).map((entry) => entry.path),
            ['Exports/a.pdf'],
        );
        assert.equal(dropped.length, 5);
    });

    it('keeps entries without an expiry as never expiring', () => {
        const kept = sanitizeExportedShares([share('Exports/a.pdf', null)]);
        assert.equal(kept.length, 1);
        assert.equal(kept[0]?.expiresAt, null);
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

    it('refuses dot-segment escapes that only match by string prefix', () => {
        assert.deepEqual(selectJanitorDeletions([share('Exports/../secret.md', 1_000)], 2_000, 'Exports'), []);
        assert.deepEqual(selectJanitorDeletions([share('Exports/sub/../../secret.md', 1_000)], 2_000, 'Exports'), []);
    });

    it('keeps links that never expire', () => {
        assert.deepEqual(selectJanitorDeletions([share('Exports/old.pdf', null)], 2_000, 'Exports'), []);
    });

    it('knows what counts as an export', () => {
        assert.equal(isExportPath('Exports', 'Exports/a.pdf'), true);
        assert.equal(isExportPath('Exports', 'Exports/nested/a.pdf'), true);
        assert.equal(isExportPath('Exports', 'Notes/a.pdf'), false);
        assert.equal(isExportPath('Exports', 'Exports-backup/a.pdf'), false);
    });

    it('rejects non-canonical spellings on both sides', () => {
        assert.equal(isExportPath('Exports', 'Exports/../secret.md'), false);
        assert.equal(isExportPath('Exports', 'Exports/./a.pdf'), false);
        assert.equal(isExportPath('Exports', '/Exports/a.pdf'), false);
        assert.equal(isExportPath('Exports', 'Exports//a.pdf'), false);
        assert.equal(isExportPath('Exports', 'Exports\\a.pdf'), false);
        assert.equal(isExportPath('Exports', ''), false);
        assert.equal(isExportPath('Exports/../Secrets', 'Exports/../Secrets/a.pdf'), false);
        assert.equal(isExportPath('Exports', 'exports/a.pdf'), false);
    });

    it('normalizes vault paths or rejects them', () => {
        assert.equal(normalizeVaultPath('Exports/a.pdf'), 'Exports/a.pdf');
        assert.equal(normalizeVaultPath('Exports/../a.pdf'), null);
        assert.equal(normalizeVaultPath('/Exports/a.pdf'), null);
        assert.equal(normalizeVaultPath('Exports\\a.pdf'), null);
    });

    it('only unshares from inside the folder once the file is gone', () => {
        assert.equal(janitorEntryPlan(true, 'file'), 'trash-then-unshare');
        assert.equal(janitorEntryPlan(true, 'gone'), 'unshare-gone');
        assert.equal(janitorEntryPlan(true, 'other'), 'leave');
        assert.equal(janitorEntryPlan(false, 'file'), 'leave');
        assert.equal(janitorEntryPlan(false, 'gone'), 'leave');
    });
});

describe('PDF export HTML sanitizer', () => {
    it('strips event-handler attributes but keeps the markup', () => {
        const out = sanitizeExportHtml('<p>hi</p><img src="x.png" onerror="alert(1)" alt="a">');
        assert.ok(!out.includes('onerror'));
        assert.ok(out.includes('<img'));
        assert.ok(out.includes('alt="a"'));
    });

    it('strips unquoted and cased handlers like onload', () => {
        const out = sanitizeExportHtml('<svg ONLOAD=alert(1)><circle r="4"/></svg>');
        assert.ok(!/onload/i.test(out));
        assert.ok(out.includes('<svg'));
    });

    it('neutralizes javascript: links however obfuscated', () => {
        for (const href of [
            'javascript:alert(1)',
            '  JaVaScRiPt:alert(1)',
            '&#106;avascript:alert(1)',
            '&#x6a;avascript:alert(1)',
            'javascript&colon;alert(1)',
            // Named whitespace references survive JSON and are decoded by the
            // browser after this check; the delta review broke the old test.
            'java&Tab;script:alert(1)',
            'java&NewLine;script:alert(1)',
            'jav&#x09;ascript:alert(1)',
            'java&#9;script:alert(1)',
        ]) {
            const out = sanitizeExportHtml(`<a href="${href}">x</a>`);
            assert.ok(!/javascript/i.test(out), href);
            assert.ok(out.includes('href="#"'), href);
        }
    });

    it('removes active elements with their content', () => {
        assert.ok(!sanitizeExportHtml('<script>alert(1)</script><p>kept</p>').includes('alert'));
        assert.ok(!sanitizeExportHtml('<SCRIPT>alert(1)</SCRIPT>').includes('alert'));
        assert.ok(!sanitizeExportHtml('<iframe src="https://example.com"></iframe>').includes('iframe'));
        assert.ok(!sanitizeExportHtml('<object data="x"><embed src="y"></object>').includes('object'));
        const kept = sanitizeExportHtml('<h1>title</h1><p>kept</p>');
        assert.ok(kept.includes('<h1>title</h1>') && kept.includes('<p>kept</p>'));
    });

    it('leaves ordinary links and images alone', () => {
        const out = sanitizeExportHtml('<a href="https://example.com">x</a><img src="photo.png">');
        assert.ok(out.includes('href="https://example.com"'));
        assert.ok(out.includes('src="photo.png"'));
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
