'use strict';

/**
 * Browser harness. Same service layer as the Electron app, exposed over HTTP so
 * the UI can be developed and inspected without packaging. Not used in the
 * shipped desktop build.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createService } = require('../src/service.js');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const APP_DATA = path.join(ROOT, '.tools', 'appdata');
// Ignore a generic PORT=0 from tooling; this harness has its own port.
const PORT = Number(process.env.SEFARIA_LENS_PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * Whether a request to /rpc or /events comes from the harness's own page.
 *
 * The harness holds the provider key and can be told where to send it, so a
 * page on another site must not be able to drive it. Three checks, each closing
 * a different door: the Host must be this loopback server (a DNS-rebinding
 * page arrives with its own hostname), a cross-site Origin is refused, and an
 * RPC body must be declared as JSON — a type no cross-site form or no-cors
 * fetch can send without a preflight, which this server never answers.
 */
function trustedRequest(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = String(req.headers.host || '').toLowerCase();
  if (!hosts.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  if (req.method === 'POST') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return false;
  }
  return true;
}

/** The renderer file a URL path names, or null when it points outside it. */
function rendererFile(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  const filePath = path.resolve(RENDERER, `.${path.sep}${rel === '/' ? 'index.html' : rel}`);
  // A bare prefix test would also accept a sibling such as "renderer-old".
  return filePath.startsWith(RENDERER + path.sep) ? filePath : null;
}

function createDevServer({ service, port = PORT }) {
  // Progress from a running generation (token deltas, phases), broadcast to the
  // page the same way the desktop app sends IPC events.
  const listeners = new Set();
  function emit(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of listeners) {
      try { res.write(line); } catch { listeners.delete(res); }
    }
  }

  function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
    });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const guarded = url.pathname === '/rpc' || url.pathname === '/events';
    if (guarded && !trustedRequest(req, server.address().port)) {
      return sendJson(res, 403, { ok: false, error: { message: 'Cross-site request refused', code: 'FORBIDDEN' } });
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 2e6) req.destroy(); });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: { message: 'Bad JSON', code: 'BAD_REQUEST' } }); }
        let done = false;
        // The page reloading or closing mid-question means nobody will read the
        // answer; stop the model rather than burn a minute of GPU on it.
        res.on('close', () => { if (!done) service.abortAll(); });
        try {
          const data = await service.call(payload.method, payload.params || {}, { emit });
          done = true;
          sendJson(res, 200, { ok: true, data });
        } catch (err) {
          done = true;
          sendJson(res, 200, { ok: false, error: { message: err.message, code: err.code || 'ERROR' } });
        }
      });
      return;
    }

    const filePath = rendererFile(url.pathname);
    if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(content);
    });
  });

  return server;
}

if (require.main === module) {
  const service = createService({
    appDataDir: APP_DATA,
    version: 'dev',
    platform: 'browser',
  });
  createDevServer({ service }).listen(PORT, '127.0.0.1', () => {
    console.log(`Sefaria Lens dev server on http://127.0.0.1:${PORT}`);
    console.log(`AI provider configured: ${service.llm.config().configured}`);
  });
}

module.exports = { createDevServer, trustedRequest, rendererFile };
