import { Platform, type DataAdapter, type SecretStorage } from 'obsidian';

import type { Logger } from '../util/logger';

/**
 * One secret value, read and written whole. Asynchronous so that a slot can
 * encrypt what it stores; see `PinProtectedSlot`.
 */
export interface SecretSlot {
    /**
     * The stored value, or `null` when nothing is stored.
     *
     * @throws {@link UnreadableSlotError} when something is stored but cannot
     * be read back. That is not the same as nothing being there, and callers
     * must not treat it as one: a PIN-protected envelope that cannot be opened
     * would otherwise look like an empty slot and be replaced with plaintext.
     */
    read(): Promise<string | null>;
    /**
     * `null` clears the secret.
     *
     * @throws {@link LockedSlotError} when the slot is PIN-protected and
     * locked, and the value would have to be stored in the clear; the caller
     * keeps it in memory and drops the write.
     */
    write(value: string | null): Promise<void>;
    /**
     * Whether the platform encrypts what this slot holds at rest.
     *
     * Only a slot that answers `true` may keep a derived PIN key across
     * restarts; see `RememberedUnlock`. Optional so a test double need not
     * implement it, and read as "not encrypted" when absent.
     */
    isEncrypted?(): boolean;
}

/**
 * The slot is locked, so the value was not stored.
 *
 * A PIN-protected slot stores ciphertext; writing while it is locked would put
 * the plaintext back in its place, which is how a token refresh that finished
 * after the PIN locked replaced the envelope with readable tokens.
 */
export class LockedSlotError extends Error {
    constructor() {
        super('The stored secret is locked; the write was refused');
        this.name = 'LockedSlotError';
    }
}

/**
 * Something is stored, but it cannot be read back.
 *
 * Distinct from `null`, which means nothing is stored. A file that exists and
 * will not decrypt is usually a session this device can no longer open — a
 * reinstalled keychain, a different OS user, a torn write — and reporting it
 * as absent made a PIN-protected slot look unprotected, after which the next
 * token refresh stored the session in the clear over the envelope.
 */
export class UnreadableSlotError extends Error {
    constructor(
        readonly path: string,
        options?: { cause?: unknown },
    ) {
        super(`The stored secret at ${path} cannot be read; it was left as it is`, options);
        this.name = 'UnreadableSlotError';
    }
}

/**
 * A secret in Obsidian's secret storage.
 *
 * The plugin stores a Proton session: an access token, a refresh token, and the
 * password that unlocks the user's private keys. Obsidian keeps these secrets
 * per device, outside the vault, and backed by the platform keystore where
 * there is one. That matters twice over for a sync plugin: anything written
 * into the vault would be picked up by the user's other backups, and by this
 * very plugin. Unlike Electron's `safeStorage`, which 0.1.0 used, it also
 * exists on Android and iOS.
 */
export class ObsidianSecretSlot implements SecretSlot {
    constructor(
        private readonly storage: SecretStorage,
        private readonly id: string,
    ) {}

    async read(): Promise<string | null> {
        // Cleared secrets read back as an empty string.
        return this.storage.getSecret(this.id) || null;
    }

    async write(value: string | null): Promise<void> {
        this.storage.setSecret(this.id, value ?? '');
    }

    /**
     * No: this is one namespace every plugin can read with a single call, and
     * on mobile nothing encrypts it at rest. A derived key kept here would
     * stand in for the PIN without being protected any better than the
     * envelope is.
     */
    isEncrypted(): boolean {
        return false;
    }
}

/**
 * Node's `fs`, on desktop only.
 *
 * Obsidian writes through its adapter, which creates files with the process
 * umask (0644 on most systems). A session file that any local user can read is
 * a finding the plugin reports itself, so it is also fixed where it is created.
 */
function nodeFs(): typeof import('node:fs') | null {
    try {
        return (window.require('node:fs') as typeof import('node:fs')) ?? null;
    } catch {
        return null;
    }
}

type SafeStorage = {
    isEncryptionAvailable(): boolean;
    decryptString(encrypted: Buffer): string;
};

/**
 * Decrypt a session saved by 0.1.0, which encrypted it with Electron's
 * `safeStorage` into `session.json`. Desktop only, since that is the only
 * place such a file can have been written. Used once, to migrate the session
 * into {@link ObsidianSecretSlot}, so upgrading does not sign anyone out.
 */
export function decryptLegacySession(base64CipherText: string, logger: Logger): string | null {
    if (!Platform.isDesktopApp) {
        return null;
    }
    for (const moduleName of ['electron', '@electron/remote']) {
        try {
            const required = window.require(moduleName) as Record<string, unknown>;
            const safeStorage =
                (required?.safeStorage as SafeStorage | undefined) ??
                ((required?.remote as Record<string, unknown> | undefined)?.safeStorage as SafeStorage | undefined);
            if (safeStorage?.isEncryptionAvailable?.() === true) {
                return safeStorage.decryptString(Buffer.from(base64CipherText, 'base64'));
            }
        } catch (error) {
            logger.debug(`Could not decrypt the old session with "${moduleName}"`, error);
        }
    }
    return null;
}

/**
 * A secret in an encrypted file of the plugin's own, keyed by the OS keystore
 * (Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux).
 *
 * Obsidian's secret storage is a better home in one respect — it exists on
 * mobile — but it is a single namespace that *every* plugin can read with one
 * call (`app.secretStorage.listSecrets()` and `getSecret()`), and the ids name
 * the plugin, so a session kept there is a two-line theft. This keeps the same
 * protection at rest while removing the shared-API shortcut; the file lives in
 * the plugin's own folder, which is never synced.
 *
 * It is not a boundary against a plugin that goes looking for files and calls
 * `safeStorage.decryptString` itself — nothing inside one process is; see
 * SECURITY.md.
 */
export class SafeStorageFileSlot implements SecretSlot {
    constructor(
        private readonly adapter: DataAdapter,
        private readonly path: string,
        private readonly safeStorage: SafeStorageWithEncryption,
    ) {}

    /**
     * The stored session, `null` when there is none.
     *
     * @throws {@link UnreadableSlotError} when the file exists and cannot be
     * decrypted. Returning `null` for that made a lock look like an empty
     * slot; see {@link UnreadableSlotError}.
     */
    async read(): Promise<string | null> {
        if (!(await this.adapter.exists(this.path))) {
            return null;
        }
        let encoded: string;
        try {
            encoded = await this.adapter.read(this.path);
        } catch (error) {
            // Present but unreadable: a different OS user, a filesystem the
            // app cannot reach. Not the same as an absent file.
            throw new UnreadableSlotError(this.path, { cause: error });
        }
        try {
            const value = this.safeStorage.decryptString(Buffer.from(encoded, 'base64')) || null;
            if (value !== null) {
                // Heal a file an older version wrote readable by everyone.
                this.closeToOthers();
            }
            return value;
        } catch (error) {
            // A reinstalled keychain, another OS user, or a damaged file: the
            // secret is unreadable, and saying so is better than throwing on
            // every start. What must not happen is calling it absent.
            throw new UnreadableSlotError(this.path, { cause: error });
        }
    }

    /**
     * Store the session, whole or not at all.
     *
     * `write` truncates before it writes, so a crash or a full disk halfway
     * through leaves a file that no longer decrypts - the very state that
     * reads as unreadable. Writing beside the file and renaming over it means
     * the old envelope stays in place until the new one is complete.
     */
    async write(value: string | null): Promise<void> {
        if (value === null) {
            await this.removeQuietly(this.path);
            await this.removeQuietly(this.tempPath);
            return;
        }
        const encoded = this.safeStorage.encryptString(value).toString('base64');
        await this.adapter.write(this.tempPath, encoded);
        this.closeToOthers(this.tempPath);
        try {
            await this.adapter.rename(this.tempPath, this.path);
        } catch (error) {
            // The old envelope is still there and still opens; leave it that
            // way rather than falling back to a direct write.
            await this.removeQuietly(this.tempPath);
            throw error;
        }
        this.closeToOthers();
    }

    /** SafeStorage: whatever the OS keystore is, this file is encrypted with it. */
    isEncrypted(): boolean {
        return true;
    }

    /** Where a write lands before it is renamed over {@link path}. */
    private get tempPath(): string {
        return `${this.path}.tmp`;
    }

    private async removeQuietly(path: string): Promise<void> {
        try {
            if (await this.adapter.exists(path)) {
                await this.adapter.remove(path);
            }
        } catch {
            // Best effort: a file left behind is overwritten by the next write.
        }
    }

    /** Make an existing file private, in case an older version wrote it 0644. */
    closeToOthers(target = this.path): void {
        const fs = nodeFs();
        if (!fs) {
            return;
        }
        // `fs` resolves a relative path against Obsidian's working directory,
        // which is not the vault, so the path has to become absolute first.
        const base = (this.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
        const resolved = base && !target.startsWith('/') ? `${base}/${target}` : target;
        try {
            fs.chmodSync(resolved, 0o600);
        } catch {
            // Best effort: a filesystem without modes, or a path the app cannot
            // reach from Node. The permission check reports what it sees.
        }
    }
}

export type SafeStorageWithEncryption = SafeStorage & { encryptString(value: string): Buffer };

/** Electron's `safeStorage`, when this platform can encrypt at all; null otherwise (mobile, or no keyring). */
export function encryptedStorage(logger: Logger): SafeStorageWithEncryption | null {
    if (!Platform.isDesktopApp) {
        return null;
    }
    for (const moduleName of ['electron', '@electron/remote']) {
        try {
            const required = window.require(moduleName) as Record<string, unknown>;
            const candidate =
                (required?.safeStorage as SafeStorageWithEncryption | undefined) ??
                ((required?.remote as Record<string, unknown> | undefined)?.safeStorage as
                    | SafeStorageWithEncryption
                    | undefined);
            if (candidate?.isEncryptionAvailable?.() === true && typeof candidate.encryptString === 'function') {
                return candidate;
            }
        } catch (error) {
            logger.debug(`Could not reach safeStorage through "${moduleName}"`, error);
        }
    }
    return null;
}

/**
 * Move a value left in Obsidian's secret storage into `to`, then clear it, so
 * upgrading does not sign anyone out and the old copy stops being readable by
 * other plugins. Best effort: a failure here means the user signs in again.
 *
 * An unreadable target counts as occupied: it is not an empty slot, and
 * overwriting it would lose whatever it holds.
 */
export async function migrateSecret(from: ObsidianSecretSlot, to: SecretSlot): Promise<boolean> {
    let existing: string | null;
    try {
        existing = await to.read();
    } catch {
        return false;
    }
    if (existing !== null) {
        return false;
    }
    const legacy = await from.read();
    if (legacy === null) {
        return false;
    }
    await to.write(legacy);
    await from.write(null);
    return true;
}
