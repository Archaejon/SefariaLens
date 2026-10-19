'use strict';

/**
 * Hebrew -> Latin transliteration with three selectable pronunciation traditions.
 *
 * Design note: this is a *respelling* engine (readable Latin), not an academic
 * phonological transcription. It models the systematic differences between
 * Modern Israeli, Ashkenazi (Lithuanian-American norm), and Mizrahi (Sephardi-
 * aligned) reading traditions:
 *
 *   feature        Modern        Ashkenazi       Mizrahi
 *   qamatz gadol   a             o               a
 *   tzere          e             ey              e
 *   cholam         o             ō               o
 *   tav rafe       t             s               ṯ (t after a break)
 *   vav            v             v               w
 *   qof            k             k               q
 *   chet           ch            ch              ch (ḥ w/ diacritics)
 *   ayin           '             '               ' (ʿ w/ diacritics)
 *   tsadi          tz            tz              ts (ṣ w/ diacritics)
 *   resh           r             r               r
 *
 * Begedkefet follows the Masoretic point: a letter carrying a dagesh is plosive
 * and an unpointed one is fricative, except when it opens a word after a break
 * (תֹהוּ -> tohu, not ṯohu), where the plosive value is kept. Mizrahi writes
 * bet/khaf/pe rafe with the letters' plain sounds (v, kh, f) rather than
 * ḇ ḵ p̱, which read badly at text size; gimel, dalet and tav keep the scholarly
 * mark because those sounds are still distinct in the tradition.
 *
 * Limitations (surfaced in the UI): stress is not marked, qamatz qatan is only
 * detected where the source marks it or a short exception list applies, and
 * shva na/nach follows the standard default-nach rule, so a minority of rare
 * forms will differ from a trained reader's recitation.
 */

const LETTERS = new Set('אבגדהוזחטיכלמנסעפצקרשתךםןףץ');
const FINAL_TO_REGULAR = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const BEGADKEFAT = new Set('בגדכפת');

// Combining marks
const M = {
  SHVA: '\u05B0', HATAF_SEGOL: '\u05B1', HATAF_PATACH: '\u05B2', HATAF_QAMATS: '\u05B3',
  HIRIQ: '\u05B4', TZERE: '\u05B5', SEGOL: '\u05B6', PATAH: '\u05B7', QAMATS: '\u05B8',
  HOLAM: '\u05B9', HOLAM_HASER: '\u05BA', QUBUTS: '\u05BB', DAGESH: '\u05BC',
  METEG: '\u05BD', MAQAF: '\u05BE', RAFE: '\u05BF', PASEQ: '\u05C0',
  SHIN_DOT: '\u05C1', SIN_DOT: '\u05C2', SOF_PASUQ: '\u05C3', QAMATS_QATAN: '\u05C7',
};

const VOWEL_MARKS = new Set([
  M.SHVA, M.HATAF_SEGOL, M.HATAF_PATACH, M.HATAF_QAMATS, M.HIRIQ, M.TZERE,
  M.SEGOL, M.PATAH, M.QAMATS, M.HOLAM, M.HOLAM_HASER, M.QUBUTS,
]);

// Cantillation + meteg are not pronounced here.
const IGNORED = new Set([M.METEG]);
for (let cp = 0x0591; cp <= 0x05af; cp++) IGNORED.add(String.fromCharCode(cp));

const CONSONANTS = {
  modern: {
    'א': '', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z',
    'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ל': 'l', 'מ': 'm', 'נ': 'n',
    'ס': 's', 'ע': '', 'פ': 'p', 'צ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh',
    'ת': 't',
  },
  ashkenazi: {
    'א': '', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z',
    'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ל': 'l', 'מ': 'm', 'נ': 'n',
    'ס': 's', 'ע': '', 'פ': 'p', 'צ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh',
    'ת': 's',
  },
  mizrahi: {
    'א': '', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'w', 'ז': 'z',
    'ח': 'ḥ', 'ט': 'ṭ', 'י': 'y', 'כ': 'k', 'ל': 'l', 'מ': 'm', 'נ': 'n',
    'ס': 's', 'ע': 'ʿ', 'פ': 'p', 'צ': 'ṣ', 'ק': 'q', 'ר': 'r', 'ש': 'sh',
    'ת': 't',
  },
};

// With dagesh qal (hard) vs. without (soft, rafe).
const HARD = { 'ב': 'b', 'ג': 'g', 'ד': 'd', 'כ': 'k', 'פ': 'p', 'ת': 't' };
const SOFT = {
  modern: { 'ב': 'v', 'ג': 'g', 'ד': 'd', 'כ': 'ch', 'פ': 'f', 'ת': 't' },
  ashkenazi: { 'ב': 'v', 'ג': 'g', 'ד': 'd', 'כ': 'ch', 'פ': 'f', 'ת': 's' },
  // Rafe (fricative) begedkefet is marked, not merged with the plosive: the
  // Sephardi/Mizrahi reading preserves the distinction even where modern speech
  // has lost it. Bet, khaf and pe are written with their plain sounds because
  // ḇ ḵ p̱ are hard to read in running text; gimel, dalet and tav keep the mark.
  mizrahi: { 'ב': 'v', 'ג': 'ḡ', 'ד': 'ḏ', 'כ': 'kh', 'פ': 'f', 'ת': 'ṯ' },
};

const STYLE_VOWELS = {
  modern: { qamats: 'a', tzere: 'e', cholam: 'o', shva: 'e' },
  // Holam takes a macron so Ashkenazi distinguishes it from qamatz: toroh vs tōroh.
  ashkenazi: { qamats: 'o', tzere: 'ey', cholam: 'ō', shva: 'e' },
  mizrahi: { qamats: 'a', tzere: 'e', cholam: 'o', shva: 'e' },
};

// Words whose qamatz is qatan even when the source does not mark U+05C7.
// Kept deliberately small: guessing broadly produced more errors than it fixed.
const QAMATS_QATAN_WORDS = new Set([
  'כָּל', 'כָּל־', 'מִכָּל', 'בְּכָל', 'וְכָל', 'כָּלָּם', 'כֻּלָּם',
  'חָכְמָה', 'חָכְמַת', 'קָדְשׁוֹ', 'קָדְשֵׁנוּ', 'אָכְלוּ', 'אָכְלָה',
]);

const PLAIN_DIACRITICS = {
  'ḥ': 'ch', 'ʿ': "'", 'ṣ': 'ts', 'ṭ': 't', 'ʾ': "'", 'ō': 'o',
  'ḇ': 'v', 'ḡ': 'g', 'ḏ': 'd', 'ḵ': 'kh', 'ṯ': 't',
};

function stripDiacritics(s) {
  return s
    .replace(/p\u0331/g, 'f')
    .replace(/[ḥʿṣṭʾōḇḡḏḵṯ]/g, (c) => PLAIN_DIACRITICS[c] || c);
}

/** Parse a Hebrew word into letter clusters: [{letter, marks:Set}] */
function parseClusters(word) {
  const clusters = [];
  for (const ch of word) {
    if (LETTERS.has(ch)) {
      clusters.push({ letter: FINAL_TO_REGULAR[ch] || ch, final: FINAL_TO_REGULAR[ch] !== undefined, marks: new Set() });
    } else if (clusters.length) {
      clusters[clusters.length - 1].marks.add(ch);
    }
  }
  return clusters;
}

function hasVowelMark(c) {
  for (const m of c.marks) if (VOWEL_MARKS.has(m)) return true;
  return false;
}

function vowelOf(c, style) {
  const s = STYLE_VOWELS[style];
  const marks = c.marks;
  if (marks.has(M.QAMATS_QATAN)) return { v: 'o', type: 'short', katan: true };
  if (marks.has(M.HATAF_SEGOL)) return { v: 'e', type: 'reduced' };
  if (marks.has(M.HATAF_PATACH)) return { v: 'a', type: 'reduced' };
  if (marks.has(M.HATAF_QAMATS)) return { v: 'o', type: 'reduced' };
  if (marks.has(M.HIRIQ)) return { v: 'i', type: 'short' };
  if (marks.has(M.TZERE)) return { v: s.tzere, type: 'long' };
  if (marks.has(M.SEGOL)) return { v: 'e', type: 'short' };
  if (marks.has(M.PATAH)) return { v: 'a', type: 'short' };
  if (marks.has(M.QAMATS)) return { v: s.qamats, type: 'long' };
  if (marks.has(M.HOLAM) || marks.has(M.HOLAM_HASER)) return { v: s.cholam, type: 'long' };
  if (marks.has(M.QUBUTS)) return { v: 'u', type: 'short' };
  return null;
}

/**
 * Convert one cluster to {cons, vowel, geminate, silentConsonant}
 * `prev` is the previous *pronounced* cluster, used for matres lectionis.
 */
function phonemeFor(c, style, inWordIndex, word, opts = {}) {
  const marks = c.marks;
  const letter = c.letter;
  let cons = CONSONANTS[style][letter] ?? '';
  let geminate = false;
  let vowel = null;
  let vowelType = null;

  const dagesh = marks.has(M.DAGESH);
  const shuruk = letter === 'ו' && dagesh;
  const hasVowel = hasVowelMark(c);
  const v = hasVowel ? vowelOf(c, style) : null;

  // --- Matres lectionis -------------------------------------------------
  if (letter === 'ו' && (shuruk || (!hasVowel && false))) {
    // vav + dagesh = shuruk (u), no consonantal value
    cons = '';
    vowel = 'u';
    vowelType = 'long';
  } else if (letter === 'ו' && (marks.has(M.HOLAM) || marks.has(M.HOLAM_HASER))) {
    cons = '';
    vowel = STYLE_VOWELS[style].cholam;
    vowelType = 'long';
  } else if (letter === 'י' && marks.has(M.HIRIQ) && !dagesh && inWordIndex > 0 && word[inWordIndex - 1].marks.has(M.HIRIQ)) {
    // yod as mater after chirik (בִּי -> bi)
    cons = '';
    vowel = 'i';
    vowelType = 'long';
  } else if (letter === 'י' && !hasVowel && inWordIndex > 0) {
    const prev = word[inWordIndex - 1];
    const prevVowel = prev && vowelOf(prev, style);
    // yod as mater after chirik (בְּרֵאשִׁית -> bereshit)
    if (prevVowel && prevVowel.v === 'i') cons = '';
  } else if (letter === 'א' && !hasVowel) {
    cons = '';
  }

  if (!vowel && v) {
    vowel = v.v;
    vowelType = v.type;
  }

  // --- Dagesh -----------------------------------------------------------
  if (dagesh && letter !== 'ו') {
    if (BEGADKEFAT.has(letter)) {
      // Dagesh qal at the start of a word or after a silent shva; otherwise forte.
      const prev = inWordIndex > 0 ? word[inWordIndex - 1] : null;
      const prevSilent = !prev || (prev.marks.has(M.SHVA) && !shvaIsNa(word, inWordIndex - 1, null));
      cons = HARD[letter];
      geminate = !prevSilent;
    } else if (letter !== 'ה' && letter !== 'י' && letter !== 'ו') {
      // Glides and mappiq he are not doubled in readable respelling.
      geminate = true;
    }
  } else if (!dagesh && BEGADKEFAT.has(letter)) {
    // An unpointed begedkefet letter is spirantized (rafe) when it follows a
    // vowel — inside the word, or across a maqaf when the word is joined to the
    // one before it. A letter that opens a word after a break keeps its plosive
    // value even though the source writes no dagesh (תֹהוּ -> tohu, not ṯohu).
    cons = (inWordIndex === 0 && !opts.joined) ? HARD[letter] : SOFT[style][letter];
  }

  // Sin dot
  if (letter === 'ש' && marks.has(M.SIN_DOT)) cons = 's';

  return { cons, vowel, vowelType, geminate, letter, marks, hasVowel };
}

/** Furtive patach: the vowel is heard before a final ח/ע (and mappiq he). */
function isFurtive(c, isLast) {
  return isLast && c.marks.has(M.PATAH) &&
    (c.letter === 'ח' || c.letter === 'ע' || (c.letter === 'ה' && c.marks.has(M.DAGESH)));
}

/** Decide shva na (pronounced) vs nach (silent). Default: nach. */
function shvaIsNa(word, i) {
  const c = word[i];
  if (!c.marks.has(M.SHVA)) return false;
  if (i === 0) return word.length > 1;
  if (i === word.length - 1) return false;
  // Two shvas in a row: the second is na.
  if (word[i - 1].marks.has(M.SHVA)) return true;
  // Dagesh forte always takes a na (הַלְּלוּיָה).
  if (c.marks.has(M.DAGESH) && !BEGADKEFAT.has(c.letter)) return true;
  if (c.marks.has(M.METEG)) return true;
  return false;
}

/** Does this word take a qamatz qatan? Marked form first, then a short word list. */
function qamatsIsQatan(clusters, rawWord) {
  const normalized = rawWord.replace(/[\u0591-\u05af\u05bd\u05c1\u05c2]/g, '');
  return QAMATS_QATAN_WORDS.has(normalized);
}

function transliterateWord(word, style, opts) {
  const clusters = parseClusters(word);
  if (!clusters.length) return '';

  // Without niqqud there is no defensible vocalisation; leave the word as written
  // rather than emitting a misleading consonant skeleton.
  // A lone shva does not tell us the vowels, so it does not count as pointed.
  const pointed = clusters.some((c) => {
    for (const m of c.marks) if (VOWEL_MARKS.has(m) && m !== M.SHVA) return true;
    return false;
  });
  if (!pointed) return word;

  // qamatz qatan for listed words: treat the first qamatz as short o
  if (qamatsIsQatan(clusters, word)) {
    const first = clusters.find((c) => c.marks.has(M.QAMATS));
    if (first) first.marks.add(M.QAMATS_QATAN);
  }

  const phonemes = clusters.map((c, i) => phonemeFor(c, style, i, clusters, opts));
  const parts = [];
  const shvaChar = STYLE_VOWELS[style].shva;
  const last = clusters.length - 1;

  // Resolve shva up front so neighbouring clusters can see it.
  for (let i = 0; i < phonemes.length; i++) {
    if (clusters[i].marks.has(M.SHVA) && !phonemes[i].vowel && shvaIsNa(clusters, i)) {
      phonemes[i].vowel = shvaChar;
      phonemes[i].vowelType = 'reduced';
    }
  }

  for (let i = 0; i < phonemes.length; i++) {
    const p = phonemes[i];
    const c = clusters[i];
    let cons = p.cons;
    let vowel = p.vowel;

    // Doubling only reads well for single-letter consonants (sh/ch/tz stay single).
    if (p.geminate && cons && cons.length === 1) cons = cons + cons;

    // A silent aleph (or ayin) carrying its own vowel between consonants acts as
    // a syllable break: ve'et, ha'aretz, yisra'el.
    if (!cons && vowel && i > 0 && i < last && (c.letter === 'א' || c.letter === 'ע')) {
      cons = "'";
    }

    if (isFurtive(c, i === last)) {
      // vowel precedes the guttural: ruach, gavoah
      parts.push(vowel || '');
      parts.push(p.geminate && cons.length <= 1 ? cons[0] : cons);
      continue;
    }

    parts.push(cons || '');
    if (vowel) parts.push(vowel);
  }

  let out = parts.join('');
  // Ashkenazi tzere (ey) before a consonantal yod: beyt, not beyyt.
  out = out.replace(/eyy/g, 'ey');
  if (opts && opts.diacritics === false) out = stripDiacritics(out);
  return out;
}

const WORD_BOUNDARY = /([\s\u05BE.,:;!?()\[\]{}"'\u05C3\u2013\u2014\u2018\u2019\u201C\u201D\/]+)/;

/** Transliterate a plain (HTML-stripped) Hebrew string. */
function transliterate(text, opts = {}) {
  const style = STYLE_VOWELS[opts.style] ? opts.style : 'modern';
  const diacritics = opts.diacritics !== false;
  if (!text) return '';
  let joinedToPrev = false;
  return text
    .split(WORD_BOUNDARY)
    .map((chunk) => {
      if (!chunk) return '';
      const joined = joinedToPrev;
      joinedToPrev = chunk === '\u05BE';
      if (!/[\u05D0-\u05EA]/.test(chunk)) {
        // Hebrew punctuation reads better as its Latin counterpart.
        return chunk.replace(/\u05BE/g, '-').replace(/\u05C3/g, '.').replace(/\u05C0/g, '|');
      }
      return transliterateWord(chunk, style, { diacritics, joined });
    })
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Per-word breakdown used by the word panel. */
function wordInfo(rawWord, opts = {}) {
  const style = STYLE_VOWELS[opts.style] ? opts.style : 'modern';
  const diacritics = opts.diacritics !== false;
  return {
    he: rawWord,
    modern: transliterateWord(rawWord, 'modern', { diacritics }),
    ashkenazi: transliterateWord(rawWord, 'ashkenazi', { diacritics }),
    mizrahi: transliterateWord(rawWord, 'mizrahi', { diacritics }),
    style,
  };
}

const STYLE_INFO = {
  modern: {
    label: 'Modern Israeli',
    blurb: 'Israeli Hebrew: qamatz = a, tzere = e, tav = t, ayin mostly silent.',
  },
  ashkenazi: {
    label: 'Ashkenazi',
    blurb: 'Lithuanian-American norm: qamatz = o, holam = ō (toroh, tōroh), tzere = ey, tav rafe = s (Shabbos, emes).',
  },
  mizrahi: {
    label: 'Mizrahi',
    blurb: 'Sephardi-aligned: qamatz = a, vav = w, bet/khaf/pe rafe = v/kh/f, qof = q, and emphatics marked (ṭ ṣ ḥ ʿ).',
  },
};

module.exports = { transliterate, transliterateWord, wordInfo, STYLE_INFO, STYLE_VOWELS };
