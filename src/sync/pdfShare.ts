import type { ShareLink } from './drive';

/**
 * The parts of "export note to PDF and share" that do not need a GUI.
 *
 * Rendering the PDF needs Electron's webview and only runs on desktop; the
 * naming, expiry and janitor decisions here are pure so they are unit-tested.
 */

/** One exported PDF and the public link made for it, kept in the settings. */
export type ExportedShare = {
    /** `export` is a PDF this plugin produced (deleted at expiry); `attachment` is a file the user shared and keeps. */
    kind?: 'export' | 'attachment';
    /** Vault-relative path of the shared file. */
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
 * How many exported shares the registry holds at most. Every export appends
 * one entry, so without a cap the list grows forever. Past the cap the
 * oldest expired entries go first, then the oldest entries: evicting a live
 * entry strands its link (the janitor only knows the registry), so expiry
 * decides before age.
 */
export const MAX_EXPORTED_SHARES = 500;

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
 * A vault path in canonical spelling, or null when the spelling is not
 * usable: empty, absolute, backslashed, doubled slashes, or any `.`/`..`
 * segment. Vault paths are relative and `/`-separated; anything else never
 * matches, so a crafted registry entry cannot escape its folder by spelling.
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

/**
 * The registry entry for an export, built from the share call's returned
 * access — its actual url and expiration — never from a newly computed date
 * or a reused link's stale state. The export flow always calls the engine's
 * `createNoteShareLink`, whose SDK updates an existing URL access in place,
 * so the returned access is the live link by construction.
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

/**
 * Whether the export flow must refuse before rendering: a paused sync never
 * uploads the PDF, and an excluded export folder never syncs it, so either
 * way the wait after writing would only strand an orphan. Null means go.
 */
export function exportPrecheckRefusal(precheck: { paused: boolean; excluded: boolean }): string | null {
    if (precheck.paused) {
        return 'Resume the sync before exporting: a paused sync never uploads the PDF, so no link can be made.';
    }
    if (precheck.excluded) {
        return 'The export folder is excluded from the sync, so the PDF would never upload and no link could be made.';
    }
    return null;
}

/** Whether a registry value is a well-formed exported share, never trusted blindly. */
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
 * non-array, an object instead of an array, an entry with an undefined path —
 * are dropped and reported through `onInvalid` instead of throwing later.
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

/**
 * Whether a path is an export: strictly inside the export folder, compared
 * on canonical spellings. Both sides are normalized first, so `..`, `.`,
 * absolute, backslashed or doubled-slash spellings never match, and a folder
 * that only matches by string prefix (`Exports2`) does not count. The
 * comparison is case-sensitive, like the vault: a case-only folder rename
 * strands old entries rather than reaching the wrong files.
 */
export function isExportPath(exportFolder: string, path: unknown): boolean {
    const folder = normalizeVaultPath(normalizeExportFolder(exportFolder));
    if (folder === null || typeof path !== 'string') {
        return false;
    }
    const target = normalizeVaultPath(path);
    if (target === null) {
        return false;
    }
    return target.startsWith(`${folder}/`);
}

/** Registry entries whose link has expired by `now`. */
export function selectExpiredShares(shares: ExportedShare[], now: number = Date.now()): ExportedShare[] {
    return shares.filter((share) => share.expiresAt !== null && share.expiresAt <= now);
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
    return selectExpiredShares(shares, now).filter(
        (share) => (share.kind ?? 'export') === 'export' && isExportPath(exportFolder, share.path),
    );
}

/**
 * What the janitor may do with one due entry: `trash-then-unshare` when the
 * file is there, `unshare-gone` when the path is recorded but the file is
 * confirmed gone, `leave` for anything else — an unconfined path, a folder at
 * an export's path, anything unvalidated. A uid is only ever unshared from
 * inside the export folder, and only once its file is gone one way or the
 * other, so a registry entry can never unshare an unrelated node.
 */
export type JanitorEntryPlan = 'trash-then-unshare' | 'unshare-gone' | 'leave';

export function janitorEntryPlan(pathValid: boolean, fileState: 'file' | 'gone' | 'other'): JanitorEntryPlan {
    if (!pathValid) {
        return 'leave';
    }
    if (fileState === 'file') {
        return 'trash-then-unshare';
    }
    if (fileState === 'gone') {
        return 'unshare-gone';
    }
    return 'leave';
}

/**
 * Record an export, replacing the entry for a path exported before. Capped:
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

/** Decode the numeric and `colon` entities a scheme check must see through. */
function decodeSchemeEntities(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_match, decimal: string) => String.fromCharCode(Number.parseInt(decimal, 10)))
        .replace(/&colon;/gi, ':');
}

/**
 * Strip what must never reach the export webview: script/iframe/object/embed
 * elements with their content, event-handler attributes, and `javascript:`
 * URLs. The rendered note is the user's own Markdown, but its raw HTML rides
 * into `document.body.innerHTML`, where an `onerror` or `javascript:` URL
 * would run inside the webview — so this second barrier applies to the
 * serialized output right before injection. String-based on purpose: it runs
 * in the plugin renderer and is unit-tested headlessly, where no DOMParser
 * exists. Legitimate markup, including images and links, passes through.
 */
export function sanitizeExportHtml(html: string): string {
    let out = String(html);
    // Active elements, with everything they contain.
    out = out.replace(/<(script|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    // Leftovers: void, self-closing, or unclosed active elements.
    out = out.replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '');
    // Event-handler attributes, quoted or unquoted. The leading whitespace
    // keeps `data-onclick` and friends intact.
    out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s"'`>=]+)/gi, '');
    // javascript: URLs in link and resource attributes, however cased,
    // spaced, or entity-obfuscated.
    out = out.replace(
        /\b(href|src|xlink:href|formaction|action)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
        (whole, name: string, value: string): string => {
            const raw = value.replace(/^['"]|['"]$/g, '');
            // What the URL parser sees through: entities decoded, every
            // whitespace and control character removed. Any entity left in a
            // URL scheme is an obfuscation attempt (&Tab;, &NewLine; and
            // unknown references are decoded by the browser after this test),
            // so the test drops all of them instead of enumerating names.
            const compact = decodeSchemeEntities(raw)
                .replace(/&[a-z#0-9]+;?/gi, '')
                // Control characters and spaces are stripped by URL parsers;
                // do it without a control-character regex (the review lint
                // bans those).
                .split('')
                .filter((ch) => ch !== ' ' && ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
                .join('');
            if (/^(javascript|vbscript):/i.test(compact)) {
                return `${name}="#"`;
            }
            return whole;
        },
    );
    return out;
}

/**
 * The script run inside the hidden webview: it swaps the help page's body
 * for the rendered note and adds a minimal print stylesheet. JSON-encoded, so
 * note content can never break out of it. What that does not cover is the
 * markup itself executing once assigned — see sanitizeExportHtml, which runs
 * on the HTML first.
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
        `document.head.appendChild(style);` +
        // Printing straight after the assignment captures an unpainted page
        // (a blank PDF on a cold webview). Wait for fonts, images and two
        // frames, then report how much text the page actually has so the
        // caller can refuse to print an empty document.
        `(async () => {` +
        `  if (document.fonts && document.fonts.ready) { await document.fonts.ready; }` +
        `  await Promise.all(Array.from(document.images).map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); })));` +
        `  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));` +
        `  return (document.body.innerText || '').trim().length;` +
        `})()`
    );
}
