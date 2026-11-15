import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DataAdapter, SecretStorage } from 'obsidian';

import { Credentials } from '../src/proton/credentials';
import { PinProtectedSlot } from '../src/proton/pinLock';
import { ObsidianSecretSlot, type SecretSlot } from '../src/proton/secretStore';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');
const LEGACY = '.obsidian/plugins/proton-drive-sync/session.json';

function memorySlot(initial: string | null = null) {
    const slot = {
        value: initial,
        read: async () => slot.value,
        write: async (value: string | null) => void (slot.value = value),
    };
    return slot satisfies SecretSlot;
}

function memoryAdapter(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files));
    const adapter = {
        exists: async (path: string) => store.has(path),
        read: async (path: string) => store.get(path)!,
        remove: async (path: string) => void store.delete(path),
    } as unknown as DataAdapter;
    return { adapter, store };
}

const SESSION = JSON.stringify({
    version: 1,
    uid: 'uid-1',
    accessToken: 'access',
    refreshToken: 'refresh',
    userKeyPassword: 'key-password',
    telemetryEnabled: false,
    accountEmail: 'me@proton.me',
});

describe('Credentials', () => {
    it('keeps the session in the secret slot, never in the vault', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);

        await credentials.setUserKeyPassword('key-password');
        await credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'access' });

        assert.equal(store.size, 0);
        const reloaded = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await reloaded.load();
        assert.equal(reloaded.isLoggedIn(), true);
        assert.equal(reloaded.getUserKeyPassword(), 'key-password');
    });

    it('moves a session saved by 0.1.0 into the slot and deletes the old file', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({ [LEGACY]: JSON.stringify({ encrypted: true, payload: 'cipher' }) });
        const credentials = new Credentials(
            slot,
            { adapter, path: LEGACY, decrypt: (payload) => (payload === 'cipher' ? SESSION : null) },
            SILENT,
        );

        await credentials.load();

        assert.equal(credentials.isLoggedIn(), true);
        assert.equal(credentials.accountEmail, 'me@proton.me');
        assert.equal(slot.value, SESSION);
        assert.equal(store.has(LEGACY), false);
    });

    it('keeps an old session file it cannot decrypt yet, for the next launch', async () => {
        // On Linux the keyring may simply still be locked at startup.
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({ [LEGACY]: JSON.stringify({ encrypted: true, payload: 'x' }) });
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);

        await credentials.load();

        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(store.has(LEGACY), true);
    });

    it('drops the old session file once a new sign-in is saved', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({ [LEGACY]: JSON.stringify({ encrypted: true, payload: 'x' }) });
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();

        await credentials.setSessionInfo({ uid: 'uid-2', accessToken: 'new' });

        assert.equal(store.has(LEGACY), false);
    });

    it('never adopts a plaintext session file', async () => {
        const slot = memorySlot();
        const { adapter, store } = memoryAdapter({
            [LEGACY]: JSON.stringify({ encrypted: false, payload: JSON.parse(SESSION) }),
        });
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => SESSION }, SILENT);

        await credentials.load();
        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(store.has(LEGACY), false);
    });

    it('forgets everything on sign-out', async () => {
        const slot = memorySlot(SESSION);
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();

        let notified = false;
        credentials.on('sessionInfoChanged', () => (notified = true));
        await credentials.signOut();

        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(slot.value, null);
        assert.equal(notified, true);
    });

    it('keeps a refresh the locked envelope refused, and it is what the unlock restores', async () => {
        const inner = memorySlot(SESSION);
        const pinSlot = new PinProtectedSlot(inner, 1000);
        await pinSlot.setPin('482915');
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(pinSlot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();
        assert.equal(credentials.isLoggedIn(), true);

        // What lockNow does next, then a token refresh that finishes just
        // before the credentials unload: the write is refused, and Proton has
        // already rotated the refresh token away.
        pinSlot.lock();
        await credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'refreshed-token', refreshToken: 'refresh-2' });

        const stored = inner.value!;
        assert.ok(stored.startsWith('{"format":"proton-drive-sync/pin-v1"'), stored);
        assert.ok(!stored.includes('refreshed-token'), 'the envelope must not be replaced by plaintext');
        assert.equal(credentials.accessToken, 'refreshed-token', 'the run keeps using the fresh pair');

        // The unlock is what writes it, and the session loaded afterwards is
        // the fresh pair rather than the one Proton already replaced.
        credentials.unload();
        assert.equal(await pinSlot.unlock('482915'), true);
        await credentials.load();
        assert.equal(credentials.accessToken, 'refreshed-token');
        assert.equal(credentials.refreshToken, 'refresh-2');
        assert.ok(inner.value!.startsWith('{"format":"proton-drive-sync/pin-v1"'), String(inner.value));
    });

    it('drops a token refresh that lands after unload, rather than signing back in behind the lock', async () => {
        const slot = memorySlot(SESSION);
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();

        credentials.unload();
        await credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'refreshed-token', refreshToken: 'refresh-2' });

        assert.equal(credentials.accessToken, undefined);
        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(slot.value, SESSION, 'the stored session is what the unlock reads');
    });

    it('accepts a new sign-in after a lock, which the lock was never about', async () => {
        const slot = memorySlot(SESSION);
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();
        credentials.unload();

        // What the fork sign-in does: the key password, then the session.
        await credentials.setUserKeyPassword('key-password-2');
        await credentials.setSessionInfo({ uid: 'uid-9', accessToken: 'signed-in', refreshToken: 'r9' });

        assert.equal(credentials.isLoggedIn(), true);
        assert.equal(credentials.accessToken, 'signed-in');
        assert.equal(JSON.parse(slot.value!).accessToken, 'signed-in');
    });

    it('loads nothing from a locked slot instead of throwing', async () => {
        const inner = memorySlot(SESSION);
        const pinSlot = new PinProtectedSlot(inner, 1000);
        await pinSlot.setPin('482915');
        pinSlot.lock();
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(pinSlot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);

        await credentials.load();

        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(inner.value!.startsWith('{"format":"proton-drive-sync/pin-v1"'), true);
    });

    it('leaves a session already in memory alone, rather than re-reading an older envelope', async () => {
        const slot = memorySlot(SESSION);
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();

        // The slot's write was refused, so what is stored is still the older
        // pair while memory holds the fresh one.
        await credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'fresh', refreshToken: 'r2' });
        slot.value = SESSION;
        await credentials.load();

        assert.equal(credentials.accessToken, 'fresh');
        assert.equal(credentials.refreshToken, 'r2');
    });

    it('tells listeners when the session is unloaded for a lock', async () => {
        const slot = memorySlot(SESSION);
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);
        await credentials.load();
        let notified = 0;
        credentials.on('sessionInfoChanged', () => (notified += 1));

        credentials.unload();

        // The account module drops its cached key references on this event; the
        // keys themselves are erased with the lock, so a kept reference would fail.
        assert.equal(notified, 1);
        assert.equal(credentials.isLoggedIn(), false);
        assert.equal(slot.value, SESSION, 'the stored session stays for the unlock');
    });

    it('saves token sets in the order they were refreshed, so an older one cannot win', async () => {
        const writes: (string | null)[] = [];
        const store = { value: null as string | null };
        const slot: SecretSlot = {
            read: async () => store.value,
            write: async (value: string | null) => {
                writes.push(value);
                // The first save takes its time: without a queue it would land
                // after the second and put the older token set back.
                await new Promise((resolve) => setTimeout(resolve, writes.length === 1 ? 40 : 5));
                store.value = value;
            },
        };
        const { adapter } = memoryAdapter();
        const credentials = new Credentials(slot, { adapter, path: LEGACY, decrypt: () => null }, SILENT);

        const first = credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'one', refreshToken: 'r1' });
        const second = credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'two', refreshToken: 'r2' });
        await Promise.all([first, second]);

        assert.equal(writes.length, 2);
        assert.equal(JSON.parse(writes[0]!).accessToken, 'one');
        assert.equal(JSON.parse(writes[1]!).accessToken, 'two');
        assert.equal(JSON.parse(store.value!).accessToken, 'two');
    });
});

describe('ObsidianSecretSlot', () => {
    it('reads a cleared secret as absent', async () => {
        const secrets = new Map<string, string>();
        const storage = {
            getSecret: (id: string) => secrets.get(id) ?? null,
            setSecret: (id: string, value: string) => void secrets.set(id, value),
        } as unknown as SecretStorage;
        const slot = new ObsidianSecretSlot(storage, 'proton-drive-sync-session-x');

        assert.equal(await slot.read(), null);
        await slot.write('secret');
        assert.equal(await slot.read(), 'secret');
        await slot.write(null);
        assert.equal(await slot.read(), null);
    });
});
