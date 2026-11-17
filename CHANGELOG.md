# Changelog

This project continues [obsidian-proton-sync](https://github.com/MarckFp/obsidian-proton-sync).
Releases before 1.0.0 are that project's; its notes are in its own releases.
Entries here describe this fork.

## [1.2.0] — 2026-11-17

### Added

- **Share any vault file with a view-only Proton link.** Right-click a file
  (or a note) and choose “Share file with a Proton link”, pick how long the
  link should live — 7, 30, 90 days, a custom number, or never — and copy the
  link from the dialog. “Manage shared files” (settings and the command
  palette) lists every link with copy, stop sharing and delete.
- **Optional delete on expiry.** Off by default: when a link expires only the
  link is removed and the file stays. Tick “Delete the file when the link
  expires” in the share dialog to have the janitor move that file to the trash
  at expiry instead. It never deletes a folder, and only a file whose current
  sync record still matches the share can be deleted, so a hand-edited config
  cannot target an unrelated note.

### Fixed

- Sharing a file whose node was remapped between the sync and the link
  creation can no longer register a link against the wrong file; the
  registry, the dialog and the clipboard all use the access the server
  returned.
- A deleted file removes its link instead of leaving it live until expiry.

## [1.1.3] — 2026-11-17

### Added

- `fullSyncOnStartup`: compare the whole tree when the vault loads instead of
  replaying Drive's events. Off in the app (event replay is cheap and usually
  right); on in the headless daemon, which starts rarely and where a saved
  event cursor that predates a change which then failed to apply would leave a
  settings file stale until the next walk. That is what happened with
  `.obsidian/community-plugins.json`: a pass read the event, the file did not
  change, and no later poll mentioned it — a restart with a full sync fixed it.

## [1.1.2] — 2026-11-17

### Changed

- The headless daemon moved to [ondreu/pss-daemon](https://github.com/ondreu/pss-daemon).
  The community directory's source scan reads every TypeScript file in the
  repository and cannot be told that a Node-only daemon is not plugin code; its
  findings are warnings that lower the listing's review score, and disabling
  its rules is itself an error. The daemon pins this repository as a submodule,
  so the engine is still one implementation and a conflict fix still lands once.
  Nothing in `main.js` changes; the plugin is unaffected.

## [1.1.1] — 2026-11-17

### Fixed

- The community directory rejects a description that contains the word
  "Obsidian" ("implied by the context"), and 1.1.0 was rejected for it. The
  About text now says "your vault and Proton Drive" and still names the
  three-way conflict detection and the headless daemon.

### Added

- `npm run check:manifest` now enforces that rule, so a release cannot repeat
  this. It was the one directory rule the check did not cover.

## [1.1.0] — 2026-11-17

### Added

- **Headless daemon** (`headless/`): the same engine runs on a Linux server,
  without Obsidian. `login`/`status`/`once`/`watch`/`verify`, a Dockerfile and
  compose file, one-process-per-vault locks, redacted logs, encrypted session at
  rest. See the README section and `docs/headless-daemon.md`.
- `resolve-folder` command, which also creates the sync folder with the SDK's
  own ids (a folder made by the Proton CLI cannot be read by this SDK).

### Changed

- **Merge is the default conflict policy.** Concurrent edits of a note are
  combined line by line; a conflict copy appears only when both sides changed
  the same lines, and `keep-both` remains available in settings. In the
  headless daemon the default is the same.

### Fixed

- Sign-in no longer fails with "Destination file already exists!" on a device
  that already holds a session file (shipped as 1.0.1).
- `verify` compares the tree the engine actually syncs: `.git` is not reported
  as untracked, and the device registry files are not reported as remote
  divergence.
- The headless daemon no longer reports a stall while it is idle with nothing
  queued.

## [1.0.0]

First release under the new name. The plugin id changes to `proton-sdk-sync`, so
it installs beside the old one rather than over it; the stored session and the
device id are adopted once on first start, so switching over does not sign you
out.

### Data safety

- Stop and ask before trashing a large share of the vault on Drive, so an
  unmounted card or an emptied folder cannot wipe the Drive copy. Threshold is
  configurable, and the pass resumes once you decide.
- Merging two edits no longer duplicates a line that sits on a span boundary.
- Downloads are written to a temporary file and renamed into place, so a crash
  mid-write cannot leave a truncated note behind.
- A remote folder delete is checked against the nodes before anything is
  removed locally; unverified children are skipped.
- A Drive file whose active revision cannot be decrypted is skipped instead of
  being treated as deleted remotely.
- A file moved out of a folder just before the folder was trashed is no longer
  deleted locally.
- The 2-second self-write hold is replaced by a stat comparison, so real edits
  made right after a download are no longer dropped.
- Files above the size cap are skipped with a reason instead of retried; mobile
  now has a default cap of 200 MB.

### Security

- The session is never written in the clear while a PIN is set: a refresh that
  arrives during lock is kept aside and written, encrypted, at the next unlock.
- An unreadable session file no longer looks like "no PIN": the plugin records
  that a PIN was set, so a torn write or a keychain that is not ready cannot
  turn into a plaintext session.
- A 401 from a captive portal or a proxy no longer signs you out; only a
  rejection that names a dead token does.
- A refresh that a gateway may already have processed is not retried, so a
  timeout cannot present a token Proton has just replaced.
- Only a genuine credential rejection signs out. A timeout, a captive portal or
  a transient network failure retries instead of wiping the session and the PIN.
- PIN envelopes use a higher work factor, wrong PINs back off, and the failure
  count survives a restart. Existing envelopes still open.
- Locking and signing out clear the decrypted key material, and the session
  info listener is no longer registered once per start.

### Reliability

- `stop()` actually stops: in-flight transfers are aborted, the running pass is
  awaited, and a stale pass can no longer overwrite the state file.
- Android sign-in survives the network dropping right after the browser
  approval, and says it succeeded with setup finishing on the next sync.
- One unreadable file no longer fails a whole pass.
- Full sync and connect are single-flight, so two unlock paths cannot start the
  engine twice.
- Conflict choices always keep the losing side as a conflict copy.
- Tapping a pending deletion in the panel no longer recreates the note.
- Windows reserved names in multi-dot file names are renamed correctly, and no
  longer renamed again on every pass.
- Merging very large text files no longer allocates a full LCS table on the UI
  thread.
- A text file that is not valid UTF-8 is kept as a conflict copy instead of
  being merged with replacement characters.
- Exclusion patterns match case-insensitively on case-insensitive filesystems,
  and lookalike spellings of `.obsidian` can no longer slip past the exclusion.
- The settings tab no longer rescans the other plugins in the vault, and the
  plugin no longer reports on them. That belonged to one deployment, not to a
  plugin anyone can install.
