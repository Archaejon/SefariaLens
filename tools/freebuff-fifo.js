'use strict';

/**
 * The Freebuff "dingus": one local named pipe, one JSON request at a time.
 *
 * Sefaria Lens connects, sends {messages, json, maxTokens, temperature}, and
 * waits for {text}. This process decides how to reach Freebuff:
 *
 *   FREEBUFF_THREAD=<id>   use a running freebuff-bridge at
 *                          FREEBUFF_BRIDGE_URL (default 127.0.0.1:7777)
 *   FREEBUFF_CMD=<cmd>     pipe the request to any program that writes
 *                          {"text": "..."} on stdout
 *
 * The bridge route is deliberately the first one: it is the only supported
 * local surface that can submit a prompt to a Freebuff Desktop session. The
 * command route exists for people whose bridge lives under another name or who
 * have their own adapter. Nothing leaves the machine.
 */

const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { DEFAULT_PIPE } = require('../src/pipe.js');

const args = process.argv.slice(2);
function option(name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PIPE = option('--pipe', process.env.FREEBUFF_PIPE || DEFAULT_PIPE);
const BRIDGE = (process.env.FREEBUFF_BRIDGE_URL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
const THREAD = process.env.FREEBUFF_THREAD || '';
const TOKEN = process.env.FREEBUFF_BRIDGE_TOKEN || '';
const COMMAND = process.env.FREEBUFF_CMD || '';
const TIMEOUT_MS = Number(process.env.FREEBUFF_TIMEOUT_MS || 300000);

function log(...parts) {
  console.log('[freebuff-fifo]', ...parts);
}

function promptFor(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const body = list
    .map((m) => `${String(m.role || 'user').toUpperCase()}:\n${String(m.content == null ? '' : m.content)}`)
    .join('\n\n');
  return `${body}\n\nAnswer the request above. Do not edit files or run commands; reply with the requested content only.`;
}

function bridgeHeaders() {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return headers;
}

async function bridgeJson(path, init = {}) {
  const res = await fetch(`${BRIDGE}${path}`, { ...init, headers: { ...bridgeHeaders(), ...(init.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave text */ }
  if (!res.ok) {
    const detail = data && (data.error || data.message) ? `${data.error || data.message}` : text.slice(0, 200);
    throw new Error(`The Freebuff bridge answered ${res.status}: ${detail || 'no detail'}`);
  }
  return data;
}

/** Pull assistant text out of whatever shape the bridge's thread history uses. */
function assistantTexts(payload) {
  const found = [];
  const seen = new Set();
  const walk = (value) => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== 'object') return;
    const role = String(value.role || value.author || value.type || '').toLowerCase();
    let text = '';
    if (typeof value.content === 'string') text = value.content;
    else if (Array.isArray(value.content)) {
      text = value.content
        .map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
        .join('');
    } else if (typeof value.text === 'string') text = value.text;
    if (text && /assistant|agent|model/.test(role) && !seen.has(text)) {
      seen.add(text);
      found.push(text.trim());
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'content' || key === 'text') continue;
      walk(child);
    }
  };
  walk(payload);
  return found.filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askBridge(request) {
  if (!THREAD) {
    throw new Error('No Freebuff thread is configured. Set FREEBUFF_THREAD to a thread id, or use FREEBUFF_CMD.');
  }
  const before = await bridgeJson(`/v1/threads/${encodeURIComponent(THREAD)}`);
  const beforeTexts = new Set(assistantTexts(before));
  const started = Date.now();

  await bridgeJson(`/v1/threads/${encodeURIComponent(THREAD)}/message`, {
    method: 'POST',
    body: JSON.stringify({ text: promptFor(request.messages) }),
  });

  let lastFresh = '';
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(1000);
    const now = await bridgeJson(`/v1/threads/${encodeURIComponent(THREAD)}`);
    const fresh = assistantTexts(now).filter((text) => !beforeTexts.has(text));
    if (fresh.length) lastFresh = fresh[fresh.length - 1];
    const thread = now && now.thread ? now.thread : null;
    const idle = !thread || thread.turnState === 'idle' || thread.status === 'closed';
    // The bridge can expose a new assistant turn while the thread is still
    // marked running. Wait for idle when the field exists; otherwise settle for
    // a fresh answer after a short grace period.
    if (lastFresh && idle) return { text: lastFresh };
    if (lastFresh && !thread && Date.now() - started > 5000) return { text: lastFresh };
  }
  throw new Error('Freebuff did not finish a reply before the pipe timeout.');
}

function runCommand(request) {
  if (!COMMAND) {
    throw new Error(
      'No Freebuff backend is configured. Start the freebuff-bridge and set FREEBUFF_THREAD, or set FREEBUFF_CMD to an adapter command.',
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(COMMAND, {
      shell: true,
      windowsHide: true,
      env: { ...process.env, FREEBUFF_PIPE: PIPE },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The Freebuff adapter command did not answer within ${Math.round(TIMEOUT_MS / 1000)}s.`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the Freebuff adapter command: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`The Freebuff adapter command exited ${code}: ${stderr.trim().slice(0, 400) || 'no stderr'}`));
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch { /* fall through */ }
      if (!parsed || typeof parsed.text !== 'string') {
        reject(new Error(`The Freebuff adapter command did not return {"text": "..."}: ${stdout.trim().slice(0, 240)}`));
        return;
      }
      resolve({ text: parsed.text });
    });
    child.stdin.end(JSON.stringify({ ...request, prompt: promptFor(request.messages) }));
  });
}

async function answer(request) {
  if (request && request.type === 'ping') {
    return { pong: true, backend: THREAD ? 'bridge' : COMMAND ? 'command' : 'none' };
  }
  if (!request || !Array.isArray(request.messages)) {
    throw new Error('Expected { messages: [...] }.');
  }
  if (THREAD) return askBridge(request);
  return runCommand(request);
}

if (process.platform !== 'win32') {
  try { fs.unlinkSync(PIPE); } catch { /* no stale socket */ }
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  let handled = false;
  const reply = (value) => {
    if (handled) return;
    handled = true;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.on('data', async (chunk) => {
    if (handled) return;
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    let request;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      reply({ error: 'The request was not valid JSON.' });
      return;
    }
    try {
      const result = await answer(request);
      reply(result);
    } catch (err) {
      reply({ error: err.message || 'The Freebuff worker failed.' });
    }
  });
  socket.on('error', () => { /* the client may disconnect while we work */ });
});

server.on('error', (err) => {
  console.error(`[freebuff-fifo] cannot listen on ${PIPE}: ${err.message}`);
  process.exit(1);
});

server.listen(PIPE, () => {
  log(`listening on ${PIPE}`);
  log(THREAD ? `forwarding to bridge ${BRIDGE}, thread ${THREAD}` : COMMAND ? 'forwarding to FREEBUFF_CMD' : 'no backend configured yet');
  if (!THREAD && !COMMAND) {
    log('set FREEBUFF_THREAD (bridge) or FREEBUFF_CMD (adapter), then restart');
  }
});

function stop() {
  server.close(() => {
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(PIPE); } catch { /* already gone */ }
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
