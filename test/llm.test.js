'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createMockLLM } = require('./mock-llm.js');
const { LLM, LLMError } = require('../src/llm.js');

function makeLLM(baseUrl, overrides = {}) {
  return new LLM({
    getSettings: () => ({
      provider: 'custom',
      baseUrl,
      model: 'mock-model',
      apiKey: 'test',
      ...overrides,
    }),
    fetchImpl: fetch,
  });
}

test('LLM client', async (t) => {
  const mock = await createMockLLM({ port: 0 });
  t.after(() => mock.close());

  await t.test('plain chat round-trip', async () => {
    const out = await makeLLM(mock.url).chat([{ role: 'user', content: 'ping' }]);
    assert.strictEqual(out, 'ready');
  });

  await t.test('json mode parses an object', async () => {
    const out = await makeLLM(mock.url).json([{ role: 'user', content: 'Return JSON: {"queries": []}' }]);
    assert.strictEqual(out.queries[0], 'love your neighbor');
  });

  await t.test('missing config raises NO_API_KEY', async () => {
    await assert.rejects(() => makeLLM(mock.url, { apiKey: '' }).test(),
      (err) => err.code === 'NO_API_KEY');
  });

  await t.test('401 raises BAD_KEY', async (t2) => {
    const failing = await createMockLLM({ port: 0, failWith: { status: 401, message: 'invalid api key' } });
    t2.after(() => failing.close());
    await assert.rejects(() => makeLLM(failing.url).chat([{ role: 'user', content: 'ping' }]),
      (err) => err instanceof LLMError && err.code === 'BAD_KEY');
  });

  await t.test('connection test', async () => {
    const res = await makeLLM(mock.url).test();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.model, 'mock-model');
  });

  await t.test('status lists the models a local server has installed', async () => {
    const status = await makeLLM(mock.url, { provider: 'ollama', apiKey: '' }).status();
    assert.strictEqual(status.running, true);
    assert.strictEqual(status.local, true);
    assert.deepStrictEqual(status.models, ['mock-model', 'other-model']);
    assert.strictEqual(status.modelInstalled, true);
    assert.strictEqual(status.ready, true);
  });

  await t.test('status flags a model that is not installed', async () => {
    const status = await makeLLM(mock.url, {
      provider: 'ollama', apiKey: '', model: 'missing-model',
    }).status();
    assert.strictEqual(status.ready, false);
    assert.strictEqual(status.modelInstalled, false);
    assert.match(status.message, /not installed/);
    assert.match(status.message, /ollama pull missing-model/);
  });

  await t.test('status reports a server that is not running', async () => {
    const status = await makeLLM('http://127.0.0.1:1/v1', { provider: 'ollama', apiKey: '' }).status();
    assert.strictEqual(status.running, false);
    assert.match(status.message, /not answering/);
  });

  await t.test('local providers get a long timeout, cloud providers stay short', () => {
    assert.strictEqual(makeLLM(mock.url, { provider: 'ollama', apiKey: '' }).config().timeoutMs, 300000);
    assert.strictEqual(makeLLM(mock.url, { provider: 'ollama', apiKey: '' }).config().local, true);
    assert.strictEqual(makeLLM(mock.url).config().local, false);
    assert.strictEqual(makeLLM(mock.url).config().timeoutMs, 60000);
  });

  await t.test('retries without response_format when a server rejects it', async (t2) => {
    const picky = await createMockLLM({ port: 0, rejectJsonMode: true });
    t2.after(() => picky.close());
    const out = await makeLLM(picky.url).json([{ role: 'user', content: 'Return JSON: {"queries": []}' }]);
    assert.strictEqual(out.queries[0], 'love your neighbor');
    assert.strictEqual(picky.calls.length, 2);
    assert.strictEqual(picky.calls[0].jsonMode, true);
    assert.strictEqual(picky.calls[1].jsonMode, false);
  });

  await t.test('repairs a reply that is not JSON', async (t2) => {
    const sloppy = await createMockLLM({ port: 0, badJsonOnce: true });
    t2.after(() => sloppy.close());
    const out = await makeLLM(sloppy.url).json([{ role: 'user', content: 'Return JSON: {"queries": []}' }]);
    assert.strictEqual(out.queries[0], 'love your neighbor');
    assert.strictEqual(sloppy.calls.length, 2);
    assert.match(sloppy.calls[1].text, /not valid JSON/);
  });

  await t.test('an aborted request reports CANCELLED, not a timeout', async (t2) => {
    const slow = await createMockLLM({ port: 0, delayMs: 1500 });
    t2.after(() => slow.close());
    const ctrl = new AbortController();
    const pending = makeLLM(slow.url).chat([{ role: 'user', content: 'ping' }], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    await assert.rejects(() => pending, (err) => err.code === 'CANCELLED');
  });

  await t.test('a missing model is reported with what is installed', async (t2) => {
    const missing = await createMockLLM({
      port: 0,
      failWith: { status: 404, message: 'model "mock-model" not found' },
    });
    t2.after(() => missing.close());
    await assert.rejects(
      () => makeLLM(missing.url).chat([{ role: 'user', content: 'ping' }]),
      (err) => err.code === 'MODEL_NOT_FOUND'
        && /Installed models: mock-model/.test(err.message),
    );
  });
});
