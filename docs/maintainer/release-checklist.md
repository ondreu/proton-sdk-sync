# Release checklist

## 1. Repository

- Rename the GitHub repo to `proton-sdk-sync` (Settings → General → Rename;
  GitHub redirects the old URL). Update `package.json` `homepage`/`repository`.
- Default branch is `main`. Merge the release branch into it.
- `.github/workflows/ci.yml` must be green on `main` (tests on Linux, Windows,
  macOS; lint; build; bundle sanity checks).

## 2. Version

- `manifest.json` `version` is the release tag, exactly: `1.0.0`, no `v`.
- `versions.json` maps `1.0.0` → `minAppVersion`.
- `CHANGELOG.md` has a `## [1.0.0]` section; the release workflow copies it into
  the release notes.

## 3. Release

Push the tag; `.github/workflows/release.yml` stamps the version files, runs the
tests, builds, moves the tag onto the stamped commit, and uploads `main.js`,
`manifest.json` and `styles.css` to the release.

Verify afterwards:

```bash
gh release view 1.0.0 --repo ondreu/proton-sdk-sync --json assets \
  --jq '.assets[].name'   # main.js, manifest.json, styles.css
gh api repos/ondreu/proton-sdk-sync/contents/manifest.json \
  --jq '.content' | base64 -d | jq .version   # "1.0.0"
```

## 4. Directory submission

Submission happens on the website, signed in as the repo owner:

1. <https://community.obsidian.md/> → sign in → link the GitHub account
   (`ondreu`), which proves ownership of the repo.
2. *Add plugin* → pick `ondreu/proton-sdk-sync`.
3. The directory reads `manifest.json` at `HEAD` of the default branch; the
   release whose tag matches `version` must already exist.
4. Address the automated review; each fix means a new release with a bumped
   version.

Before submitting, check the manifest against the requirements:

- `id` is `proton-sdk-sync`, does not contain "obsidian", and is not taken.
- `name` contains no "Obsidian" and does not read as first-party.
- `description` does not repeat the plugin name, is a sentence, ends with a
  period.
- `author`, `authorUrl` set; `isDesktopOnly: false`.
- README states the account requirement, the network use and the absence of
  telemetry, and credits the upstream project.

## 5. Known risk: the fork policy

The directory's developer policies say forks are not accepted unless the
original author approved in writing, or the original author is unreachable and
the project has had no updates for six months plus thirty days' public notice.
The upstream project was updated on 2026-11-05, so the second route is not open
yet. This project is submitted as a maintained fork with the original author
credited in the README, `NOTICE` and the licence section; the submission may be
declined on that basis.

If a reviewer raises it, the answer is the same as the README: the upstream
project stopped merging fixes, the fork keeps the plugin usable, the author is
credited, and the divergence is documented in `CHANGELOG.md`.

## 6. After publishing

- Announce in the forum's *Share & showcase* and in `#updates` on the Discord
  (needs the `developer` role).
- Watch the first issues for the two things that always come up: Android sign-in
  behind a private DNS resolver, and two sync clients fighting over one vault.
