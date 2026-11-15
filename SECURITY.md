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
plugin is locked, a token refresh is not written at all — it is dropped, and the
next unlock fetches a new one. Wrong PINs back off from one second to thirty
seconds, and the failure count survives a restart.

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
