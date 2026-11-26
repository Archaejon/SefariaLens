'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Cache } = require('../src/cache.js');
const { Settings } = require('../src/settings.js');
const { createDevServer, rendererFile } = require('../tools/devserver.js');

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `sefaria-lens-${label}-`));

test('pruning removes old cache files, caps the count, and leaves other files alone', async () => {
  const dir = tmp('prune');
  const cache = new Cache(dir);
  const day = 1000 * 60 * 60 * 24;
  const now = Date.now();
  const age = (key, days) => {
    cache.set('text', key, { key });
    const when = new Date(now - days * day);
    fs.utimesSync(cache.key('text', key), when, when);
  };
  age('stale', 45);
  age('old', 3);
  age('newer', 2);
  age('newest', 1);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  const stranger = new Date(now - 400 * day);
  fs.utimesSync(path.join(dir, 'settings.json'), stranger, stranger);

  const first = await Cache.prune(dir, { maxAgeMs: 30 * day, now });
  assert.deepStrictEqual(first, { removed: 1, kept: 3 });
  assert.ok(!fs.existsSync(cache.key('text', 'stale')));

  const second = await Cache.prune(dir, { maxAgeMs: 30 * day, maxFiles: 2, now });
  assert.deepStrictEqual(second, { removed: 1, kept: 2 });
  assert.ok(!fs.existsSync(cache.key('text', 'old')));
  assert.ok(fs.existsSync(cache.key('text', 'newest')));
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
});

test('pruning a directory that does not exist is not an error', async () => {
  assert.deepStrictEqual(
    await Cache.prune(path.join(os.tmpdir(), 'sefaria-lens-no-such-dir-xyz')),
    { removed: 0, kept: 0 },
  );
});

test('a key from the environment is used but never written to the settings file', () => {
  const file = path.join(tmp('settings'), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'file-key', model: 'file-model' }));
  const env = { SEFARIA_LENS_API_KEY: 'env-key', SEFARIA_LENS_MODEL: 'env-model' };
  const settings = new Settings(file, { env });
  assert.strictEqual(settings.get().apiKey, 'env-key');
  assert.strictEqual(settings.get().model, 'env-model');

  settings.set({ fontSize: 24 });
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.apiKey, 'file-key');
  assert.strictEqual(saved.model, 'file-model');
  assert.strictEqual(saved.fontSize, 24);
  assert.strictEqual(settings.get().apiKey, 'env-key');

  // A value the user chooses is theirs to keep.
  settings.set({ model: 'chosen' });
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.model, 'chosen');
  assert.strictEqual(saved.apiKey, 'file-key');
});

test('with no settings file, an environment key still stays off disk', () => {
  const file = path.join(tmp('settings'), 'settings.json');
  const settings = new Settings(file, { env: { SEFARIA_LENS_API_KEY: 'env-key' } });
  settings.set({ style: 'ashkenazi' });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, '');
});

test('renderer paths cannot leave the renderer folder', () => {
  assert.ok(rendererFile('/').endsWith(path.join('renderer', 'index.html')));
  assert.ok(rendererFile('/app.js').endsWith(path.join('renderer', 'app.js')));
  assert.strictEqual(rendererFile('/../package.json'), null);
  assert.strictEqual(rendererFile('/%2e%2e/package.json'), null);
  assert.strictEqual(rendererFile('/../renderer-old/app.js'), null);
  assert.strictEqual(rendererFile('/%E0%A4%A'), null);
});

async function withServer(fn) {
  const calls = [];
  const service = {
    call: async (method, params) => { calls.push({ method, params }); return { done: method }; },
    abortAll: () => {},
  };
  const server = createDevServer({ service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // node:http lets a test set Host and Origin, which fetch() forbids.
  const post = (headers, body = '{"method":"settings.set","params":{"baseUrl":"http://evil.example"}}') =>
    new Promise((resolve, reject) => {
      const req = require('node:http').request(
        { host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
      );
      req.on('error', reject);
      req.end(body);
    });
  try { await fn({ port, post, calls }); } finally { server.close(); }
}

test('the dev harness answers its own page and refuses everyone else', async () => {
  await withServer(async ({ port, post, calls }) => {
    const own = `127.0.0.1:${port}`;
    const json = { 'Content-Type': 'application/json' };

    assert.strictEqual(await post({ ...json, Host: own, Origin: `http://${own}` }), 200);
    assert.strictEqual(await post({ ...json, Host: `localhost:${port}` }), 200);
    assert.strictEqual(calls.length, 2);

    // A form or no-cors fetch from another site: no preflight, so no JSON type.
    assert.strictEqual(await post({ 'Content-Type': 'text/plain', Host: own, Origin: 'http://evil.example' }), 403);
    assert.strictEqual(await post({ 'Content-Type': 'text/plain', Host: own }), 403);
    // A foreign origin, even with the right type.
    assert.strictEqual(await post({ ...json, Host: own, Origin: 'http://evil.example' }), 403);
    assert.strictEqual(await post({ ...json, Host: own, 'Sec-Fetch-Site': 'cross-site' }), 403);
    // DNS rebinding: the attacker's name resolves here, and says so in Host.
    assert.strictEqual(await post({ ...json, Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` }), 403);
    assert.strictEqual(calls.length, 2);
  });
});

test('saving the settings form unchanged does not persist an environment override', () => {
  const file = path.join(tmp('settings'), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ provider: 'openai', model: 'file-model', baseUrl: '' }));
  const env = { SEFARIA_LENS_PROVIDER: 'ollama', SEFARIA_LENS_MODEL: 'env-model' };
  const settings = new Settings(file, { env });
  // The form sends every field it shows, including the ones it did not change.
  settings.set({ provider: 'ollama', model: 'env-model', baseUrl: '', fontSize: 22 });
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.provider, 'openai');
  assert.strictEqual(saved.model, 'file-model');
  assert.strictEqual(saved.fontSize, 22);
  assert.strictEqual(settings.get().model, 'env-model');

  // Changing a field in the form is a choice, and is kept.
  settings.set({ provider: 'ollama', model: 'picked', baseUrl: '' });
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.model, 'picked');
  assert.strictEqual(saved.provider, 'openai');
});
