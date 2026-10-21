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
function stubService({ rows, configured = true } = {}) {
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
