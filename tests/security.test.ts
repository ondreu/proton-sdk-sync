import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { CryptoProxy } from '@protontech/crypto';

import { ApiClient, type SessionCredentials, type SessionInfo } from '../src/proton/account';
import { HTTPError } from '../src/proton/account/http';
import type { Credentials } from '../src/proton/credentials';
import { assertProtonUrl } from '../src/proton/endpoints';
import { migrateSecret, ObsidianSecretSlot, SafeStorageFileSlot } from '../src/proton/secretStore';
import { redactArgument, redactNames, setLogShowsNames, Logger } from '../src/util/logger';

function memoryAdapter() {
    const files = new Map<string, string>();
    return {
        files,
        adapter: {
            exists: async (path: string) => files.has(path),
            read: async (path: string) => files.get(path) ?? '',
            write: async (path: string, data: string) => {
                files.set(path, data);
            },
            remove: async (path: string) => {
                files.delete(path);
            },
        },
    };
}

/** Stand-in for Electron's safeStorage: reversible, and obviously not the identity. */
function fakeSafeStorage() {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
        decryptString: (buffer: Buffer) => {
            const text = buffer.toString('utf8');
            if (!text.startsWith('enc:')) {
                throw new Error('not ours');
            }
            return text.slice(4);
        },
    };
}

describe('the log never carries note names by default', () => {
    it('replaces paths and file names with a stable token', () => {
        setLogShowsNames(false);
        const redacted = redactNames('Could not upload "Projekty/Trisula/Poznámky.md" and "Inbox/Meeting 10:30.md"');
        assert.ok(!redacted.includes('Trisula'), redacted);
        assert.ok(!redacted.includes('Meeting'), redacted);
        assert.match(redacted, /«file [0-9a-f]{6}»/);
        // The same name always gets the same token, so two lines still pair up.
        assert.equal(redactNames('a/b.md'), redactNames('a/b.md'));
        assert.notEqual(redactNames('a/b.md'), redactNames('a/c.md'));
    });

    it('keeps ordinary words and numbers that are not file names', () => {
        setLogShowsNames(false);
        assert.equal(redactNames('Syncing 120/4000'), 'Syncing 120/4000');
        // An address is not prose either: it is kept out of the log like a name.
        assert.ok(!redactNames('Signed in to Proton as someone@example.com').includes('someone@'));
    });

    it('replaces Drive node ids too: they identify a file across devices', () => {
        setLogShowsNames(false);
        const uid = 'w8SKm5oZxAhYYVfypUQRCf47jLomjutkpnfx2A-ogB7C6bWFDkPaIgk7IhtCKI_BjvIYAfyoEllHeQO1S6aVCQ==~ZD7EDo60rN9pWPQ3ovQR0cYTim';
        assert.equal(redactNames(`GET ${uid} 200`), 'GET «node» 200');
    });

    it('shows names again when the setting is on, for a bug report', () => {
        setLogShowsNames(true);
        assert.match(redactNames('Projekty/Trisula/Poznámky.md'), /Trisula/);
        setLogShowsNames(false);
    });

    it('leaves hosts and API paths alone: they name an endpoint, not a note', () => {
        setLogShowsNames(false);
        const line = 'GET https://drive-api.proton.me/drive/volumes/x/links 200 (351ms)';
        assert.equal(redactNames(line), line);
        assert.equal(redactNames('GET /drive/volumes/x/links 200'), 'GET /drive/volumes/x/links 200');
        assert.equal(redactNames('drive-api.proton.me'), 'drive-api.proton.me');
    });

    it('keeps the stack of an error, redacted, instead of throwing it away', () => {
        setLogShowsNames(false);
        const error = new Error('Could not upload a file');
        error.stack = 'Error: Could not upload a file\n    at upload (/vault/Tajné/poznámka.md:10:2)';
        const copy = redactArgument(error) as Error;
        assert.ok(copy instanceof Error);
        assert.equal(copy.stack?.includes('Tajné'), false, String(copy.stack));
        // The frame is what a bug report needs; only the name goes.
        assert.match(String(copy.stack), /at upload/);
    });

    it('redacts the strings inside a plain object, and keeps its shape', () => {
        setLogShowsNames(false);
        const copy = redactArgument({
            path: 'Tajné/poznámka.md',
            size: 12,
            nested: { name: 'Tajné/druhá.md' },
        }) as Record<string, unknown>;
        assert.equal(copy.size, 12);
        assert.equal(String(copy.path).includes('Tajné'), false, String(copy.path));
        const nested = copy.nested as Record<string, unknown>;
        assert.equal(String(nested.name).includes('Tajné'), false, String(nested.name));
    });

    it('redacts what reaches the buffer and the console alike', () => {
        setLogShowsNames(false);
        const lines: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
        try {
            const logger = new Logger('warn');
            logger.warn('Could not sync "Tajné/poznámka.md"');
            const buffered = logger.getEntries().at(-1)?.message ?? '';
            assert.ok(!buffered.includes('Tajné'), buffered);
            assert.ok(!lines.join(' ').includes('Tajné'), lines.join(' '));
        } finally {
            console.warn = original;
        }
    });
});

describe('requests go to Proton and nowhere else', () => {
    it('allows the hosts the plugin actually uses', () => {
        for (const url of [
            'https://drive-api.proton.me/drive/v2/shares/my-files',
            'https://drive.proton.me/api/',
            'https://account.proton.me/auth/v4',
            'https://zrh-storage.proton.me/storage/blocks',
            'https://pass.proton.me/',
        ]) {
            assert.doesNotThrow(() => assertProtonUrl(url), url);
        }
    });

    it('refuses anything else, so a token cannot be sent elsewhere', () => {
        for (const url of [
            'https://api.test/auth/v4',
            'https://proton.me.evil.example/collect',
            'http://drive-api.proton.me/drive',
            'https://notproton.me/x',
            'file:///etc/passwd',
        ]) {
            assert.throws(() => assertProtonUrl(url), /only talks to Proton/, url);
        }
    });
});

describe('the session is stored encrypted outside secret storage', () => {
    it('writes ciphertext, never the plaintext, and reads it back', async () => {
        const { adapter, files } = memoryAdapter();
        const slot = new SafeStorageFileSlot(adapter as never, 'session.bin', fakeSafeStorage());

        await slot.write('{"accessToken":"secret-token"}');
        const stored = files.get('session.bin') ?? '';
        assert.ok(!stored.includes('secret-token'), 'the file must not hold the token');
        assert.equal(Buffer.from(stored, 'base64').toString('utf8'), 'enc:{"accessToken":"secret-token"}');
        assert.deepEqual(await slot.read(), '{"accessToken":"secret-token"}');
    });

    it('clears the file on sign-out, and reports nothing when it cannot decrypt', async () => {
        const { adapter, files } = memoryAdapter();
        const slot = new SafeStorageFileSlot(adapter as never, 'session.bin', fakeSafeStorage());
        await slot.write('x');
        await slot.write(null);
        assert.equal(files.has('session.bin'), false);

        files.set('session.bin', Buffer.from('garbage').toString('base64'));
        assert.equal(await slot.read(), null);
    });

    it('moves a session out of secret storage and clears the old copy', async () => {
        const { adapter } = memoryAdapter();
        const secrets = new Map<string, string>([['proton-drive-sync-session-x', '{"uid":"u1"}']]);
        const legacy = new ObsidianSecretSlot(
            {
                getSecret: (id: string) => secrets.get(id) ?? '',
                setSecret: (id: string, value: string) => {
                    if (value === '') {
                        secrets.delete(id);
                    } else {
                        secrets.set(id, value);
                    }
                },
            } as never,
            'proton-drive-sync-session-x',
        );
        const target = new SafeStorageFileSlot(adapter as never, 'session.bin', fakeSafeStorage());

        assert.equal(await migrateSecret(legacy, target), true);
        assert.equal(await target.read(), '{"uid":"u1"}');
        assert.equal(secrets.size, 0, 'the readable copy is gone');

        // A second run must not overwrite a session that is already there.
        secrets.set('proton-drive-sync-session-x', '{"uid":"old"}');
        assert.equal(await migrateSecret(legacy, target), false);
        assert.equal(await target.read(), '{"uid":"u1"}');
    });
});

type Sent = { url: string; method: string; headers: Headers };
type Reply = Response | Error;

/** A `fetch` that records what it was sent and answers from a script. */
function scriptedFetch(reply: (sent: Sent) => Reply) {
    const sent: Sent[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) };
        sent.push(request);
        const answer = reply(request);
        if (answer instanceof Error) {
            throw answer;
        }
        return answer;
    };
    return { fetch: fetch as typeof globalThis.fetch, sent };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const html = (body: string, status: number) =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } });

class FakeCredentials implements SessionCredentials {
    uid: string | undefined = 'uid-1';
    accessToken: string | undefined = 'old';
    refreshToken: string | undefined = 'refresh-1';
    signedOut = false;

    on(): void {}
    isLoggedIn(): boolean {
        return !this.signedOut;
    }
    isTelemetryEnabled(): boolean {
        return false;
    }
    getUserKeyPassword(): string | undefined {
        return undefined;
    }
    async load(): Promise<void> {}
    async setUserKeyPassword(): Promise<void> {}
    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.uid = info.uid;
        this.accessToken = info.accessToken;
        this.refreshToken = info.refreshToken ?? this.refreshToken;
    }
    async setTelemetryEnabled(): Promise<void> {}
    async signOut(): Promise<void> {
        this.signedOut = true;
        this.uid = undefined;
        this.accessToken = undefined;
        this.refreshToken = undefined;
    }
}

describe('a refresh Proton refused, and one the network never delivered', () => {
    function api(reply: (sent: Sent) => Reply) {
        const credentials = new FakeCredentials();
        const ended = { count: 0 };
        const transport = scriptedFetch(reply);
        const client = new ApiClient({
            baseUrl: 'drive-api.proton.me',
            appVersion: 'test',
            credentials,
            logger: new Logger('error'),
            fetch: transport.fetch,
            onSessionEnded: () => (ended.count += 1),
        });
        const get = () => client.authenticatedRequest.get(`${client.baseUrlWithProtocol}/core/v4/users`).json();
        return { credentials, ended, transport, get };
    }

    it('keeps the session when a captive portal answers the refresh', async () => {
        const { credentials, ended, get } = api((request) =>
            request.url.endsWith('/auth/v4/refresh')
                ? html('<html><body>Sign in to the hotel Wi-Fi</body></html>', 403)
                : json({}, 401),
        );

        await assert.rejects(get(), HTTPError);

        assert.equal(credentials.signedOut, false, 'a portal refused the request, not Proton');
        assert.equal(credentials.accessToken, 'old');
        assert.equal(ended.count, 0);
    });

    it('keeps the session when the refresh never gets an answer', async () => {
        let refreshes = 0;
        const { credentials, ended, get } = api((request) => {
            if (request.url.endsWith('/auth/v4/refresh')) {
                refreshes += 1;
                return new TypeError('Failed to fetch');
            }
            return json({}, 401);
        });

        await assert.rejects(get(), HTTPError);

        assert.equal(refreshes, 3, 'one try and two retries');
        assert.equal(credentials.signedOut, false);
        assert.equal(ended.count, 0);
    });

    it('tries the refresh again when Proton is busy, instead of signing out', async () => {
        let refreshes = 0;
        const { credentials, ended, get } = api((request) => {
            if (request.url.endsWith('/auth/v4/refresh')) {
                refreshes += 1;
                return refreshes === 1 ? json({}, 503) : json({ UID: 'uid-1', AccessToken: 'new' });
            }
            return request.headers.get('authorization') === 'Bearer new' ? json({ User: 'me' }) : json({}, 401);
        });

        assert.deepEqual(await get(), { User: 'me' });
        assert.equal(credentials.accessToken, 'new');
        assert.equal(credentials.signedOut, false);
        assert.equal(ended.count, 0);
    });

    it('ends the session once when Proton refuses the refresh token', async () => {
        const { credentials, ended, get } = api((request) =>
            request.url.endsWith('/auth/v4/refresh')
                ? json({ Code: 10013, Error: 'invalid_grant' }, 401)
                : json({}, 401),
        );

        await assert.rejects(get(), HTTPError);

        assert.equal(credentials.signedOut, true);
        assert.equal(credentials.accessToken, undefined);
        assert.equal(ended.count, 1, 'the owner is told once, so the engine can stop');
    });

    it('ends the session on a 400 invalid_grant and a 403 invalid_credentials', async () => {
        for (const [status, error] of [
            [400, 'invalid_grant'],
            [403, 'invalid_credentials'],
        ] as const) {
            const { credentials, ended, get } = api((request) =>
                request.url.endsWith('/auth/v4/refresh') ? json({ Code: 1, Error: error }, status) : json({}, 401),
            );
            await assert.rejects(get(), HTTPError);
            assert.equal(credentials.signedOut, true, `${status} ${error}`);
            assert.equal(ended.count, 1, `${status} ${error}`);
        }
    });
});

describe('ProtonSession', () => {
    let sessionModule: typeof import('../src/proton/session');

    before(async () => {
        // The app build defines this through esbuild; the session reads it at load.
        (globalThis as { __PLUGIN_VERSION__?: string }).__PLUGIN_VERSION__ = '0.0.0-test';
        sessionModule = await import('../src/proton/session');
    });

    /** What `ProtonSession` asks of `Credentials`, with the parts a test needs to see. */
    class FakeSessionCredentials {
        uid: string | undefined;
        accessToken: string | undefined;
        refreshToken: string | undefined;
        accountEmail: string | undefined;
        listenerRegistrations = 0;
        loads = 0;
        unloaded = 0;

        on(): void {
            this.listenerRegistrations += 1;
        }
        isLoggedIn(): boolean {
            return false;
        }
        async load(): Promise<void> {
            this.loads += 1;
        }
        unload(): void {
            this.unloaded += 1;
        }
    }

    const newSession = (credentials: FakeSessionCredentials) =>
        new sessionModule.ProtonSession(credentials as unknown as Credentials, 'client-uid', new Logger('error'));

    it('builds the account once, however often init runs', async () => {
        const credentials = new FakeSessionCredentials();
        const session = newSession(credentials);

        await session.init();
        await session.init();

        assert.equal(credentials.listenerRegistrations, 1, 'one session listener, not one per init');
        assert.equal(credentials.loads, 2, 'the stored session is read again each time');
    });

    it('drops the decrypted keys when the PIN locks', async () => {
        const credentials = new FakeSessionCredentials();
        const session = newSession(credentials);
        await session.init();

        const clearKeyStore = CryptoProxy.clearKeyStore;
        let cleared = 0;
        CryptoProxy.clearKeyStore = async () => {
            cleared += 1;
        };
        try {
            session.lock();
        } finally {
            CryptoProxy.clearKeyStore = clearKeyStore;
        }

        assert.equal(cleared, 1, 'the imported private keys go with the session');
        assert.equal(credentials.unloaded, 1);
        assert.equal(session.isSignedIn(), false);
        assert.throws(() => session.getClient(), /Not signed in/);
    });
});

describe('finishing a sign-in the network interrupted (#41)', () => {
    let finishSignInSetup: typeof import('../src/proton/session').finishSignInSetup;

    before(async () => {
        (globalThis as { __PLUGIN_VERSION__?: string }).__PLUGIN_VERSION__ = '0.0.0-test';
        finishSignInSetup = (await import('../src/proton/session')).finishSignInSetup;
    });

    it('keeps trying the steps after the approval, then reports the address', async () => {
        let tries = 0;
        const email = await finishSignInSetup({
            complete: async () => {
                tries += 1;
                if (tries === 1) {
                    throw new TypeError('net::ERR_NAME_NOT_RESOLVED');
                }
                return 'someone@proton.me';
            },
            lastKnownEmail: () => undefined,
            logger: new Logger('error'),
            delaysMs: [0],
        });

        assert.equal(email, 'someone@proton.me');
        assert.equal(tries, 2);
    });

    it('still ends in a usable session when the steps keep failing', async () => {
        let tries = 0;
        const email = await finishSignInSetup({
            complete: async () => {
                tries += 1;
                throw new TypeError('Failed to fetch');
            },
            lastKnownEmail: () => 'known@proton.me',
            logger: new Logger('error'),
            delaysMs: [0],
        });

        assert.equal(email, 'known@proton.me');
        assert.equal(tries, 2);
    });
});
