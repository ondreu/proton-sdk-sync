# Headless sync daemon

Status: design. Target: run the plugin's sync engine on a Linux NAS
(Synology/UGREEN, Docker) against the same vault the Obsidian plugin syncs,
so the vault stays live after Obsidian Sync is dropped. The engine is reused
as-is; everything around it is a thin adapter.

Non-goals are at the bottom. Line references are against this repo.

## 0. Decisions up front

| # | Question | Decision |
|---|----------|----------|
| 1 | Engine reuse | Unchanged. `SyncEngine` plus a headless `App` shim; no fork (section 1). |
| 2 | Package layout | New npm workspace `headless/` with its own esbuild node build importing `../src`; plugin build untouched (section 2). |
| 3 | Auth | Device/web flow (`ProtonSession.beginWebSignIn`), session in a `SecretSlot` encrypted with a key from the environment, file `0600` (section 3). |
| 4 | State | Per-device files in the daemon data dir, same `StateFile` v1 format as the plugin; GUI state is imported once by copy, never shared live (section 4). |
| 5 | Unattended policy | Default `keep-both`; `manual` is refused. Mass delete is held and never auto-approved (section 5). |
| 6 | New dependencies | None. Only Node 24 builtins plus the existing `drive-sdk`/`crypto` (section 2). |

## 1. Running the engine unchanged

`SyncEngine`'s constructor (`src/sync/engine.ts:310`) takes
`(app, state, settings, logger, hooks, scope, environment)` where `app` is
the whole Obsidian `App` type. The engine itself only touches a small corner
of it, all through `VaultIO` (`src/sync/vault.ts:203`):

- `app.vault.adapter` (`vault.ts:224`) — every read, write, listing and stat.
- `app.vault.getAbstractFileByPath` (`vault.ts:242`) — null means "not indexed".
- Indexed-file writes: `app.vault.copy` (`vault.ts:411`),
  `app.vault.rename` (`vault.ts:693`), `app.vault.createBinary` (`vault.ts:749`),
  `app.fileManager.trashFile` (`vault.ts:843`).

The headless `App` shim (`headless/src/headlessApp.ts`) implements exactly
this: a `NodeVaultAdapter` over the vault directory using `node:fs`
(`stat`, `readBinary`/`writeBinary`, `mkdir`, `remove`, `rename`, `list`,
`getFullPath`), `getAbstractFileByPath` returning a fake for any path without
a dot-segment (mirroring Obsidian's indexing rule, as `tests/support/fakes.ts`
does), and `copy`/`rename`/`createBinary`/`trashFile` mapped onto adapter
calls. `tests/support/diskAdapter.ts` already proves the adapter half works;
the shim adds the four vault methods and the lookup on top.

What breaks outside Obsidian, and the replacement for each:

| Obsidian API | Where | Headless replacement |
|---|---|---|
| `requestUrl` (CORS escape hatch) | `src/proton/obsidianFetch.ts:24`, wired in `session.ts:162` | Plain `fetch` (undici). No CORS exists server-side. `ApiClient` already takes `fetch` as a parameter, so this is a one-line swap. |
| `window.require('fs'/'crypto')` fast paths | `vault.ts:129-145` | `import('node:fs')` / `node:crypto` directly. The code already falls back to the adapter when the require fails; headless takes the direct path. |
| `Platform.isWin/isMobile/...` | `vault.ts:32,234,269,586`, `main.ts:317-322` | Constants from `process.platform`: `windows = process.platform === 'win32'`, `isMobile = false`. Passed via `EngineEnvironment` (`src/sync/engine/types.ts:174`), which already abstracts all of these; use `DESKTOP` (`types.ts:195`) with `isMetered: () => false`. |
| Bare `window.setTimeout/clearTimeout` | `engine.ts:695`, `engine/pollScheduler.ts:66`, `devices.ts:546`, `state.ts:569`, `persistentCache.ts:124` | `globalThis.window ??= globalThis` shim at entry, the same trick `scripts/test.mjs` already uses to run these modules under Node. `clock.ts:15` already handles a missing `window`. |
| `Notice`, modals, status bar | `main.ts` UI layer | `EngineHooks.onChange/onConflict` (`types.ts:217`) write to the log and the health file instead. No UI code is imported. |
| `app.secretStorage`, Electron `safeStorage` | `main.ts:240-257`, `secretStore.ts:299` | File slot encrypted with Node `scrypt` + AES-256-GCM (section 3). |
| `IndexedDbCacheStore` | `session.ts:389-407` | New `FileCacheStore` implementing the existing `CacheStore` interface; `openEntitiesCache` already falls back to `MemoryCache` when no store is available, so this only adds persistence. |
| Vault events (`vault.on('create'/'modify'/...)`) | `main.ts:1326-1344` | An `fs.watch`-based watcher mapping onto `engine.onVaultChange/onVaultRename/onVaultFolderDelete`, with a periodic full rescan as backstop. `engine.startupSync` (`engine.ts:1066`) and `sweepDownloads` (`vault.ts:246`) already cover missed events at boot. |

If the engine cannot be reused as-is, the fallback is a one-line change, not
a fork: narrow the constructor parameter from `App` to the five vault methods
above. Everything else stays.

## 2. Package layout

Second esbuild entry in the same package is rejected: the plugin build targets
`platform: 'browser'` with `obsidian` external (`esbuild.config.mjs`), and a
node entry sharing that config would entangle the two outputs. Forking
`src/sync` into the daemon is rejected harder: every conflict fix would need
applying twice.

So: an npm workspace `headless/` with its own `package.json` and
`headless/esbuild.config.mjs` (`platform: 'node'`, `target: 'node24'`,
`format: 'cjs'`, `obsidian` aliased to a local stub like
`tests/stubs/obsidian.ts`). It imports the engine by relative path
(`../../src/sync/engine.ts`), sharing `src` source without moving it. The
plugin build, manifest and release flow do not change.

```sh
npm --workspace headless run build   # -> headless/dist/pss-daemon
./headless/dist/pss-daemon --help
```

No new runtime dependencies. Each candidate was rejected in favour of
builtins: `chokidar` (watcher; `fs.watch` per directory plus rescan suffices
for one vault), `keytar`/`libsecret` (secret storage; no keyring on a NAS,
use env-keyed file encryption), `commander`/`pino` (CLI/logging; ~100 lines of
parsing and JSONL is enough and keeps the audit surface small).

## 3. Auth

Reuse `ProtonSession` (`src/proton/session.ts:73`) and `Credentials`
(`src/proton/credentials.ts:35`) unchanged. Headless differs only in the
`fetch` passed to `ApiClient` (section 1) and the `SecretSlot`
(`src/proton/secretStore.ts:9`) backing the credentials.

First run: `pss-daemon login` calls `session.init()` then
`beginWebSignIn` (`session.ts:234`), which returns a `SignInHandle`
(`session.ts:55`) with the `account.proton.me` approval URL. The daemon prints
the URL to stdout and waits on `completion`, which polls until the user
approves in a browser — password, 2FA and security keys keep working because
the daemon never sees them. On approval, `finishSignInSetup`
(`session.ts:423`) builds the client. Unattended start afterwards restores
from disk with no prompts.

Secret material on disk (all under the daemon data dir, default
`/data/pss-daemon/`; nothing secret ever lands in the vault):

| File | Contents | Protection |
|---|---|---|
| `session.bin` | `StoredSession` v1 JSON (`credentials.ts:8`): uid, access token, refresh token, user key password, account email, cache key | AES-256-GCM, key from `PSS_KEY_FILE` via scrypt; file `0600`, write-temp-rename like `SafeStorageFileSlot.write` (`secretStore.ts:218`). PIN is not supported headless; `PinProtectedSlot` is bypassed, not reimplemented. |
| Drive metadata cache | Encrypted node cache via `FileCacheStore`, key = session `cacheKey` (`credentials.ts:97`) | Same envelope as the session; validated against `state.cursorsFingerprint()` (`state.ts:129`) exactly as `main.ts:788` does. |

Token refresh rides on `ApiClient.authenticatedRequest` through `HTTPClient`
(`src/proton/httpClient.ts:23`): a 401 refreshes like any other request. When
Proton ends the session (refresh token dead), `sessionEnded`
(`session.ts:323`) fires the handler that stops the engine; the daemon logs,
writes `status: signed-out` to the health file, and exits 4 so the supervisor
does not hot-loop a login that needs a human.

## 4. State identity

The plugin keeps `sync-state.json` (`STATE_FILE`, `main.ts:70`) at
`<pluginDir>/sync-state.json` (`main.ts:290-292`) — inside the vault's
`.obsidian` folder — plus `conflict-history.json` and the session beside it.
`SyncState.load(accountEmail, remoteFolderUid)` (`state.ts:151`) binds a file
to one account (via `accountTag`, `state.ts:19`) and one Drive folder; a file
from another account or folder is ignored, and unreadable copies set
`wasLost()` (`state.ts:147`). Writes are crash-safe (`.tmp` + `.bak`,
`state.ts:75-88`).

The daemon must not share that file live with the GUI plugin or another
daemon: the state is a per-device merge base, and two writers corrupt the
"what did we last agree on" records (`SyncRecord.base`, `types.ts:19`). So:

- Daemon data dir holds its own `sync-state.json` in the identical `StateFile`
  v1 format, keyed to the daemon's own `clientUid` (a UUID in
  `daemon.json`, replacing `installationId`/`localStorage`, `main.ts:1698`).
- Moving a vault from GUI to daemon: `pss-daemon login --import-state
  <vault>/.obsidian/plugins/<id>/sync-state.json` copies the file once. Same
  account + same folder means `load` accepts it; from then on the two evolve
  independently. Moving back is the reverse copy while the daemon is stopped.
- Two machines over one Drive folder: distinct `clientUid`s, distinct state
  files, distinct cache scopes. The shared device list in
  `.proton-drive-sync/` (`DEVICES_FOLDER`, `settings.ts:116`, via
  `DeviceRegistry`, `devices.ts:177`) is the rendezvous — the daemon registers
  as `platform: 'linux-headless'` — not a lock.
- Same-machine double start is prevented by an `flock` held on
  `<data-dir>/daemon.lock` for the process lifetime; a second start for the
  same vault path exits 5 naming the lock holder's PID.

## 5. Unattended policy

Conflict resolution without a human: the daemon accepts every
`ConflictPolicy` (`types.ts:113`) except `manual`, which records a conflict
and waits for a user who will never come — config validation rejects it at
startup and suggests `keep-both`. Default is `keep-both` (the plugin default,
`settings.ts:186`); `merge` falls back to `keep-both` on unmergeable files by
construction. Every outcome is already reported through
`onConflict`/`ConflictEvent` (`types.ts:209`), which the daemon logs as JSON
with both paths.

Mass-delete guard: a threshold breach produces `PendingMassDelete`
(`types.ts:49`) instead of deletions. The daemon never auto-approves: it logs
the held paths (capped at 50, as the panel does), writes them to the health
file, and — in `once` mode — exits 3; in `watch` mode it keeps syncing
everything else and re-reports each pass. Recovery is explicit:
`pss-daemon approve-mass-delete` (re-decides every path first, like
`engine.approveMassDelete`, `engine.ts:386`) or `deny-mass-delete`
(re-downloads, like `denyMassDelete`, `engine.ts:410`).

First sync of a non-empty vault against a non-empty folder: the daemon runs
`planFirstSync` (`engine/planning.ts:28`) as a dry run and refuses to sync
until told which side wins: `--pairing=adopt-drive | adopt-vault | merge`.
`adopt-*` mirrors the "Drive settings win / vault wins" choice the plugin
makes for config (`types.ts:151`); `merge` pairs by content (the `adopt`
action, `types.ts:104`). With an empty state on either side this flag is
required; with an established state it is ignored.

Exclusions are the plugin's, unchanged:

| Source | Rule (`src/settings.ts`) |
|---|---|
| `ALWAYS_EXCLUDED` (`:125`) | `.trash/`, `.git/`, `*.tmp`, OS droppings — never sync. |
| `configExclusions` (`:150`) | `workspace.json`, `workspace*`, `cache`, and the whole `<pluginDir>/` (state, session) — never sync even with config sync on. |
| `codeExclusions` (`:169`) | `<configDir>/plugins/**`, `community-plugins.json` — never synced to a shared vault, so a collaborator cannot ship code to every machine. `keepSelfEnabled` (`engine.ts:1693`) keeps the local install entry intact. |

## 6. CLI surface and config

```
pss-daemon login [--import-state PATH] [--pairing MODE]  # web-flow sign-in
pss-daemon status [--json]                               # health + last summary
pss-daemon once [--dry-run]                              # one full sync, then exit
pss-daemon watch                                         # poll + fs.watch loop
pss-daemon verify                                        # checksum both sides vs state
pss-daemon approve-mass-delete | deny-mass-delete
pss-daemon sign-out
```

`daemon.json` (defaults shown), validated at startup:

```ts
type DaemonConfig = {
    vaultPath: string;            // e.g. "/vault"
    configDir: string;            // default ".obsidian"
    dataDir: string;              // default "/data/pss-daemon"
    remoteFolderUid: string | null;
    conflictPolicy: ConflictPolicy; // default "keep-both"; "manual" rejected
    massDeleteThreshold: number;  // default 25, from DEFAULT_SETTINGS
    remotePollSeconds: number;    // default 30; floor MIN_POLL_SECONDS (settings.ts:216)
    transferConcurrency: number;  // default 3
    pairing?: 'adopt-drive' | 'adopt-vault' | 'merge';
    logLevel: 'debug' | 'info' | 'warn' | 'error'; // default "info"
};
```

Exit codes: `0` clean (for `once`: in sync); `1` config/usage error; `2`
sync finished with item failures (paths listed in `status.json`); `3`
mass-delete held; `4` signed out / session revoked; `5` already running
(lock held). Logging is JSONL to stdout (`{ts, level, module, msg, ...}` via
the existing `Logger`, `src/util/logger.ts`), names redacted unless
`logShowsNames` is set. `status.json` in the data dir carries
`SyncSummary` (`types.ts:56`) plus `updatedAt` for a watchdog. SIGTERM/SIGINT
calls `engine.stop()` (`engine.ts:684` — drains the queue, flushes state)
then exits 0; a second signal within 30 s forces exit 1.

## 7. Deployment

```dockerfile
FROM node:24-slim
COPY headless/dist/pss-daemon /usr/local/bin/pss-daemon
USER 65532:65532
ENTRYPOINT ["pss-daemon", "watch"]
```

```yaml
services:
  pss-daemon:
    build: .
    command: ["watch"]
    volumes:
      - /volume1/vault:/vault:rw
      - pss-data:/data/pss-daemon:rw
    environment:
      PSS_CONFIG: /data/pss-daemon/daemon.json
      PSS_KEY_FILE: /run/secrets/pss_key
    secrets: [pss_key]
    mem_limit: 768m
    cpus: 1.0
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "pss-daemon", "status"]
      interval: 60s  # checks status.json freshness, not just process liveness
```

A systemd unit is the same shape (`ExecStart=... watch`,
`EnvironmentFile`, `Restart=on-failure`, no restart on exit 4). Volume
layout: vault mounted at the configured `vaultPath`; the data dir persists
`daemon.json`, `session.bin`, `sync-state.json`, `status.json` and the cache.
Resource limits: 1 CPU / 768 MB is ample — transfers are block-chunked and the
full sync is stat-bound; raise `transferConcurrency` only if Proton
rate-limits stay quiet. Verification: `pss-daemon verify` re-hashes both
sides against state records (`ContentStamp`, `types.ts:2`) and reports
divergence; a byte-level check is `find /vault -type f | sort | xargs sha1sum`
compared before cutover and after. The nightly tar backup coexists by reading
only: it must include the vault but exclude nothing the daemon needs; torn
state copies self-heal via `.bak` (`state.ts:75-81`), and scheduling the tar
right after `once` (or reading `status.json:idle`) avoids catching a partial
pass. Never back up `session.bin` off the NAS.

## 8. Phased implementation plan

| Phase | Workstream | Owns (new files) | Shared (read-only) | Size |
|---|---|---|---|---|
| A | Headless `App` shim + node `DataAdapter` | `headless/src/headlessApp.ts`, `headless/src/nodeAdapter.ts` | `src/sync/vault.ts` | 2–3 days |
| B | Auth at rest: env-keyed `SecretSlot`, `FileCacheStore`, `login` command | `headless/src/fileSlot.ts`, `headless/src/fileCacheStore.ts` | `src/proton/{session,credentials,secretStore,persistentCache}.ts` | 3–4 days |
| C | Daemon core: config, CLI, lifecycle, watcher, health file, signals | `headless/src/{config,cli,daemon,watcher,health}.ts` | `SyncEngine` API, `EngineHooks` | 1 week |
| D | `verify`, `dry-run`, `approve/deny-mass-delete`, Docker + docs | `headless/Dockerfile`, `compose.yml`, this doc's follow-ups | engine read APIs only | 2–3 days |

Single shared-code rule: `src/` has exactly one owner per stream while that
stream runs — A owns nothing in `src` (adapter-only; if the `App`-narrowing
fallback is needed, A owns that one signature), B owns the two new classes
only (no `src` edits expected), C owns nothing in `src`. Streams run A then
B/C in parallel after A's shim compiles against `tsc --noEmit`; D last. The
integration pass after B+C: `login → once → watch` against a scratch Drive
folder, plus `npm test` (586 tests) green to prove `src` untouched.

## 9. Migration and rollback

Pilot on a copy: duplicate the vault to `/vault-pilot`, point a pilot
`daemon.json` at it with a scratch Drive folder, run `once`, then `verify`,
then `watch` for a week while Obsidian Sync still serves the real vault. Diff
pilot against source nightly (`verify` + `sha1sum`) to catch watcher gaps.

Cutover: stop writes to the old path (pause Obsidian Sync headless,
`ob sync --continuous` down), final `once` on the real vault with
`--pairing=merge` and an empty state, `verify`, then `watch` under the
supervisor. Rollback within the pilot window: stop the daemon, re-enable the
official headless client; Drive keeps every version (revisions), and the
daemon never deletes without an explicit approval, so the worst case is
re-uploads. Keep the last Obsidian Sync snapshot until `verify` is clean for
seven days.

## 10. Open questions

1. Does Proton tolerate a long-lived third-party session polling every 30 s
   from a datacenter-adjacent IP, or should the default interval be higher?
2. Should the Drive metadata cache be skipped entirely on the NAS (MemoryCache
   only) to reduce encrypted-at-rest surface, at the cost of slower starts?
3. Who holds the encryption key on a Synology — DSM key manager, a USB-stored
   file, or interactive entry at container start?

Refuse to ship without: `verify` clean on the 134 MB reference vault;
kill -9 mid-sync followed by a clean start with no `wasLost()` surprise;
mass-delete hold exercised (unmounted-folder simulation) with exit 3 and no
Drive deletions; session revocation producing exit 4, not a retry loop; and
`npm test` green, proving the engine is still shared, not forked.

## What this does not do

- No GUI, no conflict UI, no settings sync UI: policy is config, conflicts are
  log entries.
- No `manual` conflict policy, no PIN, no mobile behaviour (`isMobile` is
  always false, size limits apply uniformly).
- No multi-vault or multi-account in one process: one daemon, one vault, one
  Drive folder.
- No server, no inbound ports, no sharing links: the attack surface is
  outbound HTTPS to Proton plus two local files.
- No backup itself: it keeps the live tree synced; the nightly tar stays.
