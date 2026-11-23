'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_MAX_FILES = 5000;
// namespace-<20 hex>.json, as key() writes them.
const CACHE_FILE = /^.+-[0-9a-f]{20}\.json$/;

// Several caches share one directory with different lifetimes, and a file
// name does not say which wrote it. So a directory is pruned once per process,
// shortly after start, at the longest lifetime any of its caches asked for.
const pending = new Map();
function schedulePrune(dir, ttlMs) {
  const known = pending.get(dir);
  if (known) { known.maxAgeMs = Math.max(known.maxAgeMs, ttlMs); return; }
  const entry = { maxAgeMs: ttlMs };
  pending.set(dir, entry);
  const timer = setTimeout(() => {
    Cache.prune(dir, { maxAgeMs: entry.maxAgeMs }).catch(() => { /* best effort */ });
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Small disk + memory cache. Sefaria asks clients to be gentle, and repeated
 * verse lookups (reader navigation, word panels) are otherwise wasteful.
 */
class Cache {
  constructor(dir, { ttlMs = 1000 * 60 * 60 * 24, maxEntries = 500 } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.mem = new Map();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only FS: memory only */ }
    schedulePrune(dir, ttlMs);
  }

  /**
   * Remove cache files nobody will read again. An expired entry is otherwise
   * only deleted when the same key is asked for, so a year of browsing would
   * leave a year of files. Files older than `maxAgeMs` go, then the oldest
   * beyond `maxFiles`. Only this cache's own file names are touched.
   */
  static async prune(dir, { maxAgeMs = DEFAULT_MAX_AGE_MS, maxFiles = DEFAULT_MAX_FILES, now = Date.now() } = {}) {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return { removed: 0, kept: 0 }; }
    const files = [];
    for (const name of names) {
      if (!CACHE_FILE.test(name)) continue;
      const file = path.join(dir, name);
      try { files.push({ file, mtime: (await fs.promises.stat(file)).mtimeMs }); } catch { /* gone already */ }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let removed = 0;
    let kept = 0;
    for (const { file, mtime } of files) {
      if (now - mtime <= maxAgeMs && kept < maxFiles) { kept += 1; continue; }
      try { await fs.promises.unlink(file); removed += 1; } catch { /* ignore */ }
    }
    return { removed, kept };
  }

  key(namespace, value) {
    const h = crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20);
    return path.join(this.dir, `${namespace}-${h}.json`);
  }

  get(namespace, value) {
    const k = `${namespace}:${value}`;
    const hit = this.mem.get(k);
    if (hit) {
      if (Date.now() - hit.at < this.ttlMs) return hit.data;
      this.mem.delete(k);
    }
    try {
      const file = this.key(namespace, value);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - raw.at < this.ttlMs) {
        this.mem.set(k, raw);
        return raw.data;
      }
      fs.unlinkSync(file);
    } catch { /* miss */ }
    return undefined;
  }

  set(namespace, value, data) {
    const entry = { at: Date.now(), data };
    this.mem.set(`${namespace}:${value}`, entry);
    if (this.mem.size > this.maxEntries) {
      const oldest = this.mem.keys().next().value;
      this.mem.delete(oldest);
    }
    try { fs.writeFileSync(this.key(namespace, value), JSON.stringify(entry)); } catch { /* ignore */ }
  }

  async wrap(namespace, value, fn) {
    const hit = this.get(namespace, value);
    if (hit !== undefined) return hit;
    const data = await fn();
    this.set(namespace, value, data);
    return data;
  }
}

module.exports = { Cache };
