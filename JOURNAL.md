# Journal

Working log for Sefaria Lens. Read it at the start of every session; add an entry at the end of every session (newest first). Keep entries short: what changed, what was decided and why, what is left.

## Current state

- **Version:** 1.0.11 (tag `v1.0.11`, released 2026-11-25 on GitHub: https://github.com/Archaejon/SefariaLens/releases/tag/v1.0.11). `main` is at the release plus journal updates. Codeberg still has only 1.0.10.
- **Remotes:** `github` → https://github.com/Archaejon/SefariaLens (public, pushes work). `origin` → Codeberg `Archaejon/SefariaLens`; fetch and push fail from this machine with `Permission denied (publickey)`.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) runs a syntax check and the tests on every push to `main` and pull request; a `v<version>` tag also builds the portable exe on a Windows runner and publishes a GitHub release; a manual run builds the exe as a 7-day artifact. No secret needed. The Woodpecker file is kept for Codeberg.
- **Tests:** 216 passing. This machine has no Node on the PATH (`.tools/node` and `node_modules/electron` are Windows binaries), so run them in Docker:
  `docker run --rm -v "$PWD":/app:ro -w /app node:22-bookworm-slim node --test test/*.test.js`
- **Pushing to GitHub:** the `github` remote uses the SSH host alias `github-sefarialens` (in `~/.ssh/config`), which selects the deploy key `~/.ssh/sefarialens_github_ed25519`. That key is a write deploy key on this one repository. The machine's other GitHub key belongs to a different repository and cannot push here.

## Open items

- `npm run release` (`tools/release.js`, `tools/watch-release.js`) still pushes to `origin` and watches Woodpecker. Until it learns about GitHub, use `--no-push` and push the tag by hand, or bump and tag manually.
- No real linter yet; CI only runs `node --check` over tracked `.js` files.
- Audit findings not addressed: `renderer/app.js` is one 2,400-line file with 49 `innerHTML` sites and no tests; the 300-line smoke test lives in `electron/main.js`.
- The dev-harness request guard is covered by tests only; it has not been tried in a real browser since the change.
- Decide which remote is canonical. README, CONTRIBUTING and the release tools all point at Codeberg.
- `dist/` (980 MB of old exes) and `.tools/` (272 MB) are git-ignored local clutter.
- Product ideas, by value for effort: bookmarks/notes/saved answers; calendar entry points (parasha, Daf Yomi, 929); export to Markdown/PDF; offline pinning of works; Linux and macOS builds; stress marks in transliteration; semantic retrieval for Ask.

## Sessions

### 2026-11-25 — release 1.0.11

- Bumped `package.json`, the lockfile and the two README exe references by hand (the release script cannot push to GitHub yet), committed `Release 1.0.11` (`dd469fb`), tagged `v1.0.11` with the notes as the annotation, and pushed both to `github`.
- The tag build passed end to end, which was the one untested path of the workflow: tag check, Windows packaging, checksums, release. The release carries `SefariaLens-1.0.11-portable.exe` (74.4 MB) and `SHA256SUMS.txt`; the digest GitHub reports for the exe matches the checksum file (`28d29d70…2935645`).
- Not done: the exe itself was not downloaded or launched, so the packaged app has not been smoke-tested. It is unsigned, as before.
- Next in the proposed order: study persistence (bookmarks, notes, saved answers) as 1.1.

### 2026-11-25 — GitHub Actions

- Added `.github/workflows/ci.yml` (commit `05891f8`) and documented it in README and CONTRIBUTING. Chose a Windows runner for packaging so there is no Wine layer; release notes come from the tag annotation, as on Codeberg.
- Verified on GitHub with a manual run: `test` and `build-portable` both passed and the exe was kept as an artifact. That manual run cancelled the push build of the same commit, so the concurrency group now includes the event name.
- Left the release scripts alone: they are tied to Woodpecker's API (about 1,000 lines with tests), which is a separate piece of work.
- The project folder is now `/mnt/storage/Projects/Sefaria Lens` (was `Project 9`); `main` still matches `github/main` at `6a4a9db`.
- Proposed order of work from here: (1) done — GitHub Actions; (2) release 1.0.11; (3) study persistence — bookmarks, notes, saved answers — as the 1.1 feature, built as a new `src/study.js` store plus RPC methods; (4) calendar entry points; (5) split `renderer/app.js` by view, starting with whichever view the next feature touches.

### 2026-11-23 — hardening, commits, GitHub

- Fixed audit findings 1–5:
  - `tools/devserver.js`: `/rpc` and `/events` refuse requests unless the `Host` is the loopback server, any `Origin` is its own, and a POST is declared as JSON. Static paths are resolved inside `renderer/`. The server is now a `createDevServer` function that listens only when run directly.
  - `src/cache.js`: each cache directory is pruned once, five seconds after start — files older than 30 days, then the oldest beyond 5,000. Caches share one folder and the longest lifetime wins, so 24-hour Sefaria entries can sit on disk for up to 30 days (still treated as expired on read).
  - `src/settings.js`: `SEFARIA_LENS_*` environment overrides apply to the run and are not written to the settings file; a value set explicitly in Settings still replaces the override.
  - Docs: "seven" traditions in `package.json` and the README layout; missing modules listed.
  - New tests in `test/hardening.test.js`.
- Commits: `6a23c93` library search, `69c0f56` hardening. Made on a branch `search-and-hardening`, then fast-forwarded into `main`.
- Created the public GitHub repository `Archaejon/SefariaLens` through Composio, added a dedicated write deploy key, and pushed `main` and `v1.0.10`.
- Added this journal and `CLAUDE.md`, which tells each session to read and update it.

### 2026-11-19 — audit

- Audited the project: Electron study app over the Sefaria API, about 14.5k lines, no runtime dependencies, no build step. Electron side is sound (context isolation, no node integration, http(s)-only external links, key encrypted with `safeStorage`).
- Found a complete but uncommitted library-search feature in the working tree (Search view, category and work filters, paging, a fix for version titles containing parentheses).
- Eight findings; the five small ones were fixed on 2026-11-23, the other three are under Open items.
