'use strict';

const { stripHtml, clip } = require('./util.js');

const CATEGORIES = [
  'Tanakh', 'Talmud', 'Mishnah', 'Midrash', 'Halakhah', 'Kabbalah',
  'Philosophy', 'Liturgy', 'Jewish Thought', 'Chasidut', 'Musar', 'Responsa',
];

/**
 * Reading order for retrieved sources: the primary sources first, then the
 * works that comment on them, then Jewish thought and Mussar, then everything
 * else. Used to order the candidate list, to reserve shortlist slots per tier,
 * and to badge each source in the UI.
 */
const TIERS = ['primary', 'commentary', 'thought', 'other'];
const PRIMARY_CATEGORIES = new Set(['Tanakh', 'Mishnah', 'Talmud']);
const COMMENTARY_CATEGORIES = new Set([
  'Midrash', 'Targum', 'Commentary', 'Quoting Commentary', 'Halakhah',
  'Rishonim on Tanakh', 'Rishonim on Talmud', 'Acharonim on Tanakh', 'Acharonim on Talmud',
]);
const THOUGHT_CATEGORIES = new Set(['Jewish Thought', 'Musar', 'Chasidut', 'Kabbalah', 'Philosophy']);
const TIER_BOOST = { primary: 1.3, commentary: 1.12, thought: 1.0, other: 1.0 };
const TIER_QUOTA = { primary: 6, commentary: 4, thought: 2, other: 2 };
const TIER_LABEL = {
  primary: 'Primary source',
  commentary: 'Commentary',
  thought: 'Jewish thought / Mussar',
  other: 'Related text',
};

/** Is a work one of the primary sources, rather than a work about them? */
function isPrimaryWork(categories, title) {
  const path = categories || [];
  if (/\bon\b/.test(String(title || ''))) return false;
  return path.some((c) => PRIMARY_CATEGORIES.has(c));
}

/**
 * Place a work in a tier from its category path and title. Works such as
 * "Rashi on Genesis" sit under Tanakh and "English Explanation of Pirkei Avot"
 * under Mishnah, so a category below the top level that names a commentary
 * genre (or a title of the form "X on Y") outranks the primary category.
 */
const COMMENTARY_HINT = /commentary|\bon\b/i;

function tierFor(categories, title) {
  const path = (categories || []).filter(Boolean).map(String);
  const name = String(title || '');
  const isCommentary = COMMENTARY_HINT.test(name)
    || path.some((c) => COMMENTARY_CATEGORIES.has(c))
    || path.slice(1).some((c) => COMMENTARY_HINT.test(c));
  if (!isCommentary && path.some((c) => PRIMARY_CATEGORIES.has(c))) return 'primary';
  if (isCommentary) return 'commentary';
  if (path.some((c) => THOUGHT_CATEGORIES.has(c))) return 'thought';
  return 'other';
}

/** Work title from a ref: "Rashi on Genesis 1:1" -> "Rashi on Genesis". */
function workTitleOf(ref) {
  return String(ref || '').replace(/\s+\d+[ab]?(?::[\d\-]+)*\.?\s*$/, '').trim();
}

const SYSTEM = `You are a research assistant inside Sefaria Lens, a study tool that works on the Sefaria library of Jewish texts.
You write for an educated reader who wants primary sources, not a sermon.

Priority, when more than one candidate answers the question:
1. Primary sources: Tanakh, Mishnah, Talmud.
2. Works that comment on them: Rashi, Ramban, Ibn Ezra, Tosafot, Midrash, Targum, halakhic codes.
3. Jewish thought and Mussar.
Prefer the earliest tier that genuinely responds to the question. Reach for commentary when the primary text needs explanation, and say plainly when you are answering from commentary or later thought because no primary source speaks to the question.

Hard rules:
- Use ONLY the numbered candidate passages supplied by the user. Never introduce a source, book, or reference that is not in that list.
- Every claim about what a text says must correspond to a supplied passage.
- Quote the source's own words exactly when you quote. Hebrew/Aramaic and its English translation are both supplied; do not retranslate unless asked.
- If the candidates do not actually answer the question, say so plainly and explain what they do cover. Returning fewer than the requested number of sources is correct when the others are only loosely related.
- Each justification must be specific to its own passage: name the clause, argument, legal category, or move that makes it relevant. Never reuse one sentence across sources — an identical reason means the passages have not actually been compared.
- Be concise. No filler, no "certainly", no restating the question.`;

const ANSWER_SCHEMA = `Return ONLY a JSON object with this exact shape:
{
  "answer": "2-5 sentences answering the question, naming sources inline like (Berakhot 2a).",
  "sources": [
    {
      "index": 1,
      "justification": "1-2 sentences: why THIS passage was chosen and what it contributes. Name the specific clause, argument, or category; never a generic sentence that would fit any source.",
      "relevance": 0.0
    }
  ],
  "confidence": "high" | "medium" | "low",
  "caveats": "one short sentence, or an empty string"
}
Pick 1-4 sources, best first, and only those you would defend as directly relevant (relevance 0-1). If nothing is directly relevant, return an empty sources list and say so in the answer.`;

/** Step 1: turn a natural question into library search queries. */
async function planQueries(llm, question, { signal } = {}) {
  try {
    const plan = await llm.json([
      { role: 'system', content: 'You convert questions into short search queries for the Sefaria library search engine. Prefer the vocabulary a classical source would use. Include original-language terms when the question is about a Hebrew concept.' },
      {
        role: 'user',
        content: `Question: ${question}\n\nReturn JSON: {"queries": ["...", "..."], "concepts": ["..."]}\n2-4 queries, each 2-6 words, no boolean operators. Include one Hebrew-language query only if a Hebrew term is central to the question.`,
      },
    ], { maxTokens: 300, temperature: 0.3, signal });
    const queries = (plan.queries || []).map((q) => String(q || '').trim()).filter(Boolean);
    return { queries: queries.slice(0, 4), concepts: plan.concepts || [] };
  } catch (err) {
    if (err.code === 'CANCELLED' || (signal && signal.aborted)) throw err;
    // Planning is an optimisation, not a requirement.
    return { queries: [], concepts: [] };
  }
}

/**
 * Sefaria's search is lexical: a whole natural-language question matches
 * nothing ("caring for strangers" returns 0 results). When the AI planner is
 * unavailable, these keyword queries keep retrieval working — and they are
 * appended to planned queries so a single empty plan cannot kill the answer.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'about', 'from', 'into', 'over', 'under', 'and',
  'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'it',
  'its', 'as', 'so', 'such', 'not', 'no', 'nor', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'what', 'which', 'who',
  'whom', 'whose', 'when', 'where', 'why', 'how', 'does', 'say', 'says',
  'said', 'according', 'sources', 'source', 'text', 'texts', 'torah', 'mean',
  'means', 'meaning', 'there', 'their', 'them', 'they', 'we', 'you', 'i',
  'my', 'me', 'our', 'us', 'his', 'her', 'he', 'she', 'one', 'some', 'any',
  'all', 'each', 'more', 'most', 'much', 'many', 'also', 'very', 'just',
  'only', 'other', 'another', 'between', 'through', 'during', 'because',
  'while', 'after', 'before', 'up', 'down', 'out', 'off', 'again', 'further',
  'understand', 'understands', 'understood', 'describe', 'describes', 'explain',
  'explains', 'tell', 'teach', 'teaches', 'discuss', 'discusses', 'discussed',
  'regarding', 'concerning', 'view', 'views', 'think', 'thought', 'tradition',
  'traditional', 'judaism', 'jewish', 'relate', 'relates', 'address', 'addresses',
]);

function questionTerms(question) {
  return String(question || '')
    .replace(/[“”"'’‘?!.,;:()[\]{}]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
}

/** Keyword queries that Sefaria's lexical search can actually match. */
function fallbackQueries(question) {
  const terms = questionTerms(question);
  const raw = String(question || '').replace(/[“”"'’‘?!.,;:()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!terms.length) return raw ? [raw] : [];
  const out = [];
  // A Hebrew question is already close to a search phrase; an English one is not.
  if (/[\u05D0-\u05EA]/.test(question)) out.push(raw);
  out.push(terms.slice(0, 4).join(' '));
  out.push(...terms.filter((t) => t.length > 2));
  for (let i = 0; i < terms.length - 1; i++) out.push(`${terms[i]} ${terms[i + 1]}`);
  return [...new Set(out.filter(Boolean))].slice(0, 6);
}

function aggregate(hitLists) {
  const byRef = new Map();
  hitLists.forEach((list, qi) => {
    list.hits.forEach((hit, rank) => {
      const key = hit.ref;
      const prev = byRef.get(key);
      const weighted = hit.score * (1 - rank * 0.015);
      if (prev) {
        prev.score = Math.max(prev.score, weighted);
        prev.hits += 1;
        prev.highlight = prev.highlight || hit.highlight;
      } else {
        byRef.set(key, {
          ref: hit.ref,
          score: weighted,
          hits: 1,
          highlight: hit.highlight,
          lang: hit.lang,
          queryIndex: qi,
        });
      }
    });
  });
  return [...byRef.values()].sort((a, b) => (b.score + b.hits * 2) - (a.score + a.hits * 2));
}

/**
 * Tag search hits with a reading tier and order them primary -> commentary ->
 * thought -> other. The category comes from the table of contents, so a hit is
 * placed without fetching its text.
 */
async function orderByTier(sefaria, ranked) {
  let map = {};
  if (typeof sefaria.categoryMap === 'function') {
    try { map = await sefaria.categoryMap(); } catch { map = {}; }
  }
  const tiered = ranked.map((hit) => {
    const title = workTitleOf(hit.ref);
    return { ...hit, title, tier: tierFor(lookupPath(map, title), title) };
  });
  const weight = (h) => h.score * TIER_BOOST[h.tier] + h.hits * 2;
  tiered.sort((a, b) => (tierRank(a.tier) - tierRank(b.tier)) || (weight(b) - weight(a)));
  return tiered;
}

/** Reading order of the tiers, and a comparison that keeps it. */
function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  return i === -1 ? TIERS.length : i;
}

function byTierThenScore(a, b) {
  return (tierRank(a.tier) - tierRank(b.tier))
    || ((b.score || 0) + (b.hits || 0) * 2) - ((a.score || 0) + (a.hits || 0) * 2);
}

/**
 * Category path for a search hit's work. Search ids sometimes carry a library
 * prefix the table of contents does not ("Talmud, Shabbat" for "Shabbat").
 */
function lookupPath(map, title) {
  if (map[title]) return map[title];
  const stripped = String(title || '').replace(/^[A-Z][A-Za-z'’ ]*,\s+/, '');
  if (stripped && map[stripped]) return map[stripped];
  return [];
}

/**
 * Shortlist that keeps the priority order but reserves room for each tier, so a
 * strong commentary is not crowded out by twenty mediocre primary hits.
 */
function pickShortlist(tiered, size) {
  const picked = [];
  const seen = new Set();
  const take = (list, cap) => {
    let room = cap;
    for (const hit of list) {
      if (picked.length >= size || room <= 0) return;
      if (seen.has(hit.ref)) continue;
      seen.add(hit.ref);
      picked.push(hit);
      room -= 1;
    }
  };
  const byTier = (tier) => tiered.filter((h) => h.tier === tier);
  take(byTier('primary'), Math.max(3, Math.round(size * 0.6)));
  take(byTier('commentary'), Math.max(2, Math.round(size * 0.25)));
  take(byTier('thought'), Math.max(1, Math.round(size * 0.15)));
  take(tiered, size - picked.length);
  return picked;
}

/** How many distinctive question words actually appear in a passage's own text. */
function overlapScore(candidate, terms) {
  const haystack = `${candidate.en || ''} ${candidate.he || ''}`.toLowerCase();
  return terms.reduce((n, t) => (haystack.includes(t.toLowerCase()) ? n + 1 : n), 0);
}

async function loadCandidates(sefaria, refs) {
  const out = [];
  for (const item of refs) {
    try {
      const text = await sefaria.text(item.ref);
      const he = text.he.join(' ').trim();
      const en = text.en.join(' ').trim();
      if (!he && !en) continue;
      // The work's own categories are authoritative once its text is loaded, so
      // a table-of-contents miss is corrected here.
      const tier = (text.categories && text.categories.length)
        ? tierFor(text.categories, text.title)
        : (item.tier || 'other');
      out.push({
        ref: text.ref || item.ref,
        tier,
        heRef: text.heRef,
        categories: text.categories || [],
        primaryCategory: text.primaryCategory,
        title: text.title,
        he,
        en,
        score: item.score,
        hits: item.hits,
        heVersion: text.heVersion,
        enVersion: text.enVersion,
        license: text.license,
      });
    } catch { /* skip unreachable refs */ }
  }
  return out;
}

/** Step 3: LLM ranks candidates and writes grounded justifications. */
async function rankWithLLM(llm, question, candidates, limit, { signal } = {}) {
  // A local model on a CPU typically runs with a 4k context and generates a
  // few tokens a second. Shorter passages and a smaller answer budget keep the
  // whole request inside that context and finish in a reasonable time; cloud
  // models can still read the full text.
  const local = Boolean(llm.config && llm.config().local);
  const heBudget = local ? 260 : 520;
  const enBudget = local ? 360 : 680;
  const list = candidates.map((c, i) => {
    const he = clip(c.he, heBudget);
    const en = clip(c.en, enBudget);
    const tier = TIER_LABEL[c.tier] || TIER_LABEL.other;
    return `[${i + 1}] ${c.ref}\nTier: ${tier}\nCategory: ${(c.categories || []).join(' > ') || c.primaryCategory || 'unknown'}\nHebrew/Aramaic: ${he || '(none)'}\nEnglish: ${en || '(none)'}`;
  }).join('\n\n');

  const result = await llm.json([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Question: ${question}\n\nCandidate passages from Sefaria (${candidates.length} total):\n\n${list}\n\n${ANSWER_SCHEMA}`,
    },
  ], { maxTokens: local ? 450 : 1500, temperature: 0.2, signal });

  const picks = (Array.isArray(result.sources) ? result.sources : [])
    .map((s) => ({ ...s, index: Number(s.index) }))
    .filter((s) => Number.isInteger(s.index) && s.index >= 1 && s.index <= candidates.length)
    .slice(0, limit);

  return {
    answer: typeof result.answer === 'string' ? result.answer.trim() : '',
    picks: distinctJustifications(picks, candidates, question),
    confidence: result.confidence || 'medium',
    caveats: result.caveats || '',
  };
}

/**
 * A model that repeats one sentence across every source has not compared them,
 * and the reader is left with the same empty reason under each. Replace the
 * repeats with a grounded note about what put that passage in front of it.
 */
function distinctJustifications(picks, candidates, question) {
  if (picks.length < 2) return picks;
  const seen = new Map();
  const terms = questionTerms(question);
  return picks.map((pick) => {
    const key = String(pick.justification || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key) return pick;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 1) return pick;
    const c = candidates[pick.index - 1] || {};
    const matched = terms
      .filter((t) => `${c.en || ''} ${c.he || ''}`.toLowerCase().includes(t.toLowerCase()))
      .slice(0, 4);
    const where = (c.categories || []).join(' › ') || TIER_LABEL[c.tier] || 'Sefaria';
    const excerpt = clip(c.en || c.he || '', 90);
    return {
      ...pick,
      justification: `${c.ref ? `${c.ref}: ` : ''}${matched.length ? `matched “${matched.join(' ')}”` : 'retrieved by search'} in ${where}${excerpt ? ` — “${excerpt}”` : '.'}`,
    };
  });
}

function heuristicRank(candidates, limit, question = '') {
  const terms = questionTerms(question).filter((t) => t.length > 2);
  const ordered = [...candidates].sort((a, b) =>
    (overlapScore(b, terms) - overlapScore(a, terms)) || byTierThenScore(a, b));
  return ordered.slice(0, limit).map((c) => {
    const matched = terms.filter((t) => `${c.en || ''} ${c.he || ''}`.toLowerCase().includes(t.toLowerCase()));
    const where = (c.categories || []).join(' › ') || TIER_LABEL[c.tier] || 'Sefaria';
    return {
      index: candidates.indexOf(c) + 1,
      relevance: Math.max(0.3, Math.min(0.9, 0.4 + matched.length * 0.15)),
      justification: `Matched ${matched.length ? `“${matched.join(' ')}”` : 'the search'} in ${where}. The passage is shown in full so you can judge the fit yourself.`,
    };
  });
}

/**
 * Main entry point: question in, grounded snippets + justifications out.
 */
function cancelled() {
  const err = new Error('Cancelled.');
  err.code = 'CANCELLED';
  return err;
}

/**
 * Settle as soon as the person presses Stop, even when the work in flight is a
 * Sefaria fetch that cannot itself be aborted. The request keeps running in the
 * background and its result is discarded.
 */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

async function ask({ question, category = null, limit = 4, sefaria, llm, signal }) {
  if (!question || !question.trim()) throw new Error('Enter a question first.');
  const q = question.trim();
  const started = Date.now();
  if (signal && signal.aborted) throw cancelled();

  const plan = await planQueries(llm, q, { signal });
  if (signal && signal.aborted) throw cancelled();
  // Planned queries first, but never at the cost of the keyword fallbacks: a
  // model that returns four long phrases can otherwise fill the whole list,
  // and Sefaria's lexical search matches none of them. Two single-word
  // fallbacks are therefore reserved before the rest of the plan.
  const fallback = fallbackQueries(q);
  const words = fallback.filter((s) => !/\s/.test(s));
  const reserved = words.length ? words.slice(0, 2) : fallback.slice(0, 2);
  const queries = [...new Set([...plan.queries, ...reserved, ...fallback]
    .map((s) => String(s).trim()).filter(Boolean))]
    .slice(0, 6);

  const searches = await abortable(Promise.all(queries.map(async (query) => {
    try {
      return await sefaria.search(query, { size: 10 });
    } catch {
      return { hits: [], total: 0 };
    }
  })), signal);

  const ranked = aggregate(searches);
  // Primary sources first, then commentary, then Jewish thought and Mussar —
  // with slots reserved for each tier so commentary is not crowded out.
  const tiered = await abortable(orderByTier(sefaria, ranked), signal);
  const shortlist = category ? ranked.slice(0, 24) : pickShortlist(tiered, 18);
  let candidates = await abortable(loadCandidates(sefaria, shortlist), signal);

  if (category) {
    const filtered = candidates.filter((c) =>
      (c.categories || []).includes(category) || c.primaryCategory === category);
    if (filtered.length >= 2) candidates = filtered;
  }
  // Sefaria search is lexical and indexes the whole work, so a hit can land on a
  // passage that never mentions the query. Drop those when enough passages do
  // carry the question's own words, and otherwise leave the list alone.
  const terms = questionTerms(q).filter((t) => t.length > 2);
  const onTopic = candidates.filter((c) => overlapScore(c, terms) > 0);
  if (onTopic.length >= 3) candidates = onTopic;

  // Hand the model the candidates in reading order: primary sources first, then
  // commentary, then Jewish thought and Mussar. A local model gets fewer of
  // them so the prompt still fits its context window.
  candidates.sort(byTierThenScore);
  candidates = candidates.slice(0, llm.config() && llm.config().local ? 6 : 12);
  if (signal && signal.aborted) throw cancelled();

  if (!candidates.length) {
    return {
      question: q,
      answer: 'No passages in the Sefaria library matched this question. Try rephrasing it, or search for a distinctive phrase instead.',
      sources: [],
      confidence: 'low',
      caveats: '',
      meta: { queries, considered: 0, elapsedMs: Date.now() - started, ai: false },
    };
  }

  let answer = '';
  let picks = [];
  let confidence = 'medium';
  let caveats = '';
  let aiUsed = true;

  try {
    const rankedResult = await rankWithLLM(llm, q, candidates, limit, { signal });
    answer = rankedResult.answer;
    picks = rankedResult.picks;
    confidence = rankedResult.confidence;
    caveats = rankedResult.caveats;
    // An empty pick list with an answer is a considered "none of these fit",
    // not a failure; only a silent result falls back to raw relevance.
    if (!picks.length && !rankedResult.answer) picks = heuristicRank(candidates, Math.min(limit, 3), q);
  } catch (err) {
    // A person who pressed Stop does not want a degraded answer instead.
    if (err.code === 'CANCELLED' || (signal && signal.aborted)) throw cancelled();
    // The retrieval work is still useful without the model; degrade honestly.
    aiUsed = false;
    answer = 'The AI ranking step failed, so these are the highest-scoring passages from Sefaria search, unranked by the model.';
    picks = heuristicRank(candidates, Math.min(limit, 3), q);
    confidence = 'low';
    caveats = err.message;
  }

  const sources = picks.map((p) => {
    const c = candidates[p.index - 1];
    return {
      ref: c.ref,
      heRef: c.heRef,
      tier: c.tier || 'other',
      tierLabel: TIER_LABEL[c.tier] || TIER_LABEL.other,
      he: c.he,
      en: c.en,
      categories: c.categories,
      primaryCategory: c.primaryCategory,
      heVersion: c.heVersion,
      enVersion: c.enVersion,
      license: c.license,
      justification: String(p.justification || '').trim(),
      relevance: typeof p.relevance === 'number' ? p.relevance : null,
    };
  }).filter((s) => s.he || s.en);

  return {
    question: q,
    answer: answer || 'The model returned no summary; the selected passages are below.',
    sources,
    confidence,
    caveats,
    meta: {
      queries,
      considered: candidates.length,
      tiers: sources.reduce((acc, s) => {
        acc[s.tier] = (acc[s.tier] || 0) + 1;
        return acc;
      }, {}),
      elapsedMs: Date.now() - started,
      ai: aiUsed,
      model: aiUsed ? llm.config().model : null,
    },
  };
}

/** Contextual gloss for a clicked word, grounded in the verse and lexicon. */
async function gloss({ word, verseHe, verseEn, lexicon }, { llm }) {
  const lex = (lexicon || []).slice(0, 3).map((e) => {
    const senses = (e.senses || []).map((s) => s.text).join('; ');
    return `- ${e.lexicon}${e.morphology ? ` (${e.morphology})` : ''}: ${clip(senses, 320)}`;
  }).join('\n');

  try {
    const out = await llm.json([
      { role: 'system', content: 'You are a Hebrew lexicographer helping a student read a verse. Be precise and brief.' },
      {
        role: 'user',
        content: `Word as it appears: ${word}\nVerse (Hebrew): ${verseHe || '(not supplied)'}\nVerse (English): ${verseEn || '(not supplied)'}\n\nDictionary entries available:\n${lex || '(none)'}\n\nReturn JSON: {"gloss": "the word as used in THIS verse, 1-6 words", "root": "three-letter root if identifiable, else empty string", "binyan": "verb pattern if a verb, else empty string", "note": "at most one short clarifying sentence"} `,
      },
    ], { maxTokens: 300, temperature: 0.1 });
    return {
      gloss: String(out.gloss || '').trim(),
      root: String(out.root || '').trim(),
      binyan: String(out.binyan || '').trim(),
      note: String(out.note || '').trim(),
    };
  } catch (err) {
    const first = (lexicon || [])[0];
    const fallback = first && first.senses && first.senses[0] ? first.senses[0].text : '';
    return { gloss: fallback, root: '', binyan: '', note: err.code === 'NO_API_KEY' ? 'Add an AI key for a context-specific gloss.' : '' };
  }
}

/**
 * Produce an English rendering for segments that Sefaria publishes without one.
 * Batched and cached: a chapter is a handful of calls at most, and repeats are free.
 */
async function translateSegments({ segments, ref = '' }, { llm, cache, maxPerBatch = 15, maxChars = 2800 } = {}) {
  const items = segments
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => text && text.trim());
  if (!items.length) return { en: segments.map(() => ''), machine: false };

  const model = llm.config().model || 'unknown';
  const key = `${ref}|${model}|${items.map((i) => i.text).join('\u0001')}`;

  const run = async () => {
    const en = segments.map(() => '');
    const batches = [];
    let batch = [];
    let chars = 0;
    for (const item of items) {
      if (batch.length >= maxPerBatch || chars + item.text.length > maxChars) {
        if (batch.length) batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(item);
      chars += item.text.length;
    }
    if (batch.length) batches.push(batch);

    for (const group of batches) {
      const numbered = group.map((item, i) => `[${i + 1}] ${item.text}`).join('\n\n');
      const out = await llm.json([
        { role: 'system', content: 'You translate Hebrew and Aramaic source texts into clear, faithful English for a study app. Preserve the register of the original, keep names consistent, and do not add commentary. If a word is uncertain, translate the plain sense.' },
        {
          role: 'user',
          content: `Reference: ${ref || 'unknown'}\nTranslate each numbered segment into English. Return JSON: {"translations": ["..."]} with exactly ${group.length} strings, in order. Do not merge or split segments.\n\n${numbered}`,
        },
      ], { maxTokens: 1600, temperature: 0.1 });

      const list = Array.isArray(out.translations) ? out.translations : null;
      if (!list || list.length !== group.length) {
        throw Object.assign(new Error('The AI returned an unusable translation batch'), { code: 'BAD_TRANSLATION' });
      }
      group.forEach((item, i) => { en[item.index] = String(list[i] || '').trim(); });
    }
    return en;
  };

  const en = cache ? await cache.wrap('machine-en', key, run) : await run();
  return { en, machine: true };
}

/** Translate a selection, using the surrounding verse as context. */
async function translateSelection({ text, contextHe, contextEn, target }, { llm }) {
  const clean = stripHtml(text);
  // Selections from the Hebrew side go to English; selections from a translation
  // go back to Hebrew.
  const toHebrew = !/[\u05D0-\u05EA]/.test(clean);
  const targetLanguage = toHebrew ? 'Hebrew' : (target || 'English');

  const out = await llm.json([
    { role: 'system', content: 'You translate source texts for a study app. Preserve nuance; do not paraphrase into commentary.' },
    {
      role: 'user',
      content: `Selection to translate:\n${clean}\n\nSurrounding verse (Hebrew): ${clip(contextHe || '', 700)}\nExisting translation: ${clip(contextEn || '', 700)}\n\nReturn JSON: {"translation": "faithful ${targetLanguage} translation of the selection only", "note": "one short note on an idiom or ambiguity, or an empty string"}`,
    },
  ], { maxTokens: 500, temperature: 0.1 });
  return {
    translation: String(out.translation || '').trim(),
    note: String(out.note || '').trim(),
  };
}

module.exports = {
  ask, gloss, translateSelection, translateSegments, planQueries, aggregate, CATEGORIES,
  tierFor, orderByTier, pickShortlist, workTitleOf, isPrimaryWork, TIER_LABEL,
  fallbackQueries, questionTerms, distinctJustifications,
};
