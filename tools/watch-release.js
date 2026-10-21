'use strict';

/**
 * Watch a tag pipeline on Codeberg CI (Woodpecker) and then check that the
 * portable exe really landed on the forge release.
 *
 * Two independent sources answer two different questions:
 *
 *   - the CI API says whether `test -> build-portable -> release` finished and
 *     which step failed, but it needs a Woodpecker personal access token;
 *   - the forge API says whether the exe and its checksum file are attached to
 *     the release, and is readable without a token because the repository is
 *     public.
 *
 * The forge answer is the one that matters to users, so the watch keeps going
 * without a token: it cannot report pipeline progress, but it can still prove
 * the download exists — and, when asked, that its bytes hash to the digest the
 * release publishes. The token is only ever sent to the CI host.
 */

const crypto = require('node:crypto');

const DEFAULT_CI_URL = 'https://ci.codeberg.org';

// A portable exe is tens of megabytes; ten minutes covers a slow link without
// letting a stalled connection hold the watch open forever.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// A portable Electron build is tens of megabytes. A smaller asset is an error
// page, a LFS pointer, or a truncated upload — never a working app.
const MIN_EXE_BYTES = 5 * 1024 * 1024;

// Woodpecker's terminal states. `skipped` is terminal and is not a success:
// the release step of a tag build must actually run.
const TERMINAL = new Set(['success', 'failure', 'killed', 'canceled', 'error', 'declined', 'skipped']);

/**
 * Turn a git remote into the owner/repo pair the two APIs address. Handles the
 * forms a clone can actually have: `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo.git` and `https://host/owner/repo`.
 */
function parseRepoUrl(remote) {
  const text = String(remote || '').trim();
  if (!text) return null;

  let host;
  let repoPath;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    if (!/^(https?|ssh|git)$/i.test(scheme[1])) return null;
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    host = url.hostname;
    repoPath = url.pathname;
  } else {
    // scp-like syntax: git@codeberg.org:Owner/Repo.git. A Windows drive path
    // (`C:/work/repo.git`) has the same shape, so a single-letter host is a
    // local remote, not a server.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(text);
    if (!scp) return null;
    host = scp[1];
    if (/^[a-zA-Z]$/.test(host) || text.includes('\\')) return null;
    repoPath = scp[2];
  }

  const parts = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const name = parts.pop().replace(/\.git$/i, '');
  const owner = parts.pop();
  if (!host || !owner || !name) return null;
  return {
    host,
    owner,
    name,
    fullName: `${owner}/${name}`,
    htmlUrl: `https://${host}/${owner}/${name}`,
  };
}

/** `v1.0.11` or `1.0.11` -> `1.0.11`; anything else is not a release tag. */
function tagVersion(tag) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(tag || '').trim());
  return m ? m[1] : null;
}

function ciBaseUrl(ciUrl) {
  return String(ciUrl || DEFAULT_CI_URL).replace(/\/+$/, '');
}

function forgeBaseUrl(forgeUrl) {
  return String(forgeUrl).replace(/\/+$/, '');
}

/**
 * Score a pipeline by how specifically it belongs to this tag. Two traps make
 * the obvious checks wrong: the push that carries a release has the same commit
 * as the tag, and two tags can point at the same commit. So a pipeline whose ref
 * names a different tag is rejected outright, and the commit only identifies a
 * pipeline that carries neither a tag ref nor a branch.
 */
function pipelineScore(pipeline, tag, ref, commit) {
  if (!pipeline) return 0;
  if (pipeline.event && pipeline.event !== 'tag') return 0;
  const pipelineRef = String(pipeline.ref || '');
  if (pipelineRef.includes('/tags/')) return pipelineRef === ref ? 5 : 0;
  if (pipeline.branch === tag) return 4;
  if (pipelineRef) return 0;
  if (commit && pipeline.commit === commit) return 2;
  return 0;
}

/** The newest pipeline that belongs to `tag`, or null when none has started. */
function pickPipeline(pipelines, { tag, commit } = {}) {
  const ref = `refs/tags/${tag}`;
  const scored = (Array.isArray(pipelines) ? pipelines : [])
    .filter(Boolean)
    .map((pipeline) => ({ pipeline, score: pipelineScore(pipeline, tag, ref, commit) }))
    .filter((entry) => entry.score > 0);
  scored.sort((a, b) => (b.score - a.score) || ((b.pipeline.number || 0) - (a.pipeline.number || 0)));
  return scored.length ? scored[0].pipeline : null;
}

function workflowStates(pipeline) {
  return (Array.isArray(pipeline && pipeline.workflows) ? pipeline.workflows : [])
    .map((workflow) => ({ name: workflow.name || 'unnamed', state: workflow.state || 'unknown' }));
}

/** `pipeline #12 running [test: success, build-portable: running]` */
function pipelineLine(pipeline) {
  const workflows = workflowStates(pipeline);
  const detail = workflows.length
    ? ` [${workflows.map((w) => `${w.name}: ${w.state}`).join(', ')}]`
    : '';
  return `pipeline #${pipeline.number} ${pipeline.status || 'unknown'}${detail}`;
}

/** Steps that failed, most specific first: a failed step names the cause. */
function failedSteps(pipeline) {
  const out = [];
  for (const workflow of (pipeline && pipeline.workflows) || []) {
    for (const step of workflow.children || []) {
      if (step.state === 'failure' || step.state === 'error') {
        out.push({ name: step.name || workflow.name, id: step.id, workflow: workflow.name });
      }
    }
    if (!(workflow.children || []).length && (workflow.state === 'failure' || workflow.state === 'error')) {
      out.push({ name: workflow.name || 'unnamed', id: workflow.id, workflow: workflow.name });
    }
  }
  return out;
}

function pipelineUrl(ciUrl, repoId, number) {
  return `${ciBaseUrl(ciUrl)}/repos/${repoId}/pipeline/${number}`;
}

/**
 * The digest `SHA256SUMS.txt` claims for `exeName`, or null when the file does
 * not name it. `sha256sum` writes `<digest>  <name>`, and the `*` in `<digest>
 * *<name>` is the binary-mode marker, so both are accepted.
 */
function expectedDigest(checksumText, exeName) {
  for (const raw of String(checksumText || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(raw.trim());
    if (!m) continue;
    const name = m[2].trim();
    if (name === exeName || name.endsWith(`/${exeName}`) || name.endsWith(`\\${exeName}`)) {
      return { digest: m[1].toLowerCase(), name };
    }
  }
  return null;
}

/** SHA-256 of a downloaded file, streamed so an 80 MB exe never lands in memory. */
async function downloadDigest(url, { fetchImpl = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const hash = crypto.createHash('sha256');
  if (response.body) {
    for await (const chunk of response.body) hash.update(chunk);
  } else {
    hash.update(Buffer.from(await response.arrayBuffer()));
  }
  return hash.digest('hex');
}

/**
 * Download the published exe and compare it with the release's own checksum
 * file. Returns the digests either way, so a mismatch can be printed instead of
 * described.
 */
async function verifyExe({ exe, checksumText, exeName, fetchImpl = globalThis.fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const expected = expectedDigest(checksumText, exeName);
  if (!expected) {
    return { ok: false, expected: null, actual: null, error: `SHA256SUMS.txt does not list ${exeName}` };
  }
  if (!exe || !exe.browser_download_url) {
    return { ok: false, expected: expected.digest, actual: null, error: 'the release asset has no download URL' };
  }
  try {
    const actual = await downloadDigest(exe.browser_download_url, { fetchImpl, timeoutMs });
    return actual === expected.digest
      ? { ok: true, expected: expected.digest, actual, error: null }
      : { ok: false, expected: expected.digest, actual, error: 'digest mismatch' };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    return { ok: false, expected: expected.digest, actual: null, error: `download failed: ${detail}` };
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Decide whether a release carries what a user needs: the exe named after this
 * exact version, a non-trivial size, and a checksum file that lists it. A file
 * named for a different version is called out separately, because that is the
 * failure mode where the release looks complete but the download is the wrong
 * build.
 */
function assetReport(release, version, checksumText = null) {
  const exeName = `SefariaLens-${version}-portable.exe`;
  const sumsName = 'SHA256SUMS.txt';
  const problems = [];
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const exe = assets.find((asset) => asset && asset.name === exeName) || null;
  const otherExe = assets.find((asset) => asset && asset !== exe && /-portable\.exe$/i.test(asset.name)) || null;
  const sums = assets.find((asset) => asset && asset.name === sumsName) || null;

  if (!release) {
    problems.push('no release exists for this tag');
  } else {
    if (release.draft) problems.push('the release is still a draft');
    if (!exe) {
      problems.push(otherExe
        ? `the release has ${otherExe.name}, not ${exeName}`
        : `${exeName} is not attached`);
    } else if (Number(exe.size) < MIN_EXE_BYTES) {
      problems.push(`${exeName} is only ${formatBytes(exe.size)}`);
    }
    if (!sums) {
      problems.push(`${sumsName} is not attached`);
    } else if (Number(sums.size) === 0) {
      problems.push(`${sumsName} is empty`);
    } else if (checksumText !== null && !checksumText.includes(exeName)) {
      problems.push(`${sumsName} does not list ${exeName}`);
    }
  }

  return { ok: problems.length === 0, exeName, exe, otherExe, sums, problems };
}

/**
 * A single JSON request that never throws: the watch loop wants to retry on a
 * dropped connection and report a status code, not unwind a stack.
 */
async function requestJson(url, { token = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    const response = await fetchImpl(url, { headers, signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, text, error: null };
  } catch (error) {
    return { status: 0, body: null, text: '', error };
  }
}

/** The tail of the first failed step's log, best effort. Never fatal. */
async function failureLogTail(pipeline, { ciBase, repoId, token, fetchImpl, timeoutMs }) {
  const step = failedSteps(pipeline)[0];
  if (!step || step.id == null || !repoId) return null;
  const res = await requestJson(`${ciBase}/api/repos/${repoId}/logs/${pipeline.number}/${step.id}`, {
    token,
    fetchImpl,
    timeoutMs,
  });
  if (res.status !== 200 || !Array.isArray(res.body)) return null;
  const text = res.body
    .map((entry) => {
      // Woodpecker sends each log line's bytes as an array of integers.
      if (Array.isArray(entry.data)) return Buffer.from(entry.data).toString('utf8');
      return String(entry.data || '');
    })
    .join('');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return null;
  return { step: step.name, lines: lines.slice(-12) };
}

function indent(lines, prefix = '    ') {
  return lines.map((line) => `${prefix}${line}`).join('\n');
}

/**
 * Follow one tag from pipeline start to release assets.
 *
 * Resolves with `{ ok, pipeline, release, report, reason }`; it never throws for
 * a failed build, a missing asset, or a timeout, because those are answers the
 * caller wants to print rather than exceptions.
 */
async function watchRelease(options) {
  const {
    repo,
    tag,
    version = tagVersion(tag),
    commit = null,
    ciUrl = DEFAULT_CI_URL,
    forgeUrl = repo ? `https://${repo.host}` : 'https://codeberg.org',
    token = null,
    timeoutMs = 40 * 60 * 1000,
    intervalMs = 15000,
    graceMs = 2 * 60 * 1000,
    // A 404 from the repository lookup is definitive: Woodpecker does not have
    // this repository, so no tag pipeline can start. Waiting the full timeout
    // would just delay the activation hint.
    missingRepoGraceMs = 60 * 1000,
    // Off by default here because it costs a full download; the release command
    // turns it on unless `--no-verify-download` is given.
    verifyDownload = false,
    downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
  } = options || {};

  if (!repo) throw new Error('watchRelease needs a parsed repository');
  if (!tag) throw new Error('watchRelease needs a tag');

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const ciBase = ciBaseUrl(ciUrl);
  const forgeBase = forgeBaseUrl(forgeUrl);
  const releaseUrl = `${repo.htmlUrl}/releases/tag/${tag}`;
  const apiRepo = `${forgeBase}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  log(`Watching ${repo.fullName} for ${tag} (giving up after ${formatDuration(timeoutMs)}).`);
  log(`  release   ${releaseUrl}`);
  log(`  CI        ${ciBase}`);

  let repoId = null;
  let repoLogged = false;
  let ciBlocked = !token;
  let ciBlockReason = token ? '' : 'the pipeline could not be read without a token';
  let ciMissing = false;
  let ciMissingAt = 0;
  let pipeline = null;
  let lastPipelineLine = '';
  let releaseSeen = false;
  let checksumText = null;
  let checksumError = '';
  let checksumTried = false;
  let verification = null;
  let lastProblemLine = '';
  let finishedAt = 0;
  let assetsCompleteAt = 0;
  let lastNetworkNote = '';

  if (!token) {
    log('  note      no SEFARIA_LENS_CI_TOKEN, so the pipeline itself is not visible; watching the release instead.');
  }

  const describeProblems = (report) => {
    const line = report.problems.join('; ');
    if (line === lastProblemLine) return;
    lastProblemLine = line;
    log(`  waiting   ${line}`);
  };

  for (;;) {
    // --- pipeline -------------------------------------------------------
    if (!ciBlocked && !repoId && !ciMissing) {
      const res = await requestJson(`${ciBase}/api/repos/lookup/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, {
        token,
        fetchImpl,
      });
      if (res.status === 200 && res.body && res.body.id) {
        repoId = res.body.id;
        if (!repoLogged) {
          repoLogged = true;
          log(`  pipeline  ${ciBase}/repos/${repoId}`);
        }
      } else if (res.status === 401 || res.status === 403) {
        ciBlocked = true;
        ciBlockReason = 'the CI token was rejected';
        log('  note      the CI token was rejected; watching the release only.');
      } else if (res.status === 404) {
        ciMissing = true;
        ciMissingAt = now();
        log(`  note      CI does not know this repository yet — is it enabled at ${ciBase}/repos/add?`);
      } else if (res.error && res.error.message !== lastNetworkNote) {
        lastNetworkNote = res.error.message;
        log(`  note      CI is unreachable (${res.error.message}); retrying.`);
      }
    }

    if (repoId) {
      if (!pipeline) {
        const res = await requestJson(`${ciBase}/api/repos/${repoId}/pipelines?perPage=25&event=tag`, { token, fetchImpl });
        if (res.status === 200 && Array.isArray(res.body)) {
          const found = pickPipeline(res.body, { tag, commit });
          if (found) {
            // The listing is not guaranteed to carry workflow and step states,
            // and a failure report needs them, so read the pipeline once.
            const detail = found.number == null
              ? null
              : await requestJson(`${ciBase}/api/repos/${repoId}/pipelines/${found.number}`, { token, fetchImpl });
            pipeline = detail && detail.status === 200 && detail.body ? detail.body : found;
          }
        } else if (res.status === 401 || res.status === 403) {
          ciBlocked = true;
          ciBlockReason = 'the CI token was rejected';
          log('  note      the CI token was rejected; watching the release only.');
        }
      } else if (!TERMINAL.has(pipeline.status)) {
        const res = await requestJson(`${ciBase}/api/repos/${repoId}/pipelines/${pipeline.number}`, { token, fetchImpl });
        if (res.status === 200 && res.body) pipeline = res.body;
      }
    }

    if (pipeline) {
      const line = pipelineLine(pipeline);
      if (line !== lastPipelineLine) {
        lastPipelineLine = line;
        log(`  ${line}`);
      }
      if (TERMINAL.has(pipeline.status) && pipeline.status !== 'success') {
        if (!finishedAt) finishedAt = now();
        const link = repoId ? pipelineUrl(ciBase, repoId, pipeline.number) : `${ciBase}/repos/${repoId}`;
        log(`✗ ${tag} was pushed, but pipeline #${pipeline.number} ended ${pipeline.status}; nothing was published.`);
        if (repoId) log(`  pipeline  ${link}`);
        const tail = await failureLogTail(pipeline, { ciBase, repoId, token, fetchImpl, timeoutMs: 15000 });
        if (tail) log(`  last lines of "${tail.step}":\n${indent(tail.lines)}`);
        log(`  Re-run the pipeline, then check it with: npm run release -- --watch ${tag}`);
        return {
          ok: false,
          pipeline,
          release: null,
          report: null,
          reason: `pipeline ${pipeline.status}`,
          pipelineUrl: link,
        };
      }
    }

    // --- release --------------------------------------------------------
    const releaseRes = await requestJson(`${apiRepo}/releases/tags/${encodeURIComponent(tag)}`, { fetchImpl });
    const release = releaseRes.status === 200 ? releaseRes.body : null;

    if (releaseRes.error && releaseRes.error.message !== lastNetworkNote) {
      lastNetworkNote = releaseRes.error.message;
      log(`  note      the forge is unreachable (${releaseRes.error.message}); retrying.`);
    }
    if (release && !releaseSeen) {
      releaseSeen = true;
      log(`  release   ${release.draft ? 'created as a draft' : 'created'}; checking assets.`);
    }
    if (release && !checksumTried && Array.isArray(release.assets)) {
      const sums = release.assets.find((asset) => asset && asset.name === 'SHA256SUMS.txt');
      if (sums) {
        // Read the checksum file, not the exe: it is a few hundred bytes and
        // proves the asset it names is the one the release carries.
        checksumTried = true;
        if (sums.browser_download_url) {
          const file = await requestJson(sums.browser_download_url, { fetchImpl });
          if (file.status === 200 && typeof file.text === 'string') checksumText = file.text;
          else checksumError = file.error ? file.error.message : `HTTP ${file.status}`;
        }
      }
    }

    const report = assetReport(release, version, checksumText);
    if (report.ok) {
      if (verifyDownload && !verification) {
        if (!checksumText) {
          verification = {
            ok: false,
            expected: null,
            actual: null,
            error: checksumError ? `could not read SHA256SUMS.txt: ${checksumError}` : 'SHA256SUMS.txt is empty or unreadable',
          };
        } else {
          log(`  verify    downloading ${report.exeName} (${formatBytes(report.exe.size)}) and hashing it…`);
          verification = await verifyExe({
            exe: report.exe,
            checksumText,
            exeName: report.exeName,
            fetchImpl,
            timeoutMs: downloadTimeoutMs,
          });
          if (verification.ok) log(`  sha256    ${verification.actual} matches SHA256SUMS.txt`);
        }
      }
      if (verification && !verification.ok) {
        log(`✗ ${tag} is published, but the exe does not verify:`);
        if (verification.error) log(`  reason    ${verification.error}`);
        log(`  expected  ${verification.expected || 'no digest listed'}`);
        log(`  actual    ${verification.actual || 'not downloaded'}`);
        log(`  release   ${releaseUrl}`);
        return {
          ok: false,
          pipeline,
          release,
          report,
          verification,
          reason: verification.error === 'digest mismatch' ? 'checksum mismatch' : 'checksum unreadable',
        };
      }

      // The attached asset is the proof, but a pipeline that still says running
      // would make the report contradict itself. Give CI a moment to record its
      // own verdict; if it never does, the asset still counts.
      if (!assetsCompleteAt) assetsCompleteAt = now();
      const stillRunning = Boolean(pipeline) && !TERMINAL.has(pipeline.status);
      if (stillRunning && now() < assetsCompleteAt + graceMs) {
        await sleep(Math.max(0, Math.min(intervalMs, assetsCompleteAt + graceMs - now())));
        continue;
      }
      const elapsed = formatDuration(now() - startedAt);
      log(`✓ ${tag} is published with the built exe (checked ${elapsed} after the push).`);
      log(`  release   ${releaseUrl}`);
      log(`  asset     ${report.exeName} (${formatBytes(report.exe.size)})`);
      log(`  asset     SHA256SUMS.txt (${formatBytes(report.sums.size)})`);
      if (pipeline) log(`  build     ${pipelineLine(pipeline)}${stillRunning ? ' (still running)' : ''}`);
      return { ok: true, pipeline, release, report, verification, reason: 'published' };
    }

    // A finished-but-unsuccessful pipeline returned above, so at this point the
    // build is either still running or unobservable. Assets normally appear the
    // moment the release step finishes; after that, wait only a short grace
    // period for the forge to list them, not the whole timeout.
    if (pipeline && pipeline.status === 'success') {
      if (!finishedAt) finishedAt = now();
      describeProblems(report);
      if (now() >= finishedAt + graceMs) {
        log(`✗ pipeline #${pipeline.number} succeeded, but ${tag} is incomplete:`);
        for (const problem of report.problems) log(`    - ${problem}`);
        log(`  release   ${releaseUrl}`);
        log(`  Re-run the pipeline, then check it with: npm run release -- --watch ${tag}`);
        return { ok: false, pipeline, release, report, reason: 'assets missing' };
      }
    } else {
      if (release) describeProblems(report);
      if (ciMissing && !release && now() >= ciMissingAt + missingRepoGraceMs) {
        log(`✗ ${tag} was pushed, but ${ciBase} has no pipeline for ${repo.fullName}; nothing will build it.`);
        log(`  Enable the repository at ${ciBase}/repos/add, then check the tag with:`);
        log(`    npm run release -- --watch ${tag}`);
        return { ok: false, pipeline: null, release: null, report, reason: 'CI not activated' };
      }
      if (now() >= deadline) {
        const because = ciBlocked
          ? ciBlockReason
          : pipeline
            ? `pipeline #${pipeline.number} never finished`
            : 'no tag pipeline appeared';
        log(`✗ ${tag} was pushed, but no complete release appeared within ${formatDuration(timeoutMs)} (${because}).`);
        for (const problem of report.problems) log(`    - ${problem}`);
        log(`  release   ${releaseUrl}`);
        if (pipeline && repoId) log(`  pipeline  ${pipelineUrl(ciBase, repoId, pipeline.number)}`);
        log(`  Re-run once fixed: npm run release -- --watch ${tag}`);
        return { ok: false, pipeline, release, report, reason: 'timed out' };
      }
    }

    const remaining = (finishedAt && pipeline && pipeline.status === 'success' ? finishedAt + graceMs : deadline) - now();
    await sleep(Math.max(0, Math.min(intervalMs, remaining)));
  }
}

module.exports = {
  DEFAULT_CI_URL,
  DOWNLOAD_TIMEOUT_MS,
  MIN_EXE_BYTES,
  TERMINAL,
  parseRepoUrl,
  tagVersion,
  pipelineScore,
  pickPipeline,
  pipelineLine,
  failedSteps,
  assetReport,
  expectedDigest,
  downloadDigest,
  verifyExe,
  formatBytes,
  formatDuration,
  requestJson,
  watchRelease,
};
