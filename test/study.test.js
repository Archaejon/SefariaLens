'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Study, MAX_NOTE } = require('../src/study.js');
const { createService } = require('../src/service.js');

function notebook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sefaria-lens-study-'));
  const file = path.join(dir, 'notebook.json');
  let clock = 1000;
  const now = () => { clock += 1000; return clock; };
  return { dir, file, now, study: new Study(file, { now }) };
}

test('a bookmark and a note share one entry per passage', () => {
  const { study } = notebook();
  const marked = study.savePassage({
    ref: 'Genesis 1:3', open: 'Genesis 1', he: 'וַיֹּאמֶר אֱלֹהִים', en: 'God said', bookmarked: true,
  });
  assert.strictEqual(marked.bookmarked, true);
  assert.strictEqual(marked.note, '');
  assert.strictEqual(marked.open, 'Genesis 1');

  const noted = study.savePassage({ ref: 'Genesis 1:3', note: '  first speech\r\nof creation  ' });
  assert.strictEqual(noted.id, marked.id);
  assert.strictEqual(noted.bookmarked, true, 'writing a note leaves the bookmark alone');
  assert.strictEqual(noted.note, 'first speech\nof creation');
  assert.strictEqual(noted.en, 'God said', 'text saved earlier is kept when not sent again');
  assert.strictEqual(study.list().length, 1);
});

test('an entry with neither bookmark nor note is removed', () => {
  const { study } = notebook();
  study.savePassage({ ref: 'Exodus 20:2', bookmarked: true, note: 'anokhi' });
  assert.ok(study.savePassage({ ref: 'Exodus 20:2', bookmarked: false }), 'the note keeps it');
  assert.strictEqual(study.savePassage({ ref: 'Exodus 20:2', note: '' }), null);
  assert.strictEqual(study.list().length, 0);
  // Un-bookmarking something never saved must not create an entry.
  assert.strictEqual(study.savePassage({ ref: 'Exodus 20:3', bookmarked: false }), null);
  assert.strictEqual(study.list().length, 0);
});

test('a passage needs a reference, and long input is cut rather than refused', () => {
  const { study } = notebook();
  assert.throws(() => study.savePassage({ ref: '  ', bookmarked: true }), (err) => err.code === 'BAD_REQUEST');
  const item = study.savePassage({ ref: 'Psalms 23:1', note: 'x'.repeat(MAX_NOTE + 500) });
  assert.strictEqual(item.note.length, MAX_NOTE);
  assert.ok(item.note.endsWith('…'));
});

test('the notebook survives a restart and lists the latest change first', () => {
  const { study, file, now } = notebook();
  study.savePassage({ ref: 'Genesis 1:1', bookmarked: true });
  study.savePassage({ ref: 'Genesis 1:2', bookmarked: true });
  study.savePassage({ ref: 'Genesis 1:1', note: 'touched again' });
  const reopened = new Study(file, { now });
  assert.deepStrictEqual(reopened.list().map((i) => i.ref), ['Genesis 1:1', 'Genesis 1:2']);
  assert.strictEqual(reopened.list()[0].note, 'touched again');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'the temporary file is renamed away');
});

test('an answer is saved once, with its sources trimmed to what the notebook shows', () => {
  const { study } = notebook();
  const payload = {
    question: 'Why  two candles\non Shabbat?',
    answer: 'Zakhor and shamor.',
    confidence: 'high',
    model: 'test-model',
    sources: [
      { ref: 'Shabbat 25b', tierLabel: 'Primary source', justification: 'States the obligation.', he: 'dropped', relevance: 0.9 },
      { ref: '', justification: 'no ref, so not kept' },
    ],
  };
  const first = study.saveAnswer(payload);
  const again = study.saveAnswer(payload);
  assert.strictEqual(again.id, first.id);
  assert.strictEqual(study.list().length, 1);
  assert.strictEqual(first.question, 'Why two candles on Shabbat?');
  assert.deepStrictEqual(first.sources, [
    { ref: 'Shabbat 25b', tierLabel: 'Primary source', justification: 'States the obligation.' },
  ]);
  assert.throws(() => study.saveAnswer({ question: 'q', answer: ' ' }), (err) => err.code === 'BAD_REQUEST');
});

test('notes can be set by id, and removing a passage note can remove the entry', () => {
  const { study } = notebook();
  const answer = study.saveAnswer({ question: 'q', answer: 'a' });
  assert.strictEqual(study.setNote({ id: answer.id, note: 'check Rashi' }).note, 'check Rashi');
  assert.strictEqual(study.setNote({ id: answer.id, note: '' }).note, '', 'an answer stays without its note');

  const passage = study.savePassage({ ref: 'Ruth 1:16', note: 'only a note' });
  assert.strictEqual(study.setNote({ id: passage.id, note: '' }), null);
  assert.deepStrictEqual(study.list().map((i) => i.kind), ['answer']);

  assert.throws(() => study.setNote({ id: 'gone', note: 'x' }), (err) => err.code === 'NOT_FOUND');
  assert.deepStrictEqual(study.remove({ id: answer.id }), { removed: true });
  assert.deepStrictEqual(study.remove({ id: answer.id }), { removed: false });
});

test('a notebook file that cannot be read is set aside, not overwritten', () => {
  const { dir, file, now } = notebook();
  fs.writeFileSync(file, '{"items": [ {"id": "1", "kind": "passage", "ref": "Genesis 1:1", "note": "precious"');
  const study = new Study(file, { now });
  assert.strictEqual(study.list().length, 0);
  study.savePassage({ ref: 'Genesis 1:2', bookmarked: true });
  const aside = fs.readdirSync(dir).filter((name) => name.includes('unreadable'));
  assert.strictEqual(aside.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, aside[0]), 'utf8').includes('precious'));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 1);
});

test('the Markdown export carries passages, notes, answers and their sources', () => {
  const { study } = notebook();
  assert.ok(study.exportMarkdown().markdown.includes('Nothing saved yet.'));
  study.savePassage({ ref: 'Genesis 1:3', he: 'יְהִי אוֹר', en: 'Let there be light', note: 'line one\nline two', bookmarked: true });
  study.saveAnswer({
    question: 'What was created first?',
    answer: 'Light.',
    model: 'test-model',
    sources: [{ ref: 'Genesis 1:3', justification: 'The first\nspoken act.' }],
  });
  const out = study.exportMarkdown();
  assert.strictEqual(out.passages, 1);
  assert.strictEqual(out.answers, 1);
  for (const expected of [
    '# Sefaria Lens notebook',
    '### Genesis 1:3',
    '> יְהִי אוֹר',
    '> Let there be light',
    'line one\nline two',
    '### What was created first?',
    '- **Genesis 1:3** — The first spoken act.',
    'test-model',
  ]) {
    assert.ok(out.markdown.includes(expected), `missing: ${expected}`);
  }
});

test('the service exposes the notebook and keeps it in the app data folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sefaria-lens-study-svc-'));
  const stub = { config: () => ({ configured: false }), abortAll: () => {} };
  const service = createService({ appDataDir: dir, version: 'test', platform: 'test', llm: stub, sefaria: {} });

  const { item } = await service.call('study.savePassage', { ref: 'Genesis 1:1', open: 'Genesis 1', bookmarked: true });
  assert.strictEqual(item.ref, 'Genesis 1:1');
  const saved = await service.call('study.saveAnswer', { question: 'q', answer: 'a' });
  const noted = await service.call('study.setNote', { id: saved.item.id, note: 'n' });
  assert.strictEqual(noted.item.note, 'n');

  const listed = await service.call('study.list');
  assert.deepStrictEqual(listed.items.map((i) => i.kind).sort(), ['answer', 'passage']);
  assert.ok((await service.call('study.export')).markdown.includes('### Genesis 1:1'));
  assert.deepStrictEqual(await service.call('study.remove', { id: item.id }), { removed: true });
  assert.ok(fs.existsSync(path.join(dir, 'notebook.json')));

  await assert.rejects(
    () => service.call('study.savePassage', { bookmarked: true }),
    (err) => err.code === 'BAD_REQUEST',
  );
});
