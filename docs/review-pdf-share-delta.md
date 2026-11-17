# Delta review: `ebf84a4` against `docs/review-pdf-share.md` (finding `1cd6fbd`)

Scope: branch `origin/feat/pdf-export-share`, fix commit `ebf84a4` on top of
`1cd6fbd`. Method: read the fix diff, re-ran targeted probes against the new
code with the repo's own esbuild pipeline (76 assertions), re-ran the old
bypasses against a scratch worktree of `1cd6fbd`, read the SDK source for the
password/expiry claim, and ran the full gates. No code changed, nothing pushed.

Gates (all with `PATH=/opt/data/toolchain/node24/bin`): `npm test`
**626 tests / 176 suites, 626 pass, 0 fail** (was 610; delta **+16**, exactly
matching the 35 `it(` blocks in `tests/pdfShare.test.ts` vs 19 before).
`npm run lint`, `npm run check-types`, `npm run build` all clean.

## 1. Link reuse (old §2 FAIL, §1/§8 TOCTOU caveats) — PASS

- The flow now always calls `runtime.engine.createNoteShareLink` (`src/main.ts:1511`);
  `pickShareTarget` is deleted. Registry, notice and clipboard all use the
  returned access: `buildExportedShare(exportPath, link, sharedUid)`
  (`src/main.ts:1524-1526`, built at `src/sync/pdfShare.ts:136-143` from
  `link.url` / `link.expiration`), `navigator.clipboard.writeText(link.url)` and
  `link.expiration.toLocaleString()` (`src/main.ts:1543-1549`). No computed date
  is announced anymore.
- Stale-uid window narrowed: `sharedUid = nodeUidFor(exportPath) ?? nodeUid`
  (`src/main.ts:1523`) re-reads *after* the share, so the registry pins the node
  the live link belongs to. A remap in the remaining instruction gap is still
  theoretically possible but single-threaded-renderer negligible.
- SDK claim **verified from source** (`node_modules/@protontech/drive-sdk@0.23.0`,
  `dist/internal/sharing/sharingManagement.js`): `shareNode` routes an existing
  `urlAccess` to `updateSharedLink`, which re-encrypts with
  `` `${generatedPassword}${options.customPassword}` `` (no `customPassword`
  option → password-only-from-generated, i.e. cleared) and calls
  `updateURLAccess` with `includesCustomPassword: !!options.customPassword`
  (→ `false`) and
  `expirationTime: options.expiration ? … : undefined` (→ expiry reset/cleared).
  The plugin passes no `password` (`src/sync/drive.ts:489-496`), so both halves
  of the claim hold.
- New friction (minor, see §8): a *legacy* link makes `updateSharedLink` throw
  `ValidationError('Legacy public link cannot be updated…')`; the old flow would
  have silently reused it, the new flow hard-fails the export with a notice.

## 2. Janitor confinement (old §3 PARTIAL) — PASS

- `normalizeVaultPath` (`src/sync/pdfShare.ts:65-76`) rejects `''`, leading `/`,
  backslash, `//`, and any `.`/`..`/empty segment; `isExportPath` (`204-214`)
  compares canonical spellings on both sides. Executed probes: `Exports/../secret.md`,
  `Exports/./a.pdf`, `Exports//a.pdf`, `/Exports/a.pdf`, `Exports\\a.pdf`,
  `exports/a.pdf`, `Exports2/a.pdf`, `''`, `Exports`, `Exports/`, non-strings —
  all refused; `Exports/sub/deep/a.pdf`, `Exports/.../a.pdf` (legal name),
  `Exports/%2e%2e/x` (no URL decoding anywhere in the path) — correctly confined.
  Unicode lookalikes (U+2025, U+FF0E) stay confined. Evil folder setting
  `Exports/../Secrets` normalizes to null → matches nothing.
- One probe expectation of mine was wrong, not the code: folder `'/Exports'`
  *does* match `Exports/a.pdf` because `normalizeExportFolder` strips slashes.
  That leniency is fine — the folder is a trusted local setting; only registry
  *entries* (untrusted JSON) get strict treatment.
- Case-only rename still strands entries (fail-closed: link lives, nothing
  deleted) — by design, documented in the comment.
- Registry validation runs on load (`src/main.ts:1209`, malformed count warned
  once) **and** per janitor run (`src/main.ts:1639`); each janitor entry is
  wrapped so one bad entry cannot abort the run. Executed: `{}`, `null`,
  `undefined`, non-array, `path: undefined`, non-string url, `NaN`/`Infinity`/
  string `expiresAt`, missing `nodeUid`, 200 k-entry array — all dropped without
  throwing, good entries survive.

## 3. Unshare safety (old §3 unconfined-unshare) — PASS

- `janitorEntryPlan` (`src/sync/pdfShare.ts:243-254`) + call site
  (`src/main.ts:1662-1687`): unshare fires only for confined paths and only as
  `trash-then-unshare` (file present) or `unshare-gone` (file confirmed absent;
  `null`/`undefined` from `getAbstractFileByPath`). Folders at an export path
  (`'other'`) and unconfined paths → `leave`. A forged `data.json` therefore
  cannot unshare an arbitrary uid — the uid is only used when its *path* is
  confined and gone.
- Trash failure → `continue` (entry kept, counted for one summary warning);
  unshare failure → `continue` (entry kept). Verified by reading
  `src/main.ts:1669-1694`. Pre-existing nuance, unchanged: when offline
  (`!connected`) a locally-trashed entry is dropped from the registry without an
  explicit unshare, relying on trash propagation to kill the link.

## 4. Orphans / precheck (old §8 PARTIAL) — PASS

- `exportPrecheckRefusal({paused, excluded})` (`src/sync/pdfShare.ts:150-158`)
  is consulted at `src/main.ts:1465-1471` **before** `renderNoteToPdf`; `isExcluded`
  is a new engine accessor over `isExcludedWithAncestors` (`src/sync/engine.ts:559`).
  (Only a cheap `vault.read` precedes the refusal; the expensive webview render
  and all writes are after it.)
- Sync-timeout catch (`src/main.ts:1486-1502`) trashes the just-written PDF,
  confined by `isExportPath`, with a comment justifying why no pre-existing file
  can be there. Registry-save failure (`src/main.ts:1528-1541`) removes the
  just-made link by the re-read uid and throws a combined error — no silent
  link-lifetime leak.
- Loud-but-leaky (minor): the `link.hasPassword` guard (`src/main.ts:1512`)
  returns without registering, leaving a live link the janitor will never clean.
  Unreachable through this flow by construction; acceptable.

## 5. Trash destination (old §4 FAIL) — PARTIAL (documented deviation)

- Still `this.app.fileManager.trashFile` (export-orphan path `src/main.ts:1496`,
  janitor `src/main.ts:1679`), i.e. the user's trash preference, not
  Obsidian-only. Not closed against the spec, but now a **conscious documented
  decision**: both call sites comment that the plugin-review lint forbids forcing
  Obsidian trash. What remains is amending the spec to "user's trash preference",
  not code.

## 6. Sanitizer / webview (old §6 PARTIAL) — PARTIAL, one real bypass left

- Confirmed fixed: `nodeintegration` attribute gone (only a comment at
  `src/main.ts:1584` explains its absence); `sanitizeExportHtml(rendered.innerHTML)`
  runs after `MarkdownRenderer.render`, before `executeJavaScript`
  (`src/main.ts:1591-1592`); `did-fail-load` rejects fast (`src/main.ts:158`).
- Executed 30-payload sweep against `sanitizeExportHtml`: mixed-case, decimal/hex
  (with/without `;`) and `&colon;` `javascript:` obfuscations, embedded
  tab/newline/space schemes, `<svg onload>`, `<img onerror>` (quoted, unquoted,
  newline-separated), `<math><mi href>`, `<script>` (cased, unclosed, with
  content), `<iframe srcdoc>`, `<object>`, `<embed>`, namespaced `xlink:href`,
  `formaction`, `<video><source onerror>`, `style="expression(…)"` — **all
  neutralized**, legit links/images/`data-onclick` preserved.
- **New bypass (executed): named whitespace entities pass through untouched.**
  `sanitizeExportHtml('<a href="java&Tab;script:alert(1)">x</a>')` returns the
  input byte-for-byte (same for `&NewLine;`), while numeric `&#9;`/`&#10;` are
  neutralized. `decodeSchemeEntities` only handles numeric references and
  `&colon;`, but `&Tab;`/`&NewLine;` are valid HTML character references that
  decode to U+0009/U+000A in attribute values, which the WHATWG URL parser then
  strips — yielding `javascript:alert(1)` in the webview. Lowercase `&tab;` is
  harmless (not a valid reference; stays literal). Fix: decode `&Tab;`/
  `&NewLine;` (or all ASCII-whitespace named references) before the
  whitespace-strip, or drop `href`/`src` values containing `&`.
- Impact tempering: the guest has no Node anymore, so this is web-only script
  execution in `app://obsidian.md` origin during export of a hostile note — not
  the `process.mainModule.require('child_process')` escalation the old review
  feared. Still a genuine hole in the claimed "however … entity-obfuscated" barrier.

## 7. Registry cap (old §9 growth) — PASS with a note

- `MAX_EXPORTED_SHARES = 500` (`src/sync/pdfShare.ts:44`); `upsertExportedShare`
  evicts the first expired entry, else the oldest (`261-273`). Executed: pure-live
  overflow evicts index 0 and keeps the newcomer; mixed overflow evicts the
  expired entry and keeps all live ones.
- Notes: evicting a *live* entry strands its link (documented in the comment as
  expiry-before-age); the eviction is **silent** — no log names the dropped path.
  Consider one `warn` with the evicted path.

## 8. Gates and old-code check — PASS

- `npm test`: 626/626; `lint`, `check-types`, `build`: clean. 35 `it(` blocks in
  `tests/pdfShare.test.ts` (+16 new).
- The new tests fail against `1cd6fbd` by construction, verified without guessing:
  all 8 new symbols (`buildExportedShare`, `exportPrecheckRefusal`,
  `sanitizeExportedShares`, `sanitizeExportHtml`, `janitorEntryPlan`,
  `normalizeVaultPath`, `MAX_EXPORTED_SHARES`, `isValidExportedShare`) are absent
  from the old module (grep count 0; `typeof` executed `undefined`), and the old
  bypasses were re-executed in a scratch worktree: `isExportPath('Exports',
  'Exports/../secret.md') === true`, `pickShareTarget(passwordLink) === 'reuse'`.
  Worktree removed afterwards.

## New defects introduced by the fix (beyond §6 bypass)

1. `&Tab;` / `&NewLine;` `javascript:` URLs survive the sanitizer (details §6).
2. Legacy-link owners now get a hard export failure where the old flow silently
   reused the link (SDK `updateSharedLink` throws on legacy links). Rare, but a
   behavior regression for exactly the users with the oldest links.
3. Live-entry cap eviction is unlogged (observability only).
