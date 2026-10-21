'use strict';

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Sefaria Lens talks to any endpoint that implements POST /chat/completions with
 * a bearer token. That keeps the provider a user choice rather than a hard
 * dependency, and lets people point it at a local Ollama install if they prefer.
 *
 * Everything that decides *how much* a request costs lives in this file:
 *
 *  - TASKS gives each kind of request its own output ceiling and temperature,
 *    so a one-word gloss cannot generate a paragraph.
 *  - One context window per session (config.numCtx) keeps Ollama from
 *    reloading the model when a differently sized task arrives.
 *  - A gate serialises local inference: a second request waits instead of
 *    competing for the same GPU, and a third is refused with a clear message.
 *  - Identical requests already in flight are shared, not duplicated.
 *  - keep_alive holds the model for a configurable while after the last use,
 *    and `freeMemory()` gives that memory back on demand.
 */

const crypto = require('node:crypto');
const { pipeRequest, DEFAULT_PIPE } = require('./pipe.js');
const { Ollama } = require('./ollama.js');
const { schemaFor } = require('./schemas.js');

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyHint: 'sk-...',
    docs: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyHint: 'sk-or-...',
    docs: 'https://openrouter.ai/keys',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyHint: 'gsk_...',
    docs: 'https://console.groq.com/keys',
  },
  ollama: {
    label: 'Ollama (local, no key)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    keyHint: 'ollama',
    docs: 'https://ollama.com',
    local: true,
    native: true,
  },
  openllm: {
    label: 'OpenLLM gateway',
    baseUrl: 'https://api.openllm.sh/v1',
    model: 'gpt-4o-mini',
    keyHint: 'ol-...',
    docs: 'https://openllm.sh',
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: '',
    model: '',
    keyHint: 'API key',
    docs: '',
  },
  freebuff: {
    label: 'Freebuff (local pipe)',
    baseUrl: DEFAULT_PIPE,
    model: 'freebuff',
    keyHint: '',
    docs: '',
    local: true,
    pipe: true,
  },
};

/**
 * How much output each job is allowed, and how hot the model should run.
 * Two paragraphs of answer, one line of gloss: a local model generating 450
 * tokens it will never use is a minute of GPU time spent for nothing.
 */
const TASKS = {
  plan: { maxTokens: 260, temperature: 0.1, json: true, schema: 'plan' },
  rank: { maxTokens: 1200, temperature: 0.2, json: true, schema: 'rank' },
  gloss: { maxTokens: 300, temperature: 0.1, json: true, schema: 'gloss' },
  translate: { maxTokens: 1600, temperature: 0.1, json: true, schema: 'translate' },
  'translate.selection': { maxTokens: 700, temperature: 0.1, json: true, schema: 'translate.selection' },
  test: { maxTokens: 12, temperature: 0, json: false },
  custom: { maxTokens: 1400, temperature: 0.2, json: false },
};

/**
 * Ceilings for a model running on this machine. A local 8B model writes about
 * eight tokens a second here, so the ceiling is the difference between a
 * twenty-second answer and a two-minute one; a cloud model still gets the room
 * it needs. A caller can override any of these.
 */
const LOCAL_CAPS = {
  plan: 160,
  rank: 320,
  gloss: 120,
  translate: 700,
  'translate.selection': 300,
  test: 12,
  custom: 600,
};

/** Model ids from either the OpenAI list shape or Ollama's native tag list. */
function modelIds(payload) {
  const rows = Array.isArray(payload && payload.data)
    ? payload.data
    : Array.isArray(payload && payload.models) ? payload.models : [];
  const names = rows.map((m) => (m && (m.id || m.name || m.model)) || '').filter(Boolean);
  return [...new Set(names)];
}

/** "llama3.1" and "llama3.1:latest" name the same local model. */
function modelMatches(installed, wanted) {
  const clean = (s) => String(s || '').trim().replace(/^models\//, '');
  const a = clean(installed);
  const b = clean(wanted);
  if (!a || !b) return false;
  return a === b || `${a}:latest` === b || a === `${b}:latest`;
}

/** Ollama's native tag endpoint, for servers without /v1/models. */
function nativeTagsUrl(baseUrl) {
  try { return `${new URL(baseUrl).origin}/api/tags`; } catch { return ''; }
}

class LLMError extends Error {
  constructor(message, { code = 'LLM_ERROR', status } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
  }
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* keep trying */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

function cancelled() {
  return new LLMError('Cancelled.', { code: 'CANCELLED' });
}

/**
 * A one-slot queue with a bounded waiting room.
 *
 * Ollama answers one request at a time; sending three at once only makes each
 * of them slower and holds the model longer. Callers wait their turn, and a
 * flood is refused rather than allowed to pile up behind a minute-long answer.
 */
class Gate {
  constructor(limit = 1, maxQueue = 2) {
    this.limit = Math.max(1, limit);
    this.maxQueue = Math.max(0, maxQueue);
    this.active = 0;
    this.waiting = [];
  }

  run(task, signal) {
    if (signal && signal.aborted) return Promise.reject(cancelled());
    if (this.active < this.limit) return this.start(task);
    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(new LLMError(
        'The local model is busy with another request. Wait for it to finish, or stop it first.',
        { code: 'BUSY' },
      ));
    }
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, signal, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const at = this.waiting.indexOf(entry);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(cancelled());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.waiting.push(entry);
    });
  }

  start(task) {
    this.active += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        this.active -= 1;
        this.drain();
      });
  }

  drain() {
    while (this.active < this.limit && this.waiting.length) {
      const entry = this.waiting.shift();
      if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort);
      if (entry.signal && entry.signal.aborted) { entry.reject(cancelled()); continue; }
      this.active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => { this.active -= 1; this.drain(); });
    }
  }
}

class LLM {
  constructor({ getSettings, fetchImpl = fetch, pipeImpl = pipeRequest, ollama } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.fetchImpl = fetchImpl;
    this.pipeImpl = pipeImpl;
    this.ollama = ollama || new Ollama({ fetchImpl });
    this.gates = new Map();
    this.inFlight = new Map();
    this.statusCache = null;
    this.statusTtlMs = 20_000;
    this.backoff = null;
    this.modelCache = new Map();
    this.psCache = { at: 0, models: [] };
  }

  config(overrides = {}) {
    const s = { ...(this.getSettings() || {}), ...(overrides || {}) };
    const provider = s.provider || 'openai';
    const preset = PROVIDERS[provider] || PROVIDERS.openai;
    const baseUrl = (provider === 'custom' || s.baseUrl ? (s.baseUrl || preset.baseUrl) : preset.baseUrl)
      .replace(/\/+$/, '');
    const model = s.model || preset.model;
    const numCtx = Number(s.numCtx) > 0 ? Number(s.numCtx) : 4096;
    return {
      provider,
      baseUrl,
      model,
      apiKey: s.apiKey || '',
      // A local model on a CPU can spend minutes on a long prompt; cloud
      // endpoints answer in seconds and should still fail fast.
      timeoutMs: s.timeoutMs || (preset.local ? 300000 : 60000),
      local: Boolean(preset.local),
      native: Boolean(preset.native),
      // One context size for every task, so switching between a gloss and a
      // question does not make Ollama reload the model at a new window size.
      numCtx,
      // A negative keep_alive means "until I say otherwise"; Ollama wants that
      // as a number, and a duration ("15m") as a string.
      keepAlive: String(s.keepAlive) === '-1'
        ? -1
        : (typeof s.keepAlive === 'string' && s.keepAlive ? s.keepAlive : '15m'),
      concurrency: Number.isFinite(Number(s.concurrency)) && Number(s.concurrency) > 0
        ? Number(s.concurrency) : (preset.local ? 1 : 2),
      configured: Boolean(baseUrl && model && (s.apiKey || preset.local)),
    };
  }

  /** Output ceiling and temperature for a job, with per-call overrides. */
  task(name, overrides = {}) {
    const base = TASKS[name] || TASKS.custom;
    const key = TASKS[name] ? name : 'custom';
    const local = Boolean((PROVIDERS[this.config().provider] || {}).local);
    const ceiling = local ? Math.min(base.maxTokens, LOCAL_CAPS[key] ?? base.maxTokens) : base.maxTokens;
    return {
      name: key,
      maxTokens: overrides.maxTokens || ceiling,
      temperature: overrides.temperature != null ? overrides.temperature : base.temperature,
      json: overrides.json != null ? overrides.json : base.json,
      schema: base.schema || null,
    };
  }

  /** Prompt tokens a task may use, after its own output and a safety margin. */
  promptBudget(profile, cfg = this.config()) {
    const reserve = (profile.maxTokens || 0) + 96;
    return Math.max(256, cfg.numCtx - reserve);
  }

  gateFor(cfg) {
    const key = `${cfg.provider}|${cfg.concurrency}`;
    if (!this.gates.has(key)) this.gates.set(key, new Gate(cfg.concurrency));
    return this.gates.get(key);
  }

  async models(overrides = {}) {
    const cfg = this.config(overrides);
    if (!cfg.baseUrl) return { ok: false, models: [], error: 'No endpoint is configured.' };
    const cached = this.modelCache.get(cfg.baseUrl);
    if (cached && Date.now() - cached.at < 60_000 && !overrides.fresh) {
      return { ...cached.value, cached: true };
    }
    const preset = PROVIDERS[cfg.provider] || {};
    const timeoutMs = overrides.timeoutMs || 4000;

    if (preset.pipe) {
      try {
        await this.pipeImpl(cfg.baseUrl, { type: 'ping' }, { timeoutMs });
        return { ok: true, models: [cfg.model], endpoint: cfg.baseUrl };
      } catch (err) {
        return { ok: false, models: [], error: err.message };
      }
    }

    // Ollama's own list first: it is what `ollama list` shows, tags included.
    if (preset.native && await this.ollama.supportsNative(cfg.baseUrl)) {
      try {
        const models = await this.ollama.tags(cfg.baseUrl, { timeoutMs });
        const value = { ok: true, models, endpoint: `${new URL(cfg.baseUrl).origin}/api/tags` };
        this.modelCache.set(cfg.baseUrl, { at: Date.now(), value });
        return value;
      } catch (err) {
        return { ok: false, models: [], error: err.message };
      }
    }

    const get = async (url) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'Authorization': `Bearer ${cfg.apiKey || 'local'}` },
          signal: ctrl.signal,
        });
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, data: await res.json() };
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const list = await get(`${cfg.baseUrl}/models`);
      if (list.ok) return { ok: true, models: modelIds(list.data), endpoint: `${cfg.baseUrl}/models` };
      if (preset.local) {
        const tagsUrl = nativeTagsUrl(cfg.baseUrl);
        if (tagsUrl) {
          const tags = await get(tagsUrl);
          if (tags.ok) return { ok: true, models: modelIds(tags.data), endpoint: tagsUrl };
        }
      }
      return { ok: false, models: [], error: `The endpoint answered ${list.status} for its model list.` };
    } catch (err) {
      return {
        ok: false,
        models: [],
        error: err.name === 'AbortError' ? 'The endpoint did not answer in time.' : err.message,
      };
    }
  }

  /**
   * State of a (usually local) provider, with guidance a person can act on:
   * server not running, no models installed, or the chosen model missing.
   *
   * Cached for a few seconds and backed off after a failure, so opening
   * Settings twice does not mean two probes and a dead server is not hammered.
   */
  async status(overrides = {}) {
    const cfg = this.config(overrides);
    const key = `${cfg.provider}|${cfg.baseUrl}|${cfg.model}`;
    const now = Date.now();
    if (!overrides.force && this.statusCache && this.statusCache.key === key) {
      if (now - this.statusCache.at < this.statusTtlMs) return { ...this.statusCache.value, cached: true };
      if (this.backoff && this.backoff.key === key && now < this.backoff.until) {
        return { ...this.statusCache.value, cached: true, retryInMs: this.backoff.until - now };
      }
    }

    const preset = PROVIDERS[cfg.provider] || {};
    const local = Boolean(preset.local);
    let result;
    // A forced check really probes: the model list has its own short cache, and
    // the whole point of the button is to look again now.
    const probe = { ...overrides, fresh: Boolean(overrides.force) };
    if (preset.pipe) {
      const found = await this.models(probe);
      result = {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        local: true,
        running: Boolean(found.ok),
        models: found.models || [],
        modelInstalled: Boolean(found.ok),
        ready: Boolean(found.ok),
        message: found.ok
          ? `The Freebuff pipe is listening at ${cfg.baseUrl}.`
          : `${found.error || `Nothing is listening at ${cfg.baseUrl}.`}${/Start it with/.test(found.error || '') ? '' : ' Start it with “npm run freebuff-fifo”.'}`,
      };
    } else {
      const found = await this.models(probe);
      const installed = found.models || [];
      const running = Boolean(found.ok);
      const modelInstalled = Boolean(cfg.model) && installed.some((m) => modelMatches(m, cfg.model));
      const label = (preset.label || 'The endpoint').replace(/\s*\(.*\)$/, '');
      const pull = cfg.model || preset.model || 'a model';
      let message;
      if (!running) {
        message = local
          ? `${label} is not answering at ${cfg.baseUrl}. Install it from ${preset.docs || 'ollama.com'} and start it, then check again.`
          : `Nothing answered at ${cfg.baseUrl}.`;
      } else if (!installed.length) {
        message = `${label} is running but has no models installed.`
          + (local ? ` Run “ollama pull ${pull}”, then check again.` : '');
      } else if (!modelInstalled) {
        message = `${label} is running, but “${pull}” is not installed.`
          + (local ? ` Run “ollama pull ${pull}”, or pick one of: ${installed.slice(0, 5).join(', ')}.` : '');
      } else {
        message = `${label} is ready — ${installed.length} model${installed.length === 1 ? '' : 's'} installed.`;
      }
      result = {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        local,
        running,
        models: installed,
        modelInstalled,
        ready: running && modelInstalled,
        message,
      };
    }

    // Which model is in memory, how big, and whether it is actually on the GPU.
    if (preset.native && result.ready) {
      try {
        const loaded = await this.ollama.ps(cfg.baseUrl, { timeoutMs: 2500 });
        const mine = loaded.find((m) => modelMatches(m.name, cfg.model));
        result.loaded = mine || null;
        if (mine) {
          result.message += ` ${mine.name} is loaded (${mine.size || '?'} GB`
            + `${mine.vram ? `, ${Math.round((mine.vram / mine.size) * 100)}% in VRAM` : ''}, context ${mine.contextLength || '?'}).`;
        }
      } catch { /* placement is a nicety, not a requirement */ }
    }

    this.statusCache = { key, at: now, value: result };
    if (result.ready) this.backoff = null;
    else this.backoff = { key, until: now + Math.min(60_000, 5000 * Math.pow(2, this.failures = (this.failures || 0) + 1)) };
    return result;
  }

  /** Loaded models, for the "free memory" control and the status line. */
  async ps(overrides = {}) {
    const cfg = this.config(overrides);
    if (!cfg.native) return [];
    try {
      const models = await this.ollama.ps(cfg.baseUrl, { timeoutMs: 2500 });
      this.psCache = { at: Date.now(), models };
      return models;
    } catch {
      return this.psCache.models;
    }
  }

  /** Give the model's memory back now rather than waiting for keep_alive. */
  async freeMemory(overrides = {}) {
    const cfg = this.config(overrides);
    if (!cfg.native) return { unloaded: false, reason: 'The configured provider does not run a local model.' };
    await this.ollama.unload(cfg.model, cfg.baseUrl);
    this.psCache = { at: 0, models: [] };
    this.statusCache = null;
    return { unloaded: true, model: cfg.model };
  }

  /**
   * One chat completion.
   *
   * Options: task, json, temperature, maxTokens, signal, onToken, onStatus,
   * dedupe. The same request already in flight is shared when no streaming
   * callbacks are attached, which is what keeps a double-clicked word from
   * costing two generations.
   */
  async chat(messages, opts = {}) {
    const cfg = this.config();
    if (!cfg.configured) {
      throw new LLMError('No AI provider is configured. Add an API key in Settings to ask questions.', { code: 'NO_API_KEY' });
    }
    const profile = this.task(opts.task, opts);
    const key = (opts.dedupe === false || opts.onToken || opts.onStatus) ? null : this.requestKey(cfg, messages, profile);
    if (key && this.inFlight.has(key)) return this.inFlight.get(key);

    const gate = this.gateFor(cfg);
    if (opts.onStatus && gate.active >= gate.limit) {
      opts.onStatus({ phase: 'queued', model: cfg.model, local: cfg.local });
    }
    const run = () => this.send(cfg, messages, profile, opts);
    const promise = gate.run(run, opts.signal);
    if (key) {
      this.inFlight.set(key, promise);
      promise.then(() => this.inFlight.delete(key), () => this.inFlight.delete(key));
    }
    return promise;
  }

  requestKey(cfg, messages, profile) {
    const h = crypto.createHash('sha1');
    h.update(`${cfg.provider}|${cfg.baseUrl}|${cfg.model}|${profile.maxTokens}|${profile.temperature}|${profile.json}`);
    for (const m of messages) h.update(`|${m.role}:${m.content}`);
    return h.digest('hex');
  }

  async send(cfg, messages, profile, opts) {
    const emit = (event) => { if (opts.onStatus) opts.onStatus(event); };
    const preset = PROVIDERS[cfg.provider] || {};
    emit({ phase: 'starting', provider: cfg.provider, model: cfg.model, local: cfg.local });

    if (preset.native && await this.ollama.supportsNative(cfg.baseUrl)) {
      return this.sendNative(cfg, messages, profile, opts, emit);
    }
    if (preset.pipe) return this.sendPipe(cfg, messages, profile, opts);
    return this.sendOpenAI(cfg, messages, profile, opts);
  }

  async sendNative(cfg, messages, profile, opts, emit) {
    // Say "preparing the model" only when it really has to be read from disk.
    try {
      const loaded = Date.now() - this.psCache.at < 3000
        ? this.psCache.models
        : await this.ollama.ps(cfg.baseUrl, { timeoutMs: 1200 }).catch(() => []);
      this.psCache = { at: Date.now(), models: loaded };
      if (!loaded.some((m) => modelMatches(m.name, cfg.model))) {
        emit({ phase: 'preparing', model: cfg.model });
      }
    } catch { /* the request itself will report a real failure */ }

    let first = true;
    try {
      // A structured-output grammar is what keeps a local model from wrapping
      // its JSON in prose — and from needing a second generation to fix it.
      const format = profile.schema ? schemaFor(profile.schema) : (profile.json ? 'json' : null);
      const run = (fmt) => this.ollama.chat({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        messages,
        format: fmt,
        temperature: profile.temperature,
        numPredict: profile.maxTokens,
        numCtx: cfg.numCtx,
        keepAlive: opts.keepAlive || cfg.keepAlive,
        timeoutMs: cfg.timeoutMs,
        signal: opts.signal,
        onToken: (delta) => {
          if (first) {
            first = false;
            emit({ phase: 'generating', model: cfg.model });
          }
          if (opts.onToken) opts.onToken(delta);
        },
      });
      let out;
      try {
        out = await run(format);
      } catch (err) {
        // An older Ollama may not accept a schema object in `format`; a plain
        // JSON mode still constrains the shape enough to parse.
        if (profile.schema && err.status === 400) out = await run('json');
        else throw err;
      }
      emit({ phase: 'done', timings: out.timings });
      this.psCache.at = 0;
      return out.text;
    } catch (err) {
      const mapped = err.code === 'CANCELLED' ? cancelled() : err;
      // A person who pressed Stop does not need to be told the model stopped.
      if (mapped.code !== 'CANCELLED') {
        emit({ phase: 'error', code: mapped.code || 'PROVIDER_ERROR', message: mapped.message });
      }
      throw mapped;
    }
  }

  async sendPipe(cfg, messages, profile, opts) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, cfg.timeoutMs);
    if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
      const reply = await this.pipeImpl(cfg.baseUrl, {
        messages,
        json: profile.json,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
      }, { timeoutMs: cfg.timeoutMs, signal: ctrl.signal });
      if (!reply || typeof reply.text !== 'string' || !reply.text.trim()) {
        throw new LLMError('The Freebuff pipe returned an empty response.', { code: 'EMPTY_RESPONSE' });
      }
      return reply.text;
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw cancelled();
      if (err instanceof LLMError) throw err;
      const code = err && err.code === 'PIPE_TIMEOUT' ? 'TIMEOUT'
        : err && (err.code === 'PIPE_DOWN' || err.code === 'PIPE_CLOSED' || err.code === 'PIPE_ERROR') ? 'LOCAL_DOWN'
          : 'PROVIDER_ERROR';
      throw new LLMError(err.message || 'The Freebuff pipe failed.', { code });
    } finally {
      clearTimeout(timer);
    }
  }

  async sendOpenAI(cfg, messages, profile, opts) {
    const preset = PROVIDERS[cfg.provider] || {};
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, cfg.timeoutMs);
    if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

    const body = {
      model: cfg.model,
      messages,
      temperature: profile.temperature,
      max_tokens: profile.maxTokens,
    };
    if (profile.json) body.response_format = { type: 'json_object' };

    const send = (payload) => this.fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey || 'local'}`,
        'HTTP-Referer': 'https://sefaria.org',
        'X-Title': 'Sefaria Lens',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    try {
      let res = await send(body);
      let raw = await res.text();
      // Some local servers do not implement response_format and reject the
      // request outright. The prompt already asks for JSON, so retry plain.
      if (!res.ok && profile.json && (res.status === 400 || res.status === 422)
        && /response_format|json/i.test(raw)) {
        const { response_format, ...plain } = body;
        res = await send(plain);
        raw = await res.text();
      }
      if (!res.ok) {
        let detail = raw.slice(0, 300);
        try {
          const j = JSON.parse(raw);
          detail = (j.error && (j.error.message || j.error.type)) || detail;
        } catch { /* plain text body */ }
        if (res.status === 401 || res.status === 403) {
          throw new LLMError(`The AI provider rejected the API key: ${detail}`, { code: 'BAD_KEY', status: res.status });
        }
        if (res.status === 429) {
          throw new LLMError('The AI provider rate-limited this request. Wait a moment and try again.', { code: 'RATE_LIMIT', status: res.status });
        }
        if (res.status === 404 && /model/i.test(detail)) {
          const available = await this.models({ provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, fresh: true })
            .catch(() => ({ models: [] }));
          const names = (available.models || []).slice(0, 8);
          throw new LLMError(
            `The model “${cfg.model}” is not available at ${cfg.baseUrl}.`
            + (names.length ? ` Installed models: ${names.join(', ')}.` : '')
            + (preset.local ? ` Pull it with “ollama pull ${cfg.model}”.` : ''),
            { code: 'MODEL_NOT_FOUND', status: 404 },
          );
        }
        throw new LLMError(`AI provider error (${res.status}): ${detail}`, { code: 'PROVIDER_ERROR', status: res.status });
      }
      let data;
      try { data = JSON.parse(raw); } catch {
        throw new LLMError('AI provider returned an unreadable response', { code: 'BAD_RESPONSE' });
      }
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      if (!content) throw new LLMError('AI provider returned an empty response', { code: 'EMPTY_RESPONSE' });
      return content;
    } catch (err) {
      if (err instanceof LLMError) throw err;
      if ((opts.signal && opts.signal.aborted) && !timedOut) throw cancelled();
      if (err.name === 'AbortError') {
        throw new LLMError(
          preset.local
            ? `The local model did not answer within ${Math.round(cfg.timeoutMs / 1000)}s. Try a smaller model or a shorter passage list.`
            : 'The AI request timed out. Try a shorter question or a faster model.',
          { code: 'TIMEOUT' },
        );
      }
      throw new LLMError(
        preset.local
          ? `Could not reach ${preset.label || 'the local endpoint'} at ${cfg.baseUrl}. Start it, then try again.`
          : `Could not reach the AI provider: ${err.message}`,
        { code: preset.local ? 'LOCAL_DOWN' : 'NETWORK' },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async json(messages, opts = {}) {
    const text = await this.chat(messages, { ...opts, json: true });
    const parsed = extractJson(text);
    if (parsed) return parsed;

    // Smaller local models sometimes wrap JSON in prose. One repair turn is
    // cheaper than failing the whole answer, and it is bounded to one retry.
    // A native Ollama call constrains the output to JSON, so this only fires
    // for providers without that guarantee.
    const repaired = await this.chat([
      ...messages,
      { role: 'assistant', content: text.slice(0, 1200) },
      {
        role: 'user',
        content: 'That reply was not valid JSON. Return only the JSON object described above — no prose, no code fences, no trailing text.',
      },
    ], {
      ...opts,
      json: true,
      temperature: 0,
      maxTokens: Math.min(400, opts.maxTokens || 400),
      // The repair is a second generation: never paint it into the draft the
      // person is already reading.
      onToken: undefined,
      onStatus: undefined,
    });
    const second = extractJson(repaired);
    if (!second) throw new LLMError('The AI response was not valid JSON', { code: 'BAD_JSON' });
    return second;
  }

  async test() {
    const cfg = this.config();
    if (!cfg.configured) throw new LLMError('No AI provider is configured.', { code: 'NO_API_KEY' });
    const out = await this.chat([
      { role: 'system', content: 'Reply with exactly one word: ready' },
      { role: 'user', content: 'ping' },
    ], { task: 'test', maxTokens: 16, temperature: 0 });
    return { ok: true, model: cfg.model, provider: cfg.provider, reply: out.trim().slice(0, 80) };
  }
}

module.exports = { LLM, LLMError, PROVIDERS, TASKS, LOCAL_CAPS, Gate };
