# Data-loss / correctness review: `feat/pdf-export-share` @ `8327436` (PDF export removed)

Scope: branch `origin/feat/pdf-export-share`, HEAD `8327436` ("drop PDF export, share
any file"). PDF rendering/export is gone from `src/main.ts`; sharing now covers any vault
file with an opt-in per-share `deleteOnExpiry` (default off). `src/sync/pdfShare.ts` is
almost unchanged (comment + `deleteOnExpiry?: boolean` only). No fixes applied, nothing
pushed. Prior reviews `docs/review-pdf-share.md`, `docs/review-pdf-share-delta.md` were
read; this review re-verifies the CURRENT code, not the old export flow.

Gates (all `PATH=/opt/data/toolchain/node24/bin`): `npm test` **626/626 pass**
(`tests/pdfShare.test.ts` still 35 `it(`, **zero cover `deleteOnExpiry`** — the one new
field is untested). `npm run lint`, `npm run check-types`, `npm run build` clean.

41 executed probes (scratch file outside the repo, esbuild-bundled, deleted afterwards):
**41/41 pass**. Pure-function behavior below is probed; vault/Drive behavior is
code-reading marked as such.

## 1. Janitor (`runShareJanitor`, `src/main.ts:1536-1591`) — PARTIAL

Default-off holds, verified three ways: the trash gate is strict
`entry.deleteOnExpiry === true` (`:1556`; probed `"yes"`/`1` do not match);
`buildExportedShare` never sets the key (`pdfShare.ts:140-153`, probed `'deleteOnExpiry'
in built === false`); the dialog toggle defaults to `false` (`exportModal.ts:31,103`).

What does NOT hold:

- **No folder confinement at all.** The old janitor trashed only entries strictly inside
  the export folder (`selectJanitorDeletions` + `janitorEntryPlan` — both now dead in
  prod, see §5). The new janitor trashes **any vault path** whose entry carries the flag
  (`:1556-1568`, no `isExportPath`/`normalizeVaultPath` call anywhere in the function).
  The trash authorization is a boolean in the same `data.json` an attacker/forgery would
  already need to write — i.e. the guard and the target live in one untrusted bit.
  Repro: hand-write `{path:'Notes/precious.md', url, nodeUid, expiresAt:<past>,
  deleteOnExpiry:true}` into `data.json`, reload, wait a day/boot → `precious.md` is
  trashed. (`data.json` is local-only — `configExclusions` keeps the plugin dir out of
  sync, `settings.ts:182-193` — so this needs local file write, not a synced file. The
  previous review's "synced file cannot forge entries" half still holds.)
- **Unshare-by-uid is fully unconfined and unconditional on path.** Every well-formed
  due entry is unshared when connected (`:1570-1577`), whatever its `path` —
  `'Notes/../secret.md'`, `''`, `'/'`, garbage — lookup failure only skips the *trash*.
  A forged entry can therefore kill an arbitrary Drive link by uid at expiry.
- Failure handling is otherwise right: trash failure → `continue`, entry kept for next
  run (`:1562-1567`); unshare failure → `continue`, entry kept (`:1571-1576`) — note
  the file is *already trashed* at that point, so next run retries unshare with the
  file gone (`getAbstractFileByPath` → null → skip trash → unshare → drop). Converges.
- Vault-root/empty/`.` paths cannot trash anything: `getAbstractFileByPath('')` returns
  null (code-reading; Obsidian API behavior, unverified headless) → trash skipped,
  unshare still fires. Safe direction.
- Absolute paths (`'/abs.md'`) and `'C:/x'` (probed: passes `normalizeVaultPath`, but the
  janitor never calls it) resolve to null in the vault → no trash. Containment rests on
  the Obsidian lookup, not on any check in the function.
- `TFolder` at an entry path → bare `continue` (`:1558-1559`): the entry is **never
  unshared and never removed** — retried every run forever (registry leak + immortal
  link). Reachable: share a file, replace it with a same-named folder before expiry.
- Offline (`!connected`) entries are **dropped from the registry without unsharing**
  (`:1570,1578`): a trashed file's link dies via trash propagation, but a kept file's
  link (`deleteOnExpiry` unset/false) stays live on Drive with no registry entry left —
  link-lifetime leak. Pre-existing behavior, unchanged.
- Malformed entries are dropped without touching Drive/vault in the `due.length === 0`
  path only; when other entries are due, malformed ones linger silently until a
  no-due run persists the cleaned registry. Trivial.

In short: the "never deletes by default" half of the spec holds; the "cannot reach the
wrong file" half regressed vs the old folder-confined janitor.

## 2. Registry validation (`ExportedShare`, `pdfShare.ts:170-204`) — PASS with notes

`sanitizeExportedShares` runs on load (`main.ts:1204`), every janitor run (`:1537`) and
every manage-modal open (`:1443`); each call wraps drops in `onInvalid`, never throws.
Probed: `{}`, `null`, `undefined`, non-array, `[null, 42, 'x', {}]`, `NaN`/`Infinity`/
string/missing `expiresAt`, missing `path`/`url`/`nodeUid` → all dropped, no throw;
200 k-entry array sanitizes + filters in ~17 ms. `deleteOnExpiry` and `kind` are
deliberately unchecked — safe only because the janitor compares `deleteOnExpiry === true`
strictly (a forged `"yes"`/`1` does not trash; probed) and ignores `kind` entirely.

Notes: an entry with `deleteOnExpiry: true` and *any* vault-relative path (including
outside any folder) **passes** validation (probed `Notes/precious.md` + flag → valid) —
validation was never the barrier, and §1 shows there is no other barrier. An entry
missing `expiresAt` is dropped rather than treated as never-expire: fail-closed for
deletion, link-lifetime leak for hand-written JSON. Negative/zero numeric `expiresAt`
is immediately due (`selectExpiredShares`: `<= now`, probed `0`/`-5` due, `null` never,
exactly-now due) — forged past dates unshare/trash at the next run, not a safety issue.

## 3. Share flow (`shareFileWithLink`, `src/main.ts:1492-1529`) — PASS

- Stale/wrong `nodeUid` cannot be registered for a different path: the registry pins
  `runtime.engine.nodeUidFor(sourcePath) ?? nodeUid` **re-read after** the share call
  (`:1518`), and the link itself is created path→uid inside the engine
  (`engine.ts:3743,3755-3759`). A remap between `createNoteShareLink`'s internal
  `nodeUidOf` and the re-read is single-threaded-negligible; a rename mid-flow makes
  `nodeUidOf` throw → error notice, no share, no registration.
- The registry/notice use the **returned link's** expiry (`link.url`,
  `link.expiration?.getTime() ?? null`, `:1521-1524`) — the old reused-link/computed-date
  defect is gone with the reuse path. `link.hasPassword` aborts before registering
  (`:1512-1515`); the pre-existing live-link leak there is unreachable through this flow.
- Expiry 0/never: dialog `never` → `null` → `shareExpiration(0)` → `undefined` → no
  expiration → `expiresAt: null` → janitor never due. Dialog rejects non-positive custom
  days (`exportModal.ts:121,143-149`); negatives exist only via hand-written JSON (due
  immediately — fail-closed, §2).
- Not-synced-yet file: `waitForExportNodeUid` polls `nodeUidFor` up to 30 s (`:1682-1697`).
  Paused sync / excluded path / never-synced file → 30 s wait → error notice. **No orphan
  is possible** (nothing is written before the share), so the removed
  `exportPrecheckRefusal` gate (now dead in prod, §5) is not missed for safety — only a
  30 s-hang UX papercut.
- Link creation throwing after any Drive-side change → `catch` → notice, registry
  untouched (`:1526-1528`): no unregistered-live-link entry is written by this path.
- `saveSettings` failing after a successful share (`:1520`) leaves the entry in memory
  but not on disk → restart loses it → live link the janitor will never clean.
  Pre-existing, minor, link-lifetime only.

## 4. Hand-deletion cleanup (`forgetDeletedShare`, `src/main.ts:1594-1610`) — PASS with notes

Still wired to **every** vault `delete` (`:1355-1360`, separate from the sync's own
delete handler at `:1720-1728`), so it runs for hand deletions **and** for the janitor's
own trash. Convergence verified by reading: janitor removes the entry by reference and
`forget…` finds nothing (no-op), or `forget…` unshares/removes first and the janitor's
`filter(item => item !== entry)` becomes a no-op save — either order ends clean.

- Identity is by **path**, so uid-reuse across delete+recreate cannot unshare the wrong
  node: a recreated file gets a fresh entry/uid, and the lookup (`find(item.path)`)
  only ever touches the entry for that path.
- Rename **strands** the entry: `rename` events go only to `engine.onVaultRename`
  (`:1729-1733`); `forgetDeletedShare` is not called. Harmless: at expiry the old path
  resolves to null → no trash even with the flag → uid unshared → entry dropped. The
  renamed file keeps its bytes; its link lives until the recorded expiry.
- Delete→recreate→re-share inside the `void` async gap could make `forget…` drop the
  *new* entry and unshare the *new* link. Genuine TOCTOU, negligible probability
  (requires user action inside one microtask window), noted for completeness.
- Entry removal is best-effort-broad: removed even when the unshare throws (`:1599-1604`),
  and also removed by janitor expiry, modal stop/delete, and cap eviction — i.e. "always
  removed when the file is gone" holds only while the plugin is running; files deleted
  while Obsidian is closed linger until expiry (then cleaned as "gone").

## 5. Removal completeness — PARTIAL (safe direction, untidy)

No live path can still produce, render, or share a PDF: `exportNoteToPdfAndShare`,
`shareExportedPdf`, `renderNoteToPdf`, `inlineEmbeds`, `ensureExportFolder`,
`mimeForExtension`, `expireAttachmentShares`, `runExportJanitor`, `openExportModal` are
fully gone; the `export-pdf-share` command and both `md`-only gates are gone (any
`TFile` now shares, `main.ts:1381`). Old `kind: 'export'` entries behave sanely: the new
janitor ignores `kind`, and with `deleteOnExpiry` unset only the link is removed at
expiry — the file is kept. That is the intended migration, verified by reading
`:1554-1578`.

Leftover, dead or stale (cosmetic except where noted):

- Dead in production but tested: `resolveExportPath`, `exportPdfName`,
  `formatExportStamp`, `effectiveExportFolder`, `exportPrecheckRefusal`,
  `janitorEntryPlan`, `selectJanitorDeletions`, `sanitizeExportHtml`,
  `buildPdfPrintScript`, `copyToArrayBuffer` (`pdfShare.ts`) — no caller in `src/`,
  all still covered by `tests/pdfShare.test.ts`. Harmless; either delete or keep as
  tested utils, but `janitorEntryPlan`/`selectJanitorDeletions` *looking* like the
  janitor's guards while the janitor uses neither is actively misleading for §1.
- Stale references: `main.ts:276` ("see runExportJanitor", nonexistent);
  `:1431-1439` docstring ("Only the exported PDF ever gets a public link…") above
  `openSharedPdfsModal`; `:1479`, `:1612`, `:1613-1628` orphaned comment blocks;
  `:1700-1714` old-janitor docstring ("Only registry entries strictly inside the export
  folder are ever touched") now sitting above `registerVaultEvents` — it describes a
  guarantee the new janitor does **not** provide.
- Stale user-facing strings: command `manage-shared-pdfs` / "Manage shared PDFs"
  (`:1348-1353`); `ShareLinkModal` "PDF shared" + "The link and the PDF expire"
  (`exportModal.ts:165,184`); `SharedPdfsModal` "Shared PDFs" / "PDF export · …"
  (`:239,253`); `waitForExportNodeUid` name + "the exported PDF has not synced"
  (`main.ts:1682-1693`); `ExportPdfModal` default title/intro (dead in practice —
  `openShareFileModal` always overrides); `EXPORT_*` constant names. No behavior impact.
- Inverted strictness, worth one decision: the manage modal's Delete requires
  `kind === 'export'` (`exportModal.ts:262`) **and** `isExportPath(exportFolder, …)`
  (`main.ts:1459-1461`) — so attachments (the only kind the new flow creates, and the
  only entries the janitor can trash) have **no manual-delete path** in the UI; only the
  janitor or hand-deleting the file reaches them. Meanwhile the janitor requires neither.
  And `isExportPath('', …)` is always false (probed) — a blank `exportFolder` setting
  makes the modal Delete always throw.

## 6. Settings (`settings.ts:108-121,242-246`) — PARTIAL (intended change, silent)

`exportFolder` (default `'Exports'`) and `autoDeleteExpiredExports` (default `true`)
still exist, still load/save (`Object.assign({}, DEFAULT_SETTINGS, stored ?? adopted)`,
`main.ts:1195`), still have no UI. An old `data.json` loads fine; malformed registries
are sanitized at load (`:1204-1210`).

Behavioral consequences, both intended-but-unannounced:

- `autoDeleteExpiredExports` is **read nowhere** (only `settings.ts` + its test assert).
  A user who opted *in* to auto-delete now silently gets keep-everything: their old
  entries lack `deleteOnExpiry`, so expired links are removed and files kept. Per the
  commit message this is the point ("the janitor no longer deletes by default"), but
  there is no migration, no notice, and the default value `true` still suggests
  otherwise to anyone reading `data.json`.
- `exportFolder` is read only by the modal Delete guard (`main.ts:1459`). It no longer
  scopes anything destructive — the janitor does not consult it.

## Suggested fixes (not applied)

1. Re-scope the janitor's trash: refuse entries that fail `normalizeVaultPath`, and —
   if any folder scoping is still desired — re-use `isExportPath`; at minimum never
   trash `''`/absolute/`..` spellings explicitly rather than relying on the vault lookup
   returning null. Consider requiring the flag *and* a path check so one forged bit is
   not sufficient.
2. Either confine unsharing (skip due entries whose path is not a valid vault path) or
   document that any `data.json` writer can unshare arbitrary uids by design.
3. `continue` on `TFolder` leaks the entry forever — drop the entry (after unsharing when
   connected) instead of skipping it.
4. Offline janitor runs should keep due entries (retry when connected) rather than
   dropping them un-unshared — or record that "expiry while offline = link lives on"
   is accepted.
5. Migrate or announce: set `deleteOnExpiry` from the old `autoDeleteExpiredExports`
   for pre-existing `export` entries, or notice that auto-delete is gone; stop shipping
   the dead `autoDeleteExpiredExports: true` default.
6. Delete the dead helpers (or at least `janitorEntryPlan`/`selectJanitorDeletions`,
   which imply confinement the janitor lacks), fix the `:1700-1714` and `:276`
   comments, and rename the user-facing "PDF" strings.
