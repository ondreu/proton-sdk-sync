# Fix plan for 1.0.0

> **Status: done.** Every item below was implemented and tested before 1.0.0;
> `CHANGELOG.md` lists the user-visible result. The file is kept as the record
> of what was known to be wrong in 0.11.5 and why each change was made.

Source: issue #40 (external review of 0.11.5), issue #41 (Android sign-in), and
the audit notes kept outside the repo. Line numbers refer to 0.11.5 and are
only a hint: find the code by name.

Rules for every item:

- Behaviour first, then a test that fails without the fix. Tests use
  `node:test` and the existing harness in `tests/support/`.
- No new runtime dependencies. No API breaks outside the files you own.
- Keep the comment style: say why, in plain prose, no marketing.
- Do not touch files owned by another workstream. If a fix needs one, say so in
  your report instead of editing it.

Severity: H = data loss or security, M = wrong behaviour, L = polish.

## H — data loss, security

**F01 (H) Mass-delete guard.** Every recorded file missing locally becomes
`delete-remote`, with no limit or prompt. An unmounted SD card, an evicted
cloud folder or a vault emptied outside Obsidian then trashes the whole Drive
folder, and every other device follows.
Files: `sync/reconcile.ts`, `sync/engine.ts`, `settings.ts`, `ui/settingsTab.ts`.
Do: count planned deletions per pass. Above a threshold (setting
`massDeleteThreshold`, default 25, 0 = off) do not delete. Hold the pass, keep
the planned list, and surface it: engine summary gets `pendingMassDelete`
(count + up to 50 paths), a modal lists them with **Trash on Drive**,
**Keep on Drive (restore locally)** and **Not now**. The same guard applies to
`cleanUpDeletedFolders`. The decision must not be re-asked every poll: keep it
until the state changes. Test: 300 tracked files, 200 vanish locally → zero
delete calls, `pendingMassDelete.count === 200`; after approval the deletes
run; with threshold 0 the old behaviour returns.

**F02 (H) Merge duplicates inserted lines.** base `a b c d`, local `a B C d`,
remote `a B C Y d` → `a B C Y Y d`, reported as merged. The projection counts
an insertion sitting at a span boundary twice.
Files: `sync/merge.ts`, `sync/diff.ts`. Do: half-open spans, assign boundary
insertions to exactly one side. Test: the case above, plus the symmetric one
and one with two adjacent insertions.

**F03 (H) `stop()` does not stop a running pass.** It nulls the abort
controller, so later transfers get no signal; `fullSync`/`reconcileAll` do not
check `running`; `onunload` does not await. On reload mid-sync the old and new
engines run side by side and the old `state.flush()` can overwrite the new
state file.
Files: `sync/engine.ts`, `sync/state.ts`, `main.ts` (only the `onunload` body —
coordinate with the UI workstream, do not touch anything else there).
Do: keep the controller alive until the pass ends, abort it on stop, await the
pass, add a generation counter so a stale pass cannot write state, and make
`state.flush()` a no-op after `state.close()`. Test: start a pass, stop it,
assert no further writes and that a stale flush is dropped.

**F04 (H) Exclusion bypass via lookalike names.** `aliasKey` only lowercases, so
`.obſidian` (U+017F), `.obsıdian` (U+0131) and `OBSIDI~1` pass `isExcluded` but
resolve to `.obsidian` on macOS/Windows. In a shared vault an editor can push
`plugins/x/main.js`.
Files: `sync/paths.ts`. Do: compare on a folded key — NFKC, then full case
folding (use `toUpperCase().toLowerCase()` and also map the long-s/fdotless-i
family), strip trailing dots and spaces — and treat any `~<digits>` 8.3 segment
as unstorable on Windows. Test all four spellings plus a legitimate
`.obsidianian` that must still sync.

**F05 (H) No size cap on mobile.** `mobileMaxFileSizeMb` defaults to 0 and the
code reads, hashes and downloads whole files (~2× for a download). A 1–2 GB
video crashes the app on every retry.
Files: `settings.ts`, `sync/vault.ts`, `sync/drive.ts`. Do: default the mobile
cap to 200 MB, check `stat.size` before reading anything, and mark oversized
files `skip` with a reason instead of retrying. Add the same cap for desktop
behind `maxFileSizeMb` (default 0 = off). Test: a 300 MB file on mobile is
skipped without a read; raising the cap syncs it.

**F06 (H) Session written in clear after PIN lock.** `PinProtectedSlot.write`
writes plaintext whenever `unlocked` is null, even if a PIN envelope is stored.
A token refresh finishing after `lockNow` replaces the envelope with plaintext.
Files: `proton/pinLock.ts`. Do: with a PIN set and the slot locked, `write`
must not store plaintext — refuse (throw a typed error) and let the caller drop
the update, or keep the value in memory only. Test: lock, write, assert the
stored bytes still start with the envelope and contain no token.

**F07 (H) Any refresh 4xx signs out.** Everything but 429 — including 408 and a
captive-portal 403 — wipes the session and the PIN, without revoking and
without telling `main`, so the engine keeps a dead client.
Files: `proton/account/apiClient.ts` (vendored, keep the diff minimal),
`proton/session.ts`. Do: only 400 `invalid_grant`, 401 and 403 `invalid_credentials`
sign out. 408/429/5xx and network errors retry with backoff. On a real sign-out,
notify the owner through the existing callback so the engine stops. Test: 403
from a captive portal keeps the session; 401 `invalid_grant` clears it and
fires the callback once.

## M — wrong behaviour

**F08 (M) "Keep this device" / "Keep Drive" act on one click** and use
`keepConflictCopies`, which stays off after switching to "Ask". Keep Drive can
drop unsynced local edits with no copy.
Files: `sync/engine.ts`, `ui/conflictsModal.ts`. Do: always keep a conflict copy
of the losing side when it differs, independent of the setting; require an
explicit confirm for the destructive choice.

**F09 (M) `openFile` creates notes.** `openLinkText` creates a missing note, so
tapping a pending deletion recreates it empty; `#`/`^` in names open the wrong
file.
Files: `main.ts`, `ui/syncPanel.ts`. Do: `getFileByPath` then `leaf.openFile`,
else a notice.

**F10 (M) `windowsName` renames the wrong segment.** It checks the first dot
segment but suffixes before the last one: `aux.tar.gz` →
`aux.tar (renamed for Windows).gz`, renamed again every pass.
Files: `sync/paths.ts`. Do: check and rewrite the same segment. Test
`aux.tar.gz`, `con.txt`, `nul.tar.gz.bak`.

**F11 (M) Non-atomic writes.** Files ≤32 MB on desktop, and all files on mobile,
are written in place; a crash mid-write leaves a truncated note that then
uploads or merges.
Files: `sync/vault.ts`. Do: write every download to a temp file in the plugin
folder, fsync where available, then rename over the target. Test: simulate a
crash between write and rename, assert the target is untouched.

**F12 (M) Remote folder delete trusts the listing.** A remote folder delete marks
every recorded child absent without checking nodes; a file moved out just before
the trash is deleted locally until the next walk.
Files: `sync/engine.ts`. Do: verify children against the tree; unverified
children go to `skip`, not `delete-local`.

**F13 (M) Undecryptable revision is treated as a remote delete.** A listed file
with no decryptable active revision is dropped from `tree.files`, then looks
deleted remotely → `delete-local`.
Files: `sync/drive.ts`, `sync/engine.ts`. Do: keep it and mark `skip`.

**F14 (M) No per-item error handling** in `followRemoteMoves`, `syncFolders`,
`settleTree`; one EBUSY rename on Windows fails every full sync at the same
point.
Files: `sync/engine.ts`. Do: catch per item, record a per-file failure, continue.

**F15 (M) The 2 s self-write hold drops real edits** made right after a
download. Compare the fresh stat with the one written instead of a timer.
Files: `sync/vault.ts`, `sync/engine.ts`. Do: drop the timer; compare
size+mtime+ino where present.

**F16 (M) PIN is cheap to attack.** 6 digits with PBKDF2 600k is about 1.5
CPU-days for the whole keyspace, minutes on a GPU; `PinFormModal` verified
without backoff and the failure counter reset on restart.
Files: `proton/pinLock.ts`, `ui/pinModals.ts`. Do: keep the 6-digit minimum but
raise the work factor to 1,000,000 (the envelope records it, so old ones still
open), add exponential backoff per failure (1 s → 30 s), and persist the
failure count with a timestamp next to the envelope.

**F17 (M) Lock/sign-out does not clear decrypted keys**, and every
`session.init()` adds a `sessionInfoChanged` listener that is never removed.
Files: `proton/session.ts`, `proton/credentials.ts`. Do: clear keys on lock and
sign-out; register the listener once (or remove it).

**F18 (M) Full LCS table.** 5000 lines ≈ 100 MB `Uint32Array`, synchronous on the
UI thread.
Files: `sync/diff.ts`, `sync/merge.ts`. Do: cap the table and fall back to a
linear-space Myers diff above the cap (e.g. 2000 lines). Test: 20k-line merge
finishes under a second and still merges correctly.

**F19 (M) Non-UTF-8 text is decoded with `fatal: false`** and BOM stripped, so a
cp1252 `.txt`/`.csv` merges with U+FFFD.
Files: `sync/conflicts.ts`. Do: decode with `fatal: true`; on failure treat the
file as binary (keep-both, no merge). Test with a cp1252 byte sequence.

**F20 (M) `connect` / `engine.start` are not re-entrant.** Two unlock paths at
once start the engine twice and the second `sweepDownloads` can delete the first
pass's temp download.
Files: `main.ts`, `sync/engine.ts`. Do: single-flight promise guards.

**F21 (M) Panel and pendingChanges recompute on every vault `modify` and every
progress tick**; `.obsidian` is walked every 30 s poll. Noticeable on mobile.
Files: `sync/engine.ts`, `ui/syncPanel.ts`, `main.ts`. Do: memoise per state
generation, skip the rebuild when the rendered value is unchanged.

**F22 (M) Mobile header actions are not removed on unload**, so they duplicate
after an update.
Files: `main.ts`. Do: register their removal.

**F23 (M) "Rebuild sync state" has no confirmation.**
Files: `ui/settingsTab.ts`. Do: confirm modal, naming what is lost.

## L — polish (do the cheap ones, skip if risky)

**F24** Device request `at` is unbounded; clamp to `Date.now() + 24 h`.
**F25** Session saves are not serialised; an older token set can win. Serialise.
**F26** Sign-in reports failure after the session was already saved; say it
succeeded and that setup finishes on the next sync (#41).
**F27** Changing the log level only affects the root logger.
**F28** User exclusion patterns are case-sensitive; on Windows/macOS/iOS they
should not be.
**F29** Size+mtime quick check misses edits on FAT/exFAT (2 s resolution); also
compare ctime where available.
**F30** Backward clock jumps delay the daily walk and retries; use a monotonic
clock where the platform has one.
**F31** A remote move into an excluded path re-uploads the file at the old path.
**F32** `createImageBitmap` on huge images can exhaust memory; cap dimensions.

## #41 — Android sign-in

Network errors after the browser approval end the sign-in, although the session
was already saved. Retry network errors with a short backoff in the polling loop
(`proton/account/auth.ts`) and in the post-approval steps
(`proton/account/session.ts`); if they still fail, keep the session and say it
succeeded with setup finishing on the next sync. Files: `proton/` workstream.
