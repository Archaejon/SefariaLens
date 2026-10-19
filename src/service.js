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

/**
 * The single service layer. Both the Electron IPC bridge and the browser dev
 * harness call these methods, so behaviour stays identical in both shells.
 */
function createService({ appDataDir, version = '1.0.0', platform = process.platform, encrypt, decrypt }) {
  fs.mkdirSync(appDataDir, { recursive: true });
  const settings = new Settings(path.join(appDataDir, 'settings.json'), { encrypt, decrypt });
  const sefaria = new Sefaria({ cacheDir: path.join(appDataDir, 'cache') });
  const llm = new LLM({ getSettings: () => settings.get() });
  const translationCache = new Cache(path.join(appDataDir, 'cache'), { ttlMs: 1000 * 60 * 60 * 24 * 30 });

  /**
   * Fill in an English translation wherever the edition has none.
   *
   * Editions are often translated in part — a commentary whose first three
   * segments have English and whose remaining fifteen do not — so this works
   * per segment rather than giving up when any English exists. Rows that
   * already carry a published translation are never overwritten.
   */
  async function addMachineEnglish(rows, ref) {
    const missing = [];
    rows.forEach((row, index) => {
      if (row.he && row.he.trim() && !(row.en && row.en.trim())) missing.push({ index, he: row.he });
    });
    const hasHebrew = rows.some((r) => r.he && r.he.trim());
    if (!hasHebrew || !missing.length) return { machineTranslation: false, translationNote: '' };
    if (!llm.config().configured) {
      return {
        machineTranslation: false,
        translationNote: missing.length === rows.length
          ? 'No published English translation. Add an AI provider in Settings to generate one.'
          : `${missing.length} of ${rows.length} segments have no published English. Add an AI provider in Settings to translate them.`,
      };
    }
    try {
      const result = await translateSegments({
        segments: missing.map((m) => m.he),
        ref,
      }, { llm, cache: translationCache });
      let filled = 0;
      missing.forEach((m, i) => {
        const en = (result.en[i] || '').trim();
        if (!en) return;
        rows[m.index].en = en;
        rows[m.index].machineTranslation = true;
        filled += 1;
      });
      return {
        machineTranslation: filled > 0,
        translationNote: filled === rows.length
          ? `AI translation of a text Sefaria publishes without English (${llm.config().model}).`
          : `AI translation filled ${filled} of ${rows.length} segments that Sefaria publishes without English (${llm.config().model}).`,
      };
    } catch (err) {
      return {
        machineTranslation: false,
        translationNote: `No published English translation for ${missing.length} of ${rows.length} segments, and the AI translation failed: ${err.message}`,
      };
    }
  }

  const withTranslit = (he) => {
    const text = Array.isArray(he) ? he.join(' ') : (he || '');
    if (!text) return null;
    const diacritics = settings.get().diacritics !== false;
    const result = {
      modern: transliterate(text, { style: 'modern', diacritics }),
      ashkenazi: transliterate(text, { style: 'ashkenazi', diacritics }),
      mizrahi: transliterate(text, { style: 'mizrahi', diacritics }),
    };
    // An unvocalized edition cannot be transliterated; showing the Hebrew back
    // again would just duplicate the source line. Mixed texts (a pointed
    // commentary quoting an unpointed lemma) still get a line.
    const heb = (result.modern.match(/[\u05D0-\u05EA]/g) || []).length;
    const latin = (result.modern.match(/[A-Za-z]/g) || []).length;
    if (heb > 2 && latin < heb) return null;
    return result;
  };

  /** Load a section and shape it for the reader. */
  async function loadText(ref, version = 'english') {
    const text = await sefaria.text(ref, { version });
    const segments = Math.max(text.he.length, text.en.length);
    const rows = [];
    for (let i = 0; i < segments; i++) {
      const he = text.he[i] || '';
      const en = text.en[i] || '';
      rows.push({
        he,
        en,
        translit: he ? withTranslit(he) : null,
      });
    }
    const versionLanguage = text.enVersion ? text.enVersion.language : 'english';
    // Never machine-translate over a chosen non-English edition: the reader
    // asked for that language, and mixing generated English into it would be
    // both misleading and wrong. English versions still get gap-filling.
    const english = versionLanguage === 'english'
      ? await addMachineEnglish(rows, text.ref)
      : {
        machineTranslation: false,
        translationNote: `${text.enVersion.title} (${text.enVersion.languageLabel}) covers ${rows.filter((r) => r.en && r.en.trim()).length} of ${rows.length} segments in this passage. Switch the translation back to an English version for English text.`,
      };

    return {
      ref: text.ref,
      heRef: text.heRef,
      title: text.title,
      heTitle: text.heTitle,
      categories: text.categories,
      primaryCategory: text.primaryCategory,
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
      machineTranslation: english.machineTranslation,
      translationNote: english.translationNote,
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

  const methods = {
    'app.info': async () => ({
      version,
      platform,
      cacheDir: path.join(appDataDir, 'cache'),
      categories: CATEGORIES,
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

    'search': async ({ query, size = 14 } = {}) => {
      const result = await sefaria.search(query, { size });
      return result;
    },

    'text': async ({ ref, version = 'english' } = {}) => loadText(ref, version),

    'library.toc': async () => sefaria.toc(),

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

    'words': async ({ word } = {}) => {
      const entries = await sefaria.words(word);
      return { word, entries, translit: wordInfo(stripHtml(word || '')) };
    },

    'links': async ({ ref } = {}) => sefaria.links(ref, { withText: false }),

    'ask': async ({ question, category = null, limit = 4, requestId } = {}) => {
      const key = requestId ? String(requestId) : '';
      const ctrl = new AbortController();
      if (key) askInFlight.set(key, ctrl);
      let result;
      try {
        result = await ask({ question, category, limit, sefaria, llm, signal: ctrl.signal });
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
        return { ...source, en, machineTranslation, translit: withTranslit(source.he) };
      }));
      return result;
    },

    'ask.cancel': async ({ requestId } = {}) => {
      const ctrl = askInFlight.get(String(requestId || ''));
      if (!ctrl) return { cancelled: false };
      ctrl.abort();
      return { cancelled: true };
    },

    'gloss': async ({ word, verseHe, verseEn } = {}) => {
      const entries = await sefaria.words(word);
      const out = await gloss({ word, verseHe, verseEn, lexicon: entries }, { llm });
      return { ...out, entries, translit: wordInfo(stripHtml(word || '')) };
    },

    'translate': async ({ text, contextHe, contextEn, target } = {}) => {
      const out = await translateSelection({ text, contextHe, contextEn, target }, { llm });
      return { ...out, translit: withTranslit(stripHtml(text || '')) };
    },

    'translit': async ({ text, style } = {}) => {
      const clean = stripHtml(text || '');
      const diacritics = settings.get().diacritics !== false;
      const chosen = style || settings.get().style || 'modern';
      return {
        style: chosen,
        out: transliterate(clean, { style: chosen, diacritics }),
        all: {
          modern: transliterate(clean, { style: 'modern', diacritics }),
          ashkenazi: transliterate(clean, { style: 'ashkenazi', diacritics }),
          mizrahi: transliterate(clean, { style: 'mizrahi', diacritics }),
        },
        word: wordInfo(stripHtml(text || '').split(/\s+/)[0] || ''),
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

  async function call(method, params = {}) {
    const fn = methods[method];
    if (!fn) throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'NO_METHOD' });
    try {
      return await fn(params || {});
    } catch (err) {
      // Normalise into something the renderer can display and branch on.
      const e = new Error(err.message || 'Request failed');
      e.code = err.code || (err.name === 'SefariaError' ? 'SEFARIA' : 'ERROR');
      e.status = err.status;
      e.expose = true;
      throw e;
    }
  }

  return { call, methods, settings, sefaria, llm, withTranslit, appDataDir };
}

module.exports = { createService, segmentRefsFor };
