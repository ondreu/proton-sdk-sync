# Proton-SDK-Sync

Two-way sync between an [Obsidian](https://obsidian.md) vault and a folder in
[Proton Drive](https://proton.me/drive), built on Proton's official
[Drive SDK](https://github.com/ProtonDriveApps/sdk). Notes, attachments and your
`.obsidian` settings travel encrypted end to end: the encryption happens on your
device, with the same SDK Proton's own clients use.

> [!IMPORTANT]
> This plugin writes to your vault and can delete files in it. It has an
> automated test suite, but no external audit. Keep a backup you can restore
> from, as you would with any sync tool.

## Why this fork

This is a fork of [obsidian-proton-sync](https://github.com/MarckFp/obsidian-proton-sync).
It exists for three reasons:

- **Upstream moves slowly.** Fixes and reviews that pile up there would wait
  indefinitely; this fork ships them as they are ready.
- **Releases are tested before they go out.** Upstream 0.11.5 shipped a sign-in
  bug that made every sign-in after the first fail with "Destination file
  already exists!". This fork's 1.0.1 fixes it, and every release is cut only
  after the engine suite, the daemon suite and the fake-Drive integration
  harness are green.
- **It goes further than a plugin.** The same engine also runs as a headless
  daemon on a Linux server ([ondreu/pss-daemon](https://github.com/ondreu/pss-daemon)), so a vault can stay in sync on a NAS
  without Obsidian Sync and without a desktop running. Upstream has no such
  mode.

The sync engine, the Proton SDK usage and the plugin surface are upstream's
work, and this fork deliberately keeps the same engine rather than copying it:
a conflict fix is fixed once, for both the plugin and the daemon.

## What it does

- **Two-way sync** of the whole vault — notes, images, video, audio, PDFs,
  folders, and `.obsidian` settings if you want them.
- **Renames stay renames.** Renaming or moving a file here or on another device
  renames the same file on Drive and keeps its version history. That holds for
  renames made while syncing was paused, on mobile data, or outside Obsidian
  (in a file manager, with `git mv`): the next full sync recognises the file by
  its content and moves it instead of uploading it again.
- **Three-way conflict detection.** Every synced file records the version both
  sides last agreed on, so a device that was offline for a week can tell an
  edit it missed from an edit it made. Only a genuine double edit is reported.
- **Conflicts are recoverable.** You choose per conflict — this device, Drive,
  or both — and the losing side is kept as a conflict copy, so nothing is
  silently thrown away.
- **Version history.** Look at earlier versions of a note on Drive, compare
  them with what you have, and restore one.
- **Selective sync.** Exclude paths by glob, skip large files, and hold syncing
  on cellular data on mobile.
- **A guard against mass deletion.** If a large share of the vault disappears
  locally at once — an unmounted card, an evicted cloud folder, a vault cleared
  by something else — the plugin stops and asks before trashing anything on
  Drive.
- **Devices see each other.** Each device keeps a small note in the synced
  folder, so you can see what else syncs this vault and ask another device to
  re-check or to hand over a folder.

## Headless daemon (Linux server)

The same sync engine runs without Obsidian, so a vault can stay in sync on a
NAS or any Linux box — no desktop running, and no Obsidian Sync. That daemon
lives in its own repository, [ondreu/pss-daemon](https://github.com/ondreu/pss-daemon):
it pins this repository as a submodule and imports `src/sync` and `src/proton`
directly, so a conflict fix still lands once for both. It is not shipped in
`main.js` and nothing here depends on it.

## Requirements

- A **Proton account** with Drive. The plugin signs in through Proton's web
  login; your password is never typed into the plugin and never stored by it.
- Obsidian **1.13.7** or newer. Desktop and mobile.

## Installing

Until the plugin is in the community directory, install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/ondreu/proton-sdk-sync/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/proton-sdk-sync/`.
3. Enable **Proton-SDK-Sync** in *Settings → Community plugins*.

With [BRAT](https://github.com/TfTHacker/obsidian42-brat) you can add
`ondreu/proton-sdk-sync` instead and let it keep the plugin updated.

## Setting it up

1. *Settings → Proton-SDK-Sync → **Sign in***. A browser window opens on
   Proton's own login page; approve the sign-in there and come back.
2. Choose the Drive folder to sync with, or create one. An empty folder and an
   empty vault pair up cleanly; a folder that already has files is matched
   against the vault by content, so matching files are paired instead of copied
   twice.
3. Pick what to sync, and let the first pass finish. The status bar shows what
   it is doing; the panel behind it lists individual transfers.

A first sync of a large vault is mostly upload or download. It takes time, and
it needs Obsidian to stay open, though not in the foreground.

## Conflicts

A conflict is a file edited on two devices since they last agreed on it. The
plugin does not guess: it keeps both sides and asks.

- **This device** keeps the local file and uploads it, so Drive follows.
- **Drive** brings the Drive version down, so this device follows.
- **Both** keeps the local file and writes the Drive version beside it as a
  conflict copy, named `note (conflict from <device> 2026-01-31 12-00-00).md`.

The losing side is always kept as a conflict copy when the two differ. Nothing
is dropped because a button was pressed once.

Text files changed on both sides are merged line by line when the edits do not
overlap; the merged result is written and reported as merged. Everything else
becomes a conflict copy.

## Pausing and troubleshooting

- **Pause** stops all passes, polling and watching. Changes made meanwhile are
  found by the full sync on resume.
- **Sync now** runs a full reconciliation immediately.
- **Copy sync log** in settings puts the recent log on the clipboard, with file
  names redacted unless you turn that off.
- If a pass fails on one file — a locked file on Windows, a permission error —
  that file is recorded as failed and the rest of the pass continues.

## What is never synced

- Editor scratch files, `.DS_Store`, `Thumbs.db`, `desktop.ini`.
- `.git/`, `.trash/`, and Obsidian's own cache folders.
- Anything you exclude, and `.obsidian/` if you turn config syncing off.
- Files above your size limit, and on mobile anything above the mobile limit.

The plugin's own state and logs stay in
`.obsidian/plugins/proton-sdk-sync/`, and its Drive metadata cache in
IndexedDB; none of it syncs.

## Sharing files with a link

Any file in the vault — a note, an image, a PDF, a zip — can get a view-only
Proton public link. Right-click it (or use the command palette) and choose
“Share file with a Proton link”; pick the lifetime (7, 30, 90 days, a custom
number, or never) and the dialog shows the link with a Copy button.

- The link is created for that exact file, after it has reached Drive. Anyone
  with the URL can view it; view-only means no one can edit or upload through
  it, but a public link is public — treat it like any other share link.
- By default the file stays when the link expires; only the link goes. Tick
  “Delete the file when the link expires” to have that file moved to the trash
  at expiry instead (never a folder, and only a file the plugin can still
  match to the share it made).
- Deleting a file yourself removes its link too.
- “Manage shared files” in settings (and the command palette) lists every link
  with copy, stop sharing, and delete.

## Sharing a vault with other people

A folder shared with you on Drive can be the sync target. The device list is
then disabled: the other people in that folder would see the notes each device
writes about itself, and that is not theirs to see.

## Where your credentials live

The Proton session — access and refresh tokens, never your password — is stored
encrypted, in one of two places:

- **Desktop:** a file in the plugin's folder, encrypted with the OS keystore
  (Electron `safeStorage`: Keychain, DPAPI, libsecret), file mode `0600`. Where
  no keystore is available, it goes to Obsidian's secret storage instead.
- **Mobile:** Obsidian's own secret storage, because the mobile app has no
  keystore.

You can put a PIN in front of the stored session. With a PIN set it is never
written in the clear: a token refresh that arrives while the plugin is locked
waits in memory and is written, encrypted, at the next unlock. Wrong PINs back
off exponentially, and the count survives a restart.

Signing out ends the session on Proton's side as well, and forgets the folder
choice and the sync state, because both belong to the account you left.

## Permissions and disclosures

- **Account:** a Proton account is required. There is no way to use the plugin
  without one.
- **Network:** the plugin talks to Proton only — `account.proton.me`,
  `drive-api.proton.me`, and the regional block-storage host the Drive API hands
  out (`<region>-storage.proton.me`). It sends the requests a Drive client has
  to send: authentication, file listing, uploads, downloads, shares and version
  history. Nothing is sent anywhere else, and a request to any other host is
  refused.
- **Telemetry:** none. The SDK's telemetry interface is wired to the local log
  and the metrics are dropped; nothing about your files or your usage leaves the
  device except the Drive requests themselves.
- **Files outside the vault:** none of yours. Besides its own folder in the
  vault, the plugin uses Obsidian's secret storage (the session on mobile), a
  few per-vault keys in Obsidian's localStorage, the OS keyring entry that
  `safeStorage` needs, and an IndexedDB cache of Drive metadata. All of it stays
  on the device.
- **Ads:** none, and no paid tiers.

### What the directory review reports, and why

The automated review lists a few capabilities with a warning or a
recommendation. Each one is real, and each has a reason:

- **Direct filesystem access (desktop only).** Node's `fs` is reached lazily,
  behind a desktop check, and only through paths that have already been checked
  to stay inside the vault. It is used for two things the vault API cannot do:
  streaming a large upload in chunks instead of holding the whole file in
  memory, and hashing files larger than a few megabytes without a second full
  copy. On mobile there is no Node at all, and everything goes through the vault
  adapter and WebCrypto. That is why `isDesktopOnly` is `false`: the plugin
  runs on mobile, it just takes the slower path there.
- **Vault enumeration.** A sync plugin has to know every path in the vault; that
  is what it is comparing against Drive. Paths outside the synced folder are
  skipped before anything is read.
- **Clipboard.** Only when you press **Copy sync log**. Nothing is read from the
  clipboard, ever.
- **Dynamic code execution.** The bundle contains one `new Function`, inside
  `ttag`'s plural-form helper, which Proton's OpenPGP.js bundles for its
  translated messages. The plugin itself never evaluates generated code, and
  nothing from a note, a file name or the network reaches that helper.

## How it works, briefly

The plugin keeps a state file mapping each vault path to its Drive node and the
revision both sides last agreed on. On each pass it lists what changed on Drive
since its cursor, walks the parts of the vault that changed, and reconciles the
two against that common ancestor. Uploads are debounced; Drive is polled at the
interval Proton's own clients use. Transfers are streamed through the SDK, so a
large file does not have to fit in memory.

## Support

Bugs and questions go to
[the issue tracker](https://github.com/ondreu/proton-sdk-sync/issues). For
anything that could put someone's data at risk, say so in the title and keep the
details out of the first message.

## Credits and licence

GPL-3.0-or-later; see [LICENSE](LICENSE).

This is a maintained fork of
[MarckFp/obsidian-proton-sync](https://github.com/MarckFp/obsidian-proton-sync)
(© Marcos, GPL-3.0), which in turn builds on Proton's SDK and OpenPGP.js. The
original author is credited as a contributor. The sync engine, the conflict
handling and the UI come from that codebase, and the changes here are this
fork's own.

Bundled third-party code keeps its own licence; the header of `main.js` lists
it. Proton's OpenPGP.js fork is MIT (© Proton AG); see
`src/proton/account/LICENSE.md`.

Proton and Proton Drive are trademarks of Proton AG. Obsidian is a trademark of
Dynalist Inc. This plugin is not affiliated with either.
