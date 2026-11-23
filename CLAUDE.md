# Sefaria Lens

## Journal — required every session

- **Start of session:** read [JOURNAL.md](JOURNAL.md) before doing anything else. It holds the current state, open items and what earlier sessions did.
- **End of session:** update `JOURNAL.md` before finishing — refresh "Current state" and "Open items", and add a dated entry at the top of "Sessions" with what changed, what was decided and why, and what is left. A task is not complete until the journal is updated.

## Working here

- No Node on this machine's PATH. Run the tests in Docker:
  `docker run --rm -v "$PWD":/app:ro -w /app node:22-bookworm-slim node --test test/*.test.js`
- Push to the `github` remote (`git push github main`). `origin` is Codeberg and does not authenticate from this machine.
- No build step and no runtime dependencies; the renderer is plain HTML/CSS/JS. [README.md](README.md) has the layout, [CONTRIBUTING.md](CONTRIBUTING.md) the release checklist.
