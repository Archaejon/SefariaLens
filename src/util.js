'use strict';

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
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
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/?(?:b|i|em|strong|big|small|span|div|p|a|u|h1|h2|h3)[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
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

module.exports = { stripHtml, toSegments, decodeEntities, isHebrew, parseSearchId, clip, normQuery };
