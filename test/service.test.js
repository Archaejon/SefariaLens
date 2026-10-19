'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { segmentRefsFor } = require('../src/service.js');

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
