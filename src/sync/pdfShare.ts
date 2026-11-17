import type { ShareLink } from './drive';

/**
 * The parts of "export note to PDF and share" that do not need a GUI.
 *
 * Rendering the PDF needs Electron's webview and only runs on desktop; the
 * naming, expiry and janitor decisions here are pure so they are unit-tested.
 */

/** One exported PDF and the public link made for it, kept in the settings. */
export type ExportedShare = {
    /** Vault-relative path of the exported PDF. */
    path: string;
    /** The public link made for it. */
    url: string;
    /** Epoch ms when the link expires; null when it never does. */
    expiresAt: number | null;
    /** Drive node uid of the exported PDF, for best-effort unsharing. */
    nodeUid: string;
};

/** Where exported PDFs go unless configured otherwise. */
export const DEFAULT_EXPORT_FOLDER = 'Exports';

/** How long a new share link lasts unless configured otherwise, in days. */
export const DEFAULT_SHARE_EXPIRY_DAYS = 30;

/** How long an export upload is waited for before giving up. */
export const EXPORT_NODE_WAIT_MS = 30_000;

/** How often the wait above checks the sync state. */
export const EXPORT_NODE_POLL_MS = 250;

/** How often expired exports are cleaned up. */
export const EXPORT_JANITOR_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * A folder setting as a vault-relative path: trimmed, without leading or
 * trailing slashes. Empty when nothing usable was entered.
 */
export function normalizeExportFolder(folder: string): string {
    return folder.trim().replace(/^\/+|\/+$/g, '');
}

/** The folder to use: the setting, or the default when it is blank. */
export function effectiveExportFolder(folder: string): string {
    return normalizeExportFolder(folder) || DEFAULT_EXPORT_FOLDER;
}

/**
 * The timestamp in an export filename: `YYYY-MM-DD HHmm` in local time,
 * zero-padded so exports sort chronologically.
 */
export function formatExportStamp(time: number | Date): string {
    const date = time instanceof Date ? time : new Date(time);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}${pad(date.getMinutes())}`
    );
}

/** `<note basename> <stamp>.pdf`, the filename of one export. */
export function exportPdfName(noteBasename: string, now: number | Date = Date.now()): string {
    return `${noteBasename} ${formatExportStamp(now)}.pdf`;
}

/**
 * Where to write an export, numbered when the name is taken:
 * `Exports/Note 2026-11-17 1530.pdf`, then `... (2).pdf`, `... (3).pdf`.
 */
export function resolveExportPath(
    exportFolder: string,
    fileName: string,
    exists: (path: string) => boolean,
): string {
    const folder = effectiveExportFolder(exportFolder);
    const join = (name: string): string => `${folder}/${name}`;
    if (!exists(join(fileName))) {
        return join(fileName);
    }
    const dot = fileName.lastIndexOf('.');
    const stem = dot === -1 ? fileName : fileName.slice(0, dot);
    const extension = dot === -1 ? '' : fileName.slice(dot);
    for (let n = 2; ; n++) {
        const candidate = join(`${stem} (${n})${extension}`);
        if (!exists(candidate)) {
            return candidate;
        }
    }
}

/**
 * When a link made now lasts `days` days. Zero or negative means no expiry,
 * which is how "never expire" is configured.
 */
export function shareExpiration(days: number, now: number = Date.now()): Date | undefined {
    return days > 0 ? new Date(now + days * 24 * 60 * 60_000) : undefined;
}

/** Whether an existing link is reused rather than making a second one. */
export function pickShareTarget(existing: ShareLink | null): 'reuse' | 'create' {
    return existing === null ? 'create' : 'reuse';
}

/** Registry entries whose link has expired by `now`. */
export function selectExpiredShares(shares: ExportedShare[], now: number = Date.now()): ExportedShare[] {
    return shares.filter((share) => share.expiresAt !== null && share.expiresAt <= now);
}

/**
 * Whether a path is an export: strictly inside the export folder. The janitor
 * never touches anything else, so a misconfigured folder cannot delete notes —
 * not even the folder itself counts.
 */
export function isExportPath(exportFolder: string, path: string): boolean {
    const folder = effectiveExportFolder(exportFolder);
    return path.startsWith(`${folder}/`);
}

/**
 * What the janitor deletes: expired entries that are actually exports.
 * Expired entries outside the export folder are refused, not deleted.
 */
export function selectJanitorDeletions(
    shares: ExportedShare[],
    now: number,
    exportFolder: string,
): ExportedShare[] {
    return selectExpiredShares(shares, now).filter((share) => isExportPath(exportFolder, share.path));
}

/** Record an export, replacing the entry for a path exported before. */
export function upsertExportedShare(shares: ExportedShare[], entry: ExportedShare): ExportedShare[] {
    const next = shares.filter((share) => share.path !== entry.path);
    next.push(entry);
    return next;
}

/** Forget an export, for example after it was trashed by the janitor. */
export function removeExportedShare(shares: ExportedShare[], path: string): ExportedShare[] {
    return shares.filter((share) => share.path !== path);
}

/**
 * An exact-sized ArrayBuffer of bytes. Electron's printToPDF hands back a
 * Buffer over a shared pool, which must never be written to the vault as-is:
 * the pool's spare bytes would go with it.
 */
export function copyToArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
    if (bytes instanceof ArrayBuffer) {
        return bytes;
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

/**
 * The script run inside the hidden webview: it swaps the help page's body
 * for the rendered note and adds a minimal print stylesheet. JSON-encoded, so
 * note content can never break out of it.
 */
export function buildPdfPrintScript(title: string, html: string): string {
    const css =
        'html,body{margin:0;padding:24px;background:#fff;color:#000;}img{max-width:100%;}' +
        'pre,code{white-space:pre-wrap;word-break:break-word;}table{border-collapse:collapse;}' +
        'th,td{border:1px solid #ccc;padding:4px 8px;}';
    return (
        `document.title=${JSON.stringify(title)};` +
        `document.body.innerHTML=${JSON.stringify(html)};` +
        `const style=document.createElement('style');style.textContent=${JSON.stringify(css)};` +
        `document.head.appendChild(style);`
    );
}
