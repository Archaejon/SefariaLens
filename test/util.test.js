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
  assert.strictEqual(stripHtml('&copy; &#1488; &#x5D0;'), '© א א');
});

test('the thin spaces around a paseq are decoded', () => {
  // Sefaria's Masorah edition writes: אֱלֹהִים&thinsp;<small>׀</small>&thinsp;לָאוֹר
  assert.strictEqual(
    stripHtml('וַיִּקְרָ֨א אֱלֹהִ֤ים&thinsp;<small>׀</small>&thinsp;לָאוֹר֙'),
    'וַיִּקְרָ֨א אֱלֹהִ֤ים ׀ לָאוֹר֙',
  );
  assert.strictEqual(stripHtml('תִּצְּרֶ֓נּוּ&thinsp;׀ מִן־הַדּ֖וֹר'), 'תִּצְּרֶ֓נּוּ ׀ מִן־הַדּ֖וֹר');
});

test('paragraph markers are scaffolding, not words', () => {
  assert.strictEqual(
    stripHtml('י֥וֹם אֶחָֽד׃&nbsp;<span class="mam-spi-pe">{פ}</span><br>'),
    'י֥וֹם אֶחָֽד׃',
  );
  assert.strictEqual(
    stripHtml('אֵֽלֶּה׃&nbsp;<span class="mam-spi-samekh">{ס}</span>&nbsp;'),
    'אֵֽלֶּה׃',
  );
  // A marker that arrives without its span goes too.
  assert.strictEqual(stripHtml('וַיְהִי־כֵֽן׃ {ס}'), 'וַיְהִי־כֵֽן׃');
});

test('an entity the table does not know never reaches the reader', () => {
  assert.strictEqual(stripHtml('alph&alpha; beta&bogus;'), 'alph beta');
  assert.strictEqual(stripHtml('one&thinsp;two'), 'one two');
});

test('parses Sefaria search ids', () => {
  assert.deepStrictEqual(
    parseSearchId('Rashi on Psalms 18:2:1 (The Judaica Press Tanach [en])'),
    { ref: 'Rashi on Psalms 18:2:1', versionTitle: 'The Judaica Press Tanach', lang: 'en' },
  );
  assert.strictEqual(parseSearchId('Genesis 1:1').ref, 'Genesis 1:1');
  // A version title with its own parentheses used to defeat the split, leaving
  // the version in the ref so the result could not be opened.
  assert.deepStrictEqual(
    parseSearchId('Genesis 1:1 (The Holy Scriptures: A New Translation (JPS 1917) [en])'),
    { ref: 'Genesis 1:1', versionTitle: 'The Holy Scriptures: A New Translation (JPS 1917)', lang: 'en' },
  );
  // A ref with its own parentheses must not be cut at the first one: these
  // are real ids, and every Lieberman hit used to collapse into one wrong ref.
  assert.deepStrictEqual(
    parseSearchId('Tosefta Bikkurim (Lieberman) 2:16 (Sefaria Community Translation [en])'),
    { ref: 'Tosefta Bikkurim (Lieberman) 2:16', versionTitle: 'Sefaria Community Translation', lang: 'en' },
  );
  assert.deepStrictEqual(
    parseSearchId('Ein Yaakov (Glick Edition), Berakhot 5:15 (The Holy Scriptures: A New Translation (JPS 1917) [en])'),
    { ref: 'Ein Yaakov (Glick Edition), Berakhot 5:15', versionTitle: 'The Holy Scriptures: A New Translation (JPS 1917)', lang: 'en' },
  );
  assert.deepStrictEqual(
    parseSearchId('Genesis 1:1 (Tanakh [with Onkelos translation] [en])'),
    { ref: 'Genesis 1:1', versionTitle: 'Tanakh [with Onkelos translation]', lang: 'en' },
  );
  assert.strictEqual(parseSearchId('Tosefta Bikkurim (Lieberman) 2:16').ref, 'Tosefta Bikkurim (Lieberman) 2:16');
  assert.deepStrictEqual(
    parseSearchId('Berakhot 2a (Talmud Bavli. German trans. [de])'),
    { ref: 'Berakhot 2a', versionTitle: 'Talmud Bavli. German trans.', lang: 'de' },
  );
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
