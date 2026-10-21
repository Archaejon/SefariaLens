'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * The pipe is deliberately a transport, not a model API. A tiny local worker
 * listens on it, forwards the question to Freebuff by whatever route that
 * machine has (a bridge thread or a command), and writes one JSON reply back.
 * Keeping the transport dumb means the app never needs to know Freebuff's
 * private ports, cookies, or session format.
 */
const DEFAULT_PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\sefaria-lens-freebuff'
  : path.join(os.tmpdir(), 'sefaria-lens-freebuff.sock');

class PipeError extends Error {
  constructor(message, { code = 'PIPE_ERROR' } = {}) {
    super(message);
    this.name = 'PipeError';
    this.code = code;
  }
}

/**
 * Send one newline-delimited JSON request and wait for one JSON reply.
 * The worker may answer with { text }, { error }, or { pong: true }.
 */
function pipeRequest(pipePath, payload, { timeoutMs = 300000, signal } = {}) {
  const target = String(pipePath || DEFAULT_PIPE);
  const id = (payload && payload.id) || crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    let timer = null;
    let socket = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (socket) socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const onAbort = () => finish(new PipeError('Cancelled.', { code: 'CANCELLED' }));

    try {
      socket = net.createConnection(target);
    } catch (err) {
      finish(new PipeError(`Could not open the Freebuff pipe at ${target}: ${err.message}`, { code: 'PIPE_DOWN' }));
      return;
    }

    timer = setTimeout(() => {
      finish(new PipeError(
        `The Freebuff pipe did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        { code: 'PIPE_TIMEOUT' },
      ));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      if (!line) return;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        finish(new PipeError('The Freebuff pipe returned an unreadable reply.', { code: 'PIPE_BAD_RESPONSE' }));
        return;
      }
      if (reply.error) {
        finish(new PipeError(String(reply.error), { code: 'PIPE_WORKER_ERROR' }));
        return;
      }
      finish(null, reply);
    });
    socket.on('error', (err) => {
      const down = err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES');
      finish(new PipeError(
        down
          ? `Nothing is listening on the Freebuff pipe at ${target}. Start it with “npm run freebuff-fifo”.`
          : `Freebuff pipe error: ${err.message}`,
        { code: down ? 'PIPE_DOWN' : 'PIPE_ERROR' },
      ));
    });
    socket.on('close', () => {
      if (!settled) finish(new PipeError('The Freebuff pipe closed before replying.', { code: 'PIPE_CLOSED' }));
    });
  });
}

module.exports = { pipeRequest, PipeError, DEFAULT_PIPE };
