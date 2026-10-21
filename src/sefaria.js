'use strict';

const { Cache } = require('./cache.js');
const { stripHtml, toSegments, parseSearchId, isHebrew, clip } = require('./util.js');

const BASE = 'https://www.sefaria.org';

/**
 * Sefaria titles non-English translations with a language tag in brackets —
 * "Talmud Bavli. German trans. … [de]" — while the API reports every one of them
 * as `language: "en"`. The tag is the reliable signal, and the language name is
 * what the `version=` parameter wants: `german|Title`, not `english|Title`.
 */
const VERSION_LANGUAGES = {
  en: 'english', he: 'hebrew', de: 'german', ru: 'russian', pt: 'portuguese',
  fr: 'french', es: 'spanish', it: 'italian', itk: 'italian', nl: 'dutch',
  pl: 'polish', hu: 'hungarian', cs: 'czech', tr: 'turkish', ar: 'arabic',
  fa: 'persian', el: 'greek', la: 'latin', yi: 'yiddish', ro: 'romanian',
  sv: 'swedish', da: 'danish', no: 'norwegian', fi: 'finnish', uk: 'ukrainian',
  eo: 'esperanto', lad: 'ladino', ca: 'catalan', gl: 'galician', eu: 'basque',
  oc: 'occitan', hr: 'croatian', sr: 'serbian', bs: 'bosnian', sl: 'slovenian',
  sk: 'slovak', bg: 'bulgarian', mk: 'macedonian', lt: 'lithuanian',
  lv: 'latvian', et: 'estonian', af: 'afrikaans', id: 'indonesian',
  ms: 'malay', vi: 'vietnamese', ko: 'korean', ja: 'japanese', zh: 'chinese',
  hi: 'hindi', ka: 'georgian', hy: 'armenian', am: 'amharic', sw: 'swahili',
  az: 'azerbaijani', kk: 'kazakh', uz: 'uzbek', mt: 'maltese', ga: 'irish',
  cy: 'welsh', is: 'icelandic', sq: 'albanian', be: 'belarusian',
};
const LANGUAGE_LABELS = {
  english: 'English', hebrew: 'Hebrew', german: 'German', russian: 'Russian',
  portuguese: 'Portuguese', french: 'French', spanish: 'Spanish',
  italian: 'Italian', dutch: 'Dutch', polish: 'Polish', hungarian: 'Hungarian',
  czech: 'Czech', turkish: 'Turkish', arabic: 'Arabic', persian: 'Persian',
  greek: 'Greek', latin: 'Latin', yiddish: 'Yiddish', romanian: 'Romanian',
  swedish: 'Swedish', danish: 'Danish', norwegian: 'Norwegian',
  finnish: 'Finnish', ukrainian: 'Ukrainian', esperanto: 'Esperanto',
  ladino: 'Ladino', catalan: 'Catalan', galician: 'Galician', basque: 'Basque',
  occitan: 'Occitan', croatian: 'Croatian', serbian: 'Serbian',
  bosnian: 'Bosnian', slovenian: 'Slovenian', slovak: 'Slovak',
  bulgarian: 'Bulgarian', macedonian: 'Macedonian', lithuanian: 'Lithuanian',
  latvian: 'Latvian', estonian: 'Estonian', afrikaans: 'Afrikaans',
  indonesian: 'Indonesian', malay: 'Malay', vietnamese: 'Vietnamese',
  korean: 'Korean', japanese: 'Japanese', chinese: 'Chinese', hindi: 'Hindi',
  georgian: 'Georgian', armenian: 'Armenian', amharic: 'Amharic',
  swahili: 'Swahili', azerbaijani: 'Azerbaijani', kazakh: 'Kazakh',
  uzbek: 'Uzbek', maltese: 'Maltese', irish: 'Irish', welsh: 'Welsh',
  icelandic: 'Icelandic', albanian: 'Albanian', belarusian: 'Belarusian',
};
const RTL_LANGUAGES = new Set(['hebrew', 'arabic', 'persian', 'yiddish']);

/** Display name for a language, falling back to the bare tag in capitals. */
function languageLabel(language) {
  return LANGUAGE_LABELS[language] || String(language || '').toUpperCase();
}

/** Language of a version, from its title tag rather than Sefaria's label. */
function languageForVersion(title, declared) {
  const tag = String(title || '').match(/\[([a-z]{2,3})\]\s*$/i);
  if (tag && VERSION_LANGUAGES[tag[1].toLowerCase()]) return VERSION_LANGUAGES[tag[1].toLowerCase()];
  if (declared === 'he' || declared === 'hebrew') return 'hebrew';
  if (declared && declared !== 'en' && VERSION_LANGUAGES[declared]) return VERSION_LANGUAGES[declared];
  // An unfamiliar tag is still a non-English edition. Keeping the tag (rather
  // than claiming the version is English) makes the request fail visibly and
  // keeps the picker honest, instead of silently returning Hebrew alone.
  if (tag) return tag[1].toLowerCase();
  return 'english';
}

/** "german|Title" -> { language, title, explicit }; a bare title means English. */
function parseVersion(version) {
  const raw = String(version || 'english');
  if (raw.includes('|')) {
    const [language, ...rest] = raw.split('|');
    return { language, title: rest.join('|'), explicit: true };
  }
  if (raw === 'english' || raw === 'hebrew') return { language: raw, title: '', explicit: false };
  return { language: 'english', title: raw, explicit: true };
}

/** Best-effort language of the returned text, for versions Sefaria mislabels. */
function detectTextLanguage(segments) {
  const sample = (segments || []).join(' ').slice(0, 3000);
  const count = (re) => (sample.match(re) || []).length;
  const latin = count(/[A-Za-z]/g);
  const scripts = [
    ['russian', /[\u0400-\u04FF]/g],
    ['arabic', /[\u0600-\u06FF]/g],
    ['greek', /[\u0370-\u03FF]/g],
    ['hebrew', /[\u05D0-\u05EA]/g],
  ];
  for (const [language, re] of scripts) {
    const n = count(re);
    if (n > 20 && n > latin) return language;
  }
  return '';
}

class SefariaError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'SefariaError';
    this.status = status;
    this.url = url;
  }
}

/** Serialises requests: Sefaria asks clients to self-limit rather than hammer the API. */
class Limiter {
  constructor({ concurrency = 4, minGapMs = 90 } = {}) {
    this.concurrency = concurrency;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.queue = [];
    this.last = 0;
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      const wait = Math.max(0, this.minGapMs - (Date.now() - this.last));
      this.last = Date.now() + wait;
      setTimeout(() => {
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => {
            this.active -= 1;
            this.pump();
          });
      }, wait);
    }
  }
}

class Sefaria {
  constructor({ cacheDir, fetchImpl = fetch, timeoutMs = 25000, userAgent } = {}) {
    this.cache = new Cache(cacheDir || require('node:path').join(require('node:os').tmpdir(), 'sefaria-lens-cache'));
    this.limiter = new Limiter();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent || 'SefariaLens/1.0 (desktop study app)';
  }

  async request(url, { method = 'GET', body, retries = 2 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.limiter.run(() => this.fetchImpl(url, {
          method,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': this.userAgent,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        }));
        clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) {
          const waitMs = 400 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, waitMs));
          lastErr = new SefariaError(`Sefaria responded ${res.status}`, { status: res.status, url });
          continue;
        }
        if (res.status === 404) {
          throw new SefariaError('Sefaria has no text at that reference. Try a form like "Genesis 1:1", "Berakhot 2a", or "Mishnah Avot 1:1".', { status: 404, url });
        }
        if (!res.ok) {
          throw new SefariaError(`Sefaria responded ${res.status} for ${decodeURIComponent(url)}`, { status: res.status, url });
        }
        const text = await res.text();
        try { return JSON.parse(text); } catch {
          throw new SefariaError('Sefaria returned a non-JSON response', { status: res.status, url });
        }
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (err.name === 'AbortError') {
          lastErr = new SefariaError('Sefaria request timed out', { url });
        }
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr || new SefariaError('Sefaria request failed', { url });
  }

  /** Full text for a ref, with alignment between the Hebrew and target version. */
  async text(ref, { version = 'english', includeHebrew = true } = {}) {
    const clean = String(ref || '').trim();
    if (!clean) throw new SefariaError('A reference is required');
    // Bump this whenever the shape derived from Sefaria's response changes:
    // shaped results are cached, so an old entry would otherwise keep serving
    // stale language labels and an empty translation after an upgrade. v5 decodes
    // the thin spaces Sefaria wraps around the paseq; v4 entries still hold the
    // literal entity.
    const key = `v5|${clean}|${version}|${includeHebrew}`;
    return this.cache.wrap('text', key, async () => {
      const wanted = parseVersion(version);
      const requested = wanted.title ? `${wanted.language}|${wanted.title}` : wanted.language;
      const params = new URLSearchParams();
      params.append('version', 'source');
      if (includeHebrew) params.append('version', 'hebrew');
      if (requested && requested !== 'hebrew') params.append('version', requested);
      const url = `${BASE}/api/v3/texts/${encodeURIComponent(clean)}?${params}`;
      const data = await this.request(url);

      const versions = Array.isArray(data.versions) ? data.versions : [];
      const pick = (lang) => versions.find((v) => v.language === lang) || null;
      const heVersion = pick('he');
      let enVersion = null;
      if (wanted.title) {
        // Match on the title: Sefaria reports non-English versions as "en".
        enVersion = versions.find((v) => v.versionTitle === wanted.title) || null;
        if (!enVersion) {
          throw new SefariaError(`Sefaria has no “${wanted.title}” at that reference. Choose another translation.`, { status: 404, url });
        }
      } else {
        enVersion = pick('en') || versions.find((v) => v.language !== 'he') || null;
      }

      const heSegments = heVersion ? toSegments(heVersion.text).map(stripHtml) : [];
      const enSegments = enVersion ? toSegments(enVersion.text).map(stripHtml) : [];

      if (wanted.title && !enSegments.some((s) => s.trim())) {
        throw new SefariaError(`“${wanted.title}” has no text for this passage. Try another translation.`, { status: 404, url });
      }

      const declaredLanguage = enVersion ? languageForVersion(enVersion.versionTitle, enVersion.language) : 'english';
      // A few community versions are filed as English but hold another
      // language; the script tells the truth, so label them honestly.
      const detected = detectTextLanguage(enSegments);
      const enLanguage = declaredLanguage === 'english' && detected ? detected : declaredLanguage;

      // Only translations are offered in the picker; the Hebrew column is the
      // source. Sefaria's "language" field cannot be trusted here, so the title
      // tag drives both the label and the parameter used to fetch it.
      const versionOptions = [];
      for (const v of data.available_versions || []) {
        if (!v.versionTitle || v.language === 'he') continue;
        if (versionOptions.some((o) => o.title === v.versionTitle)) continue;
        const language = languageForVersion(v.versionTitle, v.language);
        versionOptions.push({
          title: v.versionTitle,
          language,
          languageLabel: languageLabel(language),
        });
      }
      if (enVersion && !versionOptions.some((o) => o.title === enVersion.versionTitle)) {
        versionOptions.unshift({
          title: enVersion.versionTitle,
          language: enLanguage,
          languageLabel: languageLabel(enLanguage),
        });
      }

      return {
        ref: data.ref || clean,
        heRef: data.heRef || '',
        title: data.indexTitle || data.book || '',
        heTitle: data.heIndexTitle || data.heTitle || '',
        categories: data.categories || [],
        primaryCategory: data.primary_category || (data.categories || [])[0] || '',
        sectionNames: data.sectionNames || [],
        next: data.next || null,
        prev: data.prev || null,
        firstAvailableSectionRef: data.firstAvailableSectionRef || null,
        isComplex: !!data.isComplex,
        he: heSegments,
        en: enSegments,
        heVersion: heVersion ? { title: heVersion.versionTitle, license: heVersion.license } : null,
        enVersion: enVersion ? {
          title: enVersion.versionTitle,
          license: enVersion.license,
          language: enLanguage,
          languageLabel: languageLabel(enLanguage),
          direction: RTL_LANGUAGES.has(enLanguage) ? 'rtl' : 'ltr',
        } : null,
        requestedVersion: wanted.title || '',
        versionOptions: versionOptions.slice(0, 40),
        availableVersions: versionOptions.map((v) => v.title).slice(0, 40),
        license: (enVersion && enVersion.license) || (heVersion && heVersion.license) || '',
      };
    });
  }

  /**
   * Elasticsearch-backed library search. Returns normalised hits.
   *
   * `filters` is a list of slash-separated table-of-contents paths, e.g.
   * `['Tanakh']` or `['Tanakh/Torah/Exodus']`; Sefaria applies each entry to the
   * field named at the same position in `filterFields` (text search only has
   * `path`). `field` and `slop` expose Sefaria's lemmatised Hebrew matching.
   */
  async search(query, {
    size = 12, start = 0, type = 'text', filters = null, filterFields = null, field = null, slop = null,
  } = {}) {
    const q = String(query || '').trim();
    if (!q) return { total: 0, hits: [] };
    const fields = filters ? (filterFields || filters.map(() => 'path')) : null;
    const key = `v2|${q}|${size}|${start}|${type}|${filters ? JSON.stringify(filters) : ''}`
      + `|${fields ? JSON.stringify(fields) : ''}|${field || ''}|${slop == null ? '' : slop}`;
    return this.cache.wrap('search', key, async () => {
      const body = { query: q, type, size, start };
      if (filters) { body.filters = filters; body.filter_fields = fields; }
      if (field) body.field = field;
      if (slop != null) body.slop = slop;
      const data = await this.request(`${BASE}/api/search-wrapper`, { method: 'POST', body });
      const hits = (data.hits && data.hits.hits) || [];
      return {
        total: (data.hits && data.hits.total) || 0,
        took: data.took || 0,
        hits: hits.map((h) => {
          const parsed = parseSearchId(h._id) || { ref: h._id, lang: 'en', versionTitle: '' };
          const highlight = h.highlight
            ? Object.values(h.highlight).flat().join(' ')
            : '';
          return {
            ref: parsed.ref,
            lang: parsed.lang,
            versionTitle: parsed.versionTitle,
            score: h._score || 0,
            highlight: stripHtml(highlight),
          };
        }).filter((h) => h.ref),
      };
    });
  }

  /** Lexicon entries (BDB, Jastrow, ...) for a single word. */
  async words(word) {
    const clean = String(word || '').replace(/[\u0591-\u05C7]/g, '').trim() ||
      String(word || '').trim();
    if (!clean) return [];
    return this.cache.wrap('words', `v2|${clean}`, async () => {
      for (const candidate of [String(word).trim(), clean]) {
        try {
          const data = await this.request(`${BASE}/api/words/${encodeURIComponent(candidate)}`);
          if (Array.isArray(data) && data.length) {
            return data.map((entry) => ({
              headword: entry.headword || '',
              lexicon: entry.parent_lexicon || '',
              transliteration: entry.transliteration || '',
              pronunciation: entry.pronunciation || '',
              strong: entry.strong_number || '',
              language: entry.language_code || '',
              morphology: (entry.content && entry.content.morphology) || '',
              senses: flattenSenses(entry.content),
              refs: (entry.refs || []).slice(0, 8),
            }));
          }
        } catch { /* try the next form */ }
      }
      return [];
    });
  }

  async links(ref, { withText = false } = {}) {
    if (!ref) return [];
    return this.cache.wrap('links', `${ref}|${withText}`, async () => {
      const url = `${BASE}/api/links/${encodeURIComponent(ref)}?with_text=${withText ? 1 : 0}`;
      const data = await this.request(url);
      return (Array.isArray(data) ? data : []).map((l) => {
        const collective = l.collectiveTitle && typeof l.collectiveTitle === 'object' ? l.collectiveTitle : {};
        return {
          ref: l.ref || '',
          heRef: l.heRef || '',
          category: l.category || '',
          type: l.type || '',
          commentator: l.commentator || '',
          collectiveTitle: collective.en || (typeof l.collectiveTitle === 'string' ? l.collectiveTitle : ''),
          collectiveHeTitle: collective.he || '',
          indexTitle: l.index_title || '',
          heTitle: l.heTitle || '',
          anchorRef: l.anchorRef || '',
          sourceHasEn: !!l.sourceHasEn,
          composition: Array.isArray(l.compDate) ? l.compDate[0] : (l.compDate || null),
          text: withText ? stripHtml(typeof l.text === 'string' ? l.text : '') : undefined,
        };
      }).filter((l) => l.ref);
    });
  }

  /**
   * The classic running commentaries, in the order Sefaria's own sidebar leads
   * with them. Everything else follows by composition date.
   */
  static COMMENTARY_ORDER = [
    'Rashi', 'Ramban', 'Ibn Ezra', 'Rashbam', 'Sforno', 'Kli Yakar', 'Or HaChaim',
    'Baal HaTurim', 'Radak', 'Tur', 'Abarbanel', 'Malbim', 'Shadal', 'Ralbag',
    'Chizkuni', 'Da’at Zkenim', "Da'at Zkenim", 'Tzror Hamor', 'Alshich', 'Birkat Hatorah',
    'Metsudat David', 'Metsudat Zion', 'Metzudat David', 'Metzudat Zion', 'Ibn Janach',
    'Tosafot', 'Rif', 'Rosh', 'Rambam', 'Meiri', 'Ran', 'Rashba', 'Ritva',
    'Bereshit Rabbah', 'Vayikra Rabbah', 'Shemot Rabbah', 'Devarim Rabbah', 'Midrash Tanchuma',
    'Tanchuma', 'Pesikta', 'Yalkut Shimoni', 'Sifra', 'Sifrei', 'Mekhilta',
    'Onkelos', 'Targum Jonathan', 'Targum Yerushalmi', 'Targum',
  ];

  /**
   * Every work Sefaria links to a passage, grouped by work and ordered the way
   * Sefaria's own commentary tabs are: the classics first, then by composition
   * date, then by how much of the passage the work actually covers.
   */
  async commentaries(ref, { minCoverage = 1 } = {}) {
    if (!ref) return [];
    const links = await this.links(ref);
    const groups = new Map();
    for (const l of links) {
      if (!l.indexTitle || !l.category) continue;
      let g = groups.get(l.indexTitle);
      if (!g) {
        g = {
          title: l.indexTitle,
          heTitle: l.heTitle || '',
          collectiveTitle: l.collectiveTitle || '',
          collectiveHeTitle: l.collectiveHeTitle || '',
          category: l.category,
          type: l.type || '',
          count: 0,
          hasEnglish: false,
          composition: null,
          // anchor (verse) -> the commentary's own ref for it. A work may comment
          // on several verses in one entry (Ramban on Genesis 1:1 covers 1:2), so
          // the anchor is the only reliable way back to the text.
          anchors: new Map(),
        };
        groups.set(l.indexTitle, g);
      }
      g.count += 1;
      if (l.anchorRef && !g.anchors.has(l.anchorRef)) g.anchors.set(l.anchorRef, l.ref);
      if (l.sourceHasEn) g.hasEnglish = true;
      if (!g.composition && l.composition) g.composition = l.composition;
    }

    const order = new Map(Sefaria.COMMENTARY_ORDER.map((name, i) => [name, i]));
    // Works in the classic list keep its order. Everything else follows by
    // composition date, scaled into a band that always sits after them —
    // including Tanakh books quoted in the passage, whose dates are BCE.
    const base = order.size + 1;
    const dateBand = (composition) => {
      const year = Number.isFinite(composition) ? composition : 1200;
      return Math.max(0, Math.min(40, (Math.max(-1000, Math.min(2000, year)) + 1000) / 75));
    };
    const rank = (g) => {
      const name = g.collectiveTitle || g.title;
      for (const [key, i] of order) {
        if (name === key || name.startsWith(`${key} `) || g.title.startsWith(key)) return i;
      }
      return base + dateBand(g.composition);
    };

    return [...groups.values()]
      .map((g) => ({
        ...g,
        verses: g.anchors.size,
        // Prefer the commentary ref linked to the requested verse; otherwise the
        // first linked entry, which is all a passage-level list can offer.
        sourceRef: g.anchors.get(String(ref || '').trim()) || [...g.anchors.values()][0] || '',
        anchors: undefined,
      }))
      .filter((g) => g.verses >= minCoverage)
      .sort((a, b) => (rank(a) - rank(b)) || (b.count - a.count));
  }

  /**
   * One linked work over the same passage as the base text.
   *
   * Sefaria accepts the base range's section on the commentary's own index
   * title ("Rashi on Genesis" + "1:1-3"), and returns one entry per base verse
   * — nested sub-comments included — so the two texts line up by index.
   */
  async commentaryFor(ref, work, baseTitle) {
    const clean = String(ref || '').trim();
    const title = String(baseTitle || '').trim();
    if (!clean || !work) return null;
    let suffix = '';
    if (title && clean.startsWith(title)) suffix = clean.slice(title.length).trim();
    else suffix = (clean.match(/\s(.+)$/) || [])[1] || '';
    if (!suffix) return null;
    return this.text(`${work} ${suffix}`);
  }

  /** Table of contents, used for the library browser. */
  async toc() {
    return this.cache.wrap('toc', 'v1', async () => {
      const data = await this.request(`${BASE}/api/index/`);
      const shape = (nodes) => (Array.isArray(nodes) ? nodes.map((n) => ({
        title: n.title || '',
        heTitle: n.heTitle || '',
        category: n.category || '',
        contents: n.contents ? shape(n.contents) : undefined,
      })) : []);
      return shape(data);
    });
  }

  /**
   * Sefaria's shape for a work: one node per addressable section, with the
   * number of segments in each chapter. Complex works nest further nodes.
   */
  async shape(title) {
    const clean = String(title || '').trim();
    if (!clean) return [];
    return this.cache.wrap('shape', `v1|${clean}`, async () => {
      const data = await this.request(`${BASE}/api/shape/${encodeURIComponent(clean)}`);
      return Array.isArray(data) ? data : [];
    });
  }

  /**
   * Work title -> category path, built from the table of contents so search hits
   * can be placed in a tier without fetching each text.
   */
  async categoryMap() {
    return this.cache.wrap('catmap', 'v1', async () => {
      const toc = await this.toc();
      const map = {};
      const walk = (nodes, path) => {
        for (const node of nodes || []) {
          const next = node.category ? [...path, node.category] : path;
          if (node.title) {
            map[node.title] = next;
            // Refs address Mishnah tractates as "Mishnah Avot 1:1" while the
            // table of contents lists the leaf as "Avot".
            if (next.includes('Mishnah') && !/^Mishnah\b/.test(node.title)) {
              map[`Mishnah ${node.title}`] = next;
            }
          } else if (node.category && !node.contents) {
            map[node.category] = next;
          }
          if (node.contents) walk(node.contents, next);
        }
      };
      walk(toc, []);
      return map;
    });
  }

  async index(title) {
    if (!title) return null;      return this.cache.wrap('index', `v2|${title}`, async () => {
      const data = await this.request(`${BASE}/api/v2/index/${encodeURIComponent(title)}`);
      return {
        title: data.title || title,
        heTitle: data.heTitle || '',
        categories: data.categories || [],
        sectionNames: data.schema && data.schema.sectionNames ? data.schema.sectionNames : [],
        addressTypes: (data.schema && data.schema.addressTypes) || [],
        lengths: (data.schema && data.schema.lengths) || [],
        textDepth: data.schema && data.schema.depth,
        schema: data.schema || null,
        primaryCategory: data.primary_category || (data.categories || [])[0] || '',
      };
    });
  }
}

function flattenSenses(content) {
  const out = [];
  const walk = (node, depth) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth)); return; }
    if (node.definition) out.push({ depth, text: clip(stripHtml(node.definition), 300) });
    if (node.senses) walk(node.senses, depth + 1);
  };
  walk(content && content.senses, 0);
  return out.slice(0, 8);
}

module.exports = {
  Sefaria, SefariaError, BASE, isHebrew,
  languageForVersion, parseVersion, detectTextLanguage, LANGUAGE_LABELS,
};
