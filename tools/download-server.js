'use strict';

/**
 * Local download page for the packaged app.
 *
 * The chat's file viewer cannot render a 74 MB executable, so this serves the
 * dist folder with Content-Disposition: attachment. Development only; not part
 * of the shipped app.
 *
 * Usage: node tools/download-server.js [port]
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'dist');
const PORT = Number(process.argv[2] || process.env.SEFARIA_LENS_DL_PORT) || 4180;

const FILES = [
  { name: 'SefariaLens-1.0.0-portable.exe', label: 'Sefaria Lens 1.0.0 (Windows x64 portable)', note: 'Single file, no installer, no admin rights.' },
  { name: 'SHA256SUMS.txt', label: 'SHA-256 checksum', note: 'Verify the download with sha256sum or CertUtil.' },
];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page() {
  const rows = FILES.map((f) => {
    const full = path.join(ROOT, f.name);
    let size = '';
    try {
      const bytes = fs.statSync(full).size;
      size = bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    } catch { return ''; }
    return `<li>
      <a class="file" href="/${encodeURIComponent(f.name)}" download>${escapeHtml(f.label)}</a>
      <span class="meta">${escapeHtml(size)} · ${escapeHtml(f.note)}</span>
    </li>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Download Sefaria Lens</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #14110d; color: #efe6d6;
    font: 15px/1.6 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  .card { width: min(620px, 100%); padding: 34px clamp(20px, 5vw, 38px); border: 1px solid #3a3227;
    border-radius: 16px; background: #1c1813; }
  @media (max-width: 480px) {
    .card { padding: 26px 20px; }
    h1 { font-size: 25px; }
  }
  h1 { font: 500 30px/1.2 Georgia, "Times New Roman", serif; margin: 0 0 6px; }
  h1 span { color: #d8b56c; }
  p.sub { margin: 0 0 22px; color: #a99e8c; font-size: 13.5px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  li { padding: 14px 16px; border: 1px solid #3a3227; border-radius: 11px; }
  a.file { color: #e8c987; font-weight: 600; text-decoration: none; }
  a.file:hover { text-decoration: underline; }
  .meta { display: block; color: #a99e8c; font-size: 12px; margin-top: 3px; }
  .note { margin: 22px 0 0; color: #8f8677; font-size: 12px; }
  code { color: #cfc3ad; }
</style></head>
<body><main class="card">
  <h1>Download <span>Sefaria Lens</span></h1>
  <p class="sub">Windows x64 · portable · built from the verified source tree</p>
  <ul>${rows}</ul>
  <p class="note">The executable is unsigned: if Windows SmartScreen appears, choose
  “More info” → “Run anyway”. Verify with <code>certutil -hashfile SefariaLens-1.0.0-portable.exe SHA256</code>.</p>
</main></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) {
    const body = page();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  const entry = FILES.find((f) => f.name === name);
  const full = entry ? path.join(ROOT, entry.name) : '';
  if (!full || !fs.existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const stat = fs.statSync(full);
  const isText = entry.name.endsWith('.txt');
  res.writeHead(200, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${entry.name}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Download page on http://127.0.0.1:${PORT}/`);
});
