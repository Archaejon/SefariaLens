'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * The reader's own notebook: bookmarked passages, notes on them, and answers
 * kept from Ask. One JSON file in the app's data folder — it is the only thing
 * in that folder a person wrote themselves, so it is never treated as a cache:
 * nothing here expires, and a file that cannot be read is set aside rather
 * than overwritten.
 */

const FILE_VERSION = 1;
// Generous for a notebook, small enough that one file read at startup and
// rewritten on each change stays instant.
const MAX_ITEMS = 5000;
const MAX_NOTE = 10000;
const MAX_TEXT = 2000;
const MAX_ANSWER = 8000;
const MAX_SOURCES = 12;

const text = (value, max) => {
  const s = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};
const line = (value, max) => text(value, max).replace(/\s+/g, ' ');

function studyError(message, code) {
  return Object.assign(new Error(message), { code });
}

class Study {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.items = [];
    // Set while the file exists but could not be read. Nothing is written in
    // that state: a save would replace a notebook we never saw.
    this.unreadable = null;
    this.load();
  }

  load() {
    this.unreadable = null;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      // Only a missing file is a first run. A locked or forbidden one (a sync
      // client, antivirus) still holds someone's notes.
      if (!err || err.code !== 'ENOENT') this.unreadable = err;
      return;
    }
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) throw new Error('not a notebook');
      this.items = data.items.filter((item) => item && typeof item.id === 'string'
        && (item.kind === 'passage' || item.kind === 'answer'));
    } catch {
      // Notes are irreplaceable. Keep the unreadable file beside the new one
      // instead of letting the next save write an empty notebook over it.
      const aside = this.file.replace(/\.json$/, '') + `.unreadable-${this.now()}.json`;
      this.items = [];
      try {
        fs.renameSync(this.file, aside);
      } catch (err) {
        // Could not move it out of the way, so it must not be written over.
        this.unreadable = err;
      }
    }
  }

  save() {
    const body = JSON.stringify({ version: FILE_VERSION, items: this.items }, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Written beside the file and renamed over it, so a crash mid-write leaves
    // the previous notebook intact rather than half of the new one.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** A file that was locked a moment ago may be readable now; try once more. */
  ready() {
    if (this.unreadable) this.load();
    if (this.unreadable) {
      throw studyError(
        `The notebook file could not be read (${this.unreadable.code || this.unreadable.message}), so nothing was changed. Close anything that may be holding ${path.basename(this.file)} and try again.`,
        'UNREADABLE',
      );
    }
  }

  /**
   * Apply a change and write it. If the write fails the change is undone, so
   * what the app shows never runs ahead of what is on disk.
   */
  change(fn) {
    this.ready();
    const before = this.items.map((item) => ({ ...item }));
    try {
      return fn();
    } catch (err) {
      this.items = before;
      throw err;
    }
  }

  /** Everything, most recently touched first. */
  list() {
    if (this.unreadable) this.load();
    return [...this.items].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  room() {
    if (this.items.length >= MAX_ITEMS) {
      throw studyError(`The notebook is full (${MAX_ITEMS} entries). Remove some to add more.`, 'FULL');
    }
  }

  /**
   * Bookmark a passage, annotate it, or both. One entry per ref: `bookmarked`
   * and `note` are set only when given, and an entry with neither is removed.
   * Returns the entry, or null when it no longer exists.
   */
  savePassage(params = {}) {
    return this.change(() => this.applyPassage(params));
  }

  applyPassage({ ref, open, he, en, bookmarked, note } = {}) {
    const key = line(ref, 300);
    if (!key) throw studyError('A passage needs a reference.', 'BAD_REQUEST');
    const at = this.now();
    let item = this.items.find((i) => i.kind === 'passage' && i.ref === key);
    const isNew = !item;
    if (isNew) {
      item = {
        id: crypto.randomUUID(), kind: 'passage', ref: key,
        bookmarked: false, note: '', createdAt: at,
      };
    }
    if (bookmarked !== undefined) item.bookmarked = Boolean(bookmarked);
    if (note !== undefined) item.note = text(note, MAX_NOTE);
    if (!item.bookmarked && !item.note) {
      if (!isNew) {
        this.items = this.items.filter((i) => i !== item);
        this.save();
      }
      return null;
    }
    // The passage it was read in, so opening the entry shows the verse in its
    // chapter; and enough of the text to recognise it in the notebook.
    if (open !== undefined || isNew) item.open = line(open, 300) || key;
    if (he !== undefined) item.he = text(he, MAX_TEXT);
    if (en !== undefined) item.en = text(en, MAX_TEXT);
    item.updatedAt = at;
    if (isNew) {
      this.room();
      this.items.push(item);
    }
    this.save();
    return { ...item };
  }

  /** Keep an answer from Ask. Saving the same answer twice returns the first. */
  saveAnswer(params = {}) {
    return this.change(() => this.applyAnswer(params));
  }

  applyAnswer({ question, answer, caveats, confidence, sources, model } = {}) {
    const q = line(question, 600);
    const a = text(answer, MAX_ANSWER);
    if (!q || !a) throw studyError('An answer needs its question and its text.', 'BAD_REQUEST');
    const existing = this.items.find((i) => i.kind === 'answer' && i.question === q && i.answer === a);
    if (existing) return { ...existing };
    this.room();
    const at = this.now();
    const item = {
      id: crypto.randomUUID(),
      kind: 'answer',
      question: q,
      answer: a,
      caveats: text(caveats, 1000),
      confidence: line(confidence, 20),
      model: line(model, 120),
      sources: (Array.isArray(sources) ? sources : []).slice(0, MAX_SOURCES)
        .map((s) => ({
          ref: line(s && s.ref, 300),
          tierLabel: line(s && s.tierLabel, 60),
          justification: text(s && s.justification, 1000),
        }))
        .filter((s) => s.ref),
      note: '',
      createdAt: at,
      updatedAt: at,
    };
    this.items.push(item);
    this.save();
    return { ...item };
  }

  /** Set the note on any entry. A passage left with no note and no bookmark goes. */
  setNote({ id, note } = {}) {
    return this.change(() => {
      const item = this.items.find((i) => i.id === id);
      if (!item) throw studyError('That notebook entry no longer exists.', 'NOT_FOUND');
      if (item.kind === 'passage') return this.applyPassage({ ref: item.ref, note });
      item.note = text(note, MAX_NOTE);
      item.updatedAt = this.now();
      this.save();
      return { ...item };
    });
  }

  remove({ id } = {}) {
    return this.change(() => {
      const before = this.items.length;
      this.items = this.items.filter((i) => i.id !== id);
      const removed = this.items.length < before;
      if (removed) this.save();
      return { removed };
    });
  }

  /** The whole notebook as Markdown, for pasting into anything else. */
  exportMarkdown() {
    this.ready();
    const items = this.list();
    const passages = items.filter((i) => i.kind === 'passage');
    const answers = items.filter((i) => i.kind === 'answer');
    const quote = (s) => String(s).split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
    const out = ['# Sefaria Lens notebook', ''];
    if (passages.length) {
      out.push('## Passages', '');
      for (const p of passages) {
        out.push(`### ${p.ref}`, '');
        if (p.he) out.push(quote(p.he), '');
        if (p.en) out.push(quote(p.en), '');
        if (p.note) out.push(p.note, '');
      }
    }
    if (answers.length) {
      out.push('## Saved answers', '');
      for (const a of answers) {
        out.push(`### ${a.question}`, '', a.answer, '');
        if (a.caveats) out.push(`*${a.caveats}*`, '');
        if (a.sources && a.sources.length) {
          out.push('Sources:', '');
          for (const s of a.sources) {
            out.push(`- **${s.ref}**${s.justification ? ` — ${s.justification.replace(/\s+/g, ' ')}` : ''}`);
          }
          out.push('');
        }
        if (a.note) out.push(a.note, '');
        // A hand-edited entry may have no usable date; that must not sink the export.
        const saved = new Date(a.createdAt);
        const facts = Number.isNaN(saved.getTime()) ? [] : [saved.toISOString().slice(0, 10)];
        if (a.model) facts.push(a.model);
        out.push(`_${facts.length ? `Saved ${facts.join(' · ')}; ` : ''}AI-written, check it against the sources._`, '');
      }
    }
    if (!items.length) out.push('Nothing saved yet.', '');
    return { markdown: out.join('\n'), passages: passages.length, answers: answers.length };
  }
}

module.exports = { Study, MAX_ITEMS, MAX_NOTE };
