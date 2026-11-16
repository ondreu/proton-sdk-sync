import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { MemoryCache, type ProtonDriveEntitiesCache } from '@protontech/drive-sdk';

import { Credentials } from '../src/proton/credentials';
import { EncryptedEntitiesCache, type CacheStore, type StoredEntry } from '../src/proton/persistentCache';
import type { ProtonSession } from '../src/proton/session';
import type { SecretSlot } from '../src/proton/secretStore';
import type { DataAdapter } from 'obsidian';
import { Logger } from '../src/util/logger';

const SILENT = new Logger('error');

let sessionModule: typeof import('../src/proton/session');

before(async () => {
    // The app build defines this through esbuild; the session reads it at load.
    (globalThis as { __PLUGIN_VERSION__?: string }).__PLUGIN_VERSION__ = '0.0.0-test';
    sessionModule = await import('../src/proton/session');
});

const STORED = JSON.stringify({
    version: 1,
    uid: 'test-uid',
    accessToken: 'test-access-token',
    userKeyPassword: 'test-key-password',
    telemetryEnabled: false,
});

function memorySlot(stored: string | null = STORED): SecretSlot {
    return {
        async read(): Promise<string | null> {
            return stored;
        },
        async write(): Promise<void> {},
        isEncrypted(): boolean {
            return false;
        },
    };
}

function noLegacy() {
    return {
        adapter: { exists: async () => false } as unknown as DataAdapter,
        path: 'legacy-session.json',
        decrypt: () => null,
    };
}

async function loggedInCredentials(): Promise<Credentials> {
    const credentials = new Credentials(memorySlot(), noLegacy(), SILENT);
    await credentials.load();
    assert.equal(credentials.isLoggedIn(), true);
    return credentials;
}

function memoryCacheStore(): CacheStore & { writes: number } {
    const entries = new Map<string, StoredEntry>();
    return {
        writes: 0,
        async load() {
            return { entries: [...entries.values()], marker: null };
        },
        async write(written: StoredEntry[], removed: string[], _marker: string): Promise<void> {
            this.writes++;
            for (const entry of written) {
                entries.set(entry.key, entry);
            }
            for (const key of removed) {
                entries.delete(key);
            }
        },
        async clear(): Promise<void> {
            entries.clear();
        },
    };
}

/** The private opener, reached structurally: it is the seam under test. */
function opener(session: ProtonSession): () => Promise<ProtonDriveEntitiesCache> {
    const inner = session as unknown as { openEntitiesCache(): Promise<ProtonDriveEntitiesCache> };
    return () => inner.openEntitiesCache();
}

describe('ProtonSession headless deps', () => {
    it('uses the injected cache store instead of IndexedDB', async () => {
        const store = memoryCacheStore();
        const session = new sessionModule.ProtonSession(await loggedInCredentials(), 'test-client', SILENT, () => '', {
            cacheStore: store,
        });
        const cache = await opener(session)();
        assert.ok(cache instanceof EncryptedEntitiesCache);
    });

    it('without the hook, Node falls back to the in-memory cache as before', async () => {
        assert.equal(typeof indexedDB, 'undefined');
        const session = new sessionModule.ProtonSession(await loggedInCredentials(), 'test-client', SILENT);
        const cache = await opener(session)();
        assert.ok(cache instanceof MemoryCache);
    });

    it('constructing with the hook changes nothing when no session is stored', async () => {
        const credentials = new Credentials(memorySlot(null), noLegacy(), SILENT);
        await credentials.load();
        const session = new sessionModule.ProtonSession(credentials, 'test-client', SILENT, () => '', { cacheStore: memoryCacheStore() });
        assert.equal(session.isSignedIn(), false);
    });
});
