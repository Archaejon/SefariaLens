'use strict';

/**
 * Cut a release: bump the version, update the filename the README advertises,
 * run the tests, commit, tag with the release notes, push both, and then watch
 * the tag pipeline until the built exe is attached to the release and its
 * SHA-256 matches the release's own checksum file.
 *
 *   npm run release -- 1.0.11 --notes release-notes.md
 *   npm run release -- patch                      # notes from the commits
 *   npm run release -- 1.0.11 --no-push --dry-run
 *   npm run release -- --watch v1.0.11            # check an existing tag
 *
 * The release itself is built by CI from the tag (see CONTRIBUTING.md), so the
 * version bump only produces the commit and the tag; the artefact appears only
 * if the pipeline succeeds. Watching closes that gap: a tag can be pushed and a
 * release can still be missing its exe, which is the failure this reports.
 * Every mutation is preceded by a check, and a failure after the version bump
 * restores the files it touched instead of leaving a half-bumped tree behind.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_CI_URL, parseRepoUrl, tagVersion, watchRelease } = require('./watch-release.js');

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'package.json');
const README = path.join(ROOT, 'README.md');
const TOUCHED = ['package.json', 'package-lock.json', 'README.md'];

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * npm is a shell script on Unix and a .cmd shim on Windows, and Node refuses to
 * spawn the shim without a shell. Running npm's own JavaScript entry point
 * through the current Node binary avoids both problems.
 */
function npmBin() {
  const viaEnv = process.env.npm_execpath;
  if (viaEnv && fs.existsSync(viaEnv)) return { command: process.execPath, pre: [viaEnv] };
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return { command: process.execPath, pre: [cli] };
  return { command: NPM, pre: [], shell: process.platform === 'win32' };
}

class ReleaseError extends Error {}

function parseArgs(argv) {
  const args = {
    version: null,
    notes: null,
    push: true,
    dryRun: false,
    tests: true,
    watch: null,
    wait: true,
    timeoutMinutes: 40,
    verifyDownload: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--notes') {
      args.notes = argv[i + 1];
      if (!args.notes) throw new ReleaseError('--notes needs a file path');
      i += 1;
    } else if (arg === '--watch') {
      args.watch = argv[i + 1];
      if (!args.watch || args.watch.startsWith('-')) throw new ReleaseError('--watch needs a tag like v1.0.11');
      i += 1;
    } else if (arg === '--no-watch') {
      args.wait = false;
    } else if (arg === '--no-verify-download') {
      args.verifyDownload = false;
    } else if (arg === '--verify-download') {
      args.verifyDownload = true;
    } else if (arg === '--timeout') {
      const minutes = Number(argv[i + 1]);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new ReleaseError('--timeout needs a positive number of minutes');
      }
      args.timeoutMinutes = minutes;
      i += 1;
    } else if (arg === '--no-push') {
      args.push = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--skip-tests') {
      args.tests = false;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('-')) {
      throw new ReleaseError(`unknown option ${arg}`);
    } else if (args.version) {
      throw new ReleaseError(`unexpected extra argument ${arg}`);
    } else {
      args.version = arg;
    }
  }
  return args;
}

function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (!m) throw new ReleaseError(`${value} is not a version like 1.2.3`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** "patch" / "minor" / "major" or an explicit x.y.z. Never a downgrade. */
function bumpVersion(current, spec) {
  const now = parseVersion(current);
  if (spec === 'patch') return `${now.major}.${now.minor}.${now.patch + 1}`;
  if (spec === 'minor') return `${now.major}.${now.minor + 1}.0`;
  if (spec === 'major') return `${now.major + 1}.0.0`;
  const next = parseVersion(spec);
  if (compareVersions(next, now) <= 0) {
    throw new ReleaseError(`new version ${spec} is not newer than ${current}`);
  }
  return `${next.major}.${next.minor}.${next.patch}`;
}

function compareVersions(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

/**
 * The README names the portable exe twice: the download link and the `npm run
 * dist` comment. Both have to move with the version, or the release points at a
 * file that will never exist.
 */
function updateReadme(text, from, to) {
  const needle = `SefariaLens-${from}-portable.exe`;
  const replacement = `SefariaLens-${to}-portable.exe`;
  const count = text.split(needle).length - 1;
  return { text: text.split(needle).join(replacement), count };
}

function run(command, args, { capture = false, cwd = ROOT, shell = false, label = null } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new ReleaseError(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new ReleaseError(`${label || `${command} ${args.join(' ')}`} failed${detail ? `: ${detail}` : ''}`);
  }
  return capture ? result.stdout.trim() : '';
}

const git = (args, options) => run('git', args, options);

function runNpm(args, options) {
  const bin = npmBin();
  return run(bin.command, [...bin.pre, ...args], {
    ...options,
    shell: Boolean(bin.shell),
    label: `npm ${args.join(' ')}`,
  });
}

/**
 * `git status` entries that matter, ignoring the notes file when the caller
 * keeps it inside the repository. Notes are read, never committed, so an
 * untracked notes.md must not be mistaken for uncommitted work.
 */
function dirtyEntries(notesPath) {
  const out = git(['status', '--porcelain', '--untracked-files=all'], { capture: true });
  const entries = out.split('\n').filter(Boolean);
  if (!notesPath) return entries;
  const rel = path.relative(ROOT, path.resolve(notesPath)).split(path.sep).join('/');
  return entries.filter((line) => {
    if (line.slice(0, 2) !== '??') return true;
    const entry = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    return entry !== rel;
  });
}

function tagExists(tag) {
  const local = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: ROOT });
  if (local.status === 0) return true;
  const remote = spawnSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return remote.status === 0 && Boolean(String(remote.stdout || '').trim());
}

function notesFromCommits(since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const log = git(['log', range, '--pretty=- %s', '--no-merges'], { capture: true });
  const lines = log.split('\n').filter(Boolean).slice(0, 20);
  if (!lines.length) throw new ReleaseError('no commits to describe; pass --notes <file>');
  return lines.join('\n');
}

function lastTag() {
  const out = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.status === 0 ? out.stdout.trim() : '';
}

function writeTempNotes(notes) {
  const file = path.join(os.tmpdir(), `sefaria-lens-release-${process.pid}.md`);
  fs.writeFileSync(file, `${notes}\n`, 'utf8');
  return file;
}

function restoreTouched() {
  spawnSync('git', ['checkout', '--', ...TOUCHED], { cwd: ROOT, stdio: 'inherit' });
}

function printHelp() {
  console.log(`Usage: npm run release -- <version|patch|minor|major> [options]
       npm run release -- --watch <tag>

  --notes <file>   markdown used as the tag message and release body
                   (default: bullet list of commits since the last tag)
  --watch <tag>    only follow an existing tag: report the pipeline and the
                   release asset, verify its SHA-256, change nothing
  --no-watch       push and exit without waiting for the build
  --timeout <min>  how long to watch a tag pipeline (default: 40)
  --no-verify-download
                   do not download the published exe to check its SHA-256
                   (the watch verifies it by default)
  --no-push        commit and tag locally, skip the push
  --skip-tests     do not run npm test before committing (not recommended)
  --dry-run        run every check and print the plan, change nothing

A watch reads the CI pipeline only when SEFARIA_LENS_CI_TOKEN (a Woodpecker
personal access token) is set; the release assets are read without one. It
downloads the exe once and compares its SHA-256 with SHA256SUMS.txt.`);
}

function ciUrlSetting() {
  return process.env.SEFARIA_LENS_CI_URL || DEFAULT_CI_URL;
}

function forgeUrlSetting(repo) {
  // Overridable so the watcher can be pointed at a mirror or a local fake in
  // tests; by default the forge is the one the remote names.
  return process.env.SEFARIA_LENS_FORGE_URL || `https://${repo.host}`;
}

function ciTokenSetting() {
  return process.env.SEFARIA_LENS_CI_TOKEN || process.env.WOODPECKER_TOKEN || null;
}

function originRepo() {
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
  if (remote.status !== 0) return null;
  return parseRepoUrl(remote.stdout.trim());
}

function commitFor(tag) {
  const out = spawnSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], { cwd: ROOT, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * Watch one tag to completion: true when the exe is on the release, false when
 * the build failed or the asset is missing, null when there is nothing to watch
 * (a local origin). Only `--watch` treats an unreadable origin as an error;
 * during a release the push has already happened, so it is a warning.
 */
async function watchTag({ tag, version, timeoutMinutes, verifyDownload, strict }) {
  const repo = originRepo();
  if (!repo) {
    const message = 'origin is not a remote this tool understands, so the pipeline cannot be watched';
    if (strict) throw new ReleaseError(message);
    console.warn(`release: ${message}; check the tag by hand.`);
    return null;
  }
  const result = await watchRelease({
    repo,
    tag,
    version,
    commit: commitFor(tag),
    ciUrl: ciUrlSetting(),
    forgeUrl: forgeUrlSetting(repo),
    token: ciTokenSetting(),
    timeoutMs: timeoutMinutes * 60 * 1000,
    verifyDownload,
  });
  return result.ok;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.watch) {
    if (args.version) throw new ReleaseError('pass either a version or --watch, not both');
    if (!args.wait) throw new ReleaseError('--watch and --no-watch contradict each other');
    const tag = String(args.watch).trim();
    const version = tagVersion(tag);
    if (!version) throw new ReleaseError(`${tag} is not a release tag like v1.0.11`);
    const ok = await watchTag({
      tag,
      version,
      timeoutMinutes: args.timeoutMinutes,
      verifyDownload: args.verifyDownload,
      strict: true,
    });
    return ok ? 0 : 1;
  }
  if (!args.version) {
    printHelp();
    throw new ReleaseError('a version is required');
  }

  const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'));
  const current = pkg.version;
  const next = bumpVersion(current, args.version);
  const tag = `v${next}`;
  const readmePath = README;

  console.log(`Sefaria Lens ${current} -> ${next} (tag ${tag})`);

  // Checks that must hold before anything is written.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  if (branch !== 'main') throw new ReleaseError(`releases are cut from main, not ${branch}`);
  const dirty = dirtyEntries(args.notes);
  if (dirty.length) throw new ReleaseError(`working tree is not clean:\n${dirty.join('\n')}`);
  if (tagExists(tag)) throw new ReleaseError(`tag ${tag} already exists locally or on origin`);

  const before = fs.readFileSync(readmePath, 'utf8');
  const updated = updateReadme(before, current, next);
  if (updated.count === 0) {
    throw new ReleaseError(`README does not mention SefariaLens-${current}-portable.exe; refusing to guess`);
  }

  const notes = args.notes ? fs.readFileSync(args.notes, 'utf8').trim() : notesFromCommits(lastTag());
  if (!notes) throw new ReleaseError('release notes are empty');

  if (args.dryRun) {
    console.log(`\n[dry run] would bump ${current} -> ${next}`);
    console.log(`[dry run] would update ${updated.count} README reference(s)`);
    console.log(`[dry run] would ${args.tests ? 'run npm test, ' : ''}commit, tag ${tag} with ${notes.split('\n').length} line(s) of notes`);
    console.log(`[dry run] would ${args.push
      ? (args.wait
        ? `push main and the tag, then watch the tag pipeline for the exe${args.verifyDownload ? ' and verify its SHA-256' : ''}`
        : 'push main and the tag without waiting for the build')
      : 'leave the commit and tag local'}`);
    return 0;
  }

  let bumped = false;
  let committed = false;
  try {
    runNpm(['version', next, '--no-git-tag-version']);
    bumped = true;
    fs.writeFileSync(readmePath, updated.text, 'utf8');
    console.log(`README: updated ${updated.count} reference(s) to ${next}`);

    if (args.tests) {
      console.log('\nRunning the test suite…');
      runNpm(['test']);
    }

    git(['add', ...TOUCHED]);
    git(['commit', '-m', `Release ${next}`, '-m', notes]);
    committed = true;
    const notesFile = writeTempNotes(notes);
    try {
      git(['tag', '-a', tag, '-F', notesFile]);
    } finally {
      fs.rmSync(notesFile, { force: true });
    }
    console.log(`Committed and tagged ${tag}`);

    if (args.push) {
      git(['push', 'origin', 'HEAD:main']);
      git(['push', 'origin', tag]);
      console.log(`\nPushed. CI builds the portable exe from ${tag}.`);
      if (!args.wait) {
        console.log(`Watch it with: npm run release -- --watch ${tag}`);
      } else if ((await watchTag({
        tag,
        version: next,
        timeoutMinutes: args.timeoutMinutes,
        verifyDownload: args.verifyDownload,
        strict: false,
      })) === false) {
        // The commit and the tag are already on main, so there is nothing to
        // roll back; the release users download is simply incomplete, which is
        // what the non-zero exit reports to a script.
        return 1;
      }
    } else {
      console.log(`\nNot pushed. When ready: git push origin main && git push origin ${tag}`);
    }
    return 0;
  } catch (err) {
    if (bumped && !committed) {
      console.error('\nRelease failed; restoring the files that were changed.');
      restoreTouched();
    } else if (committed) {
      // The commit and tag are valid local work; only the push failed. Undoing
      // the files would not undo the commit, so point at the push instead.
      console.error(`\nRelease failed after ${tag} was committed and tagged; the local refs are intact.`);
      console.error(`Push them with: git push origin HEAD:main && git push origin ${tag}`);
    }
    throw err;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof ReleaseError ? `release: ${err.message}` : err);
      process.exitCode = 1;
    },
  );
}

module.exports = { parseArgs, parseVersion, bumpVersion, compareVersions, updateReadme, dirtyEntries, main, watchTag };
