'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toSegments, stripHtml, parseSearchId, clip, isHebrew } = require('../src/util.js');

test('each top-level array entry is its own segment', () => {
  assert.deepStrictEqual(toSegments(['one', 'two', 'three']), ['one', 'two', 'three']);
});

test('nested arrays are joined within a segment', () => {
  assert.deepStrictEqual(
    toSegments([['a', 'b'], ['c']]),
    ['a b', 'c'],
  );
});

test('string and scalar input', () => {
  assert.deepStrictEqual(toSegments('only'), ['only']);
  assert.deepStrictEqual(toSegments(null), []);
});

test('footnotes are removed, not just de-tagged', () => {
  const html = 'When God began<sup class="footnote-marker">a</sup><i class="footnote"><b>Note</b> hidden text</i> to create';
  assert.strictEqual(stripHtml(html), 'When God began to create');
});

test('a footnote with nested italics is removed whole', () => {
  const html = 'was Confusion and Chaos,<sup class="footnote-marker">*</sup>'
    + '<i class="footnote"><b>Confusion and Chaos:</b> Heb. <i>tohu va-vohu</i>, meaning “emptiness.”</i> '
    + 'darkness over the face of Ocean';
  assert.strictEqual(stripHtml(html), 'was Confusion and Chaos, darkness over the face of Ocean');
});

test('an unterminated footnote does not swallow the rest of the segment', () => {
  const html = 'start <i class="footnote">an unclosed note';
  assert.strictEqual(stripHtml(html), 'start <i class="footnote">an unclosed note'.replace(/<[^>]+>/g, ''));
});

test('basic tags and entities', () => {
  assert.strictEqual(stripHtml('<b>hello</b> &amp; <i>world</i>'), 'hello & world');
  assert.strictEqual(stripHtml('line<br>break'), 'line break');
});

test('parses Sefaria search ids', () => {
  assert.deepStrictEqual(
    parseSearchId('Rashi on Psalms 18:2:1 (The Judaica Press Tanach [en])'),
    { ref: 'Rashi on Psalms 18:2:1', versionTitle: 'The Judaica Press Tanach', lang: 'en' },
  );
  assert.strictEqual(parseSearchId('Genesis 1:1').ref, 'Genesis 1:1');
});

test('clip respects a budget', () => {
  const out = clip('the quick brown fox jumps over the lazy dog', 20);
  assert.ok(out.length <= 21);
  assert.ok(out.endsWith('…'));
});

test('isHebrew', () => {
  assert.strictEqual(isHebrew('שלום'), true);
  assert.strictEqual(isHebrew('shalom'), false);
});
