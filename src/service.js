'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { Sefaria } = require('./sefaria.js');
const { LLM, PROVIDERS } = require('./llm.js');
const { Settings } = require('./settings.js');
const { ask, gloss, translateSelection, translateSegments, CATEGORIES, isPrimaryWork } = require('./answer.js');
const { Cache } = require('./cache.js');
const { transliterate, wordInfo, STYLE_INFO } = require('./translit.js');
const { readingFor } = require('./divine-name.js');
const { buildChapters } = require('./chapters.js');
const { stripHtml, clip } = require('./util.js');

/**
 * A ref for each loaded segment, when the text is addressed by chapter and
 * verse. Sefaria links commentary to a single verse, so per-verse commentary
 * needs the ref of the verse on screen, not just the chapter.
 * Returns null for structures where that mapping does not exist (a Talmud daf
 * comes back as its lines, which have no verse refs of their own).
 */
function segmentRefsFor(ref, count) {
  const clean = String(ref || '').trim();
  if (!clean || count < 1) return null;
  const range = clean.match(/^(.*?)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (range) {
    const [, book, chapter, start] = range;
    const first = Number(start);
    return Array.from({ length: count }, (_, i) => `${book} ${chapter}:${first + i}`);
  }
  const chapter = clean.match(/^(.*?)\s+(\d+)$/);
  if (chapter) {
    const [, book, chapterNumber] = chapter;
    return Array.from({ length: count }, (_, i) => `${book} ${chapterNumber}:${i + 1}`);
  }
  return null;
}

/**
 * Walk a Sefaria index schema to the first addressable section.
 * Complex works (siddurim, machzorim, some kabbalistic texts) are trees whose
 * leaves are named paths rather than "Title 1"; this finds one.
 */
function firstRefForSchema(node, title) {
  if (!node) return null;
  if (Array.isArray(node.addressTypes) || node.depth) {
    const types = node.addressTypes || [];
    if (types[0] === 'Talmud') return `${title} 2a`;
    const depth = node.depth || types.length || 1;
    if (depth === 1) return title;
    if (depth === 2) return `${title} 1`;
    return `${title} 1:1`;
  }
  for (const child of node.nodes || []) {
    if (!child.title) continue;
    const ref = firstRefForSchema(child, `${title}, ${child.title}`);
    if (ref) return ref;
  }
  return null;
}

// Top-level categories Sefaria's search index files texts under. The Ask tiers
// carry a few more (Philosophy), which the index does not have.
const SEARCH_SCOPES = [
  'Tanakh', 'Talmud', 'Mishnah', 'Midrash', 'Halakhah', 'Kabbalah',
  'Liturgy', 'Jewish Thought', 'Chasidut', 'Musar', 'Responsa',
];

// A commentary is indexed under its own root — "Tanakh Commentary/..." rather
// than "Tanakh/..." — while a primary text or a halakhic code keeps its path.
const COMMENTARY_ROOTS = {
  Tanakh: 'Tanakh Commentary',
  Talmud: 'Talmud Commentary',
  Mishnah: 'Mishnah Commentary',
};
const COMMENTARY_BRANCH = /commentary|rishonim|acharonim/i;

/** The path Sefaria's search index files a work under, from its categories. */
function workSearchPath(title, categories) {
  const path = (categories || []).filter(Boolean).map(String);
  if (!path.length) return title;
  const root = path.slice(1).some((c) => COMMENTARY_BRANCH.test(c))
    ? (COMMENTARY_ROOTS[path[0]] || path[0])
    : path[0];
  return [root, ...path.slice(1), title].join('/');
}

/**
 * The single service layer. Both the Electron IPC bridge and the browser dev
 * harness call these methods, so behaviour stays identical in both shells.
 */
function createService({
  appDataDir, version = '1.0.0', platform = process.platform, encrypt, decrypt,
  // Test seams: a stubbed library or model layer, so the service can be
  // exercised without the network.
  sefaria: sefariaImpl, llm: llmImpl,
}) {
  fs.mkdirSync(appDataDir, { recursive: true });
  const settings = new Settings(path.join(appDataDir, 'settings.json'), { encrypt, decrypt });
  const sefaria = sefariaImpl || new Sefaria({ cacheDir: path.join(appDataDir, 'cache') });
  const llm = llmImpl || new LLM({ getSettings: () => settings.get() });
  const translationCache = new Cache(path.join(appDataDir, 'cache'), { ttlMs: 1000 * 60 * 60 * 24 * 30 });
  // A gloss is stable for as long as the verse and the model are, and it costs
  // a local model twenty seconds to write. Clicking the same word twice, or
  // opening the same verse tomorrow, should be free.
  const glossCache = new Cache(path.join(appDataDir, 'cache'), { ttlMs: 1000 * 60 * 60 * 24 * 30 });
  // Shapes are small and stable for the life of a session; the reader asks for
  // one on every passage it opens.
  const chapterCache = new Map();

  /**
   * What a search should be limited to: the path of a single work, or one
   * top-level category. A work wins over a scope, since it is narrower.
   */
  async function searchFilter({ scope, work } = {}) {
    const title = String(work || '').trim();
    if (title) {
      const unknown = () => Object.assign(
        new Error(`Sefaria has no work called “${title}”. Pick one from the list, or clear the work field.`),
        { code: 'NOT_FOUND' },
      );
      if (typeof sefaria.index !== 'function') return title;
      let index = null;
      try {
        index = await sefaria.index(title);
      } catch (err) {
        if (err && err.status === 404) throw unknown();
        throw err;
      }
      // A title the index does not know comes back without categories; searching
      // it unfiltered would answer a question nobody asked.
      const categories = (index && index.categories) || [];
      if (!categories.length) throw unknown();
      return workSearchPath((index && index.title) || title, categories);
    }
    const chosen = String(scope || '').trim();
    return SEARCH_SCOPES.includes(chosen) ? chosen : '';
  }

  /** A renderer-supplied reading, defaulting to the casual HaShem. */
  const divineParam = (value) => (value === 'adonai' ? 'adonai' : 'hashem');

  // `divine` is the reading substituted for the Tetragrammaton: 'adonai' in
  // liturgy, 'hashem' everywhere else (see src/divine-name.js).
  const withTranslit = (he, divine = 'hashem') => {
    const text = Array.isArray(he) ? he.join(' ') : (he || '');
    if (!text) return null;
    const diacritics = settings.get().diacritics !== false;
    const read = (style) => transliterate(text, { style, diacritics, divineName: divine });
    const result = {
      modern: read('modern'),
      ashkenazi: read('ashkenazi'),
      mizrahi: read('mizrahi'),
      yemeni: read('yemeni'),
      kavkazi: read('kavkazi'),
      ancient: read('ancient'),
      'ancient-hard': read('ancient-hard'),
    };
    // An edition the source never vocalizes has no reading to offer: the line
    // would be a run of bare consonants. Mixed texts (a pointed commentary
    // quoting an unpointed lemma) still get a line.
    const letters = (text.match(/[\u05D0-\u05EA]/g) || []).length;
    const points = (text.match(/[\u05B0-\u05BB\u05C7]/g) || []).length;
    if (!letters || points / letters < 0.08) return null;
    return result;
  };

  /** Load a section and shape it for the reader. */
  async function loadText(ref, version = 'english') {
    const text = await sefaria.text(ref, { version });
    const segments = Math.max(text.he.length, text.en.length);
    // One classification for the whole passage: Adonai in a siddur or haggadah,
    // HaShem in a commentary or a daf.
    const divine = readingFor(text);
    const rows = [];
    for (let i = 0; i < segments; i++) {
      const he = text.he[i] || '';
      const en = text.en[i] || '';
      rows.push({
        he,
        en,
        translit: he ? withTranslit(he, divine) : null,
      });
    }
    const versionLanguage = text.enVersion ? text.enVersion.language : 'english';
    // Never machine-translate over a chosen non-English edition: the reader
    // asked for that language, and mixing generated English into it would be
    // both misleading and wrong.
    const missingEnglish = rows.filter((r) => r.he && r.he.trim() && !(r.en && r.en.trim())).length;
    const translationNote = versionLanguage === 'english'
      ? (missingEnglish
        ? `${missingEnglish} of ${rows.length} segments have no published English translation.`
        : '')
      : `${text.enVersion.title} (${text.enVersion.languageLabel}) covers ${rows.filter((r) => r.en && r.en.trim()).length} of ${rows.length} segments in this passage. Switch the translation back to an English version for English text.`;

    return {
      ref: text.ref,
      heRef: text.heRef,
      title: text.title,
      heTitle: text.heTitle,
      categories: text.categories,
      primaryCategory: text.primaryCategory,
      divineName: divine,
      segRefs: segmentRefsFor(text.ref, segments),
      sectionNames: text.sectionNames,
      next: text.next,
      prev: text.prev,
      rows,
      heVersion: text.heVersion,
      enVersion: text.enVersion,
      availableVersions: text.availableVersions,
      versionOptions: text.versionOptions || [],
      requestedVersion: text.requestedVersion || '',
      versionLanguage,
      versionCoverage: {
        translated: rows.filter((r) => r.en && r.en.trim()).length,
        total: rows.length,
      },
      license: text.license,
      firstAvailableSectionRef: text.firstAvailableSectionRef,
      machineTranslation: false,
      missingEnglish,
      // The reader offers this as a button; nothing is generated until it is
      // pressed.
      canAiTranslate: versionLanguage === 'english' && missingEnglish > 0 && llm.config().configured,
      translationNote,
    };
  }

  /**
   * Sefaria accepts a bare work title, but that returns the entire book. Work
   * out a sensible first section from the index schema instead.
   */
  function startRefFor(title, index) {
    if (index && index.schema) {
      const fromSchema = firstRefForSchema(index.schema, title);
      if (fromSchema) return fromSchema;
    }
    const types = (index && index.addressTypes) || [];
    if (types[0] === 'Talmud') return `${title} 2a`;
    const depth = (index && index.textDepth) || types.length || 1;
    if (depth >= 3) return `${title} 1:1`;
    if (depth === 2) return `${title} 1`;
    return title;
  }

  // Questions in flight, so the renderer's Stop button can abort the model
  // call instead of only hiding the spinner.
  const askInFlight = new Map();
  // Clicking a second word makes the first lookup obsolete: it is aborted, not
  // left to finish and race the newer one.
  let glossInFlight = null;
  let translateInFlight = null;

  const methods = {
    'app.info': async () => ({
      version,
      platform,
      cacheDir: path.join(appDataDir, 'cache'),
      categories: CATEGORIES,
      searchScopes: SEARCH_SCOPES,
      styles: STYLE_INFO,
      providers: Object.fromEntries(
        Object.entries(PROVIDERS).map(([k, v]) => [k, {
          label: v.label, baseUrl: v.baseUrl, model: v.model, keyHint: v.keyHint, docs: v.docs, local: !!v.local,
        }]),
      ),
      needsKey: !llm.config().configured,
    }),

    'settings.get': async () => settings.public(),
    'settings.set': async (patch) => settings.set(patch),

    'llm.test': async () => llm.test(),

    // Lets Settings and the wizard report whether a local server is up and
    // whether the chosen model is actually installed, before anything is saved.
    'llm.status': async (overrides = {}) => llm.status(overrides),

    // What is in memory, and how it is placed (VRAM against system RAM).
    'llm.ps': async () => ({ models: await llm.ps() }),

    // Give the model's memory back now instead of waiting for keep_alive.
    'llm.free': async () => llm.freeMemory(),

    // Full-text search over the library. `start` pages through the hits, so the
    // search view can offer "show more" instead of one long request; `scope`
    // limits it to a category and `work` to a single work.
    'search': async ({ query, size = 14, start = 0, scope = '', work = '' } = {}) => {
      const q = String(query || '').trim();
      if (!q) return { total: 0, took: 0, hits: [] };
      const take = Math.max(1, Math.min(50, Number(size) || 14));
      const from = Math.max(0, Number(start) || 0);
      const filter = await searchFilter({ scope, work });
      const result = await sefaria.search(q, {
        size: take,
        start: from,
        ...(filter ? { filters: [filter] } : {}),
      });
      return { ...result, filter };
    },

    'text': async ({ ref, version = 'english' } = {}) => loadText(ref, version),

    'library.toc': async () => sefaria.toc(),

    /**
     * Sections and chapters of one work, so the library can show a chapter grid
     * without opening the text, and the reader can offer a jump control.
     */
    'library.chapters': async ({ title } = {}) => {
      const asked = String(title || '').trim();
      if (!asked) throw Object.assign(new Error('A work title is required'), { code: 'BAD_INPUT' });
      if (chapterCache.has(asked)) return chapterCache.get(asked);
      let index = null;
      try { index = await sefaria.index(asked); } catch { /* shape alone still helps */ }
      const canonical = (index && index.title) || asked;
      let shape = [];
      try { shape = await sefaria.shape(canonical); } catch { shape = []; }
      const book = buildChapters({
        title: canonical,
        heTitle: (index && index.heTitle) || '',
        categories: (index && index.categories) || [],
        addressTypes: (index && index.addressTypes) || [],
        sectionNames: (index && index.sectionNames) || [],
        depth: (index && index.textDepth) || 0,
        shape,
      });
      chapterCache.set(asked, book);
      if (canonical !== asked) chapterCache.set(canonical, book);
      return book;
    },

    /**
     * Commentary, Midrash, Targum and other works Sefaria links to this passage,
     * grouped by work and ordered the way Sefaria's own commentary list is.
     */
    'commentaries': async ({ ref } = {}) => {
      if (!ref) throw Object.assign(new Error('A reference is required'), { code: 'BAD_INPUT' });
      const text = await sefaria.text(ref);
      const works = await sefaria.commentaries(text.ref || ref);
      const primary = isPrimaryWork(text.categories, text.title);
      const groups = [];
      for (const work of works) {
        let group = groups.find((g) => g.category === work.category);
        if (!group) { group = { category: work.category, works: [] }; groups.push(group); }
        group.works.push({
          title: work.title,
          heTitle: work.heTitle,
          collectiveTitle: work.collectiveTitle,
          category: work.category,
          type: work.type,
          verses: work.verses,
          count: work.count,
          hasEnglish: work.hasEnglish,
          // The commentary's own ref for this verse, from Sefaria's link. Some
          // works (Ramban on Genesis 1:1) cover several verses in one entry and
          // have no text at the later verse's address.
          sourceRef: work.sourceRef || '',
        });
      }
      // Commentary first, then the other genres, in Sefaria's own order.
      const order = ['Commentary', 'Quoting Commentary', 'Midrash', 'Targum', 'Talmud', 'Halakhah', 'Mishnah', 'Tanakh'];
      const rank = (c) => (order.indexOf(c) + 1) || order.length + 1;
      groups.sort((a, b) => rank(a.category) - rank(b.category));
      return {
        ref: text.ref || ref,
        title: text.title,
        categories: text.categories || [],
        primary,
        total: works.length,
        groups,
      };
    },

    /** One linked work over the same passage, aligned to the base segments. */
    'commentary': async ({ ref, work, sourceRef } = {}) => {
      if (!ref || !work) throw Object.assign(new Error('A reference and a commentary are required'), { code: 'BAD_INPUT' });
      const base = await sefaria.text(ref);
      let data = null;
      // The work's own address first: it returns every sub-comment on the verse
      // (Rashi 1:2 has five). Some works have no text at a later verse because a
      // single entry covers several verses (Ramban on Genesis 1:1 covers 1:2),
      // so the link's ref is the fallback.
      try { data = await sefaria.commentaryFor(base.ref || ref, work, base.title); } catch { data = null; }
      if (!data && sourceRef) {
        try { data = await sefaria.text(sourceRef); } catch { data = null; }
      }
      if (!data) throw Object.assign(new Error(`No ${work} text at that passage`), { code: 'NOT_FOUND' });
      // A single verse can carry several sub-comments (Rashi 1:2 has five), so
      // the commentary's own length, not the base's, sets the loop.
      const length = Math.max(base.he.length, base.en.length, data.he.length, data.en.length);
      const segments = [];
      for (let i = 0; i < length; i++) {
        const he = data.he[i] || '';
        const en = data.en[i] || '';
        if (he || en) segments.push({ index: i, he, en });
      }
      return {
        ref: data.ref,
        work,
        title: data.title || work,
        baseRef: base.ref || ref,
        baseSegments: length,
        covered: segments.length,
        aligned: data.he.length === base.he.length || data.en.length === base.en.length,
        segments,
        heVersion: data.heVersion,
        enVersion: data.enVersion,
        license: data.license,
        heTitle: data.heTitle,
      };
    },

    /** Open a work from the library tree at its first real section. */
    'library.open': async ({ title } = {}) => {
      if (!title) throw Object.assign(new Error('A work title is required'), { code: 'BAD_INPUT' });
      let index = null;
      try { index = await sefaria.index(title); } catch { /* fall back to guessing */ }
      const candidates = [];
      if (index) candidates.push(startRefFor(title, index));
      candidates.push(`${title} 1`, title);
      let lastErr = null;
      for (const ref of [...new Set(candidates)]) {
        try {
          const data = await loadText(ref);
          if (data.rows.some((r) => r.he || r.en)) return data;
        } catch (err) { lastErr = err; }
      }
      // Last resort: Sefaria's own idea of the first section for this work.
      const whole = await sefaria.text(title);
      const first = whole.firstAvailableSectionRef || whole.ref;
      if (first && first !== title) return loadText(first);
      throw lastErr || Object.assign(new Error('Could not open that work'), { code: 'NOT_FOUND' });
    },

    'words': async ({ word, divineName } = {}) => {
      const entries = await sefaria.words(word);
      return {
        word,
        entries,
        translit: wordInfo(stripHtml(word || ''), { divineName: divineParam(divineName) }),
      };
    },

    'links': async ({ ref } = {}) => sefaria.links(ref, { withText: false }),

    'ask': async ({ question, category = null, limit = 4, requestId, context = null } = {}, ctx = {}) => {
      const key = requestId ? String(requestId) : '';
      const ctrl = new AbortController();
      if (key) askInFlight.set(key, ctrl);
      const emit = ctx.emit ? (event) => ctx.emit({ type: 'ask', requestId: key, ...event }) : null;
      const onDraft = emit ? (text) => emit({ phase: 'draft', text }) : undefined;
      let result;
      try {
        result = await ask({
          question,
          category,
          limit,
          context,
          sefaria,
          llm,
          signal: ctrl.signal,
          onDraft,
          onStatus: emit ? (event) => emit({ phase: event.phase, model: event.model, timings: event.timings }) : undefined,
        });
        if (ctrl.signal.aborted) {
          const err = new Error('Cancelled.');
          err.code = 'CANCELLED';
          throw err;
        }
      } finally {
        if (key && askInFlight.get(key) === ctrl) askInFlight.delete(key);
      }
      result.sources = await Promise.all(result.sources.map(async (source) => {
        let en = source.en;
        let machineTranslation = false;
        if (!en && source.he && llm.config().configured) {
          try {
            const tr = await translateSegments({ segments: [source.he], ref: source.ref }, { llm, cache: translationCache });
            en = (tr.en && tr.en[0]) || '';
            machineTranslation = Boolean(en);
          } catch { /* leave untranslated */ }
        }
        const divine = readingFor(source);
        return {
          ...source,
          en,
          machineTranslation,
          divineName: divine,
          translit: withTranslit(source.he, divine),
        };
      }));
      return result;
    },

    'ask.cancel': async ({ requestId } = {}) => {
      const ctrl = askInFlight.get(String(requestId || ''));
      if (!ctrl) return { cancelled: false };
      ctrl.abort();
      return { cancelled: true };
    },

    // The window went away (a reload, a closed tab). Nothing is listening for
    // the answer any more, so the model should stop now rather than finish a
    // minute of work into the void.
    'ai.cancelAll': async () => {
      const n = askInFlight.size;
      for (const ctrl of askInFlight.values()) ctrl.abort();
      askInFlight.clear();
      if (glossInFlight) glossInFlight.abort();
      if (translateInFlight) translateInFlight.abort();
      return { cancelled: n };
    },

    'gloss': async ({ word, verseHe, verseEn, divineName } = {}) => {
      const entries = await sefaria.words(word);
      const model = llm.config().model || 'none';
      const key = `${model}|${word}|${verseHe || ''}|${verseEn || ''}`;
      if (glossInFlight) glossInFlight.abort();
      const ctrl = new AbortController();
      glossInFlight = ctrl;
      let out;
      let fromCache = false;
      try {
        const hit = glossCache.get('gloss', key);
        if (hit !== undefined) {
          out = hit;
          fromCache = true;
        } else {
          out = await gloss(
            { word, verseHe, verseEn, lexicon: entries },
            { llm, signal: ctrl.signal },
          );
          // A fallback from the lexicon is shown but not remembered: the model
          // may simply have been busy.
          if (!out.degraded) glossCache.set('gloss', key, out);
        }
      } finally {
        if (glossInFlight === ctrl) glossInFlight = null;
      }
      return {
        ...out,
        cached: fromCache,
        entries,
        translit: wordInfo(stripHtml(word || ''), { divineName: divineParam(divineName) }),
      };
    },

    'translate': async ({ text, contextHe, contextEn, target, divineName } = {}) => {
      const out = await translateSelection({ text, contextHe, contextEn, target }, { llm });
      return { ...out, translit: withTranslit(stripHtml(text || ''), divineParam(divineName)) };
    },

    /**
     * Translate the segments of a passage that the edition leaves untranslated.
     * Called only from the reader's button (or the auto-translate setting),
     * never from loading the passage.
     */
    'translate.missing': async ({ ref, segments = [], requestId } = {}, ctx = {}) => {
      const he = (segments || []).map((s) => String(s || ''));
      if (!ref || !he.length) return { en: [], note: '' };
      if (!llm.config().configured) {
        throw Object.assign(
          new Error('No AI provider is configured. Add one in Settings to translate this text.'),
          { code: 'NO_API_KEY' },
        );
      }
      if (translateInFlight) translateInFlight.abort();
      const ctrl = new AbortController();
      translateInFlight = ctrl;
      const emit = ctx.emit ? (event) => ctx.emit({ type: 'translate', requestId, ...event }) : null;
      try {
        if (emit) emit({ phase: 'starting' });
        const result = await translateSegments({ segments: he, ref }, {
          llm,
          cache: translationCache,
          signal: ctrl.signal,
          onProgress: emit ? (batch, total) => emit({ phase: 'generating', batch, total }) : undefined,
        });
        if (emit) emit({ phase: 'done' });
        return {
          en: result.en,
          note: `AI translation of ${he.length} segment${he.length === 1 ? '' : 's'} Sefaria publishes without English (${llm.config().model}).`,
        };
      } finally {
        if (translateInFlight === ctrl) translateInFlight = null;
      }
    },

    'translate.cancel': async () => {
      if (!translateInFlight) return { cancelled: false };
      translateInFlight.abort();
      return { cancelled: true };
    },

    'translit': async ({ text, style, divineName } = {}) => {
      const clean = stripHtml(text || '');
      const diacritics = settings.get().diacritics !== false;
      const chosen = style || settings.get().style || 'modern';
      const divine = divineParam(divineName);
      const read = (s) => transliterate(clean, { style: s, diacritics, divineName: divine });
      return {
        style: chosen,
        out: read(chosen),
        all: {
          modern: read('modern'),
          ashkenazi: read('ashkenazi'),
          mizrahi: read('mizrahi'),
          yemeni: read('yemeni'),
          kavkazi: read('kavkazi'),
          ancient: read('ancient'),
          'ancient-hard': read('ancient-hard'),
        },
        word: wordInfo(stripHtml(text || '').split(/\s+/)[0] || '', { divineName: divine }),
      };
    },

    'suggestions': async () => ([
      'What does the Torah say about caring for strangers?',
      'How do the sources understand "love your neighbor as yourself"?',
      'Why do we light two candles on Shabbat?',
      'What is the Talmudic debate about the death penalty?',
      'How does Maimonides describe the levels of tzedakah?',
      'What do the commentaries say about the binding of Isaac?',
    ]),
  };

  async function call(method, params = {}, ctx = {}) {
    const fn = methods[method];
    if (!fn) throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'NO_METHOD' });
    try {
      return await fn(params || {}, ctx);
    } catch (err) {
      // Normalise into something the renderer can display and branch on.
      const e = new Error(err.message || 'Request failed');
      e.code = err.code || (err.name === 'SefariaError' ? 'SEFARIA' : 'ERROR');
      e.status = err.status;
      e.expose = true;
      throw e;
    }
  }

  function abortAll() {
    let cancelled = 0;
    for (const ctrl of askInFlight.values()) { ctrl.abort(); cancelled += 1; }
    askInFlight.clear();
    if (glossInFlight) { glossInFlight.abort(); cancelled += 1; }
    if (translateInFlight) { translateInFlight.abort(); cancelled += 1; }
    return cancelled;
  }

  return { call, methods, settings, sefaria, llm, withTranslit, appDataDir, abortAll };
}

module.exports = { createService, segmentRefsFor };
