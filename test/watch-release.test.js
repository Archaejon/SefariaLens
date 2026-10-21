'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const {
  MIN_EXE_BYTES,
  parseRepoUrl,
  tagVersion,
  pickPipeline,
  assetReport,
  expectedDigest,
  formatBytes,
  watchRelease,
} = require('../tools/watch-release.js');

const EXE = 'SefariaLens-1.2.3-portable.exe';
const SUMS = `${'a'.repeat(64)}  ${EXE}\n`;

/** A local stand-in for the CI and forge APIs, so the watch is exercised over HTTP. */
function fakeServer(route) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.search, auth: req.headers.authorization || null });
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    route({ path: url.pathname, send, requests });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function release(base, overrides = {}) {
  return {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    assets: [
      { id: 1, name: EXE, size: 84_000_000, browser_download_url: `${base}/assets/${EXE}` },
      { id: 2, name: 'SHA256SUMS.txt', size: SUMS.length, browser_download_url: `${base}/assets/SHA256SUMS.txt` },
    ],
    ...overrides,
  };
}

function collectingLog() {
  const lines = [];
  return { lines, log: (...args) => lines.push(args.join(' ')) };
}

test('remotes parse into the owner/repo the two APIs address', () => {
  const expected = {
    host: 'codeberg.org',
    owner: 'Archaejon',
    name: 'SefariaLens',
    fullName: 'Archaejon/SefariaLens',
    htmlUrl: 'https://codeberg.org/Archaejon/SefariaLens',
  };
  for (const remote of [
    'ssh://git@codeberg.org/Archaejon/SefariaLens.git',
    'git@codeberg.org:Archaejon/SefariaLens.git',
    'https://codeberg.org/Archaejon/SefariaLens',
    'https://codeberg.org/Archaejon/SefariaLens.git',
  ]) {
    assert.deepStrictEqual(parseRepoUrl(remote), expected, remote);
  }
  assert.strictEqual(parseRepoUrl(''), null);
  assert.strictEqual(parseRepoUrl('not-a-remote'), null);
  assert.strictEqual(parseRepoUrl('/local/path/to/repo'), null);
  // A Windows drive path looks like scp syntax but is a local remote.
  assert.strictEqual(parseRepoUrl('C:/work/remote.git'), null);
  assert.strictEqual(parseRepoUrl('C:\\work\\remote.git'), null);
  assert.strictEqual(parseRepoUrl('../remote.git'), null);
});

test('a tag has to look like a release version', () => {
  assert.strictEqual(tagVersion('v1.0.11'), '1.0.11');
  assert.strictEqual(tagVersion('1.0.11'), '1.0.11');
  assert.strictEqual(tagVersion('release-1.0.11'), null);
  assert.strictEqual(tagVersion('v1.0'), null);
  assert.strictEqual(tagVersion(''), null);
});

test('the tag pipeline is chosen, never the push that carries the same commit', () => {
  const pipelines = [
    { number: 30, event: 'push', ref: 'refs/heads/main', commit: 'abc', status: 'success' },
    { number: 29, event: 'tag', ref: 'refs/heads/main', commit: 'abc', status: 'success' },
    { number: 31, event: 'tag', ref: 'refs/tags/v1.2.3', commit: 'abc', status: 'success' },
    { number: 32, event: 'tag', ref: 'refs/tags/v1.2.4', commit: 'def', status: 'running' },
  ];
  assert.strictEqual(pickPipeline(pipelines, { tag: 'v1.2.3', commit: 'abc' }).number, 31);
  assert.strictEqual(pickPipeline(pipelines, { tag: 'v1.2.5', commit: 'abc' }), null);
});

test('a re-run of the same tag resolves to the newest pipeline', () => {
  const pipelines = [
    { number: 31, event: 'tag', ref: 'refs/tags/v1.2.3', status: 'failure' },
    { number: 35, event: 'tag', ref: 'refs/tags/v1.2.3', status: 'running' },
  ];
  assert.strictEqual(pickPipeline(pipelines, { tag: 'v1.2.3' }).number, 35);
});

test('a complete release passes and names the exact version', () => {
  const report = assetReport(release('http://x'), '1.2.3', SUMS);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.exeName, EXE);
  assert.deepStrictEqual(report.problems, []);
});

test('an exe named for another version is reported as the wrong build', () => {
  const wrong = release('http://x', {
    assets: [
      { name: 'SefariaLens-1.2.2-portable.exe', size: 84_000_000 },
      { name: 'SHA256SUMS.txt', size: SUMS.length },
    ],
  });
  const report = assetReport(wrong, '1.2.3', `hash  SefariaLens-1.2.2-portable.exe`);
  assert.strictEqual(report.ok, false);
  assert.match(report.problems.join('; '), /has SefariaLens-1\.2\.2-portable\.exe, not SefariaLens-1\.2\.3-portable\.exe/);
  assert.match(report.problems.join('; '), /does not list SefariaLens-1\.2\.3/);
});

test('a missing, tiny, draft, or unchecksummed release does not pass', () => {
  assert.match(assetReport(null, '1.2.3').problems.join('; '), /no release exists/);

  const tiny = release('http://x', {
    assets: [{ name: EXE, size: 1024 }, { name: 'SHA256SUMS.txt', size: SUMS.length }],
  });
  assert.match(assetReport(tiny, '1.2.3').problems.join('; '), /is only 1\.0 KB/);

  assert.match(assetReport(release('http://x', { draft: true }), '1.2.3').problems.join('; '), /still a draft/);

  const noSums = release('http://x', { assets: [{ name: EXE, size: 84_000_000 }] });
  assert.match(assetReport(noSums, '1.2.3').problems.join('; '), /SHA256SUMS\.txt is not attached/);

  const noExe = release('http://x', { assets: [{ name: 'SHA256SUMS.txt', size: SUMS.length }] });
  assert.match(assetReport(noExe, '1.2.3').problems.join('; '), /SefariaLens-1\.2\.3-portable\.exe is not attached/);
});

test('the checksum file is parsed for the exact exe name', () => {
  const digest = 'A'.repeat(64);
  assert.deepStrictEqual(expectedDigest(`${digest}  ${EXE}\n`, EXE), { digest: 'a'.repeat(64), name: EXE });
  assert.strictEqual(expectedDigest(`${digest} *${EXE}\n`, EXE).digest, 'a'.repeat(64));
  assert.strictEqual(expectedDigest(`${digest}  dist/${EXE}\n`, EXE).digest, 'a'.repeat(64));
  assert.strictEqual(expectedDigest(`${digest}  SefariaLens-1.2.2-portable.exe\n`, EXE), null);
  assert.strictEqual(expectedDigest('', EXE), null);
  assert.strictEqual(expectedDigest('not a checksum', EXE), null);
});

test('sizes are reported for humans', () => {
  assert.strictEqual(formatBytes(84_000_000), '80.1 MB');
  assert.strictEqual(formatBytes(97), '97 B');
  assert.strictEqual(formatBytes(undefined), 'unknown size');
});

test('the watch follows the pipeline and confirms the exe reached the release', async () => {
  const states = ['pending', 'running', 'success'];
  let detailPolls = 0;
  let releasePolls = 0;
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path === '/api/repos/lookup/Archaejon/SefariaLens') return send(200, { id: 7 });
    if (path === '/api/repos/7/pipelines') {
      return send(200, [{ number: 12, event: 'tag', ref: 'refs/tags/v1.2.3', commit: 'abc', status: 'pending' }]);
    }
    if (path === '/api/repos/7/pipelines/12') {
      const status = states[Math.min(detailPolls, states.length - 1)];
      detailPolls += 1;
      return send(200, {
        number: 12,
        event: 'tag',
        ref: 'refs/tags/v1.2.3',
        status,
        workflows: [
          { name: 'test', state: 'success' },
          { name: 'build-portable', state: status === 'success' ? 'success' : 'running' },
          { name: 'release', state: status === 'success' ? 'success' : 'pending' },
        ],
      });
    }
    if (path === '/api/v1/repos/Archaejon/SefariaLens/releases/tags/v1.2.3') {
      releasePolls += 1;
      if (releasePolls < 2) return send(404, { message: 'not found' });
      return send(200, release(server.base));
    }
    if (path === '/assets/SHA256SUMS.txt') return send(200, SUMS, 'text/plain');
    send(404, { message: 'unexpected' });
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      commit: 'abc',
      token: 'secret-token',
      ciUrl: server.base,
      forgeUrl: server.base,
      intervalMs: 5,
      graceMs: 5000,
      timeoutMs: 5000,
      log,
    });

    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.pipeline.status, 'success');
    assert.strictEqual(result.report.exeName, EXE);
    assert.ok(lines.some((line) => /pipeline #12 running/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /✓ v1\.2\.3 is published with the built exe/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /asset\s+SefariaLens-1\.2\.3-portable\.exe \(80\.1 MB\)/.test(line)), lines.join('\n'));
    // Hash verification is opt-in at this layer; the CLI turns it on.
    assert.strictEqual(result.verification, null);
    assert.ok(!lines.some((line) => /sha256/.test(line)));

    // The CI token is for the CI host only; the forge is public.
    assert.ok(server.requests.filter((r) => r.path.startsWith('/api/repos')).every((r) => r.auth === 'Bearer secret-token'));
    assert.ok(server.requests.filter((r) => r.path.startsWith('/api/v1')).every((r) => r.auth === null));
  } finally {
    await server.close();
  }
});

test('a failed pipeline reports the failing step and its log tail', async () => {
  const { lines, log } = collectingLog();
  const logLine = 'error: codeberg_release_token is not set\n';
  const server = await fakeServer(({ path, send }) => {
    if (path === '/api/repos/lookup/Archaejon/SefariaLens') return send(200, { id: 7 });
    if (path === '/api/repos/7/pipelines') {
      return send(200, [{ number: 12, event: 'tag', ref: 'refs/tags/v1.2.3', status: 'failure' }]);
    }
    if (path === '/api/repos/7/pipelines/12') {
      return send(200, {
        number: 12,
        event: 'tag',
        ref: 'refs/tags/v1.2.3',
        status: 'failure',
        workflows: [
          { name: 'test', state: 'success', children: [] },
          { name: 'release', state: 'failure', children: [{ id: 5, name: 'release', state: 'failure' }] },
        ],
      });
    }
    if (path === '/api/repos/7/logs/12/5') {
      return send(200, [{ line: 1, data: Array.from(Buffer.from(logLine)) }]);
    }
    send(404, {});
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('git@codeberg.org:Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      token: 'secret-token',
      ciUrl: server.base,
      forgeUrl: server.base,
      intervalMs: 5,
      timeoutMs: 5000,
      log,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'pipeline failure');
    assert.ok(lines.some((line) => /pipeline #12 ended failure/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /codeberg_release_token is not set/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /npm run release -- --watch v1\.2\.3/.test(line)), lines.join('\n'));
  } finally {
    await server.close();
  }
});

test('without a token the release assets still prove the exe arrived', async () => {
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path.startsWith('/api/repos')) return send(401, 'User not authorized', 'text/plain');
    if (path === '/api/v1/repos/Archaejon/SefariaLens/releases/tags/v1.2.3') return send(200, release(server.base));
    if (path === '/assets/SHA256SUMS.txt') return send(200, SUMS, 'text/plain');
    send(404, {});
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      ciUrl: server.base,
      forgeUrl: server.base,
      intervalMs: 5,
      timeoutMs: 5000,
      log,
    });

    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.pipeline, null);
    assert.ok(lines.some((line) => /no SEFARIA_LENS_CI_TOKEN/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /✓ v1\.2\.3 is published/.test(line)), lines.join('\n'));
  } finally {
    await server.close();
  }
});

test('a build that never finishes ends as a timeout, not a success', async () => {
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path === '/api/repos/lookup/Archaejon/SefariaLens') return send(200, { id: 7 });
    if (path === '/api/repos/7/pipelines') {
      return send(200, [{ number: 12, event: 'tag', ref: 'refs/tags/v1.2.3', status: 'running' }]);
    }
    if (path === '/api/repos/7/pipelines/12') {
      return send(200, { number: 12, event: 'tag', ref: 'refs/tags/v1.2.3', status: 'running', workflows: [] });
    }
    send(404, {});
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      token: 'secret-token',
      ciUrl: server.base,
      forgeUrl: server.base,
      intervalMs: 5,
      timeoutMs: 60,
      log,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'timed out');
    assert.match(result.report.problems.join('; '), /no release exists for this tag/);
    assert.ok(lines.some((line) => /no complete release appeared/.test(line)), lines.join('\n'));
  } finally {
    await server.close();
  }
});

test('a repository CI does not know fails fast with the activation hint', async () => {
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path.startsWith('/api/repos')) return send(404, { message: 'not found' });
    send(404, { message: 'not found' });
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      token: 'secret-token',
      ciUrl: server.base,
      forgeUrl: server.base,
      intervalMs: 10,
      missingRepoGraceMs: 40,
      timeoutMs: 5000,
      log,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'CI not activated');
    assert.ok(lines.some((line) => /no pipeline for Archaejon\/SefariaLens/.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repos\/add/.test(line)), lines.join('\n'));
  } finally {
    await server.close();
  }
});

test('the watch downloads the exe and confirms its SHA-256', async () => {
  const payload = Buffer.alloc(MIN_EXE_BYTES + 1024, 7);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const sums = `${digest}  ${EXE}\n`;
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path === '/api/v1/repos/Archaejon/SefariaLens/releases/tags/v1.2.3') {
      return send(200, {
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: [
          { name: EXE, size: payload.length, browser_download_url: `${server.base}/download/${EXE}` },
          { name: 'SHA256SUMS.txt', size: sums.length, browser_download_url: `${server.base}/download/SHA256SUMS.txt` },
        ],
      });
    }
    if (path === '/download/SHA256SUMS.txt') return send(200, sums, 'text/plain');
    if (path === `/download/${EXE}`) return send(200, payload, 'application/octet-stream');
    send(404, {});
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      ciUrl: server.base,
      forgeUrl: server.base,
      verifyDownload: true,
      intervalMs: 5,
      timeoutMs: 10000,
      log,
    });

    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.verification.ok, true);
    assert.strictEqual(result.verification.expected, digest);
    assert.strictEqual(result.verification.actual, digest);
    assert.ok(lines.some((line) => /sha256\s+[0-9a-f]{64} matches SHA256SUMS\.txt/.test(line)), lines.join('\n'));
    // The exe is fetched once, not once per poll.
    assert.strictEqual(server.requests.filter((r) => r.path === `/download/${EXE}`).length, 1);
  } finally {
    await server.close();
  }
});

test('a published exe whose hash disagrees with the checksum file fails the watch', async () => {
  const payload = Buffer.alloc(MIN_EXE_BYTES + 1024, 9);
  const actual = crypto.createHash('sha256').update(payload).digest('hex');
  const expected = 'b'.repeat(64);
  const sums = `${expected}  ${EXE}\n`;
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path === '/api/v1/repos/Archaejon/SefariaLens/releases/tags/v1.2.3') {
      return send(200, {
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: [
          { name: EXE, size: payload.length, browser_download_url: `${server.base}/download/${EXE}` },
          { name: 'SHA256SUMS.txt', size: sums.length, browser_download_url: `${server.base}/download/SHA256SUMS.txt` },
        ],
      });
    }
    if (path === '/download/SHA256SUMS.txt') return send(200, sums, 'text/plain');
    if (path === `/download/${EXE}`) return send(200, payload, 'application/octet-stream');
    send(404, {});
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      ciUrl: server.base,
      forgeUrl: server.base,
      verifyDownload: true,
      intervalMs: 5,
      timeoutMs: 10000,
      log,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'checksum mismatch');
    assert.strictEqual(result.verification.expected, expected);
    assert.strictEqual(result.verification.actual, actual);
    const output = lines.join('\n');
    assert.match(output, /does not verify/);
    assert.match(output, new RegExp(`expected\\s+${expected}`));
    assert.match(output, new RegExp(`actual\\s+${actual}`));
  } finally {
    await server.close();
  }
});

test('an exe that cannot be downloaded is reported, not silently accepted', async () => {
  const digest = 'c'.repeat(64);
  const sums = `${digest}  ${EXE}\n`;
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path === '/api/v1/repos/Archaejon/SefariaLens/releases/tags/v1.2.3') {
      return send(200, {
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: [
          { name: EXE, size: MIN_EXE_BYTES + 1024, browser_download_url: `${server.base}/missing/${EXE}` },
          { name: 'SHA256SUMS.txt', size: sums.length, browser_download_url: `${server.base}/download/SHA256SUMS.txt` },
        ],
      });
    }
    if (path === '/download/SHA256SUMS.txt') return send(200, sums, 'text/plain');
    send(404, {});
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      ciUrl: server.base,
      forgeUrl: server.base,
      verifyDownload: true,
      intervalMs: 5,
      timeoutMs: 10000,
      log,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'checksum unreadable');
    assert.match(result.verification.error, /download failed: HTTP 404/);
    assert.ok(lines.some((line) => /download failed: HTTP 404/.test(line)), lines.join('\n'));
  } finally {
    await server.close();
  }
});

test('a successful pipeline with no exe is not reported as a release', async () => {
  const { lines, log } = collectingLog();
  const server = await fakeServer(({ path, send }) => {
    if (path === '/api/repos/lookup/Archaejon/SefariaLens') return send(200, { id: 7 });
    if (path === '/api/repos/7/pipelines') {
      return send(200, [{ number: 12, event: 'tag', ref: 'refs/tags/v1.2.3', status: 'success' }]);
    }
    if (path === '/api/repos/7/pipelines/12') {
      return send(200, { number: 12, event: 'tag', ref: 'refs/tags/v1.2.3', status: 'success', workflows: [] });
    }
    send(404, {});
  });

  try {
    const result = await watchRelease({
      repo: parseRepoUrl('ssh://git@codeberg.org/Archaejon/SefariaLens.git'),
      tag: 'v1.2.3',
      token: 'secret-token',
      ciUrl: server.base,
      forgeUrl: server.base,
      intervalMs: 5,
      graceMs: 40,
      timeoutMs: 5000,
      log,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'assets missing');
    assert.ok(lines.some((line) => /succeeded, but v1\.2\.3 is incomplete/.test(line)), lines.join('\n'));
  } finally {
    await server.close();
  }
});
