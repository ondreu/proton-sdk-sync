import type { LogLevel } from './util/logger';
import type { ExportedShare } from './sync/pdfShare';
import { DEFAULT_EXPORT_FOLDER, DEFAULT_SHARE_EXPIRY_DAYS } from './sync/pdfShare';
import type { ConflictPolicy } from './sync/types';

export type PluginSettings = {
    /** Node uid of the Drive folder the vault maps onto. Unset until chosen. */
    remoteFolderUid: string | null;
    /** Human-readable path of that folder, for display only. */
    remoteFolderPath: string | null;
    /**
     * Owner of that folder when it is shared with this account rather than in
     * its own My files, for display: their address, or "someone" when Drive
     * does not name them. Null for a folder of the user's own.
     */
    remoteFolderSharedBy: string | null;

    conflictPolicy: ConflictPolicy;
    /**
     * Keeps the losing side as a sibling file under `prefer-*` policies too.
     * Where the two versions differ it is kept whatever this says; the setting
     * only covers versions that hold the same bytes, which need no copy.
     */
    /** Kept for configurations written before 1.0.0; the losing side is now always kept when it differs. */
    keepConflictCopies: boolean;

    /**
     * Everything held: no passes, no polling, no watching. Changes made in the
     * meantime are found by the full sync that runs on resume. Persisted, so a
     * pause survives a restart.
     */
    paused: boolean;
    /** Watch the vault and sync changes as they happen. */
    autoSync: boolean;
    /** Run a full reconciliation when the plugin loads. */
    syncOnStartup: boolean;
    /**
     * On load, compare the whole tree instead of replaying Drive's events.
     *
     * Event replay is cheap and right for a desktop app that was closed for a
     * few minutes, but a cursor saved before a change that then failed to
     * apply will not mention that change again. A long-lived headless daemon
     * restarts rarely, so it can pay for a tree walk and know it is converged.
     */
    fullSyncOnStartup: boolean;
    /** Quiet period after the last edit to a file before it is uploaded. */
    uploadDebounceMs: number;
    /**
     * How often to ask Drive for events, in seconds.
     *
     * Proton's guidelines ask clients to sync from events rather than poll, and
     * the SDK's own scheduler uses 30s for the user's own volume. Going lower
     * risks the account being rate-limited; the setting exists so the interval
     * can be raised, not so it can be dropped.
     */
    remotePollSeconds: number;
    /** Parallel uploads/downloads. Kept low to stay within Drive's limits. */
    transferConcurrency: number;

    /** Skip files larger than this, in either direction. 0 disables the limit. */
    maxFileSizeMb: number;
    /**
     * On phones and tablets only: files larger than this are left where they
     * are, to be synced by a desktop device. 0 disables the limit, as on the
     * desktop.
     *
     * It starts at {@link DEFAULT_MOBILE_MAX_FILE_MB} rather than off: a file
     * of a gigabyte or two is read into memory twice over on a phone — the
     * chunks as they arrive, then the file they are joined into — which is
     * enough for the app to be killed, on every retry.
     */
    mobileMaxFileSizeMb: number;
    /**
     * On phones and tablets only: hold the sync while on a cellular
     * connection. Only Android reports the connection type; elsewhere this has
     * no effect.
     */
    wifiOnly: boolean;
    /** Glob patterns, matched against vault-relative paths. */
    excludePatterns: string[];
    /** Sync `.obsidian/` — appearance, plugins, hotkeys — alongside the notes. */
    syncObsidianConfig: boolean;
    /**
     * A pass that would remove more files than this from Drive is held instead,
     * and the user is asked; 0 turns the guard off.
     *
     * The case it exists for is a vault that lost a whole folder at once: an
     * unmounted card, a folder a cloud client evicted, a directory deleted
     * outside Obsidian. Deleting the Drive copies then propagates the loss to
     * every device. See `SyncEngine.pendingMassDelete`.
     */
    massDeleteThreshold: number;

    /** Names the device in conflict copies and in the sync log. */
    deviceName: string;
    logLevel: LogLevel;
    /** Put real note names in the log; off by default, since logs leave the device in bug reports. */
    logShowsNames: boolean;

    /** Set once the first-run setup has been shown, so it never reappears. */
    onboardingComplete: boolean;

    /**
     * Vault-relative folder exported PDFs are written to. Blank falls back to
     * {@link DEFAULT_EXPORT_FOLDER} where it is used, so an empty text field
     * cannot scatter PDFs at the vault root.
     */
    exportFolder: string;
    /**
     * How long a new export's share link lasts, in days. 0 means the link
     * never expires, and then the janitor has nothing to clean up.
     */
    shareExpiryDays: number;
    /**
     * Preselection for the per-share “Delete the file when the link expires”
     * toggle. Off by default: only the link expires and the file stays.
     * Migrated once from the old always-on `autoDeleteExpiredExports`, so
     * anyone who had that on keeps the behaviour per share.
     */
    defaultDeleteOnExpiry: boolean;
    /**
     * Every shared file and the link made for it. Only entries that pass the
     * janitor's confinement checks can ever trash their file: the path must
     * be a canonical vault path whose current sync record names the same
     * node the share was made for.
     */
    exportedShares: ExportedShare[];

    /**
     * With a PIN: minutes without using Obsidian before the PIN is asked for
     * again. 0 asks only when Obsidian opens. With a time limit, reopening
     * Obsidian within it does not ask either; see `RememberedUnlock`.
     */
    pinLockAfterMinutes: number;
    /**
     * Whether a PIN was set, recorded outside the encrypted file.
     *
     * The envelope can become unreadable — a torn write, a keychain that is not
     * unlocked yet, a copied profile — and "cannot read it" must not be mistaken
     * for "there is no PIN", which would let the next write store the session in
     * the clear. See `PinProtectedSlot`.
     */
    pinProtected: boolean;
};

/**
 * The folder at the root of the synced Drive folder where each device keeps
 * a note of itself for the vault's device list, and where the others leave
 * it requests; see `DeviceRegistry`. It is the plugin's, not the vault's, so
 * it is never synced as files. Versions before the device list sync it like
 * any other hidden folder, which does no harm: they never write to it.
 */
export const DEVICES_FOLDER = '.proton-drive-sync';

/**
 * Files that should never leave the device, regardless of user configuration.
 *
 * Editor scratch files and OS droppings. The config-folder exclusions depend
 * on where the vault keeps its config, so they are built by
 * {@link configExclusions}.
 */
export const ALWAYS_EXCLUDED = [
    `${DEVICES_FOLDER}/`,
    '.proton-sync/',
    '.trash/**',
    '.git/**',
    '.DS_Store',
    '**/.DS_Store',
    'Thumbs.db',
    '**/*.tmp',
    '**/~$*',
];

/**
 * Files inside the config folder that stay on the device even when the rest of
 * it is synced.
 *
 * `workspace.json` and friends record which panes are open and where; syncing
 * them makes two devices fight over each other's layout on every focus change.
 *
 * This plugin's whole folder stays local too. Its data files are per-device by
 * nature: the sync state is this device's merge base and `data.json` carries
 * its device name. Its code gains nothing from syncing either, since a device
 * has to have the plugin installed before it can sync at all; syncing it only
 * meant one device's version replacing another's while it ran, a downgrade as
 * often as an upgrade. Each device updates it through Obsidian instead.
 */
export function configExclusions(configDir: string, pluginDir: string | null): string[] {
    const patterns = [
        `${configDir}/workspace.json`,
        `${configDir}/workspace-mobile.json`,
        `${configDir}/workspace`,
        `${configDir}/cache`,
    ];
    if (pluginDir) {
        patterns.push(`${pluginDir}/`);
    }
    return patterns;
}

/**
 * Config files that make Obsidian run code: the installed plugins and the list
 * of enabled ones. Never synced with a vault other people can write to, even
 * with config sync on, since a collaborator could otherwise put a plugin on
 * everyone's machine that runs on the next reload.
 */
export function codeExclusions(configDir: string): string[] {
    return [`${configDir}/plugins/**`, `${configDir}/plugins`, `${configDir}/community-plugins.json`];
}

/**
 * The size limit a phone or tablet starts with, in megabytes; see
 * {@link PluginSettings.mobileMaxFileSizeMb}. The vault and Drive sides refuse
 * a larger file before reading it, from this same number, so a device that
 * never gets as far as the settings still cannot be made to read one.
 */
export const DEFAULT_MOBILE_MAX_FILE_MB = 200;

export const DEFAULT_SETTINGS: PluginSettings = {
    remoteFolderUid: null,
    remoteFolderPath: null,
    remoteFolderSharedBy: null,

    conflictPolicy: 'merge',
    keepConflictCopies: true,

    paused: false,
    autoSync: true,
    syncOnStartup: true,
    fullSyncOnStartup: false,
    uploadDebounceMs: 2000,
    remotePollSeconds: 30,
    transferConcurrency: 3,

    maxFileSizeMb: 0,
    mobileMaxFileSizeMb: DEFAULT_MOBILE_MAX_FILE_MB,
    wifiOnly: false,
    excludePatterns: [],
    syncObsidianConfig: true,
    massDeleteThreshold: 25,

    deviceName: '',
    logLevel: 'info',
    logShowsNames: false,

    onboardingComplete: false,

    exportFolder: DEFAULT_EXPORT_FOLDER,
    shareExpiryDays: DEFAULT_SHARE_EXPIRY_DAYS,
    defaultDeleteOnExpiry: false,
    exportedShares: [],

    pinLockAfterMinutes: 0,
    pinProtected: false,
};

/**
 * Whether a stored config opted into auto-delete before the per-share toggle
 * existed. The old setting defaulted to true without any UI, so a stored
 * `true` counts as opted in and migrates; a stored `false`, a missing key, or
 * an already-migrated config stays off. Pure so it is unit-tested.
 */
export function legacyAutoDeleteOptIn(stored: unknown): boolean {
    if (typeof stored !== 'object' || stored === null) {
        return false;
    }
    const record = stored as Record<string, unknown>;
    if (record.defaultDeleteOnExpiry !== undefined) {
        return false;
    }
    return record.autoDeleteExpiredExports === true;
}

/**
 * Lower bound on the poll interval: the rate Proton's own SDK polls a user's
 * Drive at. Faster would only invite rate limiting.
 */
export const MIN_POLL_SECONDS = 30;
