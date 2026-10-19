'use strict';

/**
 * A tiny OpenAI-compatible server used to exercise the Q&A pipeline without a
 * real provider key. It answers the three prompt shapes the app sends:
 * query planning, source ranking, and gloss/translation.
 */

const http = require('node:http');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function messageText(body) {
  const messages = (body && body.messages) || [];
  return messages.map((m) => m.content || '').join('\n');
}

function reply(content) {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

function createMockLLM({
  port = 4199,
  failWith = null,
  models = ['mock-model', 'other-model'],
  rejectJsonMode = false,
  badJsonOnce = false,
  delayMs = 0,
} = {}) {
  const calls = [];
  let badJsonSent = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // The model list Settings and the wizard check before saving.
    if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    const raw = await readBody(req);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const text = messageText(body);
    calls.push({ model: body.model, text, jsonMode: Boolean(body.response_format) });
    res.setHeader('Content-Type', 'application/json');

    if (failWith) {
      res.writeHead(failWith.status || 500);
      res.end(JSON.stringify({ error: { message: failWith.message || 'mock failure' } }));
      return;
    }

    if (rejectJsonMode && body.response_format) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: 'response_format is not supported by this server' } }));
      return;
    }

    if (badJsonOnce && body.response_format && !badJsonSent) {
      badJsonSent = true;
      res.end(reply('Sure! Here is the JSON you asked for.'));
      return;
    }

    // 1. Query planning
    if (text.includes('Return JSON: {"queries"')) {
      res.end(reply(JSON.stringify({
        queries: ['love your neighbor', 'ואהבת לרעך כמוך'],
        concepts: ['neighborly love', 'Leviticus 19:18'],
      })));
      return;
    }

    // 2. Ranking candidates
    if (text.includes('Candidate passages from Sefaria')) {
      const refs = [...text.matchAll(/^\[(\d+)\] (.+)$/gm)].map((m) => ({ i: Number(m[1]), ref: m[2] }));
      const chosen = refs.slice(0, 2).map((r, idx) => ({
        index: r.i,
        justification: `Mock provider: ${r.ref} was the ${idx === 0 ? 'first' : 'second'} candidate in the list. No relevance judgement was made.`,
        relevance: idx === 0 ? 0.94 : 0.81,
      }));
      res.end(reply(JSON.stringify({
        answer: 'The sources frame this as a single principle stated in Leviticus and then generalised by the rabbis.',
        sources: chosen,
        confidence: 'high',
        caveats: '',
      })));
      return;
    }

    // 3. Machine English translation of a passage (one string per numbered segment)
    if (text.includes('"translations"')) {
      const count = (text.match(/^\[\d+\]/gm) || []).length || 1;
      const translations = Array.from({ length: count }, (_, i) =>
        i === 0
          ? 'And you shall love your neighbour as yourself: this is a great principle of the Torah.'
          : `The passage continues, explaining the practice of loving one's neighbour in daily conduct (${i + 1}).`);
      res.end(reply(JSON.stringify({ translations })));
      return;
    }

    // 4. Contextual gloss — echo the word that was asked about, so a canned
    // answer can never look like the app picked the wrong word.
    if (text.includes('"gloss"')) {
      const asked = (text.match(/Word as it appears: (.+)/) || [])[1] || '';
      res.end(reply(JSON.stringify({
        gloss: asked ? `mock gloss for ${asked.trim()}` : 'mock gloss',
        root: '',
        binyan: '',
        note: 'Mock provider: no real linguistic analysis was performed.',
      })));
      return;
    }

    // 5. Selection translation
    if (text.includes('"translation"')) {
      res.end(reply(JSON.stringify({
        translation: 'In the beginning God created',
        note: 'Rendered as a temporal clause.',
      })));
      return;
    }

    // 5. Connection test
    res.end(reply('ready'));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/v1`,
        port: actual,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { createMockLLM };

if (require.main === module) {
  createMockLLM({ port: Number(process.env.MOCK_PORT) || 4199 }).then((m) => {
    console.log(`mock LLM on ${m.url}`);
  });
}
