'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
