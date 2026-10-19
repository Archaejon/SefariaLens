'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { transliterate, transliterateWord, wordInfo } = require('../src/translit.js');

const cases = [
  // word, modern, ashkenazi, mizrahi
  ['בְּרֵאשִׁית', 'bereshit', 'berey shis'.replace(' ', ''), 'bereshiṯ'],
  ['שָׁלוֹם', 'shalom', 'sholōm', 'shalom'],
  ['שַׁבָּת', 'shabbat', 'shabbos', 'shabbaṯ'],
  ['תּוֹרָה', 'torah', 'tōroh', 'torah'],
  ['חָכְמָה', 'chochmah', 'chochmoh', 'ḥokhmah'],
  ['רוּחַ', 'ruach', 'ruach', 'ruaḥ'],
  ['מַלְכָּה', 'malkah', 'malkoh', 'malkah'],
  ['בֵּית', 'beyt', 'beys', 'beyṯ'],
  ['עַיִן', 'ayin', 'ayin', 'ʿayin'],
  ['אָדָם', 'adam', 'odom', 'aḏam'],
  ['אֱמֶת', 'emet', 'emes', 'emeṯ'],
  ['קָדוֹשׁ', 'kadosh', 'kodōsh', 'qaḏosh'],
  ['צַדִּיק', 'tzaddik', 'tzaddik', 'ṣaddiq'],
  ['יְרוּשָׁלַיִם', 'yerushalayim', 'yerusholayim', 'yerushalayim'],
  ['גָּבֹהַּ', 'gavoah', 'govōah', 'gavoah'],
  ['וַיִּקְרָא', 'vayikra', 'vayikro', 'wayiqra'],
];

for (const [word, modern, ashkenazi, mizrahi] of cases) {
  test(`transliterates ${word}`, () => {
    assert.strictEqual(transliterateWord(word, 'modern'), modern);
    assert.strictEqual(transliterateWord(word, 'ashkenazi'), ashkenazi);
    assert.strictEqual(transliterateWord(word, 'mizrahi'), mizrahi);
  });
}

test('three styles are distinguishable', () => {
  const w = 'שַׁבָּת';
  const a = transliterateWord(w, 'modern');
  const b = transliterateWord(w, 'ashkenazi');
  const c = transliterateWord(w, 'mizrahi');
  assert.strictEqual(new Set([a, b, c]).size, 3);
});

test('maqaf becomes a hyphen instead of joining words', () => {
  assert.strictEqual(transliterate('וַיְהִי־אוֹר', { style: 'modern' }), 'vayhi-or');
});

test('preserves punctuation and spacing', () => {
  const out = transliterate('שָׁלוֹם, עוֹלָם!', { style: 'modern' });
  assert.strictEqual(out, 'shalom, olam!');
});

test('strips diacritics when asked', () => {
  assert.strictEqual(transliterateWord('צַדִּיק', 'mizrahi', { diacritics: false }), 'tsaddiq');
  assert.strictEqual(transliterateWord('רוּחַ', 'mizrahi', { diacritics: false }), 'ruach');
  assert.strictEqual(transliterateWord('דָּבָר', 'mizrahi', { diacritics: false }), 'davar');
  assert.strictEqual(transliterateWord('שַׁבָּת', 'mizrahi', { diacritics: false }), 'shabbat');
  // Ashkenazi holam keeps its macron only in the scholarly form.
  assert.strictEqual(transliterateWord('תּוֹרָה', 'ashkenazi', { diacritics: false }), 'toroh');
});

test('mizrahi writes bet, khaf and pe rafe with their plain sounds', () => {
  assert.strictEqual(transliterateWord('דָּבָר', 'mizrahi'), 'davar');
  assert.strictEqual(transliterateWord('מֶלֶךְ', 'mizrahi'), 'melekh');
  assert.strictEqual(transliterateWord('לֵב', 'mizrahi'), 'lev');
  assert.strictEqual(transliterateWord('סֵפֶר', 'mizrahi'), 'sefer');
  assert.strictEqual(transliterateWord('טוֹב', 'mizrahi'), 'ṭov');
  assert.strictEqual(transliterateWord('צַדִּיק', 'mizrahi'), 'ṣaddiq');
  assert.strictEqual(transliterateWord('קָדוֹשׁ', 'mizrahi'), 'qaḏosh');
});

test('mizrahi pronounces vav as w', () => {
  assert.strictEqual(transliterateWord('וָו', 'mizrahi'), 'waw');
  assert.strictEqual(transliterateWord('וַיִּקְרָא', 'mizrahi'), 'wayiqra');
  // Shuruk and holam vav remain vowels, not consonants.
  assert.strictEqual(transliterateWord('רוּחַ', 'mizrahi'), 'ruaḥ');
  assert.strictEqual(transliterateWord('קָדוֹשׁ', 'mizrahi'), 'qaḏosh');
});

test('ashkenazi distinguishes qamatz from holam', () => {
  assert.strictEqual(transliterateWord('אָדָם', 'ashkenazi'), 'odom');
  assert.strictEqual(transliterateWord('אֹדֶם', 'ashkenazi'), 'ōdem');
  assert.strictEqual(transliterateWord('תּוֹרָה', 'ashkenazi'), 'tōroh');
});

test('word-initial begedkefet without dagesh stays plosive, and a maqaf keeps the rafe', () => {
  assert.strictEqual(transliterateWord('תֹהוּ', 'mizrahi'), 'tohu');
  assert.strictEqual(transliterateWord('תְהוֹם', 'mizrahi'), 'tehom');
  assert.strictEqual(transliterateWord('בֹהוּ', 'mizrahi'), 'bohu');
  // Inside the word (after a vowel) the same letter still spirantizes.
  assert.strictEqual(transliterate('תֹהוּ וָבֹהוּ', { style: 'mizrahi' }), 'tohu wavohu');
  assert.strictEqual(transliterate('אֶל־בֵּית', { style: 'mizrahi' }), 'el-beyṯ');
});

test('ignores cantillation marks', () => {
  const withTrop = 'בְּרֵאשִׁ֖ית';
  assert.strictEqual(transliterateWord(withTrop, 'modern'), 'bereshit');
});

test('wordInfo returns all three styles', () => {
  const info = wordInfo('שָׁלוֹם', { style: 'modern' });
  assert.strictEqual(info.modern, 'shalom');
  assert.strictEqual(info.ashkenazi, 'sholōm');
  assert.strictEqual(info.style, 'modern');
});

test('leaves unpointed words alone instead of guessing vowels', () => {
  assert.strictEqual(transliterate('שלום עולם', { style: 'modern' }), 'שלום עולם');
  assert.strictEqual(transliterateWord('בראשית', 'modern'), 'בראשית');
  assert.strictEqual(transliterateWord('בְּ', 'modern'), 'בְּ');
});

test('empty input', () => {
  assert.strictEqual(transliterate('', {}), '');
  assert.strictEqual(transliterateWord('', 'modern'), '');
});
