# Changelog

This project continues [obsidian-proton-sync](https://github.com/MarckFp/obsidian-proton-sync).
Releases before 1.0.0 are that project's; its notes are in its own releases.
Entries here describe this fork.

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
  arrives during lock is dropped, and the next unlock fetches a new one.
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
