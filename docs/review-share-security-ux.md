# Share security + UX review (post-PDF-removal)

Branch `feat/pdf-export-share` at `8327436` ("feat: drop PDF export, share any file").
Reviewed the current tree, not the removed PDF path. Gates, all green:
`npm test` 626/626 pass, `npm run lint` clean, `npm run check-types` clean,
`npm run build` clean.

Related: `docs/review-pdf-share.md`, `docs/review-pdf-share-delta.md`.

## 0. What actually changed in this commit

Smaller than the message suggests. `git show HEAD --stat`:
`src/main.ts` (−462/+~85: export renderer flow deleted),
`src/sync/pdfShare.ts` (+2 lines: `deleteOnExpiry?` field),
`src/ui/exportModal.ts` (+14: the delete toggle),
`src/ui/settingsTab.ts` (Sharing group rename).
The PDF-era helpers (`exportPdfName`, `sanitizeExportHtml`,
`selectJanitorDeletions`, `janitorEntryPlan`, `printWebviewToPdf`) and the
old `ShareModal` (1/7/30-day + password) are still in the tree. Several
stale strings below come from that.

## 1. Public-link scope — PASS (one observation)

- The share path re-resolves the vault object and only links the exact
  synced node. `shareFileWithLink` (`src/main.ts:1492`) does
  `vault.getAbstractFileByPath(sourcePath)` and bails with
  `"That file is not in the vault any more."` (`:1495`) for anything not a
  `TFile`.
- The link is created from the sync record of that same path:
  `createNoteShareLink` → `nodeUidOf(path)` (`src/sync/engine.ts:3742,3861`)
  throws `"This note is not on Proton Drive yet; wait for it to sync"`
  unless the record for that exact path is `type: 'file'`. There is no
  path→other-node mapping anywhere in the flow; clipboard and registry use
  the returned access (`buildExportedShare` uses `link.url` /
  `link.expiration`, `src/sync/pdfShare.ts:146-153`).
- Renames: records follow the file (`state.ts:312`); the Drive nodeUid is
  stable across a rename, so `removeShareLinkByNodeUid` still unshares the
  right node. Worst case for a renamed-then-deleted path is a stale registry
  entry whose link is unshared at expiry — safe direction.
- Traversal / crafted registry entries: the janitor trash path goes through
  `vault.getAbstractFileByPath` + `instanceof TFile` (`src/main.ts:1557-1563`);
  a `'..'` or absolute spelling resolves to `null` and is never trashed. The
  manage-modal delete is additionally gated by `isExportPath`
  (`src/main.ts:1459`).
- Stale `nodeUid`: the flow waits for the *current* `nodeUidFor(sourcePath)`
  (`src/main.ts:1504`) and stores `nodeUidFor(sourcePath) ?? nodeUid`
  (`:1518`).
- UI entry points only ever pass vault files: `file-menu` checks
  `file instanceof TFile` (`:1381`); commands use the active file. An
  outside-the-vault path cannot be chosen, and the engine throws for
  unsynced ones. Disk IO elsewhere is spelling-checked by
  `VaultIO.checked` (`src/sync/vault.ts:233`).
- Observation (no finding): `grep symlink src` has zero hits. If Obsidian
  ever indexed a symlink as a `TFile` and the sync uploaded its target
  bytes, the link would expose the target's content. Confinement today rests
  on "indexed + synced + has a state record", which is sufficient in
  practice, but there is no explicit symlink guard to point at.

## 2. Expiry — PARTIAL

- Presets are 7/30/90/custom/never (`src/ui/exportModal.ts:4,61-67`). The
  old `ShareModal` (`.md` notes) still offers Never/1/7/30
  (`src/ui/shareModal.ts:14-19`) — two dialogs, two preset sets; acceptable
  but worth knowing.
- Custom parsing (`exportModal.ts:141-151`) is solid for the common cases:
  trimmed; blank/non-numeric/NaN → `NaN` days → blocked with
  `"Enter a positive number of days, or choose never."` (`:122`); zero and
  negatives blocked; decimals silently floored (`Math.floor`). Exponential
  notation (`1e2` → 100 days) is accepted — obscure, harmless.
- FAIL-adjacent edge, huge numbers: nothing bounds the input. `1e308` passes
  `Number.isFinite`, `shareExpiration` (`pdfShare.ts:129`) builds
  `new Date(overflow)` → **Invalid Date**, which is a truthy object and is
  passed to `shareNode` as `expiration` (`src/main.ts:1507-1508`). Server
  behavior then decides the real expiry while the user saw no error.
  Recommend an upper bound (e.g. reject absurd values in `readCustom` and in
  the `shareExpiryDays` setting validator).
- `never` is honest: no `expiration` key is sent (`:1508`), the registry
  stores `null`, result notice says `"The link never expires."` (`:183`),
  manage list says `"Never expires"` (`:250`).
- Server truth wins: registry and result notice both use the
  server-returned `link.expiration` (`pdfShare.ts:150`, `main.ts:1521-1524`),
  never a recomputed date. Requested-vs-returned is never compared, but since
  only the returned value is displayed/stored, a server clamp cannot mislead.
- Timezone/DST: epoch ms end to end; display via `toLocaleString()` (local
  tz, platform DST-aware). The request computes `now + days·86400000`, which
  can be an hour off across a DST boundary — negligible at day granularity,
  and the server value is what gets stored.
- Real inconsistency: setting `"Default link lifetime"` says
  `"0 means never."` (`src/ui/settingsTab.ts:512`), but the modal maps
  `defaultDays > 0 ? defaultDays : 30` (`exportModal.ts:47`), so `0` preselects
  **30 days**, not never. Either honor `0` as a never-preselect or reword.

## 3. Delete-on-expiry toggle — PARTIAL (defaults PASS, copy FAIL-adjacent)

- Default off in every path: field init `false` + `toggle.setValue(false)`
  (`exportModal.ts:31,101-105`); a fresh modal per share, so no selection
  persists between shares; `shareFileWithLink(sourcePath, days,
  deleteOnExpiry = false)` (`main.ts:1492`); janitor deletes only on strict
  `entry.deleteOnExpiry === true` (`:1556`), so pre-change registry entries
  without the key default to keep. No migration flips it
  (`loadSettings`, `:1188-1195`).
- Label is truthful: `"Delete the file when the link expires"` /
  `"Off by default: only the link expires and the file stays. On: the file
  is moved to the trash at expiry."` (`exportModal.ts:98-100`).
- Janitor confinement is good: `TFolder` → skip (`:1558`); gone file →
  unshare-only; trash failure keeps the entry for retry (`:1565-1567`);
  unshare failure keeps it (`:1574`); trash goes through `fileManager`
  (user's trash preference).
- BUT the settings copy overstates what the manage modal can do:
  `"“Manage shared files” lists every link, with copy, stop sharing and
  delete."` (`settingsTab.ts:508`) and `"…copy a link, stop sharing, or
  delete the file and its link."` (`:524`). In reality the Delete button is
  rendered only for `kind === 'export'` (`exportModal.ts:267-276`) and
  `onDelete` throws for anything outside the export folder (`main.ts:1459`).
  Attachments (every new share) get copy + stop-sharing only. Also the
  command is still named `"Manage shared PDFs"` (`main.ts:1351`) while the
  settings row says `"Manage shared files"`.
- Offline edge: with no connection the janitor still trashes a
  `deleteOnExpiry` file, drops the registry entry, and the link stays live
  until the next sync propagates the delete (`:1552-1580`). Self-healing, but
  "when it expires the link is removed" is briefly untrue while offline.

## 4. Manage shared files modal — PASS (minor notes)

- Copy uses `copyText` (Electron clipboard on desktop, no prompt; web API
  elsewhere — `exportModal.ts:7-21`) with a real fallback:
  `void copyText(entry.url).then(() => new Notice('Link copied.'), () =>
  new Notice('Could not copy the link.'))` (`:254-260`). Edge: if
  `navigator.clipboard` is undefined (non-secure context), `copyText` throws
  synchronously and the `void … .then()` never attaches — uncaught. Wrap the
  call or make `copyText` async.
- Stop-sharing touches only the link (`removeShareLinkByNodeUid`,
  `:1453-1457`); delete is double-gated (kind + `isExportPath`) and throws
  safely into `act()`'s notice (`:283-290`). No path reaches the vault
  without resolving to a live `TFile`/`isExportPath` check.
- Spoofing: the registry is `settings.exportedShares` (plugin `data.json`),
  never synced (`configExclusions`, `src/settings.ts:182-193`), so a synced
  file cannot plant entries. `removeShareLinkByNodeUid` trusts the stored
  uid, but only a local `data.json` edit could abuse that, and only to
  *unshare* — low impact.
- Malformed entries: sanitized at open (`:1443`) and at load (`:1204-1210`,
  counted and warned once). An unvalidated `kind` string falls through to the
  export label, but Delete still hits the `isExportPath` throw → notice, no
  crash. Modal works on a snapshot (`:225`) and removes by identity, so
  concurrent janitor runs can't corrupt its list.
- Nit: `forgetDeletedShare` matches by path only (`:1595`); a renamed share
  that is then deleted leaves a stale entry until expiry (link still
  unshared via stored uid at expiry — self-healing).

## 5. Mobile — PASS (one inconsistency noted)

- Share commands carry no `Platform` gates and appear on mobile as intended:
  `copy-share-link` (`:1332`), `manage-shared-pdfs` (`:1348`), `share-file`
  (`:1362`), and the `file-menu` item (`:1379-1390`, fires on long-press).
- The attachment flow is Electron-free: `ExportPdfModal` is pure Obsidian
  UI; `shareFileWithLink` does state-poll → SDK call → `ShareLinkModal`
  (`:1502-1529`); `copyText` gates Electron behind `Platform.isDesktopApp`
  and falls back to `navigator.clipboard`. `printWebviewToPdf` (`:1635`,
  `window.require('node:os'/'node:fs')`) is dead code with no callers — a
  landmine for future reuse, not a live mobile bug.
- Disconnected engine fails clearly: `"Sign in and wait for the sync to
  connect before sharing."` (`:1498-1501`); the note modal surfaces
  `"Could not check for a link: …"` (`shareModal.ts:60-64`).
- Inconsistency (also §6): `share-file` refuses `.md` files
  (`file.extension === 'md'`, `:1368`) while the context-menu item offers
  sharing for any `TFile` including `.md` (`:1381`). Post-"share any file"
  the command filter looks stale; `.md` goes through `copy-share-link`
  instead, so both work — but via different dialogs.

## 6. Settings/UI text — PARTIAL

- The `"Sharing"` group (`settingsTab.ts:504`) is truthful:
  `"Any file in the vault can get a view-only Proton link… You pick the link
  lifetime in the dialog; when it expires the link is removed. The file stays
  unless you tick “Delete the file when the link expires” there (off by
  default). Deleting a file yourself removes its link too."` (`:508`).
  Conflict-policy row is stacked (`pss-stacked-setting`, `:412`) with merge
  as `"Merge the changes, keep both if they overlap (recommended)"`
  (`:14-16`).
- Stale PDF-export wording still shown to users:
  - command `"Manage shared PDFs"` (`main.ts:1351`; id `manage-shared-pdfs`);
  - `SharedPdfsModal` heading `"Shared PDFs"` (`exportModal.ts:239`) and row
    label `` `PDF export · ${expiry}` `` (`:253`) — accurate for legacy
    entries, wrong air for new ones (new shares do pass
    `kind: 'attachment'`, `main.ts:1518`, so they render `"Attachment · …"`);
  - `ShareLinkModal` heading `"PDF shared"` (`:165`) and
    `` `The link and the PDF expire …` `` (`:184`) — shown for **every new
    attachment share** (`main.ts:1521`), the most user-visible leftover;
  - `ExportPdfModal` defaults (unused by the one caller, but latent):
    `"Export to PDF and share"` (`:52`),
    `"…will be exported to the export folder and shared… The PDF is deleted
    when the link expires."` (`:56`), confirm `"Export and share"` (`:115`);
  - `waitForExportNodeUid` timeout still says
    `"the exported PDF has not synced to Proton Drive yet"` (`main.ts:1690`),
    shown when *any* file hasn't synced.
- `"0 means never"` (`settingsTab.ts:512`) is contradicted by the `0 → 30`
  preselect mapping (§2).

## 7. Privacy — PASS

- Off-device surface is minimal: file bytes reach Proton only through the
  normal sync upload; sharing sends nodeUid + optional password/expiry to
  `shareNode` (`src/sync/drive.ts:489-502`). Nothing else (no analytics,
  no third party). The `#`-fragment key comment
  (`shareModal.ts:32-35`) is accurate for these links.
- Password lives in a modal-local variable, sent once, never persisted or
  logged. No `logger.*` call anywhere takes a URL (`grep` §7: only
  `"${entry.path}"` in janitor warns, `main.ts:1565,1574`).
- Paths are redacted by default: `logShowsNames` defaults `false`
  (`settings.ts:98`); `Logger.write` always redacts unless the user opts in
  (`src/util/logger.ts:231-232`); node uids → `«node»` (`:103`). The link
  itself is Proton-hosted and correctly *not* treated as a name, but it is
  never written to the log — it only appears in modal inputs and the
  clipboard. `copyLog` warns honestly:
  `"Sync log copied. It lists file names; check it before sharing."`
  (`main.ts:752`).
- Status bar / sync panel / sync status reference no link or URL (no hits).

## Recommended fixes (no code changed)

1. `ShareLinkModal`: `"PDF shared"` → file-shared wording; `:184` → "The
   link expires …" without "and the PDF".
2. Rename command `Manage shared PDFs` → `Manage shared files` (name + id).
3. Decide `shareExpiryDays = 0`: honor as never-preselect in `ExportPdfModal`
   or drop `"0 means never"`.
4. Bound custom days (and the setting validator) — reject values whose
   `new Date()` is invalid.
5. Reword settings `:508/:524` — delete is export/legacy-only, attachments
   get copy + stop-sharing; or extend Delete to attachments (with the same
   `TFile`-confinement the janitor already uses).
6. Leftovers: `ExportPdfModal` defaults, `waitForExportNodeUid` message,
   dead `printWebviewToPdf`/`selectJanitorDeletions`/`janitorEntryPlan`,
   `share-file` `.md` exclusion vs file-menu.
