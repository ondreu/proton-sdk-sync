
/**
 * Whether note names and paths may appear in log messages.
 *
 * Off by default: the log buffer is readable by every other plugin, printed to
 * the console, and copied into bug reports by "Copy sync log". Note names are
 * the user's data, so they are replaced by a stable token (`«file a1b2c3»`) that
 * still lets two messages about the same note be matched up. Turn it on in the
 * settings when a report needs the real names.
 */
let showNames = false;

export function setLogShowsNames(value: boolean): void {
    showNames = value;
}

/** A short, stable stand-in for a name, so two lines about the same note still match. */
function token(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `«file ${(hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)}»`;
}

/** A quoted name or path, or a bare token, replaced by its token; prose is left alone. */
const QUOTED = /"([^"\n]+)"|'([^'\n]+)'/g;
const TOKEN = /[^\s"']+/g;
/**
 * Drive node uids are opaque, long, and they identify a file across devices.
 *
 * They are base64url of 32 bytes: 43 characters without padding, 44 with,
 * 32 at the short end. The threshold used to be 60, which let every real uid
 * straight into the log.
 */
const NODE_UID = /[A-Za-z0-9_+/=~-]{32,}/g;

/**
 * Proton's own hosts, named one by one.
 *
 * `drive-api.proton.me` is not the user's data, and redacting it makes a bug
 * report undiagnosable. What must not be guessed at is the shape of a host: a
 * rule like "three labels is a host" waves through `2026-05-01.meeting.md`,
 * `recipe.v2.md` and `invoice.2026.01.pdf`, which are note names.
 */
const PROTON_HOSTS = ['drive-api.proton.me', 'account.proton.me'];

/** Proton's regional block storage, handed out by the Drive API at runtime. */
const PROTON_HOST = /^(?:[a-z0-9-]+\.)*(?:proton\.me|proton\.ch)$/;

/**
 * Proton's API paths, which are endpoints rather than notes.
 *
 * Only these keep a leading slash; another absolute path is the user's - it
 * appears in OS errors and stack frames - and is redacted.
 */
const PROTON_PATH_PREFIXES = ['/drive/', '/auth/', '/core/', '/storage/', '/account/'];

function looksLikeName(value: string): boolean {
    if (!/[A-Za-z]/.test(value)) {
        return false;
    }
    const core = value.replace(/[.,;:)\]}]+$/, '');
    // A Proton URL, host or API path names an endpoint, not a note. Vault
    // paths are relative (`Projekty/Trisula.md`), and any other absolute path
    // is the user's.
    if (isProtonEndpoint(core)) {
        return false;
    }
    return core.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(core);
}

/** A Proton host, named or regional; see `PROTON_HOSTS`. */
function isProtonHost(host: string): boolean {
    return PROTON_HOSTS.includes(host) || PROTON_HOST.test(host);
}

/** Whether a token names Proton's API rather than anything the user owns. */
function isProtonEndpoint(value: string): boolean {
    const lower = value.toLowerCase();
    const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value);
    if (url) {
        return isProtonHost(url[1].toLowerCase().replace(/:\d+$/, ''));
    }
    const bare = lower.replace(/\/+$/, '');
    if (isProtonHost(bare)) {
        return true;
    }
    return lower.startsWith('/') && PROTON_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Replace anything that looks like a vault path or a file name. */
export function redactNames(text: string): string {
    if (showNames) {
        return text;
    }
    // Whole quoted strings first, so a name with spaces inside stays one name.
    const quoted = text.replace(QUOTED, (match, double, single) => {
        const inner = String(double ?? single ?? '');
        return looksLikeName(inner) ? token(inner) : match;
    });
    const withoutUids = quoted.replace(NODE_UID, '«node»');
    return withoutUids.replace(TOKEN, (match) => (looksLikeName(match) ? token(match) : match));
}

/** An error with its message and stack redacted — the stack kept, not thrown away. */
function redactError(error: Error): Error {
    const copy = new Error(redactNames(error.message));
    copy.name = redactNames(error.name);
    // A bug report starts at the stack. Dropping it made the redacted log
    // useless for the case the log exists for, so redact it instead.
    if (typeof error.stack === 'string') {
        copy.stack = redactNames(error.stack);
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
        (copy as { cause?: unknown }).cause = redactArgument(cause);
    }
    return copy;
}

/**
 * A log argument with the names inside it redacted and its shape kept.
 *
 * Errors used to lose their stack, and plain objects were passed through
 * untouched, so an SDK error carrying a path in a field went into the buffer
 * and onto the clipboard as it was.
 */
export function redactArgument(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        return redactNames(value);
    }
    if (value instanceof Error) {
        return redactError(value);
    }
    if (depth >= 2) {
        // Deep enough: an SDK object graph is not worth walking, and its
        // credentials are not in the log's scope.
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactArgument(item, depth + 1));
    }
    if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const copy: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            copy[key] = redactArgument(inner, depth + 1);
        }
        return copy;
    }
    return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogEntry = {
    time: number;
    level: LogLevel;
    scope: string;
    message: string;
};

/**
 * Console logger that also keeps the most recent entries in a ring buffer so
 * the settings tab can show a sync log without the user opening devtools.
 *
 * Doubles as the SDK's `Telemetry` logger: `getLogger(scope)` matches the
 * shape `ProtonDriveClient` and the vendored account module expect.
 */
export class Logger {
    private static readonly BUFFER_SIZE = 500;

    private readonly buffer: LogEntry[] = [];

    constructor(
        private minLevel: LogLevel = 'info',
        private readonly scope = 'proton-sdk-sync',
        private readonly root?: Logger,
    ) {}

    getLogger(scope: string): Logger {
        const root = this.root ?? this;
        return new Logger(this.minLevel, `${this.scope}:${scope}`, root);
    }

    /**
     * The level in force, read from the root every time.
     *
     * A child took a copy of the root's level when it was made, and the
     * plugin hands out its children once, at load: the session's, the
     * engine's, one per drive and per poll. Setting the level on the root
     * alone left every one of them at the level they started with, so
     * changing it in the settings did nothing for the lines that matter.
     */
    private get threshold(): LogLevel {
        return (this.root ?? this).minLevel;
    }

    setLevel(level: LogLevel): void {
        (this.root ?? this).minLevel = level;
    }

    getEntries(): readonly LogEntry[] {
        return (this.root ?? this).buffer;
    }

    debug(message: string, ...args: unknown[]): void {
        this.write('debug', message, args);
    }

    info(message: string, ...args: unknown[]): void {
        this.write('info', message, args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.write('warn', message, args);
    }

    error(message: string, ...args: unknown[]): void {
        this.write('error', message, args);
    }

    private write(level: LogLevel, message: string, args: unknown[]): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.threshold]) {
            return;
        }

        const safeMessage = redactNames(message);
        const safeArgs = args.map((arg) => redactArgument(arg));

        const entry: LogEntry = { time: Date.now(), level, scope: this.scope, message: safeMessage };
        const target = this.root ?? this;
        target.buffer.push(entry);
        if (target.buffer.length > Logger.BUFFER_SIZE) {
            target.buffer.splice(0, target.buffer.length - Logger.BUFFER_SIZE);
        }

        // Info and debug go to `console.debug`, which devtools hides unless
        // "Verbose" is on, so routine sync chatter stays out of the console
        // while remaining a click away. The settings tab shows the same entries.
        const prefix = `[${this.scope}]`;
        if (level === 'error') {
            console.error(prefix, safeMessage, ...safeArgs);
        } else if (level === 'warn') {
            console.warn(prefix, safeMessage, ...safeArgs);
        } else {
            console.debug(prefix, safeMessage, ...safeArgs);
        }
    }
}

/** Entries as plain text, one per line, oldest first, for copying out of the app. */
export function formatLogEntries(entries: readonly LogEntry[]): string {
    return entries
        .map((entry) => `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`)
        .join('\n');
}
