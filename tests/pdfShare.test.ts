import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/settings';
import {
    buildExportedShare,
    DEFAULT_SHARE_EXPIRY_DAYS,
    isValidShareExpiryDays,
    MAX_EXPORTED_SHARES,
    MAX_SHARE_EXPIRY_DAYS,
    mayDeleteOnExpiry,
    normalizeVaultPath,
    parseCustomExpiryDays,
    removeExportedShare,
    sanitizeExportedShares,
    selectExpiredShares,
    shareExpiration,
    upsertExportedShare,
    type ExportedShare,
} from '../src/sync/pdfShare';

const LINK = { url: 'https://drive.proton.me/urls/abc', hasPassword: false, downloads: 0 };

function share(path: string, expiresAt: number | null): ExportedShare {
    return { path, url: LINK.url, expiresAt, nodeUid: `node-${path}` };
}

describe('share expiry', () => {
    it('counts days from now, and gives no date for zero', () => {
        assert.equal(shareExpiration(0, 1_000), undefined);
        assert.equal(shareExpiration(-1, 1_000), undefined);
        assert.equal(shareExpiration(30, 1_000)?.getTime(), 1_000 + 30 * 86_400_000);
    });

    it('rejects non-finite days instead of making an Invalid Date', () => {
        assert.equal(shareExpiration(Number.NaN, 1_000), undefined);
        assert.equal(shareExpiration(Number.POSITIVE_INFINITY, 1_000), undefined);
    });

    it('clamps absurd values to the maximum instead of overflowing the date', () => {
        const at = shareExpiration(1e308, 1_000)?.getTime();
        assert.ok(typeof at === 'number' && Number.isFinite(at));
        assert.equal(at, 1_000 + MAX_SHARE_EXPIRY_DAYS * 86_400_000);
    });

    it('bounds custom lifetimes to whole days within the maximum', () => {
        assert.equal(MAX_SHARE_EXPIRY_DAYS, 3650);
        assert.ok(isValidShareExpiryDays(1));
        assert.ok(isValidShareExpiryDays(3650));
        assert.ok(!isValidShareExpiryDays(0));
        assert.ok(!isValidShareExpiryDays(-5));
        assert.ok(!isValidShareExpiryDays(3651));
        assert.ok(!isValidShareExpiryDays(1.5));
        assert.ok(!isValidShareExpiryDays(Number.NaN));
        assert.ok(!isValidShareExpiryDays(Number.POSITIVE_INFINITY));
        assert.ok(!isValidShareExpiryDays('30'));
        assert.ok(!isValidShareExpiryDays(null));
    });

    it('parses custom dialog input or rejects it with null', () => {
        assert.equal(parseCustomExpiryDays('30'), 30);
        assert.equal(parseCustomExpiryDays('  7 '), 7);
        assert.equal(parseCustomExpiryDays('1.9'), 1);
        assert.equal(parseCustomExpiryDays(String(MAX_SHARE_EXPIRY_DAYS)), MAX_SHARE_EXPIRY_DAYS);
        assert.equal(parseCustomExpiryDays(''), null);
        assert.equal(parseCustomExpiryDays('   '), null);
        assert.equal(parseCustomExpiryDays('abc'), null);
        assert.equal(parseCustomExpiryDays('0'), null);
        assert.equal(parseCustomExpiryDays('-5'), null);
        assert.equal(parseCustomExpiryDays('0.4'), null);
        assert.equal(parseCustomExpiryDays('1e308'), null);
        assert.equal(parseCustomExpiryDays(String(MAX_SHARE_EXPIRY_DAYS + 1)), null);
        assert.equal(parseCustomExpiryDays('Infinity'), null);
        assert.equal(parseCustomExpiryDays('1e2'), 100);
    });

    it('builds the registry entry from the returned link, not a computed date', () => {
        const expiration = new Date(2_000_000);
        const withExpiry = buildExportedShare('Notes/a.md', { ...LINK, expiration }, 'node-a');
        assert.equal(withExpiry.url, LINK.url);
        assert.equal(withExpiry.expiresAt, 2_000_000);
        assert.equal(withExpiry.nodeUid, 'node-a');
        const withoutExpiry = buildExportedShare('Notes/a.md', LINK, 'node-a');
        assert.equal(withoutExpiry.expiresAt, null);
    });

    it('selects only links past their expiry', () => {
        const shares = [share('Notes/a.md', 1_000), share('Notes/b.md', 3_000), share('Notes/c.md', null)];
        assert.deepEqual(
            selectExpiredShares(shares, 2_000).map((entry) => entry.path),
            ['Notes/a.md'],
        );
    });
});

describe('share delete confinement', () => {
    it('allows the trash only for a canonical path whose record names the shared node', () => {
        assert.equal(mayDeleteOnExpiry(true, 'node-a', 'node-a'), true);
    });

    it('refuses forged entries: wrong uid, missing record, or empty entry uid', () => {
        assert.equal(mayDeleteOnExpiry(true, 'node-b', 'node-a'), false);
        assert.equal(mayDeleteOnExpiry(true, null, 'node-a'), false);
        assert.equal(mayDeleteOnExpiry(true, 'node-a', ''), false);
    });

    it('refuses non-canonical spellings even with a matching uid', () => {
        assert.equal(mayDeleteOnExpiry(false, 'node-a', 'node-a'), false);
    });

    it('normalizes vault paths or rejects them', () => {
        assert.equal(normalizeVaultPath('Notes/a.md'), 'Notes/a.md');
        assert.equal(normalizeVaultPath('Notes/../a.md'), null);
        assert.equal(normalizeVaultPath('/Notes/a.md'), null);
        assert.equal(normalizeVaultPath('Notes\\\\a.md'), null);
        assert.equal(normalizeVaultPath('Notes//a.md'), null);
        assert.equal(normalizeVaultPath(''), null);
        assert.equal(normalizeVaultPath('/'), null);
        assert.equal(normalizeVaultPath('.'), null);
        assert.equal(normalizeVaultPath('..'), null);
    });
});

describe('share settings', () => {
    it('defaults to a 30-day expiry and delete-off', () => {
        assert.equal(DEFAULT_SETTINGS.shareExpiryDays, 30);
        assert.equal(DEFAULT_SETTINGS.defaultDeleteOnExpiry, false);
        assert.deepEqual(DEFAULT_SETTINGS.exportedShares, []);
        assert.equal(DEFAULT_SHARE_EXPIRY_DAYS, 30);
    });

});

describe('share registry', () => {
    it('replaces the entry when a path is shared again', () => {
        const first = upsertExportedShare([], share('Notes/a.md', 1_000));
        const second = upsertExportedShare(first, share('Notes/a.md', 2_000));
        assert.equal(second.length, 1);
        assert.equal(second[0]?.expiresAt, 2_000);
    });

    it('forgets entries that were cleaned up', () => {
        const shares = [share('Notes/a.md', 1_000), share('Notes/b.md', 1_000)];
        assert.deepEqual(
            removeExportedShare(shares, 'Notes/a.md').map((entry) => entry.path),
            ['Notes/b.md'],
        );
    });

    it('caps the registry instead of growing forever', () => {
        const shares: ExportedShare[] = [];
        for (let n = 0; n < MAX_EXPORTED_SHARES; n++) {
            shares.push(share(`Notes/${n}.md`, null));
        }
        const next = upsertExportedShare(shares, share('Notes/new.md', null), 5_000);
        assert.equal(next.length, MAX_EXPORTED_SHARES);
        assert.ok(!next.some((entry) => entry.path === 'Notes/0.md'));
        assert.ok(next.some((entry) => entry.path === 'Notes/new.md'));
    });

    it('evicts expired entries before live ones when capped', () => {
        const shares: ExportedShare[] = [share('Notes/expired.md', 1_000)];
        for (let n = 1; n < MAX_EXPORTED_SHARES; n++) {
            shares.push(share(`Notes/${n}.md`, null));
        }
        const next = upsertExportedShare(shares, share('Notes/new.md', null), 5_000);
        assert.equal(next.length, MAX_EXPORTED_SHARES);
        assert.ok(!next.some((entry) => entry.path === 'Notes/expired.md'));
        assert.ok(next.some((entry) => entry.path === 'Notes/1.md'));
    });

    it('drops malformed entries instead of throwing', () => {
        const dropped: unknown[] = [];
        assert.deepEqual(sanitizeExportedShares({}, (entry) => dropped.push(entry)), []);
        assert.equal(dropped.length, 1);
        assert.deepEqual(
            sanitizeExportedShares(
                [
                    share('Notes/a.md', 1_000),
                    { path: undefined, url: LINK.url, expiresAt: 1_000, nodeUid: 'x' },
                    { path: 'Notes/b.md', url: 42, expiresAt: 1_000, nodeUid: 'y' },
                    { path: 'Notes/c.md', url: LINK.url, expiresAt: Number.NaN, nodeUid: 'z' },
                    null,
                ],
                (entry) => dropped.push(entry),
            ).map((entry) => entry.path),
            ['Notes/a.md'],
        );
        assert.equal(dropped.length, 5);
    });

    it('keeps entries without an expiry as never expiring', () => {
        const kept = sanitizeExportedShares([share('Notes/a.md', null)]);
        assert.equal(kept.length, 1);
        assert.equal(kept[0]?.expiresAt, null);
    });

    it('keeps delete-on-expiry entries as valid registry entries', () => {
        const kept = sanitizeExportedShares([{ ...share('Notes/a.md', 1_000), deleteOnExpiry: true }]);
        assert.equal(kept.length, 1);
        assert.equal(kept[0]?.deleteOnExpiry, true);
    });
});
