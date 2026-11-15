import { LockedSlotError, type SecretSlot } from './secretStore';

/**
 * An optional PIN over the stored Proton session.
 *
 * Without a PIN the session sits in Obsidian's secret storage as is, which the
 * operating system protects while the device is locked but not from anyone
 * using it unlocked: Obsidian's own Keychain settings can show it. With a PIN,
 * what is stored is the session encrypted with a key derived from the PIN, so
 * a copy of the secret is useless without the PIN, and Obsidian asks for it
 * when the plugin starts.
 *
 * The PIN is never stored. The key derived from it stays in memory while
 * Obsidian runs, so tokens refreshed during the session are saved encrypted
 * again; it is gone when Obsidian closes. A forgotten PIN cannot be
 * recovered, only replaced: {@link PinProtectedSlot.forget} deletes the
 * locked session and the user signs in again. Notes are not affected either
 * way, since the PIN only ever protected the sign-in.
 *
 * Key derivation is PBKDF2-SHA256 at 1,000,000 iterations, the strongest
 * function WebCrypto offers on every platform Obsidian runs on; encryption is
 * AES-256-GCM. Each envelope records the work factor it was written with, so
 * a session protected by an older, cheaper setting still opens. A wrong PIN
 * is counted beside the ciphertext and holds off the next try for a second,
 * doubling per failure up to thirty; see {@link PinProtectedSlot.attemptState}.
 */

export const MIN_PIN_LENGTH = 6;

/**
 * PBKDF2-SHA256 rounds used for a new PIN.
 *
 * Six digits is only a million guesses, so the work factor is what stands
 * between a copied envelope and the session: at this setting a GPU spends
 * minutes per PIN rather than seconds.
 */
export const PIN_ITERATIONS = 1_000_000;

const FORMAT = 'proton-drive-sync/pin-v1';
/** The first wrong PIN waits this long, and each further one waits twice as long, up to {@link BACKOFF_MAX_MS}. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Binds the ciphertext to its purpose, so it cannot be passed off as anything else. */
const ASSOCIATED_DATA = new TextEncoder().encode(FORMAT);

type Envelope = {
    format: typeof FORMAT;
    kdf: 'PBKDF2-SHA256';
    iterations: number;
    salt: string;
    iv: string;
    data: string;
    /** Wrong PINs since the last success, kept beside the ciphertext so a restart does not reset them. */
    failures?: number;
    /** When the last wrong PIN was tried, epoch ms. */
    lastFailureAt?: number;
};

/** What {@link PinProtectedSlot.attemptState} reports, for the PIN prompt to show. */
export type PinAttemptState = {
    /** Consecutive wrong PINs since the last success. */
    failures: number;
    /** When the last wrong PIN was tried, epoch ms; null when there has not been one. */
    lastFailureAt: number | null;
    /** Milliseconds until another PIN is accepted; 0 when one may be tried now. */
    retryAfterMs: number;
    /** Epoch ms of the next try that will be accepted; null when nothing is being held off. */
    retryAt: number | null;
};

/** The key derived from the PIN, with the parameters it was derived under. `raw` exists only for {@link RememberedUnlock}. */
type UnlockedKey = { key: CryptoKey; raw: Uint8Array<ArrayBuffer>; salt: Uint8Array<ArrayBuffer>; iterations: number };

/** Reading a PIN-protected session before {@link PinProtectedSlot.unlock}. */
export class LockedError extends Error {
    constructor() {
        super('The Proton session is locked with a PIN');
        this.name = 'LockedError';
    }
}

export type Protection = 'none' | 'plain' | 'pin';

export class PinProtectedSlot implements SecretSlot {
    private unlocked: UnlockedKey | null = null;

    constructor(
        private readonly inner: SecretSlot,
        /** Recorded with each encryption, so a slot always opens what an older setting wrote. */
        private readonly iterations = PIN_ITERATIONS,
        /** The backoff's clock; a test moves it rather than waiting in real time. */
        private readonly now: () => number = () => Date.now(),
    ) {}

    /** What is stored: nothing, a session as is, or one locked with a PIN. */
    async protection(): Promise<Protection> {
        const raw = await this.inner.read();
        if (raw === null) {
            return 'none';
        }
        return parseEnvelope(raw) ? 'pin' : 'plain';
    }

    /** Whether the stored session is locked and has not been unlocked in this run. */
    async isLocked(): Promise<boolean> {
        return this.unlocked === null && (await this.protection()) === 'pin';
    }

    async read(): Promise<string | null> {
        const raw = await this.inner.read();
        if (raw === null) {
            return null;
        }
        const envelope = parseEnvelope(raw);
        if (!envelope) {
            return raw;
        }
        if (!this.unlocked) {
            throw new LockedError();
        }
        return decrypt(envelope, this.unlocked.key);
    }

    /**
     * Save the session, encrypted when a PIN is set. Clearing it (sign-out)
     * also drops the PIN: it protected that session, and the next one is
     * offered a PIN of its own.
     *
     * While the PIN is locked the value is not stored at all: what is there is
     * the envelope, and writing the value as is would replace it with readable
     * tokens. The caller keeps the value in memory and drops the write.
     *
     * @throws {@link LockedSlotError} in that case.
     */
    async write(value: string | null): Promise<void> {
        if (value === null) {
            this.unlocked = null;
            await this.inner.write(null);
            return;
        }
        if (this.unlocked) {
            await this.inner.write(JSON.stringify(await encrypt(value, this.unlocked)));
            return;
        }
        if (parseEnvelope((await this.inner.read()) ?? '')) {
            throw new LockedSlotError();
        }
        await this.inner.write(value);
    }

    /** Try a PIN. On success the session can be read for the rest of this run. */
    async unlock(pin: string): Promise<boolean> {
        if (!(await this.mayTryNow())) {
            return false;
        }
        const key = await this.keyFor(pin);
        if (!key) {
            await this.recordFailure();
            return false;
        }
        this.unlocked = key;
        await this.clearFailures();
        return true;
    }

    /** Whether `pin` opens the stored session, without changing anything. */
    async verify(pin: string): Promise<boolean> {
        if (!(await this.mayTryNow())) {
            return false;
        }
        const key = await this.keyFor(pin);
        if (!key) {
            await this.recordFailure();
            return false;
        }
        await this.clearFailures();
        return true;
    }

    /**
     * How many PINs have been wrong, and how long the next try has to wait.
     *
     * The count is kept beside the ciphertext, in the same secret, so it
     * survives a restart: closing and reopening Obsidian does not hand another
     * run of guesses. It slows someone guessing at the unlocked device; a copy
     * of the envelope taken elsewhere is slowed by the key derivation instead.
     */
    async attemptState(): Promise<PinAttemptState> {
        const envelope = parseEnvelope((await this.inner.read()) ?? '');
        const failures = envelope?.failures ?? 0;
        const lastFailureAt = envelope?.lastFailureAt ?? null;
        const retryAt = failures > 0 && lastFailureAt !== null ? lastFailureAt + backoffMs(failures) : null;
        const retryAfterMs = retryAt === null ? 0 : Math.max(0, retryAt - this.now());
        return { failures, lastFailureAt, retryAfterMs, retryAt };
    }

    /** Protect the stored session with a new PIN, replacing any old one. Needs the session readable. */
    async setPin(pin: string): Promise<void> {
        if (pin.length < MIN_PIN_LENGTH) {
            throw new Error(`The PIN needs at least ${MIN_PIN_LENGTH} characters`);
        }
        const session = await this.read();
        if (session === null) {
            throw new Error('Sign in to Proton first; there is no session to protect yet');
        }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const raw = await deriveKeyBytes(pin, salt, this.iterations);
        this.unlocked = { key: await importAesKey(raw), raw, salt, iterations: this.iterations };
        await this.write(session);
    }

    /** Store the session without a PIN again. Needs the session readable. */
    async removePin(): Promise<void> {
        const session = await this.read();
        this.unlocked = null;
        if (session !== null) {
            await this.inner.write(session);
        }
    }

    /** Forget the key in memory, so the session needs the PIN again. Nothing stored changes. */
    lock(): void {
        this.unlocked = null;
    }

    /** The unlocked key, serialised for {@link RememberedUnlock}; null while locked. */
    exportKey(): string | null {
        if (!this.unlocked) {
            return null;
        }
        return JSON.stringify({ key: toBase64(this.unlocked.raw), salt: toBase64(this.unlocked.salt) });
    }

    /** Unlock with a key from {@link exportKey}. False if it does not open the stored session. */
    async unlockWithKey(exported: string): Promise<boolean> {
        const envelope = parseEnvelope((await this.inner.read()) ?? '');
        if (!envelope) {
            return false;
        }
        try {
            const { key, salt } = JSON.parse(exported) as { key: string; salt: string };
            if (salt !== envelope.salt) {
                return false;
            }
            const raw = fromBase64(key);
            const aesKey = await importAesKey(raw);
            await decrypt(envelope, aesKey);
            this.unlocked = { key: aesKey, raw, salt: fromBase64(salt), iterations: envelope.iterations };
        } catch {
            return false;
        }
        // A remembered key opens the session the PIN protects, so it counts as
        // a success: someone who had the device and the PIN is back.
        await this.clearFailures();
        return true;
    }

    /**
     * For a forgotten PIN: delete the locked session without reading it. The
     * user signs in again. It cannot be ended on Proton's side from here,
     * since that needs the tokens the PIN protects.
     */
    async forget(): Promise<void> {
        this.unlocked = null;
        await this.inner.write(null);
    }

    private async keyFor(pin: string): Promise<UnlockedKey | null> {
        const stored = await this.inner.read();
        const envelope = stored === null ? null : parseEnvelope(stored);
        if (!envelope) {
            return null;
        }
        const salt = fromBase64(envelope.salt);
        const raw = await deriveKeyBytes(pin, salt, envelope.iterations);
        const key = await importAesKey(raw);
        try {
            await decrypt(envelope, key);
        } catch {
            return null;
        }
        return { key, raw, salt, iterations: envelope.iterations };
    }

    /** Whether the wait after a wrong PIN has passed. */
    private async mayTryNow(): Promise<boolean> {
        return (await this.attemptState()).retryAfterMs === 0;
    }

    /**
     * Count a wrong PIN, with when it was tried.
     *
     * Best effort: if the write fails the count is lost at the next restart,
     * which is where it stood before; it never stands in the way of a
     * legitimate unlock.
     */
    private async recordFailure(): Promise<void> {
        const envelope = parseEnvelope((await this.inner.read()) ?? '');
        if (!envelope) {
            // No PIN is set, so there is no guessing to slow and nothing to count against.
            return;
        }
        await this.writeEnvelope({ ...envelope, failures: (envelope.failures ?? 0) + 1, lastFailureAt: this.now() });
    }

    /** Forget the wait once a PIN was accepted. */
    private async clearFailures(): Promise<void> {
        const envelope = parseEnvelope((await this.inner.read()) ?? '');
        if (!envelope || (envelope.failures === undefined && envelope.lastFailureAt === undefined)) {
            return;
        }
        const cleared = { ...envelope };
        delete cleared.failures;
        delete cleared.lastFailureAt;
        await this.writeEnvelope(cleared);
    }

    /** Rewrite the stored ciphertext, keeping it ciphertext; only the counters beside it change. */
    private async writeEnvelope(envelope: Envelope): Promise<void> {
        try {
            await this.inner.write(JSON.stringify(envelope));
        } catch {
            // Best effort; see {@link recordFailure}.
        }
    }
}

/**
 * How long a wrong PIN holds off the next try: one second, doubling with each
 * failure up to thirty.
 */
function backoffMs(failures: number): number {
    return failures <= 0 ? 0 : Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

async function deriveKeyBytes(
    pin: string,
    salt: Uint8Array<ArrayBuffer>,
    iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
        'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256);
    return new Uint8Array(bits);
}

function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encrypt(plaintext: string, unlocked: UnlockedKey): Promise<Envelope> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: ASSOCIATED_DATA },
        unlocked.key,
        new TextEncoder().encode(plaintext),
    );
    return {
        format: FORMAT,
        kdf: 'PBKDF2-SHA256',
        iterations: unlocked.iterations,
        salt: toBase64(unlocked.salt),
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(data)),
    };
}

/** Throws when the key is wrong or the data was tampered with; GCM checks both. */
async function decrypt(envelope: Envelope, key: CryptoKey): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: ASSOCIATED_DATA },
        key,
        fromBase64(envelope.data),
    );
    return new TextDecoder().decode(plaintext);
}

function parseEnvelope(raw: string): Envelope | null {
    try {
        const value = JSON.parse(raw) as Partial<Envelope> | null;
        if (
            value?.format === FORMAT &&
            typeof value.iterations === 'number' &&
            typeof value.salt === 'string' &&
            typeof value.iv === 'string' &&
            typeof value.data === 'string'
        ) {
            return value as Envelope;
        }
    } catch {
        // A plain session, or not JSON at all.
    }
    return null;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * An unlocked PIN key kept across restarts, until it expires, for the "ask
 * for the PIN after some time away" setting.
 *
 * This is the one place the key leaves memory, and it is a real weakening:
 * while a remembered key is stored, anyone who can read Obsidian's keychain
 * can open the session without the PIN, exactly as if there were none. The
 * expiry is a timestamp stored beside the key, not something cryptography
 * enforces: an expired key is deleted the next time the plugin looks, and
 * until then it is still there to be read. Only used when the user picks a
 * time limit; the default, a PIN at every launch, never stores it.
 */
export class RememberedUnlock {
    constructor(
        private readonly slot: SecretSlot,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async save(exportedKey: string, expiresAt: number): Promise<void> {
        await this.slot.write(JSON.stringify({ exportedKey, expiresAt }));
    }

    /** The key, if one is stored and has not expired. An expired one is deleted. */
    async load(): Promise<string | null> {
        const raw = await this.slot.read();
        if (raw === null) {
            return null;
        }
        try {
            const { exportedKey, expiresAt } = JSON.parse(raw) as { exportedKey?: unknown; expiresAt?: unknown };
            if (typeof exportedKey === 'string' && typeof expiresAt === 'number' && expiresAt > this.now()) {
                return exportedKey;
            }
        } catch {
            // Unreadable: treated as expired.
        }
        await this.clear();
        return null;
    }

    async clear(): Promise<void> {
        await this.slot.write(null);
    }
}
