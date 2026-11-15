/**
 * The plugin's live state, kept out of the plugin instance on purpose.
 *
 * `app.plugins.plugins["proton-sdk-sync"]` is reachable from every other plugin
 * in the vault, and anything hanging off it — the session, its tokens, the
 * authenticated Drive client — would be one property lookup away. Keeping them
 * in module scope means the only way in is through the plugin's own methods,
 * none of which hand back credentials.
 *
 * SECURITY.md records what this closes and what it cannot: another plugin in
 * the same process can still read the vault and the network stack.
 */
import type { ConflictEvent } from './sync/engine/types';
import type { ConflictHistory } from './sync/conflictHistory';
import type { DeviceList } from './sync/devices';
import type { SyncEngine } from './sync/engine';
import type { SyncState } from './sync/state';
import type { ProtonSession } from './proton/session';
import type { PinProtectedSlot } from './proton/pinLock';
import type { Logger } from './util/logger';

const runtime = {
    session: null as unknown as ProtonSession,
    state: null as unknown as SyncState,
    conflictHistory: null as unknown as ConflictHistory,
    engine: null as unknown as SyncEngine,
    devices: null as unknown as DeviceList,
    sessionSlot: null as unknown as PinProtectedSlot,
    clientUid: "",
    logger: null as unknown as Logger,
    pendingConflicts: [] as ConflictEvent[],
    /**
     * The synced folder and the folders above it. Read on every start, so the
     * saved Drive cache is allowed to keep them; see persistentCache.nodeScope.
     */
    cacheParents: new Set<string>(),
};

/** The live runtime. Throws nothing: every field is wired during `onload`. */
export function getRuntime(): typeof runtime {
    return runtime;
}
