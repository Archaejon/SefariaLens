'use strict';

/**
 * Ollama's own HTTP API.
 *
 * The OpenAI-compatible endpoint is enough to get text out of a local model,
 * but it cannot say how much context to allocate, when to unload the model, or
 * how the model is placed on the GPU — and it answers in one piece, after the
 * whole generation. The native API exposes all four: `options.num_ctx`,
 * `keep_alive`, NDJSON streaming, and per-request timings.
 *
 * This module is transport only: it knows nothing about prompts, tasks, or the
 * UI. Callers get text, token callbacks, and measurements back.
 */

class OllamaError extends Error {
  constructor(message, { code = 'OLLAMA_ERROR', status } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.status = status;
  }
}

/** The API root, whatever form the configured base URL takes (/v1, trailing /). */
function originOf(baseUrl) {
  try {
    return new URL(String(baseUrl || 'http://127.0.0.1:11434')).origin;
  } catch {
    return 'http://127.0.0.1:11434';
  }
}

const nsToMs = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e6) : null);

/** Ollama reports its own timings in nanoseconds; the app speaks milliseconds. */
function readTimings(done) {
  if (!done || typeof done !== 'object') return null;
  return {
    totalMs: nsToMs(done.total_duration),
    loadMs: nsToMs(done.load_duration),
    promptTokens: done.prompt_eval_count ?? null,
    promptMs: nsToMs(done.prompt_eval_duration),
    genTokens: done.eval_count ?? null,
    genMs: nsToMs(done.eval_duration),
  };
}

class Ollama {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
    // One probe per session: an endpoint labelled ollama that does not speak
    // the native API (a gateway in front of it, say) falls back to the
    // OpenAI-compatible path instead of failing every request.
    this.native = new Map();
  }

  url(baseUrl, path) {
    return `${originOf(baseUrl)}${path}`;
  }

  /** GET with a bounded timeout, for the small status endpoints. */
  async get(baseUrl, path, { timeoutMs = 4000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await this.fetchImpl(this.url(baseUrl, path), { signal: ctrl.signal });
      if (!res.ok) throw new OllamaError(`${path} answered ${res.status}`, { status: res.status });
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Is this endpoint Ollama? Cached per origin after the first answer. */
  async supportsNative(baseUrl) {
    const key = originOf(baseUrl);
    if (this.native.has(key)) return this.native.get(key);
    let ok = false;
    try {
      await this.get(baseUrl, '/api/version', { timeoutMs: 2500 });
      ok = true;
    } catch { ok = false; }
    this.native.set(key, ok);
    return ok;
  }

  forget(baseUrl) {
    this.native.delete(originOf(baseUrl));
  }

  /** Installed models, from the native tag list. */
  async tags(baseUrl, opts = {}) {
    const data = await this.get(baseUrl, '/api/tags', opts);
    return (data.models || []).map((m) => m.name || m.model).filter(Boolean);
  }

  /** What is loaded right now: size, VRAM share, and the context it runs with. */
  async ps(baseUrl, opts = {}) {
    const data = await this.get(baseUrl, '/api/ps', opts);
    return (data.models || []).map((m) => ({
      name: m.name || m.model,
      sizeBytes: m.size ?? null,
      vramBytes: m.size_vram ?? null,
      contextLength: m.context_length ?? null,
      expiresAt: m.expires_at || '',
      size: m.size ? Math.round(m.size / 1e6) / 1000 : null,
      vram: m.size_vram ? Math.round(m.size_vram / 1e6) / 1000 : null,
    }));
  }

  /** Quantisation and parameter count, for the status line in Settings. */
  async show(model, baseUrl, opts = {}) {
    const data = await this.get(baseUrl, '/api/show', opts).catch(() => null);
    return data || null;
  }

  /** Unload a model now, freeing its RAM/VRAM until the next request. */
  async unload(model, baseUrl, { timeoutMs = 5000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url(baseUrl, '/api/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0, stream: false }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new OllamaError(`Could not unload ${model} (${res.status})`, { status: res.status });
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One streaming chat completion.
   *
   * `onToken` is called for every delta, so the caller can paint text as it is
   * produced; the resolved value carries the whole reply plus Ollama's own
   * timings, which is how the app can report tokens per second honestly.
   */
  async chat({
    baseUrl,
    model,
    messages,
    format = null,
    temperature = 0.2,
    topP,
    numPredict,
    numCtx,
    keepAlive = '15m',
    timeoutMs = 300000,
    signal,
    onToken,
  }) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const body = {
      model,
      messages,
      stream: true,
      keep_alive: keepAlive,
      options: {
        temperature,
        ...(Number.isFinite(numPredict) ? { num_predict: numPredict } : {}),
        ...(Number.isFinite(numCtx) ? { num_ctx: numCtx } : {}),
        ...(Number.isFinite(topP) ? { top_p: topP } : {}),
      },
    };
    if (format) body.format = format;

    const startedAt = Date.now();
    try {
      const res = await this.fetchImpl(this.url(baseUrl, '/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        let detail = raw.slice(0, 300);
        try {
          const parsed = JSON.parse(raw);
          detail = (parsed.error && (parsed.error.message || parsed.error)) || detail;
        } catch { /* plain text body */ }
        if (res.status === 404 && /model/i.test(detail)) {
          throw new OllamaError(`The model “${model}” is not installed. Run “ollama pull ${model}”.`, {
            code: 'MODEL_NOT_FOUND', status: 404,
          });
        }
        throw new OllamaError(`Ollama answered ${res.status}: ${detail}`, { code: 'PROVIDER_ERROR', status: res.status });
      }
      if (!res.body) throw new OllamaError('Ollama returned no response body', { code: 'BAD_RESPONSE' });

      let text = '';
      let done = null;
      let firstTokenAt = null;
      let buffer = '';
      const consume = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let chunk;
        try { chunk = JSON.parse(trimmed); } catch { return; }
        if (chunk.error) throw new OllamaError(String(chunk.error), { code: 'PROVIDER_ERROR' });
        const delta = chunk.message && chunk.message.content;
        if (delta) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          text += delta;
          if (onToken) onToken(delta);
        }
        if (chunk.done) done = chunk;
      };

      // fetch() gives a web stream in Node and in Electron's main process.
      for await (const part of res.body) {
        buffer += typeof part === 'string' ? part : Buffer.from(part).toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          consume(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      consume(buffer);

      const timings = readTimings(done);
      if (!text.trim()) {
        throw new OllamaError('The local model returned an empty response.', { code: 'EMPTY_RESPONSE' });
      }
      return {
        text,
        timings: {
          ...(timings || {}),
          ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
          wallMs: Date.now() - startedAt,
          tokensPerSecond: timings && timings.genMs
            ? Math.round((timings.genTokens / (timings.genMs / 1000)) * 10) / 10
            : null,
        },
      };
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (signal && signal.aborted && !timedOut) {
        throw new OllamaError('Cancelled.', { code: 'CANCELLED' });
      }
      if (err.name === 'AbortError') {
        throw new OllamaError(
          timedOut
            ? `The local model did not finish within ${Math.round(timeoutMs / 1000)}s.`
            : 'Cancelled.',
          { code: timedOut ? 'TIMEOUT' : 'CANCELLED' },
        );
      }
      // This transport only ever talks to an Ollama on this machine, so any
      // connection-level failure means the same thing to the caller: the local
      // server is not there. Node reports it as `fetch failed` with the real
      // code on `cause`, which may itself be an AggregateError.
      const codes = [err && err.code, err && err.cause && err.cause.code,
        ...((err && err.cause && err.cause.errors) || []).map((e) => e.code)].filter(Boolean);
      const refused = codes.includes('ECONNREFUSED') || codes.includes('ENOTFOUND')
        || codes.includes('EHOSTUNREACH') || /fetch failed/i.test(err.message || '');
      throw new OllamaError(
        refused
          ? `Nothing is listening at ${originOf(baseUrl)}. Start Ollama, then try again.`
          : `Could not reach Ollama: ${err.message}`,
        { code: refused ? 'LOCAL_DOWN' : 'NETWORK' },
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { Ollama, OllamaError, originOf, readTimings };
