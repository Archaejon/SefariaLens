'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  ask, aggregate, gloss, translateSelection, translateSegments, planQueries,
  tierFor, orderByTier, pickShortlist, workTitleOf, isPrimaryWork,
  fallbackQueries, distinctJustifications, refSpan, coveredBy,
} = require('../src/answer.js');

const HITS = [
  { ref: 'Leviticus 19:18', lang: 'he', score: 30, highlight: 'ואהבת לרעך כמוך' },
  { ref: 'Rashi on Leviticus 19:18:1', lang: 'en', score: 22, highlight: 'love your neighbor' },
  { ref: 'Talmud, Shabbat 31a', lang: 'en', score: 18, highlight: 'That is the whole Torah' },
];

function fakeSefaria(overrides = {}) {
  return {
    search: async () => ({ total: 3, hits: HITS }),
    text: async (ref) => ({
      ref,
      heRef: ref,
      title: 'Leviticus',
      categories: ref.startsWith('Rashi') ? ['Tanakh', 'Commentary'] : ['Tanakh', 'Torah'],
      primaryCategory: 'Tanakh',
      he: ['וְאָהַבְתָּ לְרֵעֲךָ כָּמוֹךָ'],
      en: ['Love your neighbor as yourself.'],
      heVersion: { title: 'Miqra according to the Masorah', license: 'CC-BY-SA' },
      enVersion: { title: 'JPS', license: 'CC-BY-NC' },
      ...(overrides[ref] || {}),
    }),
  };
}

function fakeLLM(rank, { failRank = false } = {}) {
  return {
    config: () => ({ model: 'mock' }),
    json: async (messages) => {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"queries"')) return { queries: ['love your neighbor'], concepts: [] };
      if (failRank) throw new Error('provider down');
      return rank;
    },
  };
}

test('aggregate merges duplicate refs and rewards multi-query hits', () => {
  const merged = aggregate([
    { hits: HITS.slice(0, 2) },
    { hits: [HITS[0]] },
  ]);
  const top = merged.find((h) => h.ref === 'Leviticus 19:18');
  assert.strictEqual(top.hits, 2);
  assert.ok(merged[0].score >= merged[merged.length - 1].score);
});

test('ask returns grounded sources with justifications', async () => {
  const llm = fakeLLM({
    answer: 'Leviticus states the principle; Rashi comments on it.',
    sources: [
      { index: 1, justification: 'The verse itself states the command.', relevance: 0.95 },
      { index: 2, justification: 'Rashi explains the scope of "neighbor".', relevance: 0.7 },
    ],
    confidence: 'high',
    caveats: '',
  });
  const result = await ask({ question: 'What does the Torah say about loving a neighbor?', sefaria: fakeSefaria(), llm });

  assert.strictEqual(result.sources.length, 2);
  assert.strictEqual(result.sources[0].ref, 'Leviticus 19:18');
  assert.match(result.sources[0].justification, /verse itself/);
  assert.strictEqual(result.confidence, 'high');
  assert.strictEqual(result.meta.ai, true);
});

test('a question about a selection carries the selection and its verse into the prompts', async () => {
  let planPrompt = '';
  let rankPrompt = '';
  const llm = {
    config: () => ({ model: 'mock' }),
    json: async (messages) => {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"queries"')) {
        planPrompt = text;
        return { queries: ['love your neighbor'], concepts: [] };
      }
      rankPrompt = text;
      return {
        answer: 'The verse addresses the neighbour in Israelite law.',
        sources: [{ index: 1, justification: 'It states the command.', relevance: 0.9 }],
        confidence: 'medium',
        caveats: '',
      };
    },
  };
  const context = 'Selected text: love your neighbor\nReference: Leviticus 19:18\nSurrounding verse (English): Love your neighbor as yourself.';
  await ask({ question: 'Who is my neighbor here?', context, sefaria: fakeSefaria(), llm });

  assert.match(planPrompt, /Leviticus 19:18/);
  assert.match(rankPrompt, /selected text/i);
  assert.match(rankPrompt, /Who is my neighbor here\?/);
  assert.match(rankPrompt, /Love your neighbor as yourself/);
});

test('invalid source indexes are dropped, not trusted', async () => {
  const llm = fakeLLM({
    answer: 'x',
    sources: [
      { index: 99, justification: 'invented', relevance: 0.9 },
      { index: 1, justification: 'real', relevance: 0.8 },
    ],
    confidence: 'medium',
  });
  const result = await ask({ question: 'q', sefaria: fakeSefaria(), llm });
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.sources[0].ref, 'Leviticus 19:18');
});

test('a cancelled question is not turned into a degraded answer', async () => {
  const ctrl = new AbortController();
  const llm = {
    config: () => ({ model: 'mock', local: false }),
    json: async (messages) => {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"queries"')) return { queries: ['love your neighbor'], concepts: [] };
      ctrl.abort();
      const err = new Error('Cancelled.');
      err.code = 'CANCELLED';
      throw err;
    },
  };
  await assert.rejects(
    () => ask({ question: 'What does the Torah say about love?', sefaria: fakeSefaria(), llm, signal: ctrl.signal }),
    (err) => err.code === 'CANCELLED',
  );
});

test('degrades to heuristic ranking when the model fails', async () => {
  const llm = fakeLLM(null, { failRank: true });
  const result = await ask({ question: 'q', sefaria: fakeSefaria(), llm });
  assert.strictEqual(result.meta.ai, false);
  assert.ok(result.sources.length >= 1);
  assert.match(result.caveats, /provider down/);
});

test('category filter applies when enough matches exist', async () => {
  const llm = fakeLLM({ answer: 'x', sources: [{ index: 1, justification: 'y', relevance: 1 }] });
  const result = await ask({ question: 'q', category: 'Tanakh', sefaria: fakeSefaria(), llm });
  assert.ok(result.sources.every((s) => s.categories.includes('Tanakh')));
});

const TIER_CASES = [
  [['Tanakh', 'Torah'], 'Genesis', 'primary'],
  [['Mishnah', 'Seder Nezikin'], 'Mishnah Avot', 'primary'],
  [['Talmud', 'Bavli', 'Seder Nashim'], 'Ketubot', 'primary'],
  [['Tanakh', 'Rishonim on Tanakh', 'Rashi', 'Torah'], 'Rashi on Genesis', 'commentary'],
  [['Mishnah', 'Modern Commentary on Mishnah', 'Seder Nezikin'], 'English Explanation of Pirkei Avot', 'commentary'],
  [['Midrash', 'Midrash Rabbah', 'Bereshit Rabbah'], 'Bereshit Rabbah', 'commentary'],
  [['Musar', 'Acharonim'], 'Mesillat Yesharim', 'thought'],
  [['Jewish Thought', 'Rishonim'], 'Guide for the Perplexed', 'thought'],
  [['Kabbalah', 'Zohar'], 'Zohar', 'thought'],
  [['Reference', 'Dictionary'], 'Sefer HaArukh', 'other'],
];

for (const [categories, title, want] of TIER_CASES) {
  test(`tierFor puts ${title} in ${want}`, () => {
    assert.strictEqual(tierFor(categories, title), want);
  });
}

test('workTitleOf strips the section from a ref', () => {
  assert.strictEqual(workTitleOf('Rashi on Genesis 1:1:1'), 'Rashi on Genesis');
  assert.strictEqual(workTitleOf('Berakhot 2a'), 'Berakhot');
  assert.strictEqual(workTitleOf('Mishnah Avot 1:1-3'), 'Mishnah Avot');
  assert.strictEqual(workTitleOf('Shulchan Arukh, Orach Chaim 1:1'), 'Shulchan Arukh, Orach Chaim');
});

test('a work is primary only when it is not itself a commentary', () => {
  assert.strictEqual(isPrimaryWork(['Tanakh', 'Torah'], 'Genesis'), true);
  assert.strictEqual(isPrimaryWork(['Tanakh', 'Rishonim on Tanakh', 'Rashi'], 'Rashi on Genesis'), false);
});

test('orderByTier places primary sources before commentary and thought', async () => {
  const sefaria = {
    categoryMap: async () => ({
      Genesis: ['Tanakh', 'Torah'],
      'Rashi on Genesis': ['Tanakh', 'Rishonim on Tanakh', 'Rashi'],
      'Mesillat Yesharim': ['Musar', 'Acharonim'],
    }),
  };
  const ranked = [
    { ref: 'Mesillat Yesharim 1', score: 40, hits: 1 },
    { ref: 'Rashi on Genesis 1:1', score: 39, hits: 1 },
    { ref: 'Genesis 1:1', score: 5, hits: 1 },
  ];
  const tiered = await orderByTier(sefaria, ranked);
  assert.deepStrictEqual(tiered.map((h) => h.tier), ['primary', 'commentary', 'thought']);
  assert.strictEqual(tiered[0].ref, 'Genesis 1:1');
});

test('pickShortlist keeps primary first but reserves room for commentary', () => {
  const many = (tier, n) => Array.from({ length: n }, (_, i) => ({ ref: `${tier}-${i}`, tier, score: 10 - i, hits: 1 }));
  const shortlist = pickShortlist([...many('primary', 20), ...many('commentary', 8), ...many('thought', 4)], 18);
  const tiers = shortlist.map((h) => h.tier);
  assert.strictEqual(shortlist.length, 18);
  assert.strictEqual(tiers[0], 'primary');
  assert.ok(tiers.filter((t) => t === 'commentary').length >= 4, 'commentary keeps a share');
  assert.ok(tiers.filter((t) => t === 'thought').length >= 2, 'thought keeps a share');
  assert.strictEqual(new Set(shortlist.map((h) => h.ref)).size, 18);
});

test('ask badges every source with its tier and tallies them', async () => {
  const sefaria = fakeSefaria();
  sefaria.categoryMap = async () => ({ 'Leviticus 19:18': ['Tanakh', 'Torah'], 'Rashi on Leviticus': ['Tanakh', 'Rishonim on Tanakh', 'Rashi'] });
  const llm = fakeLLM({
    answer: 'x',
    sources: [{ index: 1, justification: 'y', relevance: 1 }],
    confidence: 'high',
    caveats: '',
  });
  const result = await ask({ question: 'q', sefaria, llm });
  assert.ok(result.sources.every((s) => s.tier && s.tierLabel));
  assert.ok(Object.keys(result.meta.tiers).length >= 1);
});

test('empty results explain themselves instead of inventing sources', async () => {
  const llm = fakeLLM({});
  const empty = { search: async () => ({ hits: [] }), text: async () => { throw new Error('nope'); } };
  const result = await ask({ question: 'q', sefaria: empty, llm });
  assert.strictEqual(result.sources.length, 0);
  assert.match(result.answer, /No passages/);
});

test('gloss falls back to the dictionary without an API key', async () => {
  const llm = { json: async () => { throw Object.assign(new Error('no key'), { code: 'NO_API_KEY' }); } };
  const out = await gloss({
    word: 'בְּרֵאשִׁית',
    verseHe: 'בְּרֵאשִׁית',
    verseEn: 'In the beginning',
    lexicon: [{ lexicon: 'BDB', senses: [{ text: 'in the beginning' }] }],
  }, { llm });
  assert.strictEqual(out.gloss, 'in the beginning');
  assert.match(out.note, /key/i);
});

test('selection translation returns the model text', async () => {
  const llm = { json: async () => ({ translation: 'In the beginning', note: '' }) };
  const out = await translateSelection({ text: 'בְּרֵאשִׁית' }, { llm });
  assert.strictEqual(out.translation, 'In the beginning');
});

test('translateSegments keeps alignment and skips empty input', async () => {
  const llm = {
    config: () => ({ model: 'mock' }),
    json: async (messages) => {
      const count = (messages[1].content.match(/^\[\d+\]/gm) || []).length;
      return { translations: Array.from({ length: count }, (_, i) => `en-${i}`) };
    },
  };
  const out = await translateSegments({ segments: ['א', 'ב', ''], ref: 'X' }, { llm });
  assert.strictEqual(out.machine, true);
  assert.deepStrictEqual(out.en, ['en-0', 'en-1', '']);
});

test('translateSegments rejects a mismatched batch', async () => {
  const llm = { config: () => ({ model: 'mock' }), json: async () => ({ translations: ['only one'] }) };
  await assert.rejects(() => translateSegments({ segments: ['א', 'ב'], ref: 'X' }, { llm }),
    (err) => err.code === 'BAD_TRANSLATION');
});

test('keyword fallbacks turn a question into queries Sefaria can match', () => {
  const queries = fallbackQueries('What does the Torah say about caring for strangers?');
  assert.ok(queries.length >= 2);
  assert.ok(queries.includes('caring'));
  assert.ok(queries.includes('strangers'));
  assert.ok(queries.every((q) => !/^what does/i.test(q)));
});

test('a plan full of phrases does not crowd out keyword fallbacks', async () => {
  const phraseLLM = {
    config: () => ({ model: 'mock' }),
    json: async (messages) => {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"queries"')) {
        return {
          queries: [
            'Torah laws on treating gerim',
            'Treatment of converts in Torah',
            'Responsibility to care for the stranger',
            'Torah teachings on kindness to outsiders',
          ],
          concepts: [],
        };
      }
      return { answer: 'x', sources: [{ index: 1, justification: 'y', relevance: 1 }], confidence: 'low' };
    },
  };
  const seen = [];
  const search = async (query) => {
    seen.push(query);
    // As Sefaria's lexical search behaves: the phrases match nothing, the
    // single keywords do.
    return ['caring', 'strangers'].includes(query)
      ? { total: HITS.length, hits: HITS }
      : { total: 0, hits: [] };
  };
  const result = await ask({
    question: 'What does the Torah say about caring for strangers?',
    sefaria: { ...fakeSefaria(), search },
    llm: phraseLLM,
  });
  assert.ok(seen.includes('caring'), `expected a keyword fallback, got: ${seen.join(' | ')}`);
  assert.ok(seen.includes('strangers'));
  assert.ok(result.sources.length >= 1);
});

test('the planner failing still leaves usable search queries', async () => {
  const seen = [];
  const sefaria = fakeSefaria();
  const baseSearch = sefaria.search;
  sefaria.search = async (q) => { seen.push(q); return baseSearch(q); };
  const llm = fakeLLM(null, { failRank: true });
  await ask({ question: 'What does the Torah say about caring for strangers?', sefaria, llm });
  assert.ok(seen.includes('caring'));
  assert.ok(seen.includes('strangers'));
});

test('repeated model justifications are replaced with passage-specific notes', () => {
  const candidates = [
    { ref: 'Leviticus 19:18', he: 'וְאָהַבְתָּ', en: 'Love your neighbor as yourself.', categories: ['Tanakh', 'Torah'], tier: 'primary' },
    { ref: 'Rashi on Leviticus 19:18:1', he: 'ואהבת', en: 'Love your neighbor — a great principle of the Torah.', categories: ['Tanakh', 'Commentary'], tier: 'commentary' },
  ];
  const same = 'It states the principle directly.';
  const out = distinctJustifications([
    { index: 1, justification: same, relevance: 0.9 },
    { index: 2, justification: same, relevance: 0.8 },
  ], candidates, 'love your neighbor');
  assert.notStrictEqual(out[0].justification, out[1].justification);
  assert.match(out[1].justification, /matched/);
  assert.match(out[1].justification, /Leviticus/);
});

test('the planner asks for a canonical ref as well as queries', async () => {
  const llm = {
    json: async (messages) => {
      assert.match(messages[1].content, /"refs"/);
      return { queries: ['golden calf'], refs: ['Exodus 32:1-6'], concepts: [] };
    },
  };
  const plan = await planQueries(llm, 'Where does the Torah mention the Golden Calf?');
  assert.deepStrictEqual(plan.refs, ['Exodus 32:1-6']);
  assert.deepStrictEqual(plan.queries, ['golden calf']);
});

test('planner refs are normalised from suffixes and objects', async () => {
  const llm = {
    json: async () => ({
      queries: [],
      refs: [
        'Exodus 32:1-6 (Chumash)',
        { book: 'Exodus', chapter: 32 },
        { book: 'Deuteronomy', start: 9, end: 10 },
        'not a ref',
      ],
    }),
  };
  const plan = await planQueries(llm, 'q');
  assert.deepStrictEqual(plan.refs, ['Exodus 32:1-6', 'Exodus 32', 'Deuteronomy 9']);
});

test('a planned Torah passage is fetched from Sefaria and ranked first', async () => {
  const calls = [];
  const exodus = {
    ref: 'Exodus 32:1-6',
    heRef: 'שמות ל״ב א׳-ו׳',
    title: 'Exodus',
    categories: ['Tanakh', 'Torah'],
    primaryCategory: 'Tanakh',
    he: ['וַיַּרְא הָעָם כִּי בֹשֵׁשׁ מֹשֶׁה'],
    en: ['When the people saw that Moses was late, they made a calf.'],
    heVersion: { title: 'Miqra according to the Masorah', license: 'CC-BY-SA' },
    enVersion: { title: 'JPS', license: 'CC-BY-NC' },
  };
  const talmud = {
    ref: 'Talmud, Avodah Zarah 43b',
    heRef: 'עבודה זרה מג:' ,
    title: 'Avodah Zarah',
    categories: ['Talmud', 'Bavli'],
    primaryCategory: 'Talmud',
    he: ['אָמַר רַבִּי יוֹחָנָן'],
    en: ['Rabbi Yochanan discussed the calf.'],
    heVersion: { title: 'Vilna', license: 'Public Domain' },
    enVersion: { title: 'Sefaria', license: 'CC0' },
  };
  const sefaria = {
    search: async (query, opts = {}) => {
      calls.push({ query, opts });
      if (opts.filters) return { total: 1, hits: [{ ref: 'Exodus 32:4', score: 18, hits: 1 }] };
      return {
        total: 2,
        hits: [
          { ref: 'Talmud, Avodah Zarah 43b', score: 32, hits: 1 },
          { ref: 'Exodus 32:4', score: 18, hits: 1 },
        ],
      };
    },
    text: async (ref) => {
      if (ref === 'Exodus 32:1-6') return exodus;
      if (ref === 'Exodus 32:4') return { ...exodus, ref, he: ['עֵגֶל מַסֵּכָה'], en: ['a molten calf'] };
      if (ref === 'Talmud, Avodah Zarah 43b') return talmud;
      throw new Error(`no such ref: ${ref}`);
    },
    categoryMap: async () => ({
      Exodus: ['Tanakh', 'Torah'],
      'Avodah Zarah': ['Talmud', 'Bavli'],
      'Talmud, Avodah Zarah': ['Talmud', 'Bavli'],
    }),
  };
  const llm = {
    config: () => ({ model: 'mock' }),
    json: async (messages) => {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"queries"')) {
        return { queries: ['golden calf'], refs: ['Exodus 32:1-6'], concepts: [] };
      }
      return { answer: 'Exodus 32 narrates it.', sources: [{ index: 1, justification: 'The narrative itself.', relevance: 0.95 }], confidence: 'high' };
    },
  };

  const result = await ask({ question: 'Where does the Torah mention the Golden Calf?', sefaria, llm });

  assert.strictEqual(result.sources[0].ref, 'Exodus 32:1-6');
  assert.strictEqual(result.sources[0].tier, 'primary');
  // The verse inside the planned range is not offered a second time.
  assert.strictEqual(result.sources.filter((s) => s.ref === 'Exodus 32:4').length, 0);
  assert.ok(calls.some((c) => c.query.toLowerCase() === 'calf' && c.opts.filters && c.opts.filters[0] === 'Tanakh'),
    `expected a Tanakh-scoped keyword search, got: ${JSON.stringify(calls.map((c) => c.query))}`);
});

test('a planned range that starts mid-chapter also offers the chapter opening', async () => {
  const passage = (ref, en) => ({
    ref,
    heRef: ref,
    title: 'Exodus',
    categories: ['Tanakh', 'Torah'],
    primaryCategory: 'Tanakh',
    he: ['וַיְדַבֵּר'],
    en: [en],
    heVersion: { title: 'Miqra', license: 'CC-BY-SA' },
    enVersion: { title: 'JPS', license: 'CC-BY-NC' },
  });
  const sefaria = {
    search: async () => ({ total: 0, hits: [] }),
    text: async (ref) => {
      if (ref === 'Exodus 32:7-14') return passage(ref, 'God spoke to Moses about the calf.');
      if (ref === 'Exodus 32:1-6') return passage(ref, 'The people made a calf.');
      throw new Error(`no such ref: ${ref}`);
    },
  };
  const llm = {
    config: () => ({ model: 'mock' }),
    json: async (messages) => {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"queries"')) return { queries: ['golden calf'], refs: ['Exodus 32:7-14'], concepts: [] };
      return { answer: 'x', sources: [{ index: 2, justification: 'The narrative itself.', relevance: 0.9 }], confidence: 'high' };
    },
  };
  const result = await ask({ question: 'Where does the Torah mention the Golden Calf?', sefaria, llm });
  assert.strictEqual(result.sources[0].ref, 'Exodus 32:1-6');
});

test('an invented planned ref is skipped instead of breaking the answer', async () => {
  const sefaria = fakeSefaria({
    'Exodus 99:1-6': null,
  });
  const base = sefaria.text;
  sefaria.text = async (ref) => {
    if (ref === 'Exodus 99:1-6') throw new Error('no such passage');
    return base(ref);
  };
  const llm = {
    config: () => ({ model: 'mock' }),
    json: async (messages) => {
      const text = messages.map((m) => m.content).join('\n');
      if (text.includes('"queries"')) return { queries: ['love your neighbor'], refs: ['Exodus 99:1-6'], concepts: [] };
      return { answer: 'x', sources: [{ index: 1, justification: 'y', relevance: 1 }], confidence: 'low' };
    },
  };
  const result = await ask({ question: 'What does the Torah say about love?', sefaria, llm });
  assert.ok(result.sources.length >= 1);
  assert.ok(!result.sources.some((s) => s.ref === 'Exodus 99:1-6'));
});

test('a Tanakh-scoped verse is ordered before a higher-scoring Talmud passage', async () => {
  const tiered = await orderByTier({
    categoryMap: async () => ({
      Exodus: ['Tanakh', 'Torah'],
      'Avodah Zarah': ['Talmud', 'Bavli'],
    }),
  }, [
    { ref: 'Talmud, Avodah Zarah 43b', score: 40, hits: 2 },
    { ref: 'Exodus 32:1-6', score: 15, hits: 1, scriptureScope: true },
  ]);
  assert.strictEqual(tiered[0].ref, 'Exodus 32:1-6');
});

test('a planned range covers the search hits inside it', () => {
  const span = refSpan('Exodus 32:1-6');
  assert.deepStrictEqual(span, { book: 'exodus', chapter: 32, start: 1, end: 6 });
  assert.strictEqual(coveredBy('Exodus 32:4', span), true);
  assert.strictEqual(coveredBy('Exodus 32:19', span), false);
  assert.strictEqual(coveredBy('Exodus 33:1', span), false);
});

test('an English selection is translated back into Hebrew', async () => {
  let prompt = '';
  const llm = { json: async (messages) => { prompt = messages.map((m) => m.content).join('\n'); return { translation: 'בְּרֵאשִׁית', note: '' }; } };
  await translateSelection({ text: 'In the beginning', contextHe: 'בְּרֵאשִׁית' }, { llm });
  assert.match(prompt, /faithful Hebrew translation/);
});
