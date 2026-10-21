'use strict';

// Named entities Sefaria's texts actually contain. The important one is
// &thinsp;: the Masoretic text wraps the paseq (׀) in thin spaces, so without
// this entry the reader showed the literal "&thinsp;׀" in Psalms and the Torah.
// An entity missing from this table is dropped rather than shown, so markup can
// never leak into the reading text again.
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  // spaces and invisible marks
  '&nbsp;': ' ', '&ensp;': '\u2002', '&emsp;': '\u2003', '&thinsp;': '\u2009',
  '&hairsp;': '\u200A', '&numsp;': '\u2007', '&puncsp;': '\u2008',
  '&zwnj;': '\u200C', '&zwj;': '\u200D', '&zwsp;': '\u200B',
  '&lrm;': '\u200E', '&rlm;': '\u200F', '&shy;': '\u00AD',
  // typography
  '&ndash;': '–', '&mdash;': '—', '&hellip;': '…', '&bull;': '•',
  '&middot;': '·', '&lsquo;': '‘', '&rsquo;': '’', '&sbquo;': '‚',
  '&ldquo;': '“', '&rdquo;': '”', '&bdquo;': '„', '&lsaquo;': '‹',
  '&rsaquo;': '›', '&laquo;': '«', '&raquo;': '»', '&prime;': '′',
  '&Prime;': '″', '&oline;': '‾', '&frasl;': '⁄', '&dagger;': '†',
  '&Dagger;': '‡', '&sect;': '§', '&para;': '¶', '&deg;': '°',
  '&plusmn;': '±', '&times;': '×', '&divide;': '÷', '&minus;': '−',
  '&frac12;': '½', '&frac14;': '¼', '&frac34;': '¾', '&sup1;': '¹',
  '&sup2;': '²', '&sup3;': '³', '&micro;': 'µ', '&permil;': '‰',
  '&cent;': '¢', '&pound;': '£', '&yen;': '¥', '&euro;': '€',
  '&copy;': '©', '&reg;': '®', '&trade;': '™',
  // arrows and signs used in scholarly notes
  '&larr;': '←', '&rarr;': '→', '&uarr;': '↑', '&darr;': '↓',
  '&harr;': '↔', '&lArr;': '⇐', '&rArr;': '⇒', '&hArr;': '⇔',
  '&le;': '≤', '&ge;': '≥', '&ne;': '≠', '&asymp;': '≈',
  '&infin;': '∞', '&sum;': '∑', '&prod;': '∏', '&radic;': '√',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, name) =>
      ENTITIES[m] ?? ENTITIES[`&${name.toLowerCase()};`] ?? '');
}

/**
 * Drop `<i class="footnote">…</i>` blocks, which routinely contain a nested
 * `<i>` for a transliterated word. A non-greedy regex stops at that inner tag
 * and leaves the rest of the note in the running text, so the block is matched
 * by walking its nesting depth instead.
 */
function dropFootnotes(s) {
  const open = /<i\b[^>]*class="footnote"[^>]*>/i;
  let out = s;
  for (;;) {
    const m = open.exec(out);
    if (!m) return out;
    const tagRe = /<\/?i\b[^>]*>/gi;
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = -1;
    let t;
    while ((t = tagRe.exec(out))) {
      if (t[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) { end = t.index + t[0].length; break; }
      } else {
        depth += 1;
      }
    }
    if (end === -1) return out;
    out = out.slice(0, m.index) + out.slice(end);
  }
}

/** Strip Sefaria's inline markup, dropping footnote bodies entirely. */
function stripHtml(input) {
  if (input == null) return '';
  let s = String(input);
  s = s.replace(/<sup[^>]*class="footnote-marker"[^>]*>[\s\S]*?<\/sup>/gi, '');
  s = dropFootnotes(s);
  s = s.replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '');
  // The Masorah edition closes a paragraph with a wrapped marker
  // ("&nbsp;<span class=\"mam-spi-pe\">{פ}</span>"). It is page furniture, not
  // words, and reads as debris inline, so the whole marker goes.
  s = s.replace(/<span[^>]*class="[^"]*mam-spi-[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/?(?:b|i|em|strong|big|small|span|div|p|a|u|h1|h2|h3)[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // A marker left without its span (or any other stray section sign).
  s = s.replace(/\s*\{[פס]\}/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Turn a Sefaria text node into one string per addressable segment.
 *
 * The top-level array is the list of segments (verses, mishnayot, daf lines).
 * Nested arrays belong to a single segment, so they are joined, not split.
 */
function toSegments(text) {
  if (text == null) return [];
  if (typeof text === 'string') return [text];
  if (!Array.isArray(text)) return [String(text)];
  return text.map((node) => {
    if (node == null) return '';
    if (Array.isArray(node)) return node.map(flattenNode).join(' ');
    return String(node);
  });
}

function flattenNode(node) {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(flattenNode).join(' ');
  return String(node);
}

const HE_RANGE = /[\u0590-\u05FF]/;

function isHebrew(s) {
  return HE_RANGE.test(s || '');
}

/**
 * Sefaria search returns ids like:
 *   "Genesis 1:1 (The JPS Tanakh [en])"
 *   "Mishneh Torah, Positive Mitzvot 206 (Mishneh Torah ... [en])"
 * Split the ref from the version suffix.
 */
function parseSearchId(id) {
  if (!id) return null;
  const m = String(id).match(/\s*\(([^()]*)\[(he|en)\]\s*\)\s*$/);
  if (m) {
    return { ref: String(id).slice(0, m.index).trim(), versionTitle: m[1].trim(), lang: m[2] };
  }
  return { ref: String(id).trim(), versionTitle: '', lang: isHebrew(id) ? 'he' : 'en' };
}

/** Trim to a character budget on a word boundary. */
function clip(s, max) {
  if (!s || s.length <= max) return s || '';
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trim() + '…';
}

function normQuery(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Rough token count, for keeping a prompt inside the model's context window.
 *
 * A pointed Hebrew word costs far more tokens than its length suggests — a
 * local model spends roughly one token per character and a half of niqqud-laden
 * text, against four characters per token for English. Estimated on that split
 * with a little headroom, which is enough to trim a candidate list before it is
 * sent; the real count comes back from the server afterwards.
 */
function estimateTokens(s) {
  const text = String(s == null ? '' : s);
  if (!text) return 0;
  const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const other = text.length - hebrew;
  return Math.ceil(hebrew / 1.55 + other / 4) + 1;
}

module.exports = {
  stripHtml, toSegments, decodeEntities, isHebrew, parseSearchId, clip, normQuery, estimateTokens,
};
