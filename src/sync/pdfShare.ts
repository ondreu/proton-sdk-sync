import type { ShareLink } from './drive';

/**
 * The parts of sharing a vault file that do not need a GUI.
 *
 * Naming, expiry, registry validation and janitor confinement are pure so
 * they are unit-tested; the plugin wires them to the vault and the engine.
 */

/** One shared file and the public link made for it, kept in the settings. */
export type ExportedShare = {
    /**
     * `export` is a legacy PDF this plugin produced; `attachment` is a file
     * the user shared and keeps. Both are links to vault files now.
     */
    kind?: 'export' | 'attachment';
    /** Vault-relative path of the shared file. */
    path: string;
    /** The public link made for it. */
    url: string;
    /** Epoch ms when the link expires; null when it never does. */
    expiresAt: number | null;
    /** Drive node uid of the shared file, for best-effort unsharing. */
    nodeUid: string;
    /** Off by default: at expiry only the link goes; on, the file is trashed too. */
    deleteOnExpiry?: boolean;
};

/** Where exported PDFs went unless configured otherwise; kept for old settings. */
export const DEFAULT_EXPORT_FOLDER = 'Exports';

/** How long a new share link lasts unless configured otherwise, in days. */
export const DEFAULT_SHARE_EXPIRY_DAYS = 30;

/**
 * The longest custom link lifetime the dialog accepts, in days (ten years).
 * Above this a computed expiry can overflow to an Invalid Date, which the
 * SDK must never receive.
 */
export const MAX_SHARE_EXPIRY_DAYS = 3650;

/** How long an upload is waited for before giving up. */
export const EXPORT_NODE_WAIT_MS = 30_000;

/** How often the wait above checks the sync state. */
export const EXPORT_NODE_POLL_MS = 250;

/** How often expired share links are cleaned up. */
export const EXPORT_JANITOR_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How many shared files the registry holds at most. Every share appends
 * one entry, so without a cap the list grows forever. Past the cap the
 * oldest expired entries go first, then the oldest entries: evicting a live
 * entry strands its link (the janitor only knows the registry), so expiry
 * decides before age.
 */
export const MAX_EXPORTED_SHARES = 500;

/**
 * A vault path in canonical spelling, or null when the spelling is not
 * usable: empty, absolute, backslashed, doubled slashes, or any `.`/`..`
 * segment. Vault paths are relative and `/`-separated; anything else never
 * matches, so a crafted registry entry cannot reach a file by spelling.
 */
export function normalizeVaultPath(path: string): string | null {
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('//')) {
        return null;
    }
    const segments = path.split('/');
    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') {
            return null;
        }
    }
    return segments.join('/');
}

/**
 * Whether a janitor or manage-modal delete may trash the file: the path
 * must be a canonical vault path, the sync record must currently name a
 * node for it, and that node must be the one the share was made for. Any
 * mismatch — a forged registry entry, a stale uid after delete-and-recreate,
 * an unsynced file — refuses, so one forged bit in `data.json` can never
 * trash an arbitrary vault file. Never call it for a folder.
 */
export function mayDeleteOnExpiry(pathValid: boolean, fileUid: string | null, entryUid: string): boolean {
    return (
        pathValid &&
        typeof entryUid === 'string' &&
        entryUid !== '' &&
        fileUid !== null &&
        fileUid === entryUid
    );
}

/** Whether a link lifetime in days is sane: a whole number of days within bounds. */
export function isValidShareExpiryDays(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= MAX_SHARE_EXPIRY_DAYS
    );
}

/**
 * A custom lifetime typed into the dialog, in days, or null when it must be
 * rejected with an error instead of reaching the SDK. Fractions are floored
 * to whole days; blanks, non-numbers, non-positive values and absurd ones
 * (which could overflow the expiry date) are all null.
 */
export function parseCustomExpiryDays(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed === '') {
        return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    const days = Math.floor(parsed);
    return isValidShareExpiryDays(days) ? days : null;
}

/**
 * When a link made now lasts `days` days. Zero or negative means no expiry,
 * which is how "never expire" is configured. Absurd values are clamped to
 * {@link MAX_SHARE_EXPIRY_DAYS} so the SDK never receives an Invalid Date.
 */
export function shareExpiration(days: number, now: number = Date.now()): Date | undefined {
    if (!Number.isFinite(days) || days <= 0) {
        return undefined;
    }
    const at = now + Math.min(days, MAX_SHARE_EXPIRY_DAYS) * 24 * 60 * 60_000;
    return Number.isFinite(at) ? new Date(at) : undefined;
}

/**
 * The registry entry for a share, built from the share call's returned
 * access — its actual url and expiration — never from a newly computed date
 * or a reused link's stale state.
 */
export function buildExportedShare(
    path: string,
    link: ShareLink,
    nodeUid: string,
    kind: 'export' | 'attachment' = 'export',
): ExportedShare {
    return {
        kind,
        path,
        url: link.url,
        expiresAt: link.expiration?.getTime() ?? null,
        nodeUid,
    };
}

/** Whether a registry value is a well-formed shared-file entry, never trusted blindly. */
export function isValidExportedShare(value: unknown): value is ExportedShare {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.path === 'string' &&
        typeof entry.url === 'string' &&
        typeof entry.nodeUid === 'string' &&
        (entry.expiresAt === null || (typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)))
    );
}

/**
 * Only the well-formed entries of a stored registry. Malformed ones — a
 * non-array, an object instead of an array, an entry without a path — are
 * dropped and reported through `onInvalid` instead of throwing later.
 */
export function sanitizeExportedShares(value: unknown, onInvalid?: (entry: unknown) => void): ExportedShare[] {
    if (!Array.isArray(value)) {
        if (value !== undefined) {
            onInvalid?.(value);
        }
        return [];
    }
    const items: unknown[] = value;
    return items.filter((entry): entry is ExportedShare => {
        if (isValidExportedShare(entry)) {
            return true;
        }
        onInvalid?.(entry);
        return false;
    });
}

/** Registry entries whose link has expired by `now`. */
export function selectExpiredShares(shares: ExportedShare[], now: number = Date.now()): ExportedShare[] {
    return shares.filter((share) => share.expiresAt !== null && share.expiresAt <= now);
}

/**
 * Record a share, replacing the entry for a path shared before. Capped:
 * past {@link MAX_EXPORTED_SHARES} the oldest expired entries go first, then
 * the oldest entries.
 */
export function upsertExportedShare(
    shares: ExportedShare[],
    entry: ExportedShare,
    now: number = Date.now(),
): ExportedShare[] {
    const next = shares.filter((share) => share.path !== entry.path);
    next.push(entry);
    while (next.length > MAX_EXPORTED_SHARES) {
        const expired = next.findIndex((share) => share.expiresAt !== null && share.expiresAt <= now);
        next.splice(expired === -1 ? 0 : expired, 1);
    }
    return next;
}

/** Forget a share, for example after it was cleaned up by the janitor. */
export function removeExportedShare(shares: ExportedShare[], path: string): ExportedShare[] {
    return shares.filter((share) => share.path !== path);
}
