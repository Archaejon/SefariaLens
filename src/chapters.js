'use strict';

/**
 * Turn Sefaria's shape for a work into the sections and chapters the library
 * and the reader use to jump around.
 *
 * `/api/shape/<title>` answers with a tree: a plain book is one node whose
 * `chapters` are segment counts per chapter; a complex work (Zohar, a siddur)
 * is a node whose `chapters` are themselves nodes, each addressed by its own
 * title ("Zohar, Bereshit"). Both shapes collapse to: sections, each with an
 * ordered list of chapter refs.
 */

/** "Zohar, Bereshit" -> "Bereshit"; a plain work keeps its own name. */
function shortLabel(nodeTitle, workTitle) {
  const prefix = `${workTitle}, `;
  return nodeTitle.startsWith(prefix) ? nodeTitle.slice(prefix.length) : nodeTitle;
}

/**
 * Talmud refs address a folio ("Berakhot 2"), so one unit per daf rather than
 * one per amud. Sefaria's shape counts amudim; the leading placeholders it
 * carries for the opening folio would otherwise produce a daf that has no text.
 */
function talmudUnits(prefix, count) {
  const full = Math.ceil(count / 2);
  return Array.from({ length: full }, (_, i) => {
    const daf = i + 2;
    return { n: daf, label: String(daf), ref: `${prefix} ${daf}` };
  });
}

function chapterUnits(prefix, count) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { n, label: String(n), ref: `${prefix} ${n}` };
  });
}

function buildChapters({
  title,
  heTitle = '',
  categories = [],
  addressTypes = [],
  sectionNames = [],
  depth = 0,
  shape = [],
} = {}) {
  const work = String(title || '').trim();
  const talmud = addressTypes[0] === 'Talmud';
  const sections = [];

  const pushSection = (nodeTitle, nodeHe, count) => {
    const refPrefix = nodeTitle || work;
    const units = talmud ? talmudUnits(refPrefix, count) : chapterUnits(refPrefix, count);
    if (!units.length) return;
    sections.push({
      title: refPrefix,
      label: shortLabel(refPrefix, work),
      // The node's Hebrew title carries the whole work's name too ("ספר הזהר,
      // בראשית"); the section picker only needs the section part.
      heTitle: nodeHe ? shortLabel(nodeHe, heTitle) : '',
      length: units.length,
      units,
    });
  };

  // A one-level schema (a work with no internal address) reads as a single
  // passage: "Open" rather than a chapter grid of one. Complex works report no
  // depth at all, so an unknown depth must fall through to the shape itself.
  const flat = depth === 1;

  const walk = (node, inherited) => {
    if (!node) return;
    const own = node.title || inherited || work;
    const children = Array.isArray(node.chapters) ? node.chapters : null;
    // Child nodes are objects; a commentary's per-chapter counts are arrays of
    // arrays, which make the work itself a leaf rather than fifty sections.
    const container = children && children.length
      && typeof children[0] === 'object' && !Array.isArray(children[0]);
    if (container) {
      for (const child of children) walk(child, own);
      return;
    }
    const count = children
      ? (talmud ? children.filter((n) => Number(n) > 0).length : children.length)
      : Number(node.length) || 0;
    pushSection(own, node.heTitle, count);
  };

  if (flat) {
    sections.push({
      title: work,
      label: work,
      heTitle,
      length: 1,
      units: [{ n: 1, label: 'Read', ref: work }],
    });
    return finish(sections);
  }

  if (Array.isArray(shape) && shape.length) for (const node of shape) walk(node, work);
  if (!sections.length && work) {
    sections.push({
      title: work,
      label: work,
      heTitle,
      length: 1,
      units: [{ n: 1, label: 'Read', ref: work }],
    });
  }

  return finish(sections);

  function finish(list) {
    return {
      title: work,
      heTitle,
      categories,
      addressTypes,
      sectionNames,
      unitLabel: talmud ? 'daf' : 'chapter',
      complex: list.length > 1,
      sections: list,
      total: list.reduce((sum, s) => sum + s.units.length, 0),
    };
  }
}

/**
 * Which chapter unit a loaded ref belongs to — the longest unit ref the passage
 * starts with, so "Genesis 1:1" is chapter 1 and not chapter 10.
 */
function unitForRef(book, ref) {
  const clean = String(ref || '').trim();
  if (!book || !clean) return null;
  let best = null;
  for (const section of book.sections || []) {
    for (const unit of section.units || []) {
      if (clean !== unit.ref && !clean.startsWith(`${unit.ref} `) && !clean.startsWith(`${unit.ref}:`)) continue;
      if (!best || unit.ref.length > best.unit.ref.length) best = { section, unit };
    }
  }
  return best;
}

module.exports = { buildChapters, unitForRef };
