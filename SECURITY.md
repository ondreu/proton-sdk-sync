# Security

What the plugin stores, where it goes, and what it does not do.

## Credentials

The plugin never sees your Proton password. Sign-in happens on Proton's own web
login in your browser; the plugin receives a session (access and refresh tokens)
through Proton's standard web-login flow, and stores it encrypted:

- **Desktop:** `.obsidian/plugins/proton-sdk-sync/session.bin`, encrypted with
  Electron's `safeStorage` (Keychain, DPAPI or libsecret). Mode `0600`. If the
  OS cannot encrypt, the session goes to Obsidian's secret storage instead.
- **Mobile:** Obsidian's secret storage, since the mobile app has no keystore.

Optional PIN protection wraps that value in an authenticated envelope
(AES-256-GCM, PBKDF2-SHA-256, 1,000,000 iterations, random salt). While the
plugin is locked, a token refresh is kept aside and written, encrypted, at the
next unlock; the envelope is never replaced with readable tokens. Wrong PINs
back off from one second to thirty seconds, and the failure count survives a
restart.

A six-digit PIN is not a strong secret against someone holding a copy of the
file: at this work factor the whole keyspace costs about 1.5 CPU-days on one
core, less on a GPU. The PIN is there to keep a stolen, unlocked device out, and
a longer PIN is worth choosing. The failure counter only slows guessing at the
device — anyone with the file can remove it.

Signing out ends the session server-side through Proton's revoke endpoint before
forgetting it locally.

## Data

Everything the plugin writes stays inside the vault:

- `session.bin` — the encrypted session, where `safeStorage` exists.
- `sync-state.json` — path → Drive node and the last agreed revision.
- `conflict-history.json` — recent conflicts, for the history view.
- The SDK's Drive metadata cache, in IndexedDB, scoped to the synced subtree.

Those files never sync to Drive and are not readable by other people. Note names
do appear in the state file, because the mapping is the point of it; the file
does not leave the device.

The log is kept in memory and, on request, copied to the clipboard. File names
in it are redacted unless you turn `Log note names` on.

## Network

The plugin talks to Proton and nowhere else:

- `account.proton.me` — web login and session refresh.
- `drive-api.proton.me` — the Drive API the SDK uses.

Both are pinned in `src/proton/endpoints.ts`; a request to any other host is
refused. There is no telemetry, no analytics, no update check, and no remote
configuration. The SDK's telemetry interface is wired to the local log, and its
metrics are discarded.

## Headless daemon

The NAS daemon (`headless/`) reuses the same session format and the same
network endpoints as the plugin; only the custody differs.

**Key custody and rotation.** The session file is encrypted with AES-256-GCM;
the key is 32 bytes from the file named by `PSS_KEY_FILE` (scrypt envelope,
fresh salt+iv per write). The key file must be mode `0600`, owned by the
daemon uid, stored off the vault (Docker secret at `/run/secrets/pss_key` in
the reference compose), and backed up OFF the NAS separately from everything
else: losing it strands `session.bin` (re-login required), leaking it
exposes the session. There is no in-place re-key: to rotate, sign out and
log in again with the new key file, and the old envelope is replaced only
by that explicit fresh `login`, never silently. A
wrong/rotated key must never read as "signed out": if `login` finds an
unreadable `session.bin`, it refuses to overwrite it without
`--rotate-key` (alias `--force`) — exit 7 naming the key file, never
Proton. The same mismatch in `once`/`watch`/`verify` exits 7 instead of
reporting "not signed in".

**On-disk layout.** Data dir (default `/data/pss-daemon`, never inside the
vault): `session.bin` and `drive-cache.bin` mode `0600` in dirs mode `0700`
(healed on every write); `sync-state.json`, `status.json`, `device-id` and
both lock dirs are equally owner-only — `0600`/`0700`, written with explicit
modes and healed on every open (see `headless/src/secureFs.ts`). Verify
after first start:
`find /data/pss-daemon -perm /077` must print nothing. Nothing secret ever
lands in the vault.

**What lands in logs and status.** JSONL goes to stdout, which means Docker
logs on the NAS keep it indefinitely. Structured note paths — conflict and
copy paths, mass-delete held paths, plan and verify report paths,
`status.json` (`lastSummary` + `massDeleteHeld`) — redact by default to a
stable short digest (`<redacted:a1b2c3d4>`), so lines stay correlatable
without naming anything; counters stay exact. `--show-names` (or
`logShowsNames: true` in daemon.json) opts back into plaintext. Not covered:
free-text error strings from the OS or the Drive SDK may still embed a path
no pattern can reliably find, and the sign-in account is named unless
redaction is on — so still keep log rotation
(`logging.max-size/max-file` in compose.yml) and do not forward the logs to
third-party aggregation. Key bytes and key-file contents never appear in any
error string, log line, or status field.

**Backup exclusion.** `session.bin` must be excluded from every backup
(`scripts/backup-daemon-state.sh` does this and verifies the archive
contains no `session.bin`/`drive-cache.bin`); it never leaves the NAS.
Back up the key file separately, encrypted, off-site.

**Threat model non-protections.** The daemon does not defend against: the
NAS admin or root (full disk read either way); any process running as the
same uid (it can read the session and remove the lock — unavoidable in one
container); the Hermes co-writer of the vault (a second writer over the same
files bypasses the merge base — one writer per vault, enforced by the dual
lock, not by cryptography); or a Proton-account compromise (a valid session
elsewhere revokes nothing here — revocation is detected via `sessionEnded`
and exits 4 for a human re-login).

**Lock pid-namespace caveat.** Liveness is `kill(pid, 0)` plus the Linux boot
id. Two containers over one vault live in different pid namespaces, so a
live holder's pid is unverifiable from the other side — same-boot-id plus
ESRCH would misread "live but foreign" as "stale" and take over into two
writers. Defences, all landed: the lock carries a heartbeat (takeover needs
a dead pid *and* a heartbeat older than 30 s, or a boot id from before this
boot); an unreadable-but-recent lock reads as held, never stale; heartbeats
publish via temp-file plus rename, so readers never see a torn half-write;
and `release()` only unlinks a file it still owns. Still run one daemon per
vault — or `--pid=host` so pids are comparable.

## What this plugin does not defend against

Another plugin running in the same Obsidian process can read the vault and the
network stack. Keeping the session out of the plugin instance raises the bar —
there is no property to read — but it is not a sandbox, and it cannot be one.
If you install a plugin you do not trust, assume it can read your notes.

## Reporting a problem

Open an issue at
[ondreu/proton-sdk-sync](https://github.com/ondreu/proton-sdk-sync/issues). For
anything that could put someone's data at risk, say so in the title and keep the
details out of the first message; a maintainer will arrange a private channel.
