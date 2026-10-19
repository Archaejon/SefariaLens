'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Sefaria, languageForVersion, parseVersion, detectTextLanguage } = require('../src/sefaria.js');

function links() {
  const make = (indexTitle, category, ref, anchorRef, extra = {}) => ({
    ref,
    index_title: indexTitle,
    category,
    anchorRef,
    heTitle: indexTitle,
    sourceHasEn: true,
    ...extra,
  });
  return [
    make('Rashi on Genesis', 'Commentary', 'Rashi on Genesis 1:1:1', 'Genesis 1:1', { compDate: [1040, 1105] }),
    make('Or HaChaim on Genesis', 'Commentary', 'Or HaChaim on Genesis 1:2:1', 'Genesis 1:2', { compDate: [1696, 1743] }),
    make('Rashi on Genesis', 'Commentary', 'Rashi on Genesis 1:2:1', 'Genesis 1:2', { compDate: [1040, 1105] }),
    make('Bereshit Rabbah', 'Midrash', 'Bereshit Rabbah 1:1', 'Genesis 1:1', { sourceHasEn: false }),
    make('Mesillat Yesharim', 'Musar', 'Mesillat Yesharim 1', 'Genesis 1:1', { sourceHasEn: true }),
    make('Ibn Ezra on Genesis', 'Commentary', 'Ibn Ezra on Genesis 1:3:1', 'Genesis 1:3', { compDate: [1089, 1167] }),
    { ref: '', index_title: '', category: '' },
  ];
}

function freshSefaria(raw) {
  const s = new Sefaria({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sef-')) });
  s.request = async () => raw;
  return s;
}

test('commentaries groups links by work and leads with the classics', async () => {
  const s = freshSefaria(links());
  const groups = await s.commentaries('Genesis 1:1-3');
  assert.deepStrictEqual(groups.map((g) => g.title), [
    'Rashi on Genesis', 'Ibn Ezra on Genesis', 'Or HaChaim on Genesis', 'Bereshit Rabbah', 'Mesillat Yesharim',
  ]);
  const rashi = groups[0];
  assert.strictEqual(rashi.category, 'Commentary');
  assert.strictEqual(rashi.count, 2);
  assert.strictEqual(rashi.verses, 2);
  assert.strictEqual(rashi.hasEnglish, true);
  const rabbah = groups.find((g) => g.title === 'Bereshit Rabbah');
  assert.strictEqual(rabbah.category, 'Midrash');
  assert.strictEqual(rabbah.hasEnglish, false);
});

test('commentaries drops malformed links and empty groups', async () => {
  const s = freshSefaria(links());
  const groups = await s.commentaries('Genesis 1:1');
  assert.ok(groups.every((g) => g.title && g.category));
});

test('commentaryFor echoes the base range onto the commentary title', async () => {
  const s = freshSefaria([]);
  const asked = [];
  s.text = async (ref) => { asked.push(ref); return { ref, he: ['', 'x', ''], en: ['', 'y', ''], title: ref }; };
  const data = await s.commentaryFor('Genesis 1:1-3', 'Rashi on Genesis', 'Genesis');
  assert.strictEqual(asked[0], 'Rashi on Genesis 1:1-3');
  assert.deepStrictEqual(data.he, ['', 'x', '']);
});

test('commentaryFor handles talmudic and chapter refs', async () => {
  const s = freshSefaria([]);
  const asked = [];
  s.text = async (ref) => { asked.push(ref); return { ref, he: [''], en: [''], title: ref }; };
  await s.commentaryFor('Berakhot 2a', 'Rashi on Berakhot', 'Berakhot');
  await s.commentaryFor('Mishnah Avot 1', 'Rambam on Mishnah Avot', 'Mishnah Avot');
  assert.deepStrictEqual(asked, ['Rashi on Berakhot 2a', 'Rambam on Mishnah Avot 1']);
});

test('version language comes from the title tag, not Sefaria\'s en label', () => {
  assert.strictEqual(languageForVersion('Talmud Bavli. German trans. by Lazarus Goldschmidt, 1929 [de]', 'en'), 'german');
  assert.strictEqual(languageForVersion('Berakhot:Translation to Russian [ru]', 'en'), 'russian');
  assert.strictEqual(languageForVersion('Publicado em 5784, Saymon Pires da Silva [pt]', 'en'), 'portuguese');
  assert.strictEqual(languageForVersion('La Malnova Testamento, L.L.Zamenhof [eo]', 'en'), 'esperanto');
  assert.strictEqual(languageForVersion('Biblia de Ferrara [lad]', 'en'), 'ladino');
  assert.strictEqual(languageForVersion('The Koren Jerusalem Bible', 'en'), 'english');
  assert.strictEqual(languageForVersion('Miqra according to the Masorah', 'he'), 'hebrew');
  // An unknown tag must not be reported as English: that would request
  // "english|Title" and quietly return Hebrew alone.
  assert.strictEqual(languageForVersion('An edition [xx]', 'en'), 'xx');
});

test('a version tagged [eo] is requested by its language name and labelled', async () => {
  const title = 'La Malnova Testamento, L.L.Zamenhof [eo]';
  const raw = {
    ref: 'Genesis 1:1',
    versions: [
      { language: 'he', versionTitle: 'Miqra according to the Masorah', text: ['בְּרֵאשִׁית'] },
      { language: 'en', versionTitle: title, text: ['En la komenco Dio kreis la ĉielon kaj la teron.'] },
    ],
    available_versions: [
      { language: 'he', versionTitle: 'Miqra according to the Masorah' },
      { language: 'en', versionTitle: title },
    ],
  };
  const s = freshSefaria(raw);
  let asked = '';
  s.request = async (url) => { asked = url; return raw; };
  const data = await s.text('Genesis 1:1', { version: `esperanto|${title}` });
  assert.match(asked, /version=esperanto%7CLa\+Malnova/);
  assert.strictEqual(data.enVersion.language, 'esperanto');
  assert.strictEqual(data.enVersion.languageLabel, 'Esperanto');
  assert.strictEqual(data.en[0], 'En la komenco Dio kreis la ĉielon kaj la teron.');
  const option = data.versionOptions.find((v) => v.title === title);
  assert.strictEqual(option.languageLabel, 'Esperanto');
});

test('parseVersion separates language from title', () => {
  assert.deepStrictEqual(parseVersion('german|Talmud Bavli [de]'), { language: 'german', title: 'Talmud Bavli [de]', explicit: true });
  assert.deepStrictEqual(parseVersion('english'), { language: 'english', title: '', explicit: false });
  assert.deepStrictEqual(parseVersion('The Koren Jerusalem Bible'), { language: 'english', title: 'The Koren Jerusalem Bible', explicit: true });
});

test('detectTextLanguage catches a translation filed as English', () => {
  assert.strictEqual(detectTextLanguage(['Трактат Берахот, первый трактат первого из шести разделов Мишны']), 'russian');
  assert.strictEqual(detectTextLanguage(['Love your neighbor as yourself.']), '');
});

test('a non-English version is listed with its language and fetched with that language', async () => {
  const raw = {
    ref: 'Berakhot 2a',
    heRef: '',
    indexTitle: 'Berakhot',
    categories: ['Talmud'],
    versions: [
      { language: 'he', versionTitle: 'Vocalized Aramaic', text: ['א'] },
      { language: 'en', versionTitle: 'Talmud Bavli. German trans. [de]', text: ['VON WANN AN'] },
    ],
    available_versions: [
      { language: 'en', versionTitle: 'William Davidson Edition - English' },
      { language: 'en', versionTitle: 'Talmud Bavli. German trans. [de]' },
    ],
  };
  const s = freshSefaria(raw);
  const data = await s.text('Berakhot 2a', { version: 'german|Talmud Bavli. German trans. [de]' });
  assert.strictEqual(data.enVersion.language, 'german');
  assert.strictEqual(data.enVersion.languageLabel, 'German');
  assert.strictEqual(data.en[0], 'VON WANN AN');
  const germanOption = data.versionOptions.find((v) => v.title.startsWith('Talmud Bavli'));
  assert.strictEqual(germanOption.language, 'german');
  assert.ok(data.versionOptions.every((v) => v.language !== 'hebrew'));
});

test('a version that has no text at the ref is an error, not a blank page', async () => {
  const raw = { ref: 'Berakhot 2a', versions: [{ language: 'he', versionTitle: 'Vocalized Aramaic', text: ['א'] }], available_versions: [] };
  const s = freshSefaria(raw);
  await assert.rejects(
    () => s.text('Berakhot 2a', { version: 'english|A Version That Does Not Exist' }),
    (err) => /no .* at that reference|has no text/i.test(err.message),
  );
});

test('categoryMap maps works and Mishnah tractate refs to their category path', async () => {
  const s = freshSefaria([]);
  s.cache = { wrap: async (_a, _b, fn) => fn() };
  s.toc = async () => ([
    {
      category: 'Tanakh',
      contents: [
        { category: 'Torah', contents: [{ title: 'Genesis', heTitle: 'בראשית' }] },
        { category: 'Rishonim on Tanakh', contents: [{ category: 'Rashi', contents: [{ title: 'Rashi on Genesis' }] }] },
      ],
    },
    {
      category: 'Mishnah',
      contents: [{ category: 'Seder Nezikin', contents: [{ title: 'Avot' }, { title: 'Mishnah Avot', heTitle: 'אבות' }] }],
    },
  ]);
  const map = await s.categoryMap();
  assert.deepStrictEqual(map['Genesis'], ['Tanakh', 'Torah']);
  assert.deepStrictEqual(map['Rashi on Genesis'], ['Tanakh', 'Rishonim on Tanakh', 'Rashi']);
  assert.deepStrictEqual(map['Mishnah Avot'], ['Mishnah', 'Seder Nezikin']);
});
