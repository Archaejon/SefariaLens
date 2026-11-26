'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pipeRequest } = require('../src/pipe.js');
const { LLM } = require('../src/llm.js');

function testPath(label) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\sefaria-lens-test-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`
    : path.join(os.tmpdir(), `sefaria-lens-test-${label}-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
}

async function serve(handler, label) {
  const pipe = testPath(label);
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      handler(request, socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  return {
    pipe,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== 'win32') { try { fs.unlinkSync(pipe); } catch { /* gone */ } }
    },
  };
}

test('pipe client sends one request and reads one JSON reply', async () => {
  const srv = await serve((request, socket) => {
    socket.end(`${JSON.stringify({ text: `heard: ${request.messages[0].content}` })}\n`);
  }, 'roundtrip');
  try {
    const reply = await pipeRequest(srv.pipe, { messages: [{ role: 'user', content: 'ping' }] }, { timeoutMs: 3000 });
    assert.strictEqual(reply.text, 'heard: ping');
  } finally {
    await srv.close();
  }
});

test('pipe client surfaces a worker error', async () => {
  const srv = await serve((_request, socket) => {
    socket.end(`${JSON.stringify({ error: 'no Freebuff thread' })}\n`);
  }, 'error');
  try {
    await assert.rejects(
      () => pipeRequest(srv.pipe, { messages: [] }, { timeoutMs: 3000 }),
      (err) => err.code === 'PIPE_WORKER_ERROR' && /no Freebuff thread/.test(err.message),
    );
  } finally {
    await srv.close();
  }
});

test('a missing pipe is reported as PIPE_DOWN with a start hint', async () => {
  await assert.rejects(
    () => pipeRequest(testPath('missing'), { type: 'ping' }, { timeoutMs: 1000 }),
    (err) => err.code === 'PIPE_DOWN' && /npm run freebuff-fifo/.test(err.message),
  );
});

test('the Freebuff provider sends chat through the pipe', async () => {
  const calls = [];
  const llm = new LLM({
    getSettings: () => ({ provider: 'freebuff', model: 'freebuff' }),
    pipeImpl: async (pipe, payload) => {
      calls.push({ pipe, payload });
      return { text: 'ready' };
    },
  });
  const out = await llm.chat([{ role: 'user', content: 'ping' }]);
  assert.strictEqual(out, 'ready');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].pipe, /sefaria-lens-freebuff/);
  assert.strictEqual(calls[0].payload.messages[0].content, 'ping');
});

test('the Freebuff provider reports the pipe as a ready local model', async () => {
  const llm = new LLM({
    getSettings: () => ({ provider: 'freebuff', model: 'freebuff' }),
    pipeImpl: async () => ({ pong: true }),
  });
  const status = await llm.status();
  assert.strictEqual(status.ready, true);
  assert.strictEqual(status.local, true);
  assert.match(status.message, /listening/);
});

test('a missing pipe status names the start command once', async () => {
  const llm = new LLM({
    getSettings: () => ({ provider: 'freebuff', model: 'freebuff' }),
    pipeImpl: async () => {
      const err = new Error('Nothing is listening on the Freebuff pipe at \\.\\pipe\\x. Start it with “npm run freebuff-fifo”.');
      err.code = 'PIPE_DOWN';
      throw err;
    },
  });
  const status = await llm.status();
  assert.strictEqual(status.ready, false);
  assert.strictEqual((status.message.match(/Start it with/g) || []).length, 1);
});

test('a closed pipe falls back to LOCAL_DOWN advice', async () => {
  const llm = new LLM({
    getSettings: () => ({ provider: 'freebuff', model: 'freebuff' }),
    pipeImpl: async () => {
      const err = new Error('Nothing is listening');
      err.code = 'PIPE_DOWN';
      throw err;
    },
  });
  await assert.rejects(
    () => llm.chat([{ role: 'user', content: 'ping' }]),
    (err) => err.code === 'LOCAL_DOWN' && /Nothing is listening/.test(err.message),
  );
});

test('a pipe that times out is reported as a timeout, not as a cancellation', async () => {
  const llm = new LLM({
    getSettings: () => ({ provider: 'freebuff', model: 'freebuff', timeoutMs: 30 }),
    // The real transport rejects with CANCELLED when its signal aborts, and
    // the client's own timer is what aborts it here.
    pipeImpl: (pipe, payload, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' }));
      }, { once: true });
    }),
  });
  await assert.rejects(
    () => llm.chat([{ role: 'user', content: 'ping' }]),
    (err) => err.code === 'TIMEOUT' && /did not answer/.test(err.message),
  );
});

test('pressing Stop on a pipe request is still a cancellation', async () => {
  const ctrl = new AbortController();
  const llm = new LLM({
    getSettings: () => ({ provider: 'freebuff', model: 'freebuff', timeoutMs: 5000 }),
    pipeImpl: (pipe, payload, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' }));
      }, { once: true });
    }),
  });
  const pending = llm.chat([{ role: 'user', content: 'ping' }], { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(() => pending, (err) => err.code === 'CANCELLED');
});
