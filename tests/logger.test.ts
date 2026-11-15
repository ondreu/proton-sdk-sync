import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger, redactNames, setLogShowsNames } from '../src/util/logger';

function messages(logger: Logger): string[] {
    return logger.getEntries().map((entry) => entry.message);
}

describe('the log level', () => {
    it('reaches loggers handed out before it changed', () => {
        const root = new Logger('warn');
        const child = root.getLogger('sync');

        child.info('before the change');
        assert.deepEqual(messages(root), []);

        root.setLevel('debug');
        child.info('after the change');
        assert.deepEqual(messages(root), ['after the change']);
    });

    it('is taken from a child too, for every scope', () => {
        const root = new Logger('debug');
        const child = root.getLogger('sync');

        child.setLevel('error');
        root.warn('dropped');
        child.error('kept');

        assert.deepEqual(
            root.getEntries().map((entry) => entry.message),
            ['kept'],
        );
    });

    it('leaves the entries of every scope in one buffer', () => {
        const root = new Logger('info');
        root.getLogger('sync').info('one');
        root.getLogger('drive').info('two');

        assert.deepEqual(
            root.getEntries().map((entry) => entry.scope),
            ['proton-sdk-sync:sync', 'proton-sdk-sync:drive'],
        );
    });
});

describe('redaction tells a name from an endpoint', () => {
    it('treats a note name that has three labels as a name, not a host', () => {
        setLogShowsNames(false);
        for (const name of ['2026-05-01.meeting.md', 'recipe.v2.md', 'invoice.2026.01.pdf']) {
            const redacted = redactNames(name);
            assert.notEqual(redacted, name, name);
            assert.match(redacted, /«file [0-9a-f]{6}»/, name);
        }
    });

    it('keeps the Proton hosts and API paths the log needs', () => {
        setLogShowsNames(false);
        for (const line of [
            'GET https://drive-api.proton.me/drive/v2/volumes 200',
            'POST https://account.proton.me/auth/v4/refresh 200',
            'GET /drive/volumes/x/links 200',
            'drive-api.proton.me',
        ]) {
            assert.equal(redactNames(line), line);
        }
    });

    it('does not keep another host just because it is a URL', () => {
        setLogShowsNames(false);
        const line = 'GET https://example.invalid/collect 200';
        assert.notEqual(redactNames(line), line);
    });

    it('redacts an absolute path in an OS error', () => {
        setLogShowsNames(false);
        const redacted = redactNames("ENOENT: no such file or directory, open '/home/ondrej/Vault/secret.md'");
        assert.ok(!redacted.includes('secret.md'), redacted);
        assert.ok(!redacted.includes('ondrej'), redacted);
    });

    it('redacts a bare absolute path, not just a quoted one', () => {
        setLogShowsNames(false);
        const redacted = redactNames('could not open /home/ondrej/Vault/secret.md for reading');
        assert.ok(!redacted.includes('secret'), redacted);
        assert.ok(!redacted.includes('Vault'), redacted);
    });

    it('redacts a node uid from 32 characters up, which is every real one', () => {
        setLogShowsNames(false);
        const uid = 'w8SKm5oZxAhYYVfypUQRCf47jLomjutkpnfx2A';
        assert.ok(uid.length >= 32, String(uid.length));
        assert.equal(redactNames(`GET ${uid} 200`), 'GET «node» 200');

        const padded = `${uid}==~ZD7EDo60rN9pWPQ3ovQR0cYTim`;
        assert.equal(redactNames(`GET ${padded} 200`), 'GET «node» 200');
    });
});
