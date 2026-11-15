import { LockedSlotError, UnreadableSlotError, type SecretSlot } from './secretStore';

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
 * between a copied envelope and the session: at this setting the whole
 * six-digit space costs about 1.5 CPU-days on one core, and a GPU shortens
 * that but does not make it free. That is enough to stop someone who finds a
 * copy of the file from reading it this evening; it is not enough to survive
 * a determined attacker with hardware, which is why a longer PIN is worth
 * choosing over six digits.
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

/**
 * Where the plugin records that a PIN is set, outside the secret it protects.
 *
 * Needed because the stored envelope cannot always be read: a session.bin the
 * OS keystore can no longer open looks exactly as if there were nothing there.
 * With this flag kept in the plugin's own settings, a slot that once had a PIN
 * keeps refusing to write plaintext even when what it holds cannot be checked
 * — the case that used to end with the tokens stored in the clear.
 */
export type PinSetRecord = {
    /** Whether a PIN was set, according to the plugin's settings. */
    isSet(): boolean;
    /** Record a PIN being set, or removed. */
    set(value: boolean): void;
};

export class PinProtectedSlot implements SecretSlot {
    private unlocked: UnlockedKey | null = null;
    /**
     * A value written while the slot was locked, kept until the next unlock.
     *
     * Dropping it lost a refreshed token pair for good: Proton rotates the
     * refresh token away on the first use, so what the envelope held before
     * the refresh was already dead, and the next start signed the user out.
     */
    private pending: string | null = null;

    constructor(
        private readonly inner: SecretSlot,
        /** Recorded with each encryption, so a slot always opens what an older setting wrote. */
        private readonly iterations = PIN_ITERATIONS,
        /** The backoff's clock; a test moves it rather than waiting in real time. */
        private readonly now: () => number = () => Date.now(),
        /** The plugin's record of a PIN being set; see {@link PinSetRecord}. */
        private readonly pinSet?: PinSetRecord,
    ) {}

    /** What is stored: nothing, a session as is, or one locked with a PIN. */
    async protection(): Promise<Protection> {
        switch (await this.stored()) {
            case 'none':
                return 'none';
            case 'plain':
                return 'plain';
            case 'envelope':
                return 'pin';
            case 'unreadable':
                // Unreadable is not empty. Reporting 'none' invited the next
                // write to put the session in the clear over whatever this is;
                // with no record to consult, assume the PIN that would explain
                // a file we cannot open.
                return (await this.pinWasSet()) ? 'pin' : 'plain';
        }
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
     * tokens. The value is kept instead, and written — encrypted — by the next
     * {@link unlock}.
     *
     * @throws {@link LockedSlotError} in that case.
     */
    async write(value: string | null): Promise<void> {
        if (value === null) {
            this.unlocked = null;
            this.pending = null;
            await this.inner.write(null);
            await this.recordPinSet(false);
            return;
        }
        if (this.unlocked) {
            this.pending = null;
            await this.inner.write(JSON.stringify(await encrypt(value, this.unlocked)));
            return;
        }
        const stored = await this.stored();
        if (stored === 'envelope' || (stored === 'unreadable' && (await this.pinWasSet()))) {
            this.pending = value;
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
        await this.writePending();
        await this.clearFailures();
        return true;
    }

    /**
     * Whether `pin` opens the stored session, without changing what is stored.
     *
     * A right PIN unlocks the slot for this run, as {@link unlock} does: it is
     * the same proof, and the PIN dialogs verify the current PIN in order to
     * change or remove it, which they can only do while the session is
     * readable.
     */
    async verify(pin: string): Promise<boolean> {
        return this.check(pin, true);
    }

    /**
     * Check a PIN without unlocking the slot.
     *
     * For a caller that may be cancelled — proving the PIN before signing out,
     * for instance. Adopting the key there would leave the session unlocked
     * while the interface still says it is locked.
     */
    async verifyOnly(pin: string): Promise<boolean> {
        return this.check(pin, false);
    }

    private async check(pin: string, adopt: boolean): Promise<boolean> {
        if (!(await this.mayTryNow())) {
            return false;
        }
        const key = await this.keyFor(pin);
        if (!key) {
            await this.recordFailure();
            return false;
        }
        if (adopt) {
            this.unlocked = key;
            await this.writePending();
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
     *
     * The counters are attacker-controlled once the file is copied, so they
     * are read defensively: a non-numeric or negative count is no count, a
     * `lastFailureAt` in the future is not a wait, and the wait never exceeds
     * {@link BACKOFF_MAX_MS}. Otherwise a single edit to the stored file could
     * lock the owner out for years, or for ever.
     */
    async attemptState(): Promise<PinAttemptState> {
        let envelope: Envelope | null = null;
        try {
            envelope = parseEnvelope((await this.inner.read()) ?? '');
        } catch (error) {
            if (!(error instanceof UnreadableSlotError)) {
                throw error;
            }
            // An unreadable file has no counters to respect; the PIN dialog
            // must still open so the user can forget it.
        }
        const failures = validFailures(envelope?.failures);
        const lastFailureAt = validLastFailure(envelope?.lastFailureAt, this.now());
        const retryAfterRaw = failures > 0 && lastFailureAt !== null ? lastFailureAt + backoffMs(failures) : null;
        const retryAfterMs =
            retryAfterRaw === null ? 0 : Math.min(Math.max(0, retryAfterRaw - this.now()), BACKOFF_MAX_MS);
        return {
            failures,
            lastFailureAt,
            retryAfterMs,
            retryAt: retryAfterMs === 0 ? null : this.now() + retryAfterMs,
        };
    }

    /**
     * Protect the stored session with a new PIN, replacing any old one.
     *
     * Needs the session readable, or a value kept by {@link write} while the
     * slot was locked: re-keying what is already in memory is safe, and it is
     * the only copy of the newest tokens.
     */
    async setPin(pin: string): Promise<void> {
        if (pin.length < MIN_PIN_LENGTH) {
            throw new Error(`The PIN needs at least ${MIN_PIN_LENGTH} characters`);
        }
        const session = await this.sessionToProtect();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const raw = await deriveKeyBytes(pin, salt, this.iterations);
        this.unlocked = { key: await importAesKey(raw), raw, salt, iterations: this.iterations };
        this.pending = null;
        await this.write(session);
        await this.recordPinSet(true);
    }

    /**
     * Store the session without a PIN again.
     *
     * A locked slot is refused rather than emptied: what is there can only be
     * read with the current PIN, and deleting it would sign the user out of a
     * session they still have on Proton.
     */
    async removePin(): Promise<void> {
        const session = await this.sessionToProtect();
        this.unlocked = null;
        this.pending = null;
        await this.inner.write(session);
        await this.recordPinSet(false);
    }

    /** Forget the key in memory, so the session needs the PIN again. Nothing stored changes. */
    lock(): void {
        this.unlocked = null;
    }

    /**
     * The unlocked key, serialised for {@link RememberedUnlock}; null while
     * locked, and null when the slot underneath is not encrypted by the OS.
     *
     * The key is the PIN by another name: written where anything can read it,
     * it removes the PIN's protection entirely, so it is only handed out for a
     * slot the OS encrypts — the desktop file, never Obsidian's secret
     * storage. On a phone the PIN is then asked for at every launch, which is
     * what a PIN is for.
     */
    exportKey(): string | null {
        if (!this.unlocked || !osEncrypted(this.inner)) {
            return null;
        }
        return JSON.stringify({ key: toBase64(this.unlocked.raw), salt: toBase64(this.unlocked.salt) });
    }

    /** Unlock with a key from {@link exportKey}. False if it does not open the stored session. */
    async unlockWithKey(exported: string): Promise<boolean> {
        let stored: string | null;
        try {
            stored = await this.inner.read();
        } catch {
            // Nothing can be unlocked from a file that cannot be read; the PIN
            // form is the way forward.
            return false;
        }
        const envelope = parseEnvelope(stored ?? '');
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
        await this.writePending();
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
        this.pending = null;
        await this.inner.write(null);
        await this.recordPinSet(false);
    }

    /** What the slot underneath holds, as far as it can be told. */
    private async stored(): Promise<'none' | 'plain' | 'envelope' | 'unreadable'> {
        let raw: string | null;
        try {
            raw = await this.inner.read();
        } catch (error) {
            if (error instanceof UnreadableSlotError) {
                return 'unreadable';
            }
            throw error;
        }
        if (raw === null) {
            return 'none';
        }
        return parseEnvelope(raw) ? 'envelope' : 'plain';
    }

    /** Whether the plugin's settings say a PIN was set; absent, the safe answer is yes. */
    private async pinWasSet(): Promise<boolean> {
        return this.pinSet?.isSet() ?? true;
    }

    private async recordPinSet(value: boolean): Promise<void> {
        try {
            // The plugin writes the flag to its settings; `Promise.resolve`
            // covers a plain setter as well as one that saves asynchronously.
            await Promise.resolve(this.pinSet?.set(value));
        } catch {
            // Best effort: the settings write is the caller's; the slot is
            // already in the right state either way.
        }
    }

    /** Write what a locked slot refused, now that the key is here. */
    private async writePending(): Promise<void> {
        const value = this.pending;
        if (value === null || !this.unlocked) {
            return;
        }
        this.pending = null;
        try {
            await this.inner.write(JSON.stringify(await encrypt(value, this.unlocked)));
        } catch (error) {
            // Put it back: the next unlock gets another try, and until then
            // the newest tokens stay in memory rather than nowhere.
            this.pending = value;
            throw error;
        }
    }

    /** The session a new or removed PIN applies to: the newest one this run knows of. */
    private async sessionToProtect(): Promise<string> {
        if (this.pending !== null) {
            return this.pending;
        }
        let session: string | null;
        try {
            session = await this.read();
        } catch (error) {
            if (error instanceof LockedError) {
                throw new Error('Enter the current PIN first; the stored session cannot be read without it');
            }
            throw error;
        }
        if (session === null) {
            throw new Error('Sign in to Proton first; there is no session to protect yet');
        }
        return session;
    }

    private async keyFor(pin: string): Promise<UnlockedKey | null> {
        let stored: string | null;
        try {
            stored = await this.inner.read();
        } catch (error) {
            if (!(error instanceof UnreadableSlotError)) {
                throw error;
            }
            // Nothing a PIN can open: the file is there but this device cannot
            // decrypt it. Counted as a wrong PIN rather than thrown at the
            // dialog, which offers "Forgot PIN" for exactly this case.
            return null;
        }
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
        let envelope: Envelope | null;
        try {
            envelope = parseEnvelope((await this.inner.read()) ?? '');
        } catch (error) {
            if (error instanceof UnreadableSlotError) {
                // Nothing to count beside a file this device cannot open, and
                // losing the count is where it stood before; see below.
                return;
            }
            throw error;
        }
        if (!envelope) {
            // No PIN is set, so there is no guessing to slow and nothing to count against.
            return;
        }
        await this.writeEnvelope({ ...envelope, failures: (envelope.failures ?? 0) + 1, lastFailureAt: this.now() });
    }

    /** Forget the wait once a PIN was accepted. */
    private async clearFailures(): Promise<void> {
        let envelope: Envelope | null;
        try {
            envelope = parseEnvelope((await this.inner.read()) ?? '');
        } catch (error) {
            if (error instanceof UnreadableSlotError) {
                return;
            }
            throw error;
        }
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

/**
 * The failure count, as far as it can be believed.
 *
 * It is stored in the same file as the ciphertext, so anyone who can edit the
 * file can edit it. A count that is not a finite positive number is no count;
 * a count of a million is thirty seconds' wait, not a lockout.
 */
function validFailures(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.min(Math.floor(value), 1_000);
}

/**
 * When the last wrong PIN was tried, if that is a time this run can act on.
 *
 * A date in the future would hold off every try until it arrived — a file
 * edited to say "next year" locked the owner out — and a value that is not a
 * number would make the wait `NaN`, which compares false everywhere and
 * refuses every PIN for ever. Anything further ahead than the longest wait is
 * treated as no time at all.
 */
function validLastFailure(value: unknown, now: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > now + BACKOFF_MAX_MS) {
        return null;
    }
    return value;
}

/** Whether the OS encrypts what `slot` holds; a slot that does not say is read as no. */
function osEncrypted(slot: SecretSlot): boolean {
    return slot.isEncrypted?.() === true;
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
 *
 * It is also only used where the OS encrypts the slot. Obsidian's secret
 * storage is readable by every plugin and is plaintext on mobile, so a key
 * kept there would sit in the clear and the PIN would protect nothing; on such
 * a device {@link canRemember} is false and {@link save} refuses.
 */
export class RememberedUnlock {
    constructor(
        private readonly slot: SecretSlot,
        private readonly now: () => number = () => Date.now(),
        /** Refuse a slot the OS does not encrypt. On by default; see the class comment. */
        private readonly options: { encryptedOnly?: boolean } = {},
    ) {}

    /** Whether a key may be kept here at all. */
    canRemember(): boolean {
        return this.options.encryptedOnly === false || osEncrypted(this.slot);
    }

    /**
     * Keep the key until `expiresAt`, or report false without writing anything
     * when the slot is not encrypted.
     */
    async save(exportedKey: string, expiresAt: number): Promise<boolean> {
        if (!this.canRemember()) {
            return false;
        }
        await this.slot.write(JSON.stringify({ exportedKey, expiresAt }));
        return true;
    }

    /** The key, if one is stored and has not expired. An expired one is deleted. */
    async load(): Promise<string | null> {
        if (!this.canRemember()) {
            // Nothing may be kept here, and anything an older version kept
            // should not stay: it is the key to the session, in the clear.
            await this.clear();
            return null;
        }
        let raw: string | null;
        try {
            raw = await this.slot.read();
        } catch {
            // Unreadable is not a reason to refuse to start: treat it as
            // nothing remembered, and let the PIN prompt take over.
            return null;
        }
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
