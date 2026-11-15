import '../src/polyfills';

import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { generateSignInUrl, parseUserKeyPassword } from '../src/proton/account/authWeb';
import { Auth } from '../src/proton/account/auth';
import type { AccountApi } from '../src/proton/account/accountApi';
import { AccountApiError } from '../src/proton/account/accountApi';
import type { SessionCredentials, SessionInfo } from '../src/proton/account/sessionCredentials';
import type { Srp } from '../src/proton/account/srp';
import { Logger } from '../src/util/logger';

/** Encrypt a fork payload the way account.proton.me does: AES-256-GCM, AAD "fork", nonce‖ciphertext‖tag. */
function forkPayload(key: Uint8Array, json: object): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('fork'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(json), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

describe('authWeb — sign-in fork', () => {
    it('puts a fresh 256-bit key and the client id in the sign-in link', () => {
        const { encryptionKey, signInUrl } = generateSignInUrl('external-drive', 'CODE', 'account.proton.me');
        assert.equal(encryptionKey.byteLength, 32);
        const payload = decodeURIComponent(signInUrl.split('#payload=')[1]!);
        assert.equal(payload, `0:CODE:${Buffer.from(encryptionKey).toString('base64')}:external-drive`);
        assert.ok(signInUrl.startsWith('https://account.proton.me/desktop/login?'));
        assert.notDeepEqual(generateSignInUrl('external-drive', 'CODE').encryptionKey, encryptionKey);
    });

    it('decrypts the key password Proton returns', async () => {
        const { encryptionKey } = generateSignInUrl('external-drive', 'CODE');
        const payload = forkPayload(encryptionKey, { type: 'default', keyPassword: 'hunter2' });
        assert.equal(await parseUserKeyPassword(encryptionKey, payload), 'hunter2');
    });

    it('rejects a payload that was tampered with or encrypted for another key', async () => {
        const { encryptionKey } = generateSignInUrl('external-drive', 'CODE');
        const other = generateSignInUrl('external-drive', 'CODE').encryptionKey;
        await assert.rejects(parseUserKeyPassword(encryptionKey, forkPayload(other, { keyPassword: 'x' })));

        const bytes = Buffer.from(forkPayload(encryptionKey, { keyPassword: 'x' }), 'base64');
        bytes[20]! ^= 1;
        await assert.rejects(parseUserKeyPassword(encryptionKey, bytes.toString('base64')));
    });

    it('rejects a payload without a key password, or too short to hold one', async () => {
        const { encryptionKey } = generateSignInUrl('external-drive', 'CODE');
        await assert.rejects(parseUserKeyPassword(encryptionKey, forkPayload(encryptionKey, { type: 'x' })));
        await assert.rejects(parseUserKeyPassword(encryptionKey, 'AAAA'), /blob length/);
    });
});

/** The session fields the account module writes, in memory. */
class MemoryCredentials implements SessionCredentials {
    uid: string | undefined;
    accessToken: string | undefined;
    refreshToken: string | undefined;
    private userKeyPassword: string | undefined;
    private telemetryEnabled = false;

    on(): void {}
    isLoggedIn(): boolean {
        return this.uid !== undefined && this.userKeyPassword !== undefined;
    }
    isTelemetryEnabled(): boolean {
        return this.telemetryEnabled;
    }
    getUserKeyPassword(): string | undefined {
        return this.userKeyPassword;
    }
    async load(): Promise<void> {}
    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this.userKeyPassword = userKeyPassword;
    }
    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.uid = info.uid;
        this.accessToken = info.accessToken;
        this.refreshToken = info.refreshToken ?? this.refreshToken;
    }
    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        this.telemetryEnabled = enabled;
    }
    async signOut(): Promise<void> {
        this.uid = this.accessToken = this.refreshToken = this.userKeyPassword = undefined;
    }
}

describe('authViaWeb — a phone that loses the network (#41)', () => {
    it('asks the fork again after a poll that never reached Proton, and still signs in', async () => {
        const credentials = new MemoryCredentials();
        let encryptionKey: Uint8Array | undefined;
        let polls = 0;
        const accountApi = {
            async sessionForksInit() {
                return { Code: 1000, Selector: 'selector', UserCode: 'USER' };
            },
            async sessionForksStatus() {
                polls += 1;
                if (polls === 1) {
                    // What an Android device reports while the network is away.
                    throw new AccountApiError('Unable to resolve host "account.proton.me"', {});
                }
                return {
                    Code: 1000,
                    Payload: forkPayload(encryptionKey!, { type: 'default', keyPassword: 'key-password' }),
                    UID: 'uid-1',
                    AccessToken: 'access-token',
                    RefreshToken: 'refresh-token',
                };
            },
            async settings() {
                return { UserSettings: { Telemetry: 0 } };
            },
        };
        const auth = new Auth(
            'external-drive',
            accountApi as unknown as AccountApi,
            credentials,
            {} as Srp,
            new Logger('error'),
            'account.proton.me',
            { initialDelayMs: 0, pollIntervalMs: 0, retryDelaysMs: [0] },
        );

        const result = await auth.authViaWeb((url) => {
            const payload = decodeURIComponent(url.split('#payload=')[1]!);
            encryptionKey = Buffer.from(payload.split(':')[2]!, 'base64');
        });

        assert.equal(polls, 2, 'the failed poll was asked again, not given up on');
        assert.equal(result.uid, 'uid-1');
        assert.equal(credentials.uid, 'uid-1');
        assert.equal(credentials.accessToken, 'access-token');
        assert.equal(credentials.refreshToken, 'refresh-token');
        assert.equal(credentials.getUserKeyPassword(), 'key-password');
        assert.equal(credentials.isLoggedIn(), true, 'the session survives as a usable one');
    });
});
