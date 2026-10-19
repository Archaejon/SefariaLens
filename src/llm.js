'use strict';

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Sefaria Lens talks to any endpoint that implements POST /chat/completions with
 * a bearer token. That keeps the provider a user choice rather than a hard
 * dependency, and lets people point it at a local Ollama install if they prefer.
 */

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

class LLM {
  constructor({ getSettings, fetchImpl = fetch } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.fetchImpl = fetchImpl;
  }

  config(overrides = {}) {
    const s = { ...(this.getSettings() || {}), ...(overrides || {}) };
    const provider = s.provider || 'openai';
    const preset = PROVIDERS[provider] || PROVIDERS.openai;
    const baseUrl = (provider === 'custom' || s.baseUrl ? (s.baseUrl || preset.baseUrl) : preset.baseUrl)
      .replace(/\/+$/, '');
    const model = s.model || preset.model;
    return {
      provider,
      baseUrl,
      model,
      apiKey: s.apiKey || '',
      // A local model on a CPU can spend minutes on a long prompt; cloud
      // endpoints answer in seconds and should still fail fast.
      timeoutMs: s.timeoutMs || (preset.local ? 300000 : 60000),
      local: Boolean(preset.local),
      configured: Boolean(baseUrl && model && (s.apiKey || preset.local)),
    };
  }

  /** Models installed at the configured endpoint, or a reason it is unreachable. */
  async models(overrides = {}) {
    const cfg = this.config(overrides);
    if (!cfg.baseUrl) return { ok: false, models: [], error: 'No endpoint is configured.' };
    const preset = PROVIDERS[cfg.provider] || {};
    const timeoutMs = overrides.timeoutMs || 4000;

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
   */
  async status(overrides = {}) {
    const cfg = this.config(overrides);
    const preset = PROVIDERS[cfg.provider] || {};
    const local = Boolean(preset.local);
    const found = await this.models(overrides);
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
    return {
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

  async chat(messages, { json = false, temperature = 0.2, maxTokens = 1400, signal } = {}) {
    const cfg = this.config();
    if (!cfg.configured) {
      throw new LLMError('No AI provider is configured. Add an API key in Settings to ask questions.', { code: 'NO_API_KEY' });
    }
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, cfg.timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

    const preset = PROVIDERS[cfg.provider] || {};
    const body = {
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };

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
      if (!res.ok && json && (res.status === 400 || res.status === 422)
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
          const available = await this.models({ provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model })
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
      if ((signal && signal.aborted) && !timedOut) {
        throw new LLMError('Cancelled.', { code: 'CANCELLED' });
      }
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
    const repaired = await this.chat([
      ...messages,
      { role: 'assistant', content: text.slice(0, 2000) },
      {
        role: 'user',
        content: 'That reply was not valid JSON. Return only the JSON object described above — no prose, no code fences, no trailing text.',
      },
    ], { ...opts, json: true, temperature: 0 });
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
    ], { maxTokens: 16, temperature: 0 });
    return { ok: true, model: cfg.model, provider: cfg.provider, reply: out.trim().slice(0, 80) };
  }
}

module.exports = { LLM, LLMError, PROVIDERS };
