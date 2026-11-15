import type { DataAdapter } from 'obsidian';

import type { Logger } from '../util/logger';
import type { SessionCredentials, SessionInfo } from './account';
import { newCacheKey } from './persistentCache';
import { LockedSlotError, type SecretSlot } from './secretStore';

type StoredSession = {
    version: 1;
    uid: string;
    accessToken: string;
    refreshToken?: string;
    userKeyPassword: string;
    telemetryEnabled: boolean;
    accountEmail?: string;
    /** Encrypts the saved Drive metadata cache; kept here so it shares the session's protection. */
    cacheKey?: string;
};

/** Where 0.1.0 kept the session, and how to read it back. */
export type LegacySessionFile = {
    adapter: DataAdapter;
    path: string;
    decrypt: (base64CipherText: string) => string | null;
};

/**
 * The plugin's `SessionCredentials`, kept in a {@link SecretSlot}.
 *
 * Kept out of `data.json` on purpose. Settings are saved on every change and
 * are fair game for a user to inspect or copy between machines; a session is
 * neither, and it belongs to one device. Keeping it outside the vault also
 * means a copied or synced vault never carries anyone's sign-in along.
 */
export class Credentials implements SessionCredentials {
    private session: StoredSession | null = null;
    /**
     * Set by {@link unload}: the session is out of memory on purpose, and
     * nothing may put it back except a load.
     */
    private locked = false;
    /**
     * A token pair that arrived while the PIN had the session unloaded.
     *
     * Held in memory only, and only until the next load: writing it is refused
     * while locked, and dropping it would leave a rotated-away refresh token in
     * the envelope. See {@link setSessionInfo}.
     */
    private pendingRefresh: SessionInfo | null = null;
    private readonly listeners = new Set<() => void>();
    /** The save queue: each save starts after the one before it has finished. */
    private pendingSave: Promise<void> = Promise.resolve();

    constructor(
        private readonly slot: SecretSlot,
        private readonly legacy: LegacySessionFile,
        private readonly logger: Logger,
    ) {}

    get uid(): string | undefined {
        return this.session?.uid;
    }

    get accessToken(): string | undefined {
        return this.session?.accessToken;
    }

    get refreshToken(): string | undefined {
        return this.session?.refreshToken;
    }

    get accountEmail(): string | undefined {
        return this.session?.accountEmail;
    }

    on(_event: 'sessionInfoChanged', callback: () => void): void {
        this.listeners.add(callback);
    }

    isLoggedIn(): boolean {
        return this.session !== null && Boolean(this.session.uid) && Boolean(this.session.userKeyPassword);
    }

    isTelemetryEnabled(): boolean {
        return this.session?.telemetryEnabled ?? false;
    }

    getUserKeyPassword(): string | undefined {
        return this.session?.userKeyPassword;
    }

    /**
     * The key the saved Drive cache is encrypted with, created with the first
     * session that needs one. Stored inside the session, so the PIN protects it
     * and signing out removes it. Null when there is no session.
     */
    async cacheKey(): Promise<string | null> {
        if (!this.session) {
            return null;
        }
        if (!this.session.cacheKey) {
            this.session.cacheKey = newCacheKey();
            await this.persist();
        }
        return this.session.cacheKey;
    }

    /**
     * Read the stored session, unless this run already holds one.
     *
     * A session in memory is newer than the stored one whenever a refresh
     * landed while the PIN was locked: the slot keeps that refresh aside and
     * only writes it on the next unlock (see `PinProtectedSlot.write`), so
     * re-reading here would put the pre-refresh tokens back in front of the
     * fresh pair. Nothing is thrown when the slot cannot be read: the plugin
     * starts signed out, which is recoverable, while a throw here is not.
     */
    async load(): Promise<void> {
        if (this.session !== null) {
            this.logger.debug('Keeping the session already in memory');
            return;
        }
        let stored: string | null;
        try {
            stored = await this.slot.read();
        } catch (error) {
            // Locked with the PIN, or a file this device cannot open; either
            // way there is no session to restore, and the unlock dialog or the
            // settings tab offers what to do about it.
            this.logger.warn('Could not read the stored Proton session; starting signed out', error);
            return;
        }
        if (stored === null) {
            stored = await this.migrateLegacyFile();
        }
        this.locked = false;
        if (stored === null) {
            return;
        }
        try {
            this.session = JSON.parse(stored) as StoredSession;
            this.logger.debug('Loaded stored Proton session');
        } catch (error) {
            this.logger.error('Failed to read the stored session', error);
        }
        if (this.session !== null && this.pendingRefresh !== null) {
            // A refresh that finished while the PIN had the session unloaded:
            // applied over what was stored, so the key password and the rest
            // of the session survive, and written now that the slot can.
            const { uid, accessToken, refreshToken } = this.pendingRefresh;
            this.pendingRefresh = null;
            this.session = {
                ...this.session,
                uid,
                accessToken,
                ...(refreshToken !== undefined && { refreshToken }),
            };
            await this.persist();
            this.emitChanged();
        }
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        if (this.locked) {
            // The PIN locked the session away. The tokens must not be written
            // — the slot would refuse, and the envelope is the only copy that
            // may exist on disk — but they must not be dropped either: Proton
            // rotates the refresh token on use, so the stored one is already
            // dead. They wait here and are merged at the next load(), which is
            // the first moment they can be stored encrypted.
            this.logger.debug('The session is unloaded for the PIN lock; holding a token refresh for the next unlock');
            this.pendingRefresh = info;
            return;
        }
        this.session = {
            version: 1,
            telemetryEnabled: false,
            userKeyPassword: '',
            ...this.session,
            uid: info.uid,
            accessToken: info.accessToken,
            ...(info.refreshToken !== undefined && { refreshToken: info.refreshToken }),
        };
        await this.persist();
        this.emitChanged();
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        // Only a sign-in sets the key password, and it does so before the new
        // session; a token refresh never does. A new sign-in is not the locked
        // session coming back, so the lock is lifted for it rather than
        // dropping the signed-in tokens on the floor. (See `setSessionInfo`.)
        this.locked = false;
        this.session = {
            version: 1,
            uid: '',
            accessToken: '',
            telemetryEnabled: false,
            ...this.session,
            userKeyPassword,
        };
        await this.persist();
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        if (!this.session) {
            return;
        }
        this.session.telemetryEnabled = enabled;
        await this.persist();
    }

    /** Records which account the session belongs to, for display in settings. */
    async setAccountEmail(email: string): Promise<void> {
        if (!this.session) {
            return;
        }
        this.session.accountEmail = email;
        await this.persist();
    }

    /**
     * Drop the session from memory, leaving it stored; for locking with the PIN.
     *
     * Listeners are told, as they are for any other change: the account module
     * caches key references that are erased with the session, and a reference
     * to a key that no longer exists fails every decrypt that uses it.
     */
    unload(): void {
        this.session = null;
        this.locked = true;
        this.pendingRefresh = null;
        this.emitChanged();
    }

    async signOut(): Promise<void> {
        this.session = null;
        this.locked = false;
        this.pendingRefresh = null;
        await this.enqueueSave(null);
        await this.removeLegacyFile();
        this.emitChanged();
    }

    /**
     * Save the current session, after every save asked for before it.
     *
     * Two saves can overlap - a refresh that lands while the plugin is writing
     * the session it just changed - and the store takes whichever finishes
     * last. Each save carries the value it was asked to write, so chaining
     * them makes the newest token set the one that ends up stored.
     */
    private persist(): Promise<void> {
        if (!this.session) {
            return Promise.resolve();
        }
        return this.enqueueSave(JSON.stringify(this.session));
    }

    /** Queue one write behind the saves before it. */
    private enqueueSave(value: string | null): Promise<void> {
        const save = this.pendingSave.then(() => this.write(value));
        // One failed save must not stop the ones after it; the caller still
        // sees the failure on its own promise.
        this.pendingSave = save.catch(() => undefined);
        return save;
    }

    /**
     * Write one value to the slot.
     *
     * A PIN-locked slot refuses a plaintext write, and rightly: the stored
     * session is the envelope, and replacing it with the tokens would undo the
     * PIN. The slot keeps the value it refused and writes it at the next
     * unlock, so a refresh that landed under the lock is not lost; nothing
     * more to do here.
     */
    private async write(value: string | null): Promise<void> {
        try {
            await this.slot.write(value);
        } catch (error) {
            if (!(error instanceof LockedSlotError)) {
                throw error;
            }
            this.logger.debug('The PIN is locked; the slot keeps the refreshed session for the next unlock');
            return;
        }
        if (value !== null) {
            // A new session supersedes one an older version left behind.
            await this.removeLegacyFile();
        }
    }

    /**
     * Move a session saved by 0.1.0 into the slot.
     *
     * The old file is deleted once migrated, or when it is not something this
     * plugin wrote. It is kept when decryption merely failed: on Linux the
     * keyring is often still locked early in a login, and deleting the file
     * then would sign the user out for good over a timing accident.
     */
    private async migrateLegacyFile(): Promise<string | null> {
        const { adapter, path, decrypt } = this.legacy;
        let file: { encrypted?: boolean; payload?: unknown };
        try {
            if (!(await adapter.exists(path))) {
                return null;
            }
            file = JSON.parse(await adapter.read(path)) as typeof file;
        } catch (error) {
            this.logger.warn('Discarding an unreadable session file left by an older version', error);
            await this.removeLegacyFile();
            return null;
        }
        if (file.encrypted !== true || typeof file.payload !== 'string') {
            // Only reachable for a file this plugin did not write. Refuse it
            // rather than adopt a session of unknown provenance.
            this.logger.warn('Stored session is not encrypted; ignoring it');
            await this.removeLegacyFile();
            return null;
        }

        const decrypted = decrypt(file.payload);
        if (decrypted === null) {
            this.logger.warn('Could not decrypt the session saved by an older version; will try again next launch');
            return null;
        }
        try {
            await this.slot.write(decrypted);
        } catch (error) {
            if (!(error instanceof LockedSlotError)) {
                throw error;
            }
            // The slot is locked; the session is usable for this run and the
            // old file stays for the next start, rather than being deleted
            // with nowhere to put it.
            this.logger.debug('The PIN is locked; keeping the old session file until the unlock');
            return decrypted;
        }
        await this.removeLegacyFile();
        this.logger.info('Moved the stored Proton session into Obsidian’s secret storage');
        return decrypted;
    }

    private async removeLegacyFile(): Promise<void> {
        try {
            if (await this.legacy.adapter.exists(this.legacy.path)) {
                await this.legacy.adapter.remove(this.legacy.path);
            }
        } catch (error) {
            this.logger.warn('Failed to remove the old session file', error);
        }
    }

    private emitChanged(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
