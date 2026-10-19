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

const service = createService({
  appDataDir: APP_DATA,
  version: 'dev',
  platform: 'browser',
});

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
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: { message: 'Bad JSON', code: 'BAD_REQUEST' } }); }
      try {
        const data = await service.call(payload.method, payload.params || {});
        sendJson(res, 200, { ok: true, data });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: { message: err.message, code: err.code || 'ERROR' } });
      }
    });
    return;
  }

  let filePath = path.join(RENDERER, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(RENDERER)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sefaria Lens dev server on http://127.0.0.1:${PORT}`);
  console.log(`AI provider configured: ${service.llm.config().configured}`);
});
