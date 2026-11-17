# Adversarial review: `feat/pdf-export-share` (1cd6fbd)

Scope: branch `origin/feat/pdf-export-share`, single commit `1cd6fbd`
`Add desktop-only export note to PDF and share`. main untouched.
Diff: 7 files, +684 (`src/main.ts` +251, `src/sync/pdfShare.ts` new,
`src/settings.ts`, `src/sync/engine.ts` +17, `src/ui/settingsTab.ts`,
`styles.css`, `tests/pdfShare.test.ts`). Reviewed against the spec in the
task; no fixes applied, nothing pushed, branch unmodified.

## Verified baseline (all run with `PATH=/opt/data/toolchain/node24/bin`)

- `npm test`: **610 tests / 174 suites, 610 pass, 0 fail.**
- `tests/pdfShare.test.ts` contributes **19 `it(` blocks** (counted with
  `grep -c`), all passing inside the 610. Claimed coverage matches reality.
- `npm run lint`: clean. `npm run check-types`: clean. `npm run build`: clean.
- 20 extra adversarial probes (path confinement, expiry edges, unicode,
  reuse, injection surface) were run from a scratch file outside the repo via
  the repo's own esbuild test pipeline: **20/20 pass**, then deleted.

## Verdicts per risk

### 1. No public link except for the exported PDF — PASS (with one stale-uid caveat)

- `src/main.ts:1445-1451`: the share path is `exportPath` only. Both
  `noteShareLink(exportPath)` and `createNoteShareLink(exportPath, …)` resolve
  path → node inside the engine (`src/sync/engine.ts:3728-3735` via
  `nodeUidOf`, `3852-3857`, which throws unless the record is a synced file).
  The polled `nodeUid` (`1445`, from `nodeUidFor`, `3746-3749`) is **not**
  passed to the share calls — it is only stored in the registry — so a stale
  uid cannot redirect a share onto another node.
- Caveat (PARTIAL, low severity): the registry's `nodeUid` is captured
  *before* the share (`1445` → `1463-1468`). If the path's record is remapped
  between the poll and the share (rename/delete + recreate race), the registry
  pins the old uid while the live link belongs to the new node. The janitor
  then unshares the wrong (possibly unrelated) uid. Repro: export, and in the
  ms between `waitForExportNodeUid` resolving and `createNoteShareLink`
  running, replace the export path's sync record (delete + same-name recreate
  + fast sync). Registry holds uid A, link lives on node B.

### 2. Link reuse without node identity — FAIL

- `src/main.ts:1447-1451` + `src/sync/pdfShare.ts:102-104`:
  `pickShareTarget` returns `'reuse'` for **any** non-null link. No comparison
  of node uid, expiration, or password against the registry or the new
  settings.
- Consequences:
  - An existing password-protected link is reused silently; the notice still
    says "Share link copied", and the recipient is password-blocked.
  - An existing link with an *older/different* expiry is reused, but the
    registry is overwritten with the **newly computed** `expiresAt`
    (`1463-1467`) and the notice announces the **new** expiry (`1454-1458`).
    The notice can state an expiry the real link does not have (link dies
    early while the user believes it is shared, or janitor deletes late/early
    relative to the real link).
- Repro (unit level, no Drive needed): `pickShareTarget({url, hasPassword:
  true, …})` → `'reuse'`; `upsertExportedShare` then stamps the new
  `expiresAt` over it. The function provably ignores everything but nullness.
- Mitigating factor: in the normal flow `existing` is almost always null,
  because `resolveExportPath` (`72-91`) always returns a non-existent path, so
  the same-path link rarely exists. The reuse branch is near-dead code — but
  where it fires, it is wrong.

### 3. Janitor path confinement — PARTIAL (prefix check bypassable, unshare unconfined)

- `src/sync/pdfShare.ts:116-119`: `isExportPath` is a raw
  `path.startsWith(folder + '/')`. Verified by execution:
  - `Exports2/x.pdf` → refused. `Notes/precious.md`, `../outside.pdf`,
    `/Exports/a.pdf`, `exports/a.pdf` (case), `Exports\a.pdf` → refused. Good.
  - **`Exports/../secret.md` → accepted** (starts with `Exports/`). The
    check does not normalize `..`, `.`, or `//` in the *entry path*, and
    `normalizeExportFolder` (`41-43`) strips only leading/trailing `/` —
    `Exports/../Secrets` passes through verbatim (probed). If
    `vault.getAbstractFileByPath` normalizes `..` (unverified headless), a
    hand-crafted registry entry escapes the folder; if it returns null, the
    trash is a no-op **but the unshare still fires** (see next point).
- `src/main.ts:1552-1558`: `removeShareLinkByNodeUid(entry.nodeUid)` is
  **not path-confined at all**. Any `nodeUid` string in `data.json` is
  unshared once its entry is due and path-confined. `data.json` is local
  plugin data (not vault-synced — `configExclusions` keeps the plugin dir out
  of sync, so a synced file cannot forge entries: that half of the spec
  holds), but anyone/anything that can write `data.json` can unshare an
  arbitrary Drive node and, combined with a same-folder path, trash an
  arbitrary vault file inside the export folder (e.g. folder set to `Notes` +
  entry `Notes/precious.md` → trashed).
- Orphaning (correctness, no data loss): entries are matched against the
  *current* folder string. Renaming `Exports` → `Archive`, or a case-only
  change `Exports` → `exports`, strands old entries: never cleaned, links live
  past expiry (probed: `selectJanitorDeletions([Exports/old.pdf], …, 'exports')`
  → `[]`). Fail-open for link lifetime, fail-closed for deletion — safe
  direction, but a link-lifetime leak.
- Malformed registry: no schema validation on load (`main.ts:1176-1183` trusts
  `data.json`). `exportedShares: {}` → `.filter` throws inside the janitor;
  entries with `path: undefined` → `startsWith` throws. `runExportJanitor` is
  invoked `void` (`~261`, `~415`), so this becomes an unhandled rejection and
  the janitor silently stops working. Repro: set
  `{"exportedShares": {}}` in `data.json`, reload, wait a day/boot — expired
  exports are never cleaned, no error surfaces.

### 4. Trash destination contradicts spec — FAIL (spec vs code)

- Spec: expired PDFs go to **Obsidian trash, never system trash**.
- Code `src/main.ts:1560-1567` uses `this.app.fileManager.trashFile(file)`
  with the comment *"so the user's deletion preference (Obsidian trash,
  system trash) is honoured"* — i.e. system trash is explicitly possible.
  Direct contradiction; either the spec or the call must change.

### 5. Expiry math — PASS with notes

- `shareExpiration` (`97-99`): `days > 0 ? now + days*86400000 : undefined`.
  `0` and negatives → never expire (settings UI additionally clamps `≥ 0`,
  `settingsTab.ts` validate). Exactly-at-expiry counts as expired (`<=`,
  `107-109`; probed). Negative-via-`data.json` fails open to never-expire
  (safe direction, link-lifetime leak at worst). Fractional days scale
  linearly (0.5 d = 12 h). Fixed-ms days drift ~1 h across DST vs calendar
  days — immaterial for a share link, notice uses `toLocaleString()`.

### 6. Webview script injection — PARTIAL (string layer safe, DOM layer not)

- What the branch proves: `buildPdfPrintScript` (`164-174`) embeds title and
  HTML via `JSON.stringify`, so note content **cannot break out of the JS
  string** into the `executeJavaScript` payload (`main.ts:1505`). The branch
  test asserts exactly this, and it holds (re-verified with
  `<img onerror>` / `"` payloads).
- What that does **not** cover: the payload assigns the HTML to
  `document.body.innerHTML`. Any `onerror`/`onload`/`javascript:`-URL markup
  surviving `MarkdownRenderer.render` executes **inside the webview**, which
  is created with `webview.setAttribute('nodeintegration', '')`
  (`main.ts:1501`) — a boolean attribute whose presence enables Node in the
  guest — loading privileged `app://obsidian.md/help.html` (`1500`) as its
  origin. Probed: `<img src="x" onerror="alert(1)">` and
  `<a href="javascript:…">` survive JSON embedding byte-for-byte into the
  `innerHTML` assignment, i.e. the claimed barrier is at the wrong layer.
- Exploitability hinges on whether `MarkdownRenderer.render` strips event
  handlers/`javascript:` URLs before `rendered.innerHTML` is read — not
  verifiable headless. Treat as **guilty until proven innocent**: drop
  `nodeintegration` (nothing printed needs Node), and/or sanitize
  `rendered` (strip `on*`, `javascript:` URLs, `script`/`iframe`/`object`)
  before injection. PoC note body: ``<img src=x onerror="process.mainModule
  .require('child_process').exec('…')">`` — fires on export iff the renderer
  passes the attribute through.

### 7. Webview lifecycle / hang / mobile — PASS (one minor)

- `finally { component.unload(); webview.remove(); }` (`1507-1510`) always
  detaches the element. `pdfWebviewReady` (`143-151`) rejects after 30 s, so
  no infinite hang when `dom-ready` never fires.
- Minor: no `did-fail-load` listener, so a bad `src` always costs the full
  30 s. Desktop gate is triple (`Platform.isDesktop && isDesktopApp` in the
  command `1327-1328`, the file menu `1347-1349`, and the entry `1412`), and
  mobile returns before touching Electron APIs. No mobile crash path.

### 8. `waitForExportNodeUid` identity + failure orphans — PARTIAL

- `nodeUidFor` (`3746-3749`) returns the *current* record for the path with no
  check that it is the bytes just written (no mtime/size/content match). A
  path remap mid-poll (rename over the export path) returns another file's
  uid; the share then links the wrong file — same TOCTOU as §1, low
  probability, single-threaded renderer.
- Deterministic failure modes leave **orphan PDFs** (written to the vault,
  never shared, never registered, never cleaned):
  - Sync paused: the export gates on `isConnected` but not `paused`; the
    upload never happens; 30 s wait → throw → orphan remains.
  - Export folder (or `Exports/**`) in `excludePatterns`: same 30 s hang,
    every time. No pre-check against the exclusion filter.
  - `createShareLink` succeeding but clipboard/`saveSettings` failing: live
    link + file, registry lost → janitor never cleans (link-lifetime leak).
- Repro: add `Exports/**` to excluded patterns, run export on any note,
  wait 30 s → error notice + unshared `Exports/<note> <stamp>.pdf` left
  behind permanently.

### 9. Registry write atomicity / growth — PARTIAL

- `upsertExportedShare` replaces same-path entries (no dupes — tested), but
  every distinct export path appends forever: one entry per export, no cap,
  no pruning of entries whose file was manually deleted (non-expired ones
  linger until expiry; with `autoDeleteExpiredExports: false` they linger
  forever). Realistic volume is tiny; still unbounded by construction.
- Janitor drops the registry entry even when **both** unshare and trash
  failed (`1569-1570` run unconditionally after best-effort attempts): a
  transient `trashFile` failure means a still-shared, still-present file the
  janitor will never revisit. The entry should be retained unless the trash
  succeeded (the Drive delete propagates through the trash, killing the link).

### 10. Engine accessors — PASS

- `nodeUidFor` returns `string | null` (immutable primitive, no handle to
  `SyncState` internals). `removeShareLinkByNodeUid` forwards one uid to
  `DriveIO.removeShareLink`; it bypasses the path→uid lookup by design (needed
  when the vault path is already gone) and the engine's op queue, but performs
  no state mutation, so no locking is bypassed. Only caller is the janitor
  with registry uids. No issue beyond §3's confinement note.

### 11. Settings migration / clobbering — PASS

- `loadSettings` (`1176-1183`): `Object.assign({}, DEFAULT_SETTINGS,
  stored ?? adopted)` — old `data.json` without the four new keys gets
  `Exports` / `30` / `true` / `[]` (`settings.ts:242-245`). Blank folder falls
  back at every use site (`effectiveExportFolder`), so vault-root scatter is
  impossible. `saveSettings` persists the whole object including
  `exportedShares`; the settings-tab writer sets one key then saves, no
  clobbering. `upsert`/`remove` build new arrays, so the shared
  `DEFAULT_SETTINGS.exportedShares` reference is never mutated in place.

### 12. UX / correctness notes (minor)

- `resolveExportPath` always returns a *free* name, so the `modifyBinary`
  branch (`1438-1439`) is dead code outside races — harmless, but the
  overwrite path is untested and untestable in practice.
- Reused-link notice (§2) can announce an expiry the link does not have.
- `shareExpiryDays` accepts fractions in the UI (0.5 d works); NaN/negative
  rejected in UI, trusted from `data.json`.
- Changing the export folder strands old entries by design (settings desc
  says so); old links then outlive their files' discoverability.
- Hidden-webview CSS (`styles.css`, `position:fixed; left:-10000px;
  visibility:hidden`) is assumed to still yield a correct `printToPDF`;
  unverified headless — needs one manual desktop pass, as do the pixels.

## Suggested fixes (not applied)

1. Reuse: compare live link against registry need — at minimum, on reuse
   adopt the *link's* actual expiration (or update the Drive link to the new
   expiry) and surface `hasPassword`; never announce a computed expiry for a
   reused link.
2. Janitor: normalize both sides before the prefix test (resolve `..`/`.`,
   reject absolute paths/leading `/`, decide case policy explicitly) and keep
   a registry entry when the trash failed. Validate `exportedShares` shape on
   load (drop malformed entries loudly).
3. Decide the trash question: enforce Obsidian trash (spec) or amend the spec
   to "user's trash preference".
4. Webview: remove `setAttribute('nodeintegration', '')`; sanitize rendered
   HTML (`on*`, `javascript:`, active elements) before `innerHTML`; add
   `did-fail-load` to fail fast.
5. Export: pre-check `paused` and the exclusion filter before writing the PDF
   (or delete/register the orphan on failure); verify the wait result still
   describes the written bytes.
6. `removeShareLinkByNodeUid` callers: pass only registry-owned uids (already
   true) — document that the uid itself is unconfined by design.
