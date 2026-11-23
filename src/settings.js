'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  provider: 'openai',
  model: '',
  baseUrl: '',
  apiKey: '',
  style: 'modern',
  diacritics: true,
  showEnglish: true,
  showHebrew: true,
  showTranslit: true,
  showCommentaries: true,
  // 0 means show the whole section; otherwise this many segments at first,
  // with a "show more" control for the rest.
  pageSize: 0,
  // Set once the first-run wizard is finished or skipped, so it never nags.
  setupComplete: false,
  fontSize: 20,
  category: '',
  // How long a local model stays in memory after the last request. Long enough
  // to avoid a 5-second reload between questions, short enough that an idle
  // app is not holding 5 GB. "Free memory" in Settings unloads it immediately.
  keepAlive: '15m',
  // One context window for every task, so the model never reloads at a new
  // size. 4096 suits a ranking prompt of six short passages; raise it only if
  // the machine has memory to spare.
  numCtx: 4096,
  // Generate English for untranslated passages as soon as one is opened. Off
  // by default: it costs a local model a minute of inference per passage.
  autoTranslate: false,
};

const ENV_OVERRIDES = {
  apiKey: 'SEFARIA_LENS_API_KEY',
  baseUrl: 'SEFARIA_LENS_BASE_URL',
  model: 'SEFARIA_LENS_MODEL',
  provider: 'SEFARIA_LENS_PROVIDER',
};

/** Persisted app settings. The API key is encrypted by the caller when available. */
class Settings {
  constructor(file, { encrypt, decrypt, env = process.env } = {}) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.env = env;
    this.data = { ...DEFAULTS };
    // What the file holds for each value an environment variable is standing
    // in for, so a save writes that back rather than the override.
    this.shadowed = {};
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const secret = raw.apiKey;
      const data = { ...DEFAULTS, ...raw };
      data.apiKey = this.decrypt && secret ? this.decrypt(secret) : (secret || '');
      this.data = data;
    } catch { /* first run */ }

    // Environment overrides make headless testing and CI possible. They apply
    // to this run only: a key handed over in the environment must not end up
    // in the settings file because some unrelated setting was saved.
    this.shadowed = {};
    for (const [field, name] of Object.entries(ENV_OVERRIDES)) {
      if (!this.env[name]) continue;
      this.shadowed[field] = this.data[field];
      this.data[field] = this.env[name];
    }
  }

  get() {
    return { ...this.data };
  }

  /** Settings safe to send to the renderer: the key is never echoed back. */
  public() {
    const { apiKey, ...rest } = this.data;
    return { ...rest, hasKey: Boolean(apiKey) };
  }

  set(patch) {
    const next = { ...this.data };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS)) continue;
      next[k] = v;
      // A value the user sets replaces the override for good.
      delete this.shadowed[k];
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiKey') && patch.apiKey === '') {
      next.apiKey = '';
    }
    this.data = next;
    this.save();
    return this.public();
  }

  save() {
    const out = { ...this.data, ...this.shadowed };
    if (this.encrypt && out.apiKey) out.apiKey = this.encrypt(out.apiKey);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch { /* non-fatal */ }
  }
}

module.exports = { Settings, DEFAULTS };
