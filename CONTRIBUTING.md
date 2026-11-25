# Contributing to Sefaria Lens

Issues and pull requests are welcome. This file covers working on the code and
cutting a release; [README.md](README.md) describes the app itself.

## Getting started

Node 22 is what CI runs, and `package.json` accepts anything from 18 up. There
is no build step for the renderer and no bundler: the files in `renderer/` are
served as they are.

```bash
npm install
npm start          # Electron window
npm run dev        # browser harness at http://127.0.0.1:4173
npm test           # node:test suites
```

`npm run dev` is usually the faster loop — it serves the same UI and the same
RPC handlers over HTTP, so reloading the page picks up renderer changes without
restarting the desktop app.

## Tests

The suites are plain `node:test` files in `test/`, run by `npm test`
(`node --test test/*.test.js`). They need no network, no API key and no running
model: model calls go to mock servers (`test/mock-llm.js` and the Ollama stub in
`test/ollama.test.js`), and Sefaria responses are fixtures. A new file in
`test/` is picked up automatically.

Please add a test for any behaviour change. When a test needs a model, extend a
mock rather than reaching for a real endpoint — the suite has to stay runnable
on a machine with nothing installed.

## Style

Match the surrounding code rather than a formatter that isn't configured here:
CommonJS with `'use strict'`, two-space indentation, single quotes, semicolons.
Comments explain *why* a decision was made (a budget, a timeout, an ordering),
not what the next line does.

Two invariants are easy to break and worth watching in review:

- **Local inference is on demand.** Opening a passage, navigating, or rendering
  must never start a generation. AI work happens on an explicit action, is
  cancellable, and is deduplicated while in flight.
- **Reading works without a model.** Anything that only needs Sefaria data, the
  lexicon, or the transliteration rules should keep working when no provider is
  configured, and should say so plainly rather than failing obscurely.

## Pull requests

Keep a change to one concern, keep `npm test` green, and say what you measured
if the change is about speed or resource use. There is no linter to satisfy beyond CI's
syntax check; a reviewer will read the diff.

## Continuous integration

On GitHub, [.github/workflows/ci.yml](.github/workflows/ci.yml) runs the test
suite on every push to `main` and every pull request, and a `v<version>` tag
also packages the portable exe on a Windows runner and publishes the release.
It needs no setup and no secret. A manual run from the Actions tab builds the
exe without releasing it.

Codeberg builds this repository with Woodpecker: pushes and pull requests run
the test suite on Node 22, and tags additionally package the Windows portable
exe and publish it. Enabling CI on a fork, the repository secret the release
step needs, and what each step proves are documented in
[the README's Continuous integration section](README.md#continuous-integration).
That setup is a set of account actions, so a checkout with `.woodpecker.yml`
will still produce no builds until the repository is enabled there.

If you edit [.woodpecker.yml](.woodpecker.yml), install the Woodpecker CLI and
validate it before pushing:

```bash
woodpecker-cli lint .woodpecker.yml
```

## Release checklist

Releases are cut from annotated tags and built by CI, so a release needs no
Windows machine. Tags and `package.json` must agree: `v<version>` has to match
the `version` field exactly, or the build stops before packaging.

1. **Start from a green `main`.**

   ```bash
   git switch main && git pull
   npm ci && npm test
   ```

2. **Write the notes.** They become the release body and the tag message, so
   write them for the person deciding whether to upgrade: what changed, why it
   matters, any measured effect, and known limits. A file is easiest; keep it
   untracked or outside the repository.

3. **Run the release command.**

   ```bash
   npm run release -- 1.0.11 --notes release-notes.md
   ```

   `patch`, `minor` and `major` work instead of an explicit version. The script
   checks that you are on `main` with a clean tree and that the tag is new, then
   bumps `package.json` and the lockfile, rewrites both README references to the
   exe filename, runs `npm test`, commits `Release <version>` with the notes as
   the body, creates the annotated tag, and pushes `main` and the tag. If a step
   fails it restores the files it changed, so a failed release leaves no
   half-bumped tree.

   Preview without touching anything with `--dry-run`, or stop before the push
   with `--no-push`. `--skip-tests` exists but should not be needed: the script
   runs the suite so a red release cannot be tagged.

4. **Let the command watch the tag pipeline.** `test` runs first, then
   `build-portable`, then `release`. The release step needs the
   `codeberg_release_token` secret; if it is missing, the tests and the build
   still pass and only the upload fails.

   The watch reads pipeline progress only with a Woodpecker personal access
   token in `SEFARIA_LENS_CI_TOKEN` (profile page → Access tokens). Without one
   it still watches the release, because the Codeberg API is public, and says so
   instead of pretending it can see the build. It prints each step transition,
   the failing step's last log lines, and gives up after `--timeout` minutes
   (default 40). If Woodpecker has never seen the repository, it stops after a
   minute and points at the activation page instead of waiting out the timeout.
   `--no-watch` returns as soon as the tag is pushed.

   The command exits 0 only once `SefariaLens-<version>-portable.exe` (at least
   5 MB) and `SHA256SUMS.txt` are attached to the release and the checksum file
   names that exe. Once they are, it downloads the exe once — streamed, so the
   whole file is never held in memory — and compares its SHA-256 with the digest
   in `SHA256SUMS.txt`. A mismatch fails the release even though the file is
   attached, and prints both digests. `--no-verify-download` skips the ~80 MB
   download on a metered link.

   A failed pipeline, a missing asset, a draft release, or an exe built for a
   different version exits non-zero. The tag stays pushed either way, so a
   broken release can be re-checked after a pipeline re-run without cutting a
   new version:

   ```bash
   npm run release -- --watch v1.0.11
   ```

5. **Verify by hand only if the watch could not.** The check above is the one a
   user can repeat; run it when the download was skipped (offline machine, a
   mirror, or `--no-verify-download`) to hash the bytes a user would actually
   get:

   ```bash
   curl -LO https://codeberg.org/Archaejon/SefariaLens/releases/download/v1.0.11/SHA256SUMS.txt
   curl -LO https://codeberg.org/Archaejon/SefariaLens/releases/download/v1.0.11/SefariaLens-1.0.11-portable.exe
   sha256sum -c SHA256SUMS.txt
   ```

   Expect `SefariaLens-1.0.11-portable.exe: OK`; anything else means the upload
   and the checksum file disagree, so re-run the tag pipeline.

6. **If the upload failed**, fix the cause and re-run the pipeline for the tag.
   Assets are replaced rather than rejected, so a re-run repairs a half-finished
   release. If the tag itself is wrong — a bad message, or a version that does
   not match `package.json` — move it before anyone downloads the asset, since
   the tag name is what users see:

   ```bash
   git tag -d v1.0.11
   git push origin :refs/tags/v1.0.11
   git tag -a v1.0.11 -F release-notes.md
   git push origin v1.0.11
   ```

`npm run dist` still builds `dist/SefariaLens-<version>-portable.exe` locally if
you want to smoke-test the packaged app before tagging. That output is ignored
by git; CI generates its own checksums for the release.
