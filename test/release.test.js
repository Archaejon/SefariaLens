'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseArgs, bumpVersion, compareVersions, updateReadme } = require('../tools/release.js');

test('an explicit version is accepted as given', () => {
  assert.strictEqual(bumpVersion('1.0.10', '1.2.3'), '1.2.3');
});

test('patch, minor and major bump the right place', () => {
  assert.strictEqual(bumpVersion('1.0.10', 'patch'), '1.0.11');
  assert.strictEqual(bumpVersion('1.0.10', 'minor'), '1.1.0');
  assert.strictEqual(bumpVersion('1.9.9', 'major'), '2.0.0');
});

test('a release never moves backwards', () => {
  assert.throws(() => bumpVersion('1.0.10', '1.0.10'), /not newer/);
  assert.throws(() => bumpVersion('1.0.10', '1.0.9'), /not newer/);
});

test('comparison is numeric, not lexical', () => {
  assert.ok(compareVersions({ major: 1, minor: 10, patch: 0 }, { major: 1, minor: 9, patch: 9 }) > 0);
});

test('a malformed version is rejected', () => {
  assert.throws(() => bumpVersion('1.0.10', '1.1'), /not a version/);
  assert.throws(() => bumpVersion('1.0.10', 'v1.1.0'), /not a version/);
});

test('both README references move together', () => {
  const text = 'download `SefariaLens-1.0.10-portable.exe`\n# build dist/SefariaLens-1.0.10-portable.exe\n';
  const { text: out, count } = updateReadme(text, '1.0.10', '1.0.11');
  assert.strictEqual(count, 2);
  assert.match(out, /SefariaLens-1\.0\.11-portable\.exe/);
  assert.doesNotMatch(out, /1\.0\.10-portable/);
});

test('a README that names no exe reports zero replacements', () => {
  assert.strictEqual(updateReadme('nothing here', '1.0.10', '1.0.11').count, 0);
});

test('flags parse and default to pushing, testing and watching', () => {
  const plain = parseArgs(['1.0.11']);
  assert.deepStrictEqual(plain, {
    version: '1.0.11',
    notes: null,
    push: true,
    dryRun: false,
    tests: true,
    watch: null,
    wait: true,
    timeoutMinutes: 40,
    verifyDownload: true,
  });
  const guarded = parseArgs(['patch', '--notes', 'notes.md', '--no-push', '--dry-run', '--skip-tests']);
  assert.strictEqual(guarded.notes, 'notes.md');
  assert.strictEqual(guarded.push, false);
  assert.strictEqual(guarded.dryRun, true);
  assert.strictEqual(guarded.tests, false);
});

test('the watch flags parse', () => {
  const watchOnly = parseArgs(['--watch', 'v1.0.11']);
  assert.strictEqual(watchOnly.watch, 'v1.0.11');
  assert.strictEqual(watchOnly.version, null);
  const noWait = parseArgs(['1.0.12', '--no-watch']);
  assert.strictEqual(noWait.wait, false);
  const short = parseArgs(['1.0.12', '--timeout', '2.5']);
  assert.strictEqual(short.timeoutMinutes, 2.5);
});

test('hash verification is on unless it is turned off', () => {
  assert.strictEqual(parseArgs(['1.0.12']).verifyDownload, true);
  assert.strictEqual(parseArgs(['1.0.12', '--no-verify-download']).verifyDownload, false);
  assert.strictEqual(parseArgs(['1.0.12', '--no-verify-download', '--verify-download']).verifyDownload, true);
  assert.strictEqual(parseArgs(['--watch', 'v1.0.12', '--no-verify-download']).verifyDownload, false);
});

test('a watch flag without a tag or a sane timeout is refused', () => {
  assert.throws(() => parseArgs(['--watch']), /needs a tag/);
  assert.throws(() => parseArgs(['--watch', '--no-push']), /needs a tag/);
  assert.throws(() => parseArgs(['1.0.12', '--timeout', '0']), /positive number of minutes/);
  assert.throws(() => parseArgs(['1.0.12', '--timeout', 'soon']), /positive number of minutes/);
});

test('an unknown flag or a missing notes path is refused', () => {
  assert.throws(() => parseArgs(['1.0.11', '--publish']), /unknown option/);
  assert.throws(() => parseArgs(['1.0.11', '--notes']), /needs a file path/);
  assert.throws(() => parseArgs(['1.0.11', '1.0.12']), /unexpected extra argument/);
});
