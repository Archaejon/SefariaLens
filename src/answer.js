'use strict';

const { stripHtml, clip, estimateTokens } = require('./util.js');

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
// A hit retrieved by a Tanakh-scoped search, or the passage the planner named
// outright. These are the verses that actually narrate or legislate the subject,
// and they are kept ahead of a later Talmudic or halakhic discussion of it.
const SCRIPTURE_SLOTS = 4;
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
When a Tanakh verse narrates the event or states the law itself, prefer it over a later Talmudic or halakhic discussion of the same subject, and cite that verse first. A later passage is the better answer only when no Tanakh passage addresses the question.

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

/**
 * A planner may return a ref as a string, with a parenthetical suffix
 * ("Exodus 32:1-6 (Chumash)"), or as an object. Normalise all three into the
 * plain ref Sefaria's text endpoint accepts; anything unrecognisable is
 * dropped rather than sent as a guessed URL.
 */
function normalizeRef(value) {
  if (value && typeof value === 'object') {
    const book = String(value.book || value.title || value.ref || '').trim();
    if (!book) return '';
    const chapter = Number(value.chapter != null ? value.chapter : value.start);
    if (!Number.isFinite(chapter)) return book;
    const first = value.verseStart != null ? Number(value.verseStart) : Number(value.verse);
    const last = value.verseEnd != null ? Number(value.verseEnd) : null;
    if (!Number.isFinite(first)) return `${book} ${chapter}`.trim();
    return `${book} ${chapter}:${first}${Number.isFinite(last) ? `-${last}` : ''}`;
  }
  return String(value || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Step 1: turn a natural question into search queries and likely refs. */
async function planQueries(llm, question, { signal, onStatus } = {}) {
  try {
    const plan = await llm.json([
      { role: 'system', content: 'You plan searches for the Sefaria library of Jewish texts. Prefer the vocabulary a classical source would use. Include original-language terms when the question is about a Hebrew concept.' },
      {
        role: 'user',
        content: `Question: ${question}\n\nReturn JSON: {"queries": ["...", "..."], "refs": ["..."]}\n2-3 queries, each 2-6 words, no boolean operators. Include one Hebrew-language query only if a Hebrew term is central to the question.\nrefs: at most one exact Sefaria reference for the passage that most directly answers the question, with a verse range where the passage is verses (for example "Exodus 32:1-6"). For a question about where an event appears, give the verses that narrate the event itself. Use a real Sefaria book name. Leave refs empty if unsure.`,
      },
    ], { task: 'plan', temperature: 0.1, signal, onStatus });
    const queries = (plan.queries || []).map((q) => String(q || '').trim()).filter(Boolean);
    // A ref the model invents is harmless: it is fetched from Sefaria and
    // dropped when Sefaria has no such passage. Do not let a rambling answer
    // turn into a long list of fetches.
    const rawRefs = Array.isArray(plan.refs) ? plan.refs : (plan.refs ? [plan.refs] : []);
    const refs = [...new Set(rawRefs.map(normalizeRef).filter((r) => r && r.length <= 80 && /\d/.test(r)))]
      .slice(0, 3);
    return { queries: queries.slice(0, 4), refs, concepts: plan.concepts || [] };
  } catch (err) {
    if (err.code === 'CANCELLED' || (signal && signal.aborted)) throw err;
    // Planning is an optimisation, not a requirement.
    return { queries: [], refs: [], concepts: [] };
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
  'mention', 'mentions', 'mentioned', 'reference', 'references', 'appear',
  'appears', 'appeared', 'locate', 'located', 'verses', 'verse', 'passage',
  'passages', 'story', 'account', 'narrative', 'happen', 'happens', 'happened',
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

/**
 * A Sefaria ref as a comparable span: book, chapter, first and last verse.
 * "Exodus 32:1-6" covers verses 1-6; a bare chapter covers all of it. Refs
 * without a chapter/verse pair (a Talmud daf) return null and are never used
 * to suppress another hit.
 */
function refSpan(ref) {
  const m = String(ref || '').trim().match(/^(.+?)\s+(\d+)(?::(\d+)(?:\s*-\s*(\d+))?)?(?:[ab])?$/);
  if (!m) return null;
  const verse = m[3] == null ? null : Number(m[3]);
  return {
    book: m[1].toLowerCase().replace(/\s+/g, ' '),
    chapter: Number(m[2]),
    start: verse == null ? 1 : verse,
    end: m[4] ? Number(m[4]) : (verse == null ? Infinity : verse),
  };
}

/** Does `ref` fall inside a span that is already a candidate? */
function coveredBy(ref, span) {
  if (!span) return false;
  const own = refSpan(ref);
  return Boolean(own && own.book === span.book && own.chapter === span.chapter
    && own.start >= span.start && own.end <= span.end);
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
    const path = lookupPath(map, title);
    // A planned ref whose work the table of contents does not expose keeps the
    // tier its own categories gave it instead of falling into "other".
    return {
      ...hit,
      title,
      tier: path.length ? tierFor(path, title) : (hit.tier || 'other'),
      scripture: path.includes('Tanakh') || (hit.categories || []).includes('Tanakh'),
    };
  });
  const weight = (h) => h.score * TIER_BOOST[h.tier] + h.hits * 2;
  tiered.sort((a, b) => (tierRank(a.tier) - tierRank(b.tier))
    || (Number(Boolean(b.scriptureScope)) - Number(Boolean(a.scriptureScope)))
    || (weight(b) - weight(a)));
  return tiered;
}

/** Reading order of the tiers, and a comparison that keeps it. */
function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  return i === -1 ? TIERS.length : i;
}

function byTierThenScore(a, b) {
  return (tierRank(a.tier) - tierRank(b.tier))
    || (Number(Boolean(b.scriptureScope)) - Number(Boolean(a.scriptureScope)))
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
  // The verse that narrates or legislates the subject is the reason the person
  // asked: keep those ahead of a later discussion even when it scores higher.
  take(tiered.filter((h) => h.scriptureScope), SCRIPTURE_SLOTS);
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
        scriptureScope: Boolean(item.scriptureScope),
        planned: Boolean(item.planned),
        heVersion: text.heVersion,
        enVersion: text.enVersion,
        license: text.license,
      });
    } catch { /* skip unreachable refs */ }
  }
  return out;
}

/** Shape a Sefaria text response as a ranking candidate. */
function passageFromText(text, ref, score) {
  const he = (text.he || []).join(' ').trim();
  const en = (text.en || []).join(' ').trim();
  if (!he && !en) return null;
  const categories = text.categories || [];
  return {
    ref,
    heRef: text.heRef || '',
    title: text.title || '',
    categories,
    primaryCategory: text.primaryCategory || '',
    he,
    en,
    tier: tierFor(categories, text.title),
    score,
    hits: 1,
    heVersion: text.heVersion,
    enVersion: text.enVersion,
    license: text.license,
    scriptureScope: true,
    planned: true,
  };
}

/**
 * Turn the refs the planner proposed into candidates. Sefaria still supplies
 * the text, so a remembered passage is grounded: a ref that does not exist, or
 * has no text, is dropped exactly like any other failed fetch.
 *
 * A planner can name a divine speech inside a narrative (Exodus 32:7-14)
 * instead of the verses that tell the story (32:1-6). For a Tanakh passage
 * that starts mid-chapter, the chapter opening is added as well, so the
 * passage everyone means by "the Golden Calf" is always in front of the model.
 */
async function plannedPassages(sefaria, refs, { signal } = {}) {
  const out = [];
  for (const ref of refs || []) {
    try {
      const text = await abortable(sefaria.text(ref), signal);
      let he = (text.he || []).slice();
      let en = (text.en || []).slice();
      let finalRef = text.ref || ref;
      // A model that names a chapter rather than verses is trimmed to its
      // opening when the chapter is long, where a narrative or a law code
      // begins. Short chapters are kept whole: trimming Exodus 20 would cut
      // off most of the Ten Commandments.
      if (!/:\d/.test(ref) && Math.max(he.length, en.length) > 20) {
        const n = Math.min(15, Math.max(he.length, en.length));
        he = he.slice(0, n);
        en = en.slice(0, n);
        finalRef = `${ref}:1-${n}`;
      }
      const main = passageFromText({ ...text, he, en }, finalRef, 40);
      if (!main) continue;
      out.push(main);

      const span = refSpan(finalRef);
      const isTanakh = (text.categories || []).includes('Tanakh');
      if (isTanakh && span && span.start > 1) {
        const title = text.title || span.book;
        const openingRef = `${title} ${span.chapter}:1-6`;
        try {
          const opening = await abortable(sefaria.text(openingRef), signal);
          const candidate = passageFromText(opening, opening.ref || openingRef, 38);
          if (candidate) out.push(candidate);
        } catch { /* no chapter opening: the planned range still stands */ }
      }
    } catch { /* an invented or unavailable ref is simply skipped */ }
  }
  return out;
}

/**
 * The two content words most likely to name the subject. The planner's refs
 * are the precise route to a passage; these keep a lexical search inside
 * Tanakh working when the planner is down or its ref is wrong.
 */
function scriptureTerms(question) {
  const seen = new Set();
  const terms = [];
  for (const term of questionTerms(question)) {
    const key = term.toLowerCase();
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms.slice(-2);
}

/**
 * Search Tanakh only. Sefaria's index is lexical, and a translation often never
 * uses the questioner's phrase ("golden calf" does not occur in Exodus 32), so
 * an unrestricted search can miss the Torah altogether and leave Talmud and
 * later commentary to fill the page.
 */
async function scriptureScopedHits(sefaria, question) {
  const terms = scriptureTerms(question);
  if (!terms.length) return [];
  const results = await Promise.all(terms.map(async (term) => {
    try {
      const hebrew = /[\u0590-\u05FF]/.test(term);
      return await sefaria.search(term, {
        size: 20,
        filters: ['Tanakh'],
        filterFields: ['path'],
        ...(hebrew ? { field: 'naive_lemmatizer', slop: 4 } : {}),
      });
    } catch { return { hits: [] }; }
  }));
  const merged = new Map();
  results.forEach((res) => {
    const seen = new Set();
    let taken = 0;
    for (const hit of res.hits || []) {
      if (taken >= 6) break;
      if (seen.has(hit.ref)) continue;
      seen.add(hit.ref);
      taken += 1;
      const score = hit.score * 1.12;
      const prev = merged.get(hit.ref);
      if (prev) {
        prev.score = Math.max(prev.score, score);
        prev.hits += 1;
      } else {
        merged.set(hit.ref, { ...hit, score, hits: 1, scriptureScope: true });
      }
    }
  });
  return [...merged.values()].sort((a, b) => (b.score + b.hits * 2) - (a.score + a.hits * 2));
}

/**
 * How much of each passage reaches the prompt. A local model pays for every
 * token twice — once to read it, once in wall-clock time — so the clips shrink
 * before the candidate list does.
 */
const PASSAGE_CLIPS = {
  local: [[260, 360], [200, 300], [150, 240], [120, 190]],
  cloud: [[520, 680]],
};

function candidateBlock(c, i, heBudget, enBudget) {
  const tier = TIER_LABEL[c.tier] || TIER_LABEL.other;
  return `[${i + 1}] ${c.ref}\nTier: ${tier}\nCategory: ${(c.categories || []).join(' > ') || c.primaryCategory || 'unknown'}\n`
    + `Hebrew/Aramaic: ${clip(c.he, heBudget) || '(none)'}\nEnglish: ${clip(c.en, enBudget) || '(none)'}`;
}

/**
 * Keep the ranking prompt inside the model's context window.
 *
 * Ollama silently drops the front of an over-long prompt, which would take the
 * rules with it, so the list is trimmed here instead: shorten the passages
 * first, then drop candidates from the end, and never go below three.
 */
function fitPrompt(candidates, { question, context, schema, budget, local }) {
  const overhead = estimateTokens(SYSTEM) + estimateTokens(schema)
    + estimateTokens(question) + estimateTokens(context || '') + 64;
  const levels = PASSAGE_CLIPS[local ? 'local' : 'cloud'];
  let best = null;
  for (const [heBudget, enBudget] of levels) {
    const blocks = candidates.map((c, i) => candidateBlock(c, i, heBudget, enBudget));
    let used = overhead;
    let keep = 0;
    for (const block of blocks) {
      const cost = estimateTokens(block);
      if (used + cost > budget) break;
      used += cost;
      keep += 1;
    }
    keep = Math.max(keep, Math.min(3, blocks.length));
    best = { blocks: blocks.slice(0, keep), heBudget, enBudget, keep, tokens: used };
    if (keep === blocks.length) return best;
  }
  return best;
}

/**
 * The answer field of a JSON object that is still arriving. The ranker replies
 * with JSON, so painting its raw output would show braces and escapes; this
 * finds the `answer` string and returns as much of it as has been generated.
 */
function partialJsonString(text, field = 'answer') {
  const head = new RegExp(`"${field}"\\s*:\\s*"`).exec(String(text || ''));
  if (!head) return '';
  let out = '';
  for (let i = head.index + head[0].length; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i += 1;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

/** Step 3: LLM ranks candidates and writes grounded justifications. */
async function rankWithLLM(llm, question, candidates, limit, { signal, context = '', onDraft, onStatus } = {}) {
  // A local model on a CPU typically runs with a 4k context and generates a
  // few tokens a second. Shorter passages and a smaller answer budget keep the
  // whole request inside that context and finish in a reasonable time; cloud
  // models can still read the full text.
  const cfg = llm.config ? llm.config() : {};
  const local = Boolean(cfg.local);
  const profile = llm.task ? llm.task('rank') : { maxTokens: 450, temperature: 0.2 };
  const budget = llm.promptBudget
    ? llm.promptBudget(profile, cfg)
    : (local ? 3200 : 12000);
  const asked = `Question: ${question}`;
  const fitted = fitPrompt(candidates, { question: asked, context, schema: ANSWER_SCHEMA, budget, local });
  const considered = candidates.slice(0, fitted.keep);

  let draft = '';
  const result = await llm.json([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${asked}\n${context ? `\nThe question refers to this selected text:\n${clip(context, 700)}\n` : ''}\nCandidate passages from Sefaria (${considered.length} total):\n\n${fitted.blocks.join('\n\n')}\n\n${ANSWER_SCHEMA}`,
    },
  ], {
    task: 'rank',
    temperature: 0.2,
    signal,
    onStatus,
    ...(onDraft ? {
      onToken: (delta) => {
        draft += delta;
        const partial = partialJsonString(draft, 'answer');
        if (partial) onDraft(partial);
      },
    } : {}),
  });

  const picks = (Array.isArray(result.sources) ? result.sources : [])
    .map((s) => ({ ...s, index: Number(s.index) }))
    .filter((s) => Number.isInteger(s.index) && s.index >= 1 && s.index <= considered.length)
    .slice(0, limit);

  return {
    answer: typeof result.answer === 'string' ? result.answer.trim() : '',
    picks: distinctJustifications(picks, considered, question),
    confidence: result.confidence || 'medium',
    caveats: result.caveats || '',
    considered: considered.length,
    promptTokens: fitted.tokens,
    clipBudget: { he: fitted.heBudget, en: fitted.enBudget },
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

async function ask({ question, category = null, limit = 4, context = null, sefaria, llm, signal, onDraft, onStatus }) {
  if (!question || !question.trim()) throw new Error('Enter a question first.');
  const q = question.trim();
  // A question asked about a highlighted passage carries that passage into
  // retrieval, but the answer still answers the question itself.
  const contextText = String(context || '').trim().slice(0, 1200);
  const retrievalQuestion = contextText ? `${q}\n${contextText}` : q;
  const started = Date.now();
  if (signal && signal.aborted) throw cancelled();

  const plan = await planQueries(llm, retrievalQuestion, { signal, onStatus });
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

  // Three retrieval routes at once: the planned queries, the passage the
  // planner named outright, and the same keywords restricted to Tanakh.
  const [planned, searches, scoped] = await abortable(Promise.all([
    plannedPassages(sefaria, plan.refs, { signal }),
    Promise.all(queries.map(async (query) => {
      try {
        return await sefaria.search(query, { size: 10 });
      } catch {
        return { hits: [], total: 0 };
      }
    })),
    scriptureScopedHits(sefaria, retrievalQuestion),
  ]), signal);

  // A planned range already contains any search hit inside it.
  const spans = planned.map((p) => refSpan(p.ref)).filter(Boolean);
  const ranked = aggregate(searches)
    .filter((hit) => !spans.some((span) => coveredBy(hit.ref, span)));

  // With a planned passage, only verses from its own chapter are useful: the
  // rest of the narrative. A Tanakh match from another book (a calf offering in
  // Leviticus for "golden calf") would be noise, and the model may invent a
  // connection to it. Without a planned passage, scoped hits are the fallback.
  const sameChapter = (hit) => {
    const own = refSpan(hit.ref);
    return Boolean(own && spans.some((span) => own.book === span.book && own.chapter === span.chapter));
  };
  const extras = scoped.filter((hit) => !spans.some((span) => coveredBy(hit.ref, span))
    && (!planned.length || sameChapter(hit)));
  extras.sort((a, b) => (b.score + b.hits * 2) - (a.score + a.hits * 2));
  const scopedHits = extras.slice(0, planned.length ? 3 : 4);

  const seenRefs = new Set();
  const combined = [...planned, ...scopedHits, ...ranked].filter((hit) => {
    if (seenRefs.has(hit.ref)) return false;
    seenRefs.add(hit.ref);
    return true;
  });

  // Primary sources first, then commentary, then Jewish thought and Mussar —
  // with slots reserved for each tier so commentary is not crowded out.
  let tiered = await abortable(orderByTier(sefaria, combined), signal);
  // When the planner named the passage, a Tanakh verse from somewhere else is
  // almost always a one-word coincidence (a calf offering in Leviticus for
  // "golden calf"). Keep the planned chapter and non-Tanakh discussion, and
  // drop the coincidences before the model has to judge them.
  if (planned.length) {
    tiered = tiered.filter((hit) => {
      if (hit.planned || hit.scriptureScope || !hit.scripture) return true;
      const own = refSpan(hit.ref);
      return Boolean(own && spans.some((span) => own.book === span.book && own.chapter === span.chapter));
    });
  }
  const shortlist = category ? combined.slice(0, 24) : pickShortlist(tiered, 18);
  let candidates = await abortable(loadCandidates(sefaria, shortlist), signal);

  if (category) {
    const filtered = candidates.filter((c) =>
      (c.categories || []).includes(category) || c.primaryCategory === category);
    if (filtered.length >= 2) candidates = filtered;
  }
  // Sefaria search is lexical and indexes the whole work, so a hit can land on a
  // passage that never mentions the query. Drop those when enough passages do
  // carry the question's own words, and otherwise leave the list alone.
  const terms = questionTerms(retrievalQuestion).filter((t) => t.length > 2);
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
  let rankedTokens = null;

  try {
    const rankedResult = await rankWithLLM(llm, q, candidates, limit, {
      signal, context: contextText, onDraft, onStatus,
    });
    if (rankedResult.considered) candidates = candidates.slice(0, rankedResult.considered);
    rankedTokens = rankedResult.promptTokens || null;
    answer = rankedResult.answer;
    picks = rankedResult.picks;
    confidence = rankedResult.confidence;
    caveats = rankedResult.caveats;
    // An empty pick list with an answer is a considered "none of these fit",
    // not a failure; only a silent result falls back to raw relevance.
    if (!picks.length && !rankedResult.answer) picks = heuristicRank(candidates, Math.min(limit, 3), retrievalQuestion);
  } catch (err) {
    // A person who pressed Stop does not want a degraded answer instead.
    if (err.code === 'CANCELLED' || (signal && signal.aborted)) throw cancelled();
    // The retrieval work is still useful without the model; degrade honestly.
    aiUsed = false;
    answer = 'The AI ranking step failed, so these are the highest-scoring passages from Sefaria search, unranked by the model.';
    picks = heuristicRank(candidates, Math.min(limit, 3), retrievalQuestion);
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
      promptTokens: aiUsed ? rankedTokens : null,
    },
  };
}

/** Contextual gloss for a clicked word, grounded in the verse and lexicon. */
async function gloss({ word, verseHe, verseEn, lexicon }, { llm, signal }) {
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
    ], { task: 'gloss', temperature: 0.1, signal });
    return {
      gloss: String(out.gloss || '').trim(),
      root: String(out.root || '').trim(),
      binyan: String(out.binyan || '').trim(),
      note: String(out.note || '').trim(),
    };
  } catch (err) {
    if (err.code === 'CANCELLED') throw err;
    const first = (lexicon || [])[0];
    const fallback = first && first.senses && first.senses[0] ? first.senses[0].text : '';
    // A degraded answer is shown but never cached: a provider that was down a
    // minute ago may be up again, and the lexicon's first sense is not the
    // gloss this verse deserves.
    return {
      gloss: fallback,
      root: '',
      binyan: '',
      note: err.code === 'NO_API_KEY' ? 'Add an AI key for a context-specific gloss.' : '',
      degraded: true,
    };
  }
}

/**
 * Produce an English rendering for segments that Sefaria publishes without one.
 * Batched and cached: a chapter is a handful of calls at most, and repeats are free.
 */
async function translateSegments({ segments, ref = '' }, { llm, cache, signal, onProgress, maxPerBatch = 8, maxChars = 1600 } = {}) {
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

    for (const [batchIndex, group] of batches.entries()) {
      if (signal && signal.aborted) throw cancelled();
      if (onProgress) onProgress(batchIndex, batches.length);
      const numbered = group.map((item, i) => `[${i + 1}] ${item.text}`).join('\n\n');
      const out = await llm.json([
        { role: 'system', content: 'You translate Hebrew and Aramaic source texts into clear, faithful English for a study app. Preserve the register of the original, keep names consistent, and do not add commentary. If a word is uncertain, translate the plain sense.' },
        {
          role: 'user',
          content: `Reference: ${ref || 'unknown'}\nTranslate each numbered segment into English. Return JSON: {"translations": ["..."]} with exactly ${group.length} strings, in order. Do not merge or split segments.\n\n${numbered}`,
        },
      ], { task: 'translate', maxTokens: 900, temperature: 0.1, signal });

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
  ], { task: 'translate.selection', temperature: 0.1 });
  return {
    translation: String(out.translation || '').trim(),
    note: String(out.note || '').trim(),
  };
}

module.exports = {
  ask, gloss, translateSelection, translateSegments, planQueries, aggregate, CATEGORIES,
  tierFor, orderByTier, pickShortlist, workTitleOf, isPrimaryWork, TIER_LABEL,
  fallbackQueries, questionTerms, distinctJustifications, refSpan, coveredBy,
  fitPrompt, partialJsonString, candidateBlock, SYSTEM, ANSWER_SCHEMA,
};
