'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { segmentRefsFor, createService } = require('../src/service.js');

test('a verse range becomes one ref per verse', () => {
  assert.deepStrictEqual(segmentRefsFor('Genesis 1:1-3', 3),
    ['Genesis 1:1', 'Genesis 1:2', 'Genesis 1:3']);
});

test('a chapter becomes its verses in order', () => {
  assert.deepStrictEqual(segmentRefsFor('Genesis 1', 3),
    ['Genesis 1:1', 'Genesis 1:2', 'Genesis 1:3']);
});

test('a multi-word work title keeps its prefix', () => {
  assert.deepStrictEqual(segmentRefsFor('Mishnah Avot 1', 2),
    ['Mishnah Avot 1:1', 'Mishnah Avot 1:2']);
});

test('a single verse maps to itself', () => {
  assert.deepStrictEqual(segmentRefsFor('Deuteronomy 10:19', 1), ['Deuteronomy 10:19']);
});

test('a Talmud daf has no verse mapping', () => {
  assert.strictEqual(segmentRefsFor('Berakhot 2a', 14), null);
  assert.strictEqual(segmentRefsFor('Genesis', 31), null);
});

/** A service with a stubbed library and a model that counts its own use. */
function stubService({ rows, configured = true, search: searchImpl, index: indexImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sefaria-lens-test-'));
  const calls = { chat: 0, gloss: 0 };
  const llm = {
    config: () => ({ model: 'mock-model', local: true, configured, baseUrl: 'http://127.0.0.1:1/v1' }),
    task: () => ({ maxTokens: 120, temperature: 0.1, json: true }),
    promptBudget: () => 3600,
    async json(messages) {
      calls.chat += 1;
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"gloss"')) {
        calls.gloss += 1;
        return { gloss: 'mock gloss', root: '', binyan: '', note: '' };
      }
      if (text.includes('"translations"')) {
        const count = (text.match(/^\[\d+\]/gm) || []).length || 1;
        return { translations: Array.from({ length: count }, (_, i) => `translation ${i + 1}`) };
      }
      return { queries: [], refs: [], concepts: [] };
    },
  };
  const sefaria = {
    text: async (ref) => ({
      ref,
      heRef: ref,
      title: 'Tosefta',
      categories: ['Tosefta'],
      primaryCategory: 'Tosefta',
      he: rows,
      en: rows.map(() => ''),
      heVersion: { title: 'Tosefta', license: '' },
      enVersion: { title: 'English', language: 'english', languageLabel: 'English', license: '' },
      availableVersions: [],
    }),
    words: async () => [],
    categoryMap: async () => ({}),
    search: searchImpl || (async () => ({ total: 0, took: 0, hits: [] })),
    index: indexImpl || (async (title) => ({ title, categories: [] })),
  };
  const service = createService({ appDataDir: dir, version: 'test', platform: 'test', llm, sefaria });
  return { service, calls, dir };
}

test('opening a passage never calls the model', async () => {
  const { service, calls } = stubService({ rows: ['א׳', 'ב׳', 'ג׳'] });
  const data = await service.call('text', { ref: 'Tosefta Berakhot 1' });
  assert.strictEqual(calls.chat, 0, 'loading a page must not generate anything');
  assert.strictEqual(data.missingEnglish, 3);
  assert.strictEqual(data.canAiTranslate, true);
  assert.match(data.translationNote, /3 of 3 segments/);
  assert.strictEqual(data.machineTranslation, false);
});

test('translation happens only when it is asked for', async () => {
  const { service, calls } = stubService({ rows: ['א׳', 'ב׳'] });
  await service.call('text', { ref: 'Tosefta Berakhot 1' });
  assert.strictEqual(calls.chat, 0);
  const out = await service.call('translate.missing', {
    ref: 'Tosefta Berakhot 1',
    segments: ['א׳', 'ב׳'],
  });
  assert.deepStrictEqual(out.en, ['translation 1', 'translation 2']);
  assert.strictEqual(calls.chat, 1, 'one batch for two short segments');
  assert.match(out.note, /AI translation of 2 segments/);
});

test('a repeated word click is answered from cache', async () => {
  const { service, calls } = stubService({ rows: ['א׳'] });
  const word = 'וְאָהַבְתָּ';
  const first = await service.call('gloss', { word, verseHe: 'וְאָהַבְתָּ', verseEn: 'and you shall love' });
  assert.strictEqual(first.gloss, 'mock gloss');
  assert.strictEqual(calls.gloss, 1);
  const second = await service.call('gloss', { word, verseHe: 'וְאָהַבְתָּ', verseEn: 'and you shall love' });
  assert.strictEqual(calls.gloss, 1, 'the second click must not generate again');
  assert.strictEqual(second.gloss, 'mock gloss');
  assert.strictEqual(second.cached, true);
});

test('library search passes the query and paging through to Sefaria', async () => {
  const seen = [];
  const { service } = stubService({
    rows: ['א׳'],
    search: async (query, options) => {
      seen.push({ query, options });
      return {
        total: 812,
        took: 46,
        hits: [{ ref: 'Genesis 1:1', lang: 'he', versionTitle: 'Miqra according to the Masorah', highlight: 'בראשית' }],
      };
    },
  });
  const out = await service.call('search', { query: '  ראשית  ', size: 20, start: 40 });
  assert.deepStrictEqual(seen, [{ query: 'ראשית', options: { size: 20, start: 40 } }]);
  assert.strictEqual(out.total, 812);
  assert.strictEqual(out.hits[0].ref, 'Genesis 1:1');
});

test('an empty search never reaches the library', async () => {
  const seen = [];
  const { service } = stubService({
    rows: ['א׳'],
    search: async (query) => { seen.push(query); return { total: 0, hits: [] }; },
  });
  const out = await service.call('search', { query: '   ' });
  assert.deepStrictEqual(out, { total: 0, took: 0, hits: [] });
  assert.strictEqual(seen.length, 0);
});

test('a huge page size or a negative offset is clamped before it is sent', async () => {
  const seen = [];
  const { service } = stubService({
    rows: ['א׳'],
    search: async (query, options) => { seen.push(options); return { total: 3, hits: [] }; },
  });
  await service.call('search', { query: 'shabbat', size: 5000, start: -12 });
  assert.deepStrictEqual(seen, [{ size: 50, start: 0 }]);
});

test('a category scope is sent as a path filter, and echoed back', async () => {
  const seen = [];
  const { service } = stubService({
    rows: ['א׳'],
    search: async (query, options) => { seen.push(options); return { total: 2, hits: [] }; },
  });
  const out = await service.call('search', { query: 'shabbat', scope: 'Talmud' });
  assert.deepStrictEqual(seen, [{ size: 14, start: 0, filters: ['Talmud'] }]);
  assert.strictEqual(out.filter, 'Talmud');
});

test('a category the search index does not have is not sent as a filter', async () => {
  const seen = [];
  const { service } = stubService({
    rows: ['א׳'],
    search: async (query, options) => { seen.push(options); return { total: 2, hits: [] }; },
  });
  const out = await service.call('search', { query: 'shabbat', scope: 'Philosophy' });
  assert.deepStrictEqual(seen, [{ size: 14, start: 0 }]);
  assert.strictEqual(out.filter, '');
});

test('a work is searched under the path its categories file it in', async () => {
  const seen = [];
  const { service } = stubService({
    rows: ['א׳'],
    index: async (title) => ({ title, categories: ['Tanakh', 'Torah'] }),
    search: async (query, options) => { seen.push(options); return { total: 3, hits: [] }; },
  });
  await service.call('search', { query: 'beginning', work: 'Genesis' });
  assert.deepStrictEqual(seen[0].filters, ['Tanakh/Torah/Genesis']);
});

test('a commentary is filed under the commentary root, and beats a scope', async () => {
  const seen = [];
  const { service } = stubService({
    rows: ['א׳'],
    index: async (title) => ({ title, categories: ['Tanakh', 'Rishonim on Tanakh', 'Rashi', 'Torah'] }),
    search: async (query, options) => { seen.push(options); return { total: 1, hits: [] }; },
  });
  const out = await service.call('search', { query: 'beginning', work: 'Rashi on Genesis', scope: 'Talmud' });
  assert.deepStrictEqual(seen[0].filters,
    ['Tanakh Commentary/Rishonim on Tanakh/Rashi/Torah/Rashi on Genesis']);
  assert.strictEqual(out.filter, 'Tanakh Commentary/Rishonim on Tanakh/Rashi/Torah/Rashi on Genesis');
});

test('a work the library does not know is reported, not searched unfiltered', async () => {
  const seen = [];
  const search = async (query, options) => { seen.push(options); return { total: 0, hits: [] }; };
  // Sefaria answers an unknown title with an index that has no categories, and
  // a hard 404 for some forms; neither may become an unfiltered search.
  for (const index of [
    async () => ({ title: 'Not A Real Work', categories: [] }),
    async () => { throw Object.assign(new Error('Not found'), { status: 404 }); },
  ]) {
    const { service } = stubService({ rows: ['א׳'], index, search });
    await assert.rejects(
      () => service.call('search', { query: 'beginning', work: 'Not A Real Work' }),
      (err) => err.code === 'NOT_FOUND' && /Not A Real Work/.test(err.message),
    );
  }
  assert.strictEqual(seen.length, 0);
});

test('without a provider the reader still opens, and offers no translation', async () => {
  const { service, calls } = stubService({ rows: ['א׳'], configured: false });
  const data = await service.call('text', { ref: 'Tosefta Berakhot 1' });
  assert.strictEqual(calls.chat, 0);
  assert.strictEqual(data.canAiTranslate, false);
  await assert.rejects(
    () => service.call('translate.missing', { ref: 'Tosefta Berakhot 1', segments: ['א׳'] }),
    (err) => err.code === 'NO_API_KEY',
  );
});

test('segment refs follow the depth of the work, not the look of the ref', () => {
  // Two levels: a chapter's segments are its verses.
  assert.deepStrictEqual(segmentRefsFor('Genesis 1', 2, 2), ['Genesis 1:1', 'Genesis 1:2']);
  assert.deepStrictEqual(segmentRefsFor('Genesis 1:3-4', 2, 2), ['Genesis 1:3', 'Genesis 1:4']);
  assert.deepStrictEqual(segmentRefsFor('Genesis 1:3', 1, 2), ['Genesis 1:3']);
  // Three levels: "1:1" is a verse whose segments are comments, so the second
  // comment is 1:1:2 — not verse 1:2, where a note would land on other text.
  assert.deepStrictEqual(
    segmentRefsFor('Rashi on Genesis 1:1', 3, 3),
    ['Rashi on Genesis 1:1:1', 'Rashi on Genesis 1:1:2', 'Rashi on Genesis 1:1:3'],
  );
  // A whole chapter of a three-level work has no flat mapping.
  assert.strictEqual(segmentRefsFor('Rashi on Genesis 1', 40, 3), null);
  assert.strictEqual(segmentRefsFor('Berakhot 2a', 10, 2), null);
});
