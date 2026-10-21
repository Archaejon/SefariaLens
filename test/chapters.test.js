'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildChapters, unitForRef } = require('../src/chapters.js');

test('a plain book becomes numbered chapters', () => {
  const book = buildChapters({
    title: 'Genesis',
    heTitle: 'בראשית',
    depth: 2,
    addressTypes: ['Perek', 'Pasuk'],
    shape: [{ title: 'Genesis', heTitle: 'בראשית', length: 2, chapters: [31, 25] }],
  });
  assert.strictEqual(book.total, 2);
  assert.strictEqual(book.complex, false);
  assert.strictEqual(book.unitLabel, 'chapter');
  assert.deepStrictEqual(book.sections.map((s) => s.units.map((u) => u.ref)),
    [['Genesis 1', 'Genesis 2']]);
  assert.strictEqual(book.sections[0].heTitle, 'בראשית');
});

test('a complex work splits into sections addressed by their own titles', () => {
  const book = buildChapters({
    title: 'Zohar',
    heTitle: 'ספר הזהר',
    shape: [{
      isComplex: true,
      length: 5,
      chapters: [
        { title: 'Zohar, Introduction', heTitle: 'הקדמה', length: 2, chapters: [3, 4] },
        { title: 'Zohar, Bereshit', heTitle: 'בראשית', length: 3, chapters: [2, 11, 3] },
      ],
    }],
  });
  assert.strictEqual(book.complex, true);
  assert.deepStrictEqual(book.sections.map((s) => s.label), ['Introduction', 'Bereshit']);
  assert.deepStrictEqual(book.sections[1].units.map((u) => u.ref),
    ['Zohar, Bereshit 1', 'Zohar, Bereshit 2', 'Zohar, Bereshit 3']);
  assert.strictEqual(book.total, 5);
});

test('a Talmud tractate is addressed by daf, and skips the leading placeholders', () => {
  const book = buildChapters({
    title: 'Berakhot',
    depth: 2,
    addressTypes: ['Talmud', 'Integer'],
    shape: [{ title: 'Berakhot', length: 5, chapters: [0, 0, 14, 19, 15] }],
  });
  assert.strictEqual(book.unitLabel, 'daf');
  assert.deepStrictEqual(book.sections[0].units.map((u) => u.ref),
    ['Berakhot 2', 'Berakhot 3']);
});

test('a commentary whose counts nest by verse is one work, not one section per chapter', () => {
  const book = buildChapters({
    title: 'Rashi on Genesis',
    depth: 2,
    shape: [{ title: 'Rashi on Genesis', length: 2, chapters: [[3, 5], [1, 2]] }],
  });
  assert.strictEqual(book.sections.length, 1);
  assert.strictEqual(book.total, 2);
  assert.deepStrictEqual(book.sections[0].units.map((u) => u.ref),
    ['Rashi on Genesis 1', 'Rashi on Genesis 2']);
});

test('a one-level work is a single passage', () => {
  const book = buildChapters({ title: 'Mesillat Yesharim', depth: 1, shape: [] });
  assert.deepStrictEqual(book.sections[0].units, [{ n: 1, label: 'Read', ref: 'Mesillat Yesharim' }]);
});

test('without a shape the work still opens', () => {
  const book = buildChapters({ title: 'Some Work', depth: 2, shape: [] });
  assert.strictEqual(book.total, 1);
  assert.strictEqual(book.sections[0].units[0].ref, 'Some Work');
});

test('unitForRef prefers the longest chapter ref the passage starts with', () => {
  const book = buildChapters({
    title: 'Genesis',
    depth: 2,
    shape: [{ title: 'Genesis', length: 12, chapters: new Array(12).fill(20) }],
  });
  assert.strictEqual(unitForRef(book, 'Genesis 1:1').unit.ref, 'Genesis 1');
  assert.strictEqual(unitForRef(book, 'Genesis 10:4').unit.ref, 'Genesis 10');
  assert.strictEqual(unitForRef(book, 'Genesis 1').unit.ref, 'Genesis 1');
  assert.strictEqual(unitForRef(book, 'Exodus 1:1'), null);
});

test('unitForRef finds the Zohar section a passage belongs to', () => {
  const book = buildChapters({
    title: 'Zohar',
    shape: [{
      chapters: [
        { title: 'Zohar, Introduction', length: 2, chapters: [1, 1] },
        { title: 'Zohar, Bereshit', length: 2, chapters: [1, 1] },
      ],
    }],
  });
  const hit = unitForRef(book, 'Zohar, Bereshit 2');
  assert.strictEqual(hit.section.label, 'Bereshit');
  assert.strictEqual(hit.unit.ref, 'Zohar, Bereshit 2');
});
