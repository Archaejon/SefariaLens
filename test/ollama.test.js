'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Ollama } = require('../src/ollama.js');
const { LLM } = require('../src/llm.js');

/**
 * A native Ollama-shaped server: the four endpoints the app uses, streaming
 * NDJSON on /api/chat so the transport can be tested the way Ollama really
 * answers.
 */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function createMockOllama({
  port = 0,
  models = ['llama3.1:8b'],
  loaded = [{ name: 'llama3.1:8b', size: 5.28e9, size_vram: 5.28e9, context_length: 4096 }],
  tokens = ['The ', 'sources ', 'agree.'],
  failChat = null,
  tokenDelayMs = 0,
} = {}) {
  const state = { chatBodies: [], tags: 0, ps: 0, chat: 0, generateBodies: [], active: 0, maxActive: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: '0.40.6' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tags') {
      state.tags += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/ps') {
      state.ps += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ models: loaded.map((m) => ({ ...m, expires_at: '2099-01-01T00:00:00Z' })) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.generateBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ done: true }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.chatBodies.push(body);
      state.chat += 1;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      if (failChat) {
        state.active -= 1;
        res.writeHead(failChat.status || 500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: failChat.message || 'mock failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let cancelled = false;
      req.on('close', () => { cancelled = true; });
      for (const token of tokens) {
        if (cancelled) break;
        if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs));
        res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: token }, done: false })}\n`);
      }
      if (!cancelled) {
        res.write(`${JSON.stringify({
          model: body.model,
          message: { role: 'assistant', content: '' },
          done: true,
          total_duration: 3_000_000_000,
          load_duration: 0,
          prompt_eval_count: 1200,
          prompt_eval_duration: 12_000_000_000,
          eval_count: 30,
          eval_duration: 3_000_000_000,
        })}\n`);
      }
      res.end();
      state.active -= 1;
      return;
    }
    res.writeHead(404).end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/v1`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeLLM(url, overrides = {}) {
  return new LLM({
    getSettings: () => ({
      provider: 'ollama', model: 'llama3.1:8b', apiKey: '', baseUrl: url, ...overrides,
    }),
    fetchImpl: fetch,
  });
}

test('native Ollama transport', async (t) => {
  const mock = await createMockOllama();
  t.after(() => mock.close());
  const ollama = new Ollama({ fetchImpl: fetch });

  await t.test('streams deltas and returns the reply with timings', async () => {
    const seen = [];
    const out = await ollama.chat({
      baseUrl: mock.url,
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hi' }],
      format: 'json',
      numPredict: 120,
      numCtx: 4096,
      keepAlive: '15m',
      onToken: (delta) => seen.push(delta),
    });
    assert.strictEqual(out.text, 'The sources agree.');
    assert.deepStrictEqual(seen, ['The ', 'sources ', 'agree.']);
    assert.ok(out.timings.ttftMs >= 0);
    assert.strictEqual(out.timings.promptTokens, 1200);
    assert.strictEqual(out.timings.tokensPerSecond, 10);
    const body = mock.state.chatBodies.at(-1);
    assert.strictEqual(body.options.num_ctx, 4096);
    assert.strictEqual(body.options.num_predict, 120);
    assert.strictEqual(body.keep_alive, '15m');
    assert.strictEqual(body.format, 'json');
    assert.strictEqual(body.stream, true);
  });

  await t.test('an aborted stream reports CANCELLED', async (t2) => {
    const slow = await createMockOllama({ tokenDelayMs: 120 });
    t2.after(() => slow.close());
    const ctrl = new AbortController();
    const pending = ollama.chat({
      baseUrl: slow.url,
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 60);
    await assert.rejects(() => pending, (err) => err.code === 'CANCELLED');
  });

  await t.test('a missing server reports LOCAL_DOWN', async () => {
    await assert.rejects(
      () => ollama.chat({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.code === 'LOCAL_DOWN' && /Nothing is listening/.test(err.message),
    );
  });

  await t.test('a missing model names the pull command', async (t2) => {
    const missing = await createMockOllama({ failChat: { status: 404, message: 'model "ghost" not found' } });
    t2.after(() => missing.close());
    await assert.rejects(
      () => ollama.chat({ baseUrl: missing.url, model: 'ghost', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err.code === 'MODEL_NOT_FOUND' && /ollama pull ghost/.test(err.message),
    );
  });

  await t.test('unload asks for keep_alive 0', async () => {
    await ollama.unload('llama3.1:8b', mock.url);
    assert.strictEqual(mock.state.generateBodies.at(-1).keep_alive, 0);
  });
});

test('local orchestration', async (t) => {
  const mock = await createMockOllama();
  t.after(() => mock.close());

  await t.test('the native endpoint is preferred for the ollama provider', async () => {
    const llm = makeLLM(mock.url);
    const out = await llm.chat([{ role: 'user', content: 'hello' }], { task: 'gloss', onToken: () => {} });
    assert.match(out, /sources/);
    const body = mock.state.chatBodies.at(-1);
    // A gloss gets its own small output ceiling, not the model's default.
    assert.strictEqual(body.options.num_predict, 120);
    // And a grammar, so the reply is the object and nothing else.
    assert.strictEqual(body.format.type, 'object');
    assert.deepStrictEqual(Object.keys(body.format.properties), ['gloss', 'root', 'binyan', 'note']);
  });

  await t.test('identical requests in flight are shared', async (t2) => {
    const slow = await createMockOllama({ tokenDelayMs: 40 });
    t2.after(() => slow.close());
    const llm = makeLLM(slow.url);
    const messages = [{ role: 'user', content: 'same question' }];
    const before = slow.state.chat;
    await Promise.all([llm.chat(messages), llm.chat(messages)]);
    assert.strictEqual(slow.state.chat - before, 1);
  });

  await t.test('local inference is one at a time', async (t2) => {
    const slow = await createMockOllama({ tokenDelayMs: 30 });
    t2.after(() => slow.close());
    const llm = makeLLM(slow.url);
    await Promise.all([
      llm.chat([{ role: 'user', content: 'one' }]),
      llm.chat([{ role: 'user', content: 'two' }]),
    ]);
    assert.strictEqual(slow.state.chat, 2);
    assert.strictEqual(slow.state.maxActive, 1, 'two generations must not overlap');
  });

  await t.test('a flood is refused instead of queued forever', async (t2) => {
    const slow = await createMockOllama({ tokenDelayMs: 40 });
    t2.after(() => slow.close());
    const llm = makeLLM(slow.url);
    const calls = ['a', 'b', 'c', 'd'].map((content) =>
      llm.chat([{ role: 'user', content }]).then(() => 'ok', (err) => err.code));
    const results = await Promise.all(calls);
    assert.deepStrictEqual(results.slice(0, 3), ['ok', 'ok', 'ok']);
    assert.strictEqual(results[3], 'BUSY');
  });

  await t.test('a local model gets a tighter answer ceiling than a cloud one', () => {
    const local = makeLLM(mock.url).task('rank');
    const cloud = new LLM({
      getSettings: () => ({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k' }),
      fetchImpl: fetch,
    }).task('rank');
    assert.strictEqual(local.maxTokens, 320);
    assert.strictEqual(cloud.maxTokens, 1200);
  });

  await t.test('status is cached, and a forced check is not', async () => {
    const llm = makeLLM(mock.url);
    const before = mock.state.tags;
    const first = await llm.status();
    assert.strictEqual(first.ready, true);
    assert.strictEqual(mock.state.tags - before, 1);
    const second = await llm.status();
    assert.strictEqual(second.cached, true);
    assert.strictEqual(mock.state.tags - before, 1);
    await llm.status({ force: true });
    assert.strictEqual(mock.state.tags - before, 2);
  });

  await t.test('status reports where the model actually runs', async () => {
    const llm = makeLLM(mock.url);
    const status = await llm.status({ force: true });
    assert.ok(status.loaded, 'the loaded model should be reported');
    assert.strictEqual(status.loaded.vram, 5.28);
    assert.match(status.message, /100% in VRAM/);
  });

  await t.test('freeing memory unloads the model', async () => {
    const llm = makeLLM(mock.url);
    const out = await llm.freeMemory();
    assert.deepStrictEqual(out, { unloaded: true, model: 'llama3.1:8b' });
    assert.strictEqual(mock.state.generateBodies.at(-1).keep_alive, 0);
  });

  await t.test('keep_alive passes through, with -1 as the "until I unload" number', async () => {
    const llm = makeLLM(mock.url, { keepAlive: '-1' });
    assert.strictEqual(llm.config().keepAlive, -1);
    await llm.chat([{ role: 'user', content: 'hold' }]);
    assert.strictEqual(mock.state.chatBodies.at(-1).keep_alive, -1);
    assert.strictEqual(makeLLM(mock.url, { keepAlive: '5m' }).config().keepAlive, '5m');
  });

  await t.test('a cancelled generation does not report an error status', async (t2) => {
    const slow = await createMockOllama({ tokenDelayMs: 120 });
    t2.after(() => slow.close());
    const phases = [];
    const ctrl = new AbortController();
    const pending = makeLLM(slow.url).chat([{ role: 'user', content: 'slow' }], {
      signal: ctrl.signal,
      onStatus: (event) => phases.push(event.phase),
    });
    setTimeout(() => ctrl.abort(), 60);
    await assert.rejects(() => pending, (err) => err.code === 'CANCELLED');
    assert.ok(phases.includes('starting'));
    assert.ok(!phases.includes('error'), 'pressing Stop is not a model failure');
  });

  await t.test('prompt budget leaves room for the answer', async () => {
    const llm = makeLLM(mock.url, { numCtx: 4096 });
    const profile = llm.task('rank');
    const budget = llm.promptBudget(profile);
    assert.ok(budget < 4096 - profile.maxTokens);
    assert.ok(budget >= 256);
  });
});
