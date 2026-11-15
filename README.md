# Proton-SDK-Sync

Two-way sync between an [Obsidian](https://obsidian.md) vault and a folder in
[Proton Drive](https://proton.me/drive), built on Proton's official
[Drive SDK](https://github.com/ProtonDriveApps/sdk). Notes, attachments and your
`.obsidian` settings travel encrypted end to end: the encryption happens on your
device, with the same SDK Proton's own clients use.

> [!IMPORTANT]
> This plugin writes to your vault and can delete files in it. It has an
> automated test suite, but no external security audit. Keep a backup, and try
> it on a copy of a vault first.

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

## Requirements

- A **Proton account** with Drive. The plugin signs in through Proton's web
  login; your password is never typed into the plugin and never stored by it.
- Obsidian **1.13.7** or newer. Desktop and mobile.

## Installing

Until the plugin is in the community directory, install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](../../releases/latest).
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

The losing side is always kept as a conflict copy when it differs, even if
conflict copies are turned off for ordinary merges — losing an edit because a
button was clicked once is not a trade worth making.

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

The plugin's own state, logs and cached metadata stay in
`.obsidian/plugins/proton-sdk-sync/` and never sync.

## Sharing a vault with other people

A folder shared with you on Drive can be the sync target. The device list is
then disabled: the other people in that folder would see the notes each device
writes about itself, and that is not theirs to see.

## Where your credentials live

The Proton session — access and refresh tokens, never your password — is stored
encrypted, in one of two places:

- **Desktop:** a file in the plugin's folder, encrypted with the OS keystore
  (Electron `safeStorage`: Keychain, DPAPI, libsecret), file mode `0600`.
- **Mobile:** Obsidian's own secret storage, because the mobile app has no
  keystore.

You can put a PIN in front of the stored session. With a PIN set it is never
written in the clear: a token refresh that arrives while the plugin is locked is
dropped, and the next unlock fetches a fresh one. Wrong PINs back off
exponentially, and the count survives a restart.

Signing out ends the session on Proton's side as well, and forgets the folder
choice and the sync state, because both belong to the account you left.

## Permissions and disclosures

- **Account:** a Proton account is required. There is no way to use the plugin
  without one.
- **Network:** the plugin talks to Proton only — `account.proton.me`,
  `drive-api.proton.me` and the addresses the SDK resolves from them. It sends
  the requests a Drive client has to send: authentication, file listing,
  uploads, downloads, shares and version history. Nothing is sent anywhere else.
- **Telemetry:** none. The SDK's telemetry interface is wired to the local log
  and the metrics are dropped; nothing about your files or your usage leaves the
  device except the Drive requests themselves.
- **Files outside the vault:** none of yours. Besides its own folder in the
  vault, the plugin uses Obsidian's secret storage (the session on mobile), a
  few per-vault keys in Obsidian's localStorage, the OS keyring entry that
  `safeStorage` needs, and an IndexedDB cache of Drive metadata. All of it stays
  on the device.
- **Ads:** none, and no paid tiers.

## How it works, briefly

The plugin keeps a state file mapping each vault path to its Drive node and the
revision both sides last agreed on. On each pass it lists what changed on Drive
since its cursor, walks the parts of the vault that changed, and reconciles the
two against that common ancestor. Uploads are debounced; Drive is polled at the
interval Proton's own clients use. Transfers are streamed through the SDK, so a
large file does not have to fit in memory.

## Credits and licence

GPL-3.0-or-later; see [LICENSE](LICENSE).

This is a maintained fork of
[MarckFp/obsidian-proton-sync](https://github.com/MarckFp/obsidian-proton-sync)
(© Marcos, GPL-3.0), which in turn builds on Proton's SDK and OpenPGP.js. The
original author is credited as a contributor. The fork exists because the
upstream project stopped merging fixes; the sync engine, the conflict handling
and the UI come from that codebase, and the changes here are this fork's own.

Bundled third-party code keeps its own licence; the header of `main.js` lists
it. Proton's OpenPGP.js fork is MIT (© Proton AG); see
`src/proton/account/LICENSE.md`.

Proton and Proton Drive are trademarks of Proton AG. Obsidian is a trademark of
Dynalist Inc. This plugin is not affiliated with either.
