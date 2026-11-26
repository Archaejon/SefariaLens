'use strict';

/**
 * The notebook: bookmarks and notes on passages, and answers kept from Ask.
 *
 * Loaded before app.js and sharing its globals (S, $, esc, api, toast, openRef,
 * renderReaderBody, renderAnswer), which are only touched when a function here
 * runs, never while this file loads. The entries live in the service layer
 * (study.* RPC methods); S.study is a copy kept in step with every change so
 * the reader can mark a verse without asking again.
 */

/* ------------------------------------------------------------------ state */

function indexStudy() {
  S.studyByRef = new Map(S.study.filter((i) => i.kind === 'passage').map((i) => [i.ref, i]));
}

async function loadStudy() {
  try {
    const { items } = await api.rpc('study.list');
    S.study = Array.isArray(items) ? items : [];
  } catch {
    S.study = [];
  }
  indexStudy();
}

/** Fold one saved, changed or removed entry into the local copy. */
function applyStudyChange({ item = null, removedId = '', removedRef = '' } = {}) {
  let list = S.study;
  if (removedId) list = list.filter((i) => i.id !== removedId);
  if (removedRef) list = list.filter((i) => !(i.kind === 'passage' && i.ref === removedRef));
  if (item) list = [item, ...list.filter((i) => i.id !== item.id)];
  S.study = list;
  indexStudy();
}

/**
 * The ref a segment is saved under. A verse has a ref of its own; a line of a
 * daf does not, so it is addressed as a segment of the passage on screen.
 */
function segStudyRef(data, index) {
  if (!data) return '';
  if (data.segRefs && data.segRefs[index]) return data.segRefs[index];
  return (data.rows || []).length === 1 ? data.ref : `${data.ref}:${index + 1}`;
}

/* ------------------------------------------------------------------ reader */

function studyToolsHtml(index) {
  const ref = segStudyRef(S.reader, index);
  const item = S.studyByRef.get(ref);
  const marked = Boolean(item && item.bookmarked);
  const noted = Boolean(item && item.note);
  return `
    <button class="seg-tool${marked ? ' is-on' : ''}" data-bm="${index}" aria-pressed="${marked}"
      title="${marked ? 'Remove bookmark from' : 'Bookmark'} ${esc(ref)}"
      aria-label="${marked ? 'Remove bookmark from' : 'Bookmark'} ${esc(ref)}">${marked ? '★' : '☆'}</button>
    <button class="seg-tool${noted ? ' is-on' : ''}" data-note="${index}"
      title="${noted ? 'Edit your note on' : 'Write a note on'} ${esc(ref)}"
      aria-label="${noted ? 'Edit your note on' : 'Write a note on'} ${esc(ref)}">✎</button>`;
}

function noteEditorHtml(saveAttr, value, hasNote) {
  return `<div class="note-editor">
      <textarea data-note-input rows="3" maxlength="10000" aria-label="Your note"
        placeholder="Your note. Ctrl+Enter saves, Esc cancels.">${esc(value)}</textarea>
      <div class="note-actions">
        <button class="primary small" ${saveAttr}>Save note</button>
        <button class="ghost small" data-note-cancel>Cancel</button>
        ${hasNote ? `<button class="ghost small" ${saveAttr} data-note-clear>Delete note</button>` : ''}
      </div>
    </div>`;
}

function segNoteHtml(index) {
  const ref = segStudyRef(S.reader, index);
  const item = S.studyByRef.get(ref);
  const note = item ? item.note : '';
  if (S.noteOpen === ref) return noteEditorHtml(`data-note-save="${index}"`, S.noteDraft, Boolean(note));
  return note
    ? `<button class="seg-note" data-note="${index}" title="Edit this note">${esc(note)}</button>`
    : '';
}

/** Keep what is being typed when the body is redrawn for another reason. */
function keepNoteDraft() {
  const input = document.querySelector('#reader-text [data-note-input]');
  if (input) S.noteDraft = input.value;
}

function focusNoteInput(root) {
  const input = root && root.querySelector('[data-note-input]');
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function passagePayload(index) {
  const data = S.reader;
  const row = (data.rows || [])[index] || {};
  return { ref: segStudyRef(data, index), open: data.ref, he: row.he || '', en: row.en || '' };
}

async function savePassage(payload) {
  const { item } = await api.rpc('study.savePassage', payload);
  applyStudyChange(item ? { item } : { removedRef: payload.ref });
  return item;
}

async function toggleBookmark(index) {
  if (!S.reader) return;
  const payload = passagePayload(index);
  const current = S.studyByRef.get(payload.ref);
  const next = !(current && current.bookmarked);
  try {
    await savePassage({ ...payload, bookmarked: next });
    toast(next ? `Bookmarked ${payload.ref}` : `Bookmark removed from ${payload.ref}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  renderReaderBody();
}

function openNote(index) {
  if (!S.reader) return;
  const ref = segStudyRef(S.reader, index);
  const item = S.studyByRef.get(ref);
  S.noteOpen = ref;
  S.noteDraft = item ? item.note : '';
  renderReaderBody();
  focusNoteInput($('#reader-text'));
}

async function saveNote(index, { clear = false } = {}) {
  if (!S.reader) return;
  keepNoteDraft();
  const payload = passagePayload(index);
  const note = clear ? '' : S.noteDraft;
  try {
    await savePassage({ ...payload, note });
    S.noteOpen = '';
    S.noteDraft = '';
    toast(note.trim() ? 'Note saved' : 'Note deleted');
  } catch (err) {
    toast(err.message, 'err');
  }
  renderReaderBody();
}

/** After opening a passage from the notebook, bring its verse into view. */
function focusSegment(ref) {
  const data = S.reader;
  if (!data || !ref) return;
  const index = (data.rows || []).findIndex((_, i) => segStudyRef(data, i) === ref);
  if (index < 0) return;
  if (S.pageSize > 0 && index >= (S.readerShown || S.pageSize)) {
    S.readerShown = Math.ceil((index + 1) / S.pageSize) * S.pageSize;
    renderReaderBody();
  }
  const el = document.querySelector(`#reader-text .segment[data-seg="${index}"]`);
  if (!el) return;
  el.classList.add('is-focus');
  el.scrollIntoView({ block: 'center' });
}

/* ------------------------------------------------------------------ ask */

function savedAnswerFor(result) {
  return result && result.savedId ? S.study.find((i) => i.id === result.savedId) : null;
}

function saveAnswerButtonHtml(result) {
  if (!result || !String(result.answer || '').trim()) return '';
  // Without a model there is no answer to keep, only a notice above a list of
  // search hits; those can be bookmarked one by one.
  if (result.meta && result.meta.ai === false) return '';
  return savedAnswerFor(result)
    ? '<button class="ghost small" data-view-notebook>Saved to notebook ✓</button>'
    : '<button class="ghost small" data-save-answer>Save to notebook</button>';
}

function sourceBookmarkHtml(src, index) {
  const item = S.studyByRef.get(src.ref);
  const marked = Boolean(item && item.bookmarked);
  return `<button class="ghost small" data-bm-src="${index}" aria-pressed="${marked}">${marked ? '★ Bookmarked' : '☆ Bookmark'}</button>`;
}

async function saveAnswer() {
  const result = S.askResult;
  if (!result) return;
  try {
    const { item } = await api.rpc('study.saveAnswer', {
      question: result.question,
      answer: result.answer,
      caveats: result.caveats || '',
      confidence: result.confidence || '',
      model: (result.meta && result.meta.model) || '',
      sources: (result.sources || []).map((s) => ({
        ref: s.ref, tierLabel: s.tierLabel || '', justification: s.justification || '',
      })),
    });
    result.savedId = item.id;
    applyStudyChange({ item });
    toast('Answer saved to the notebook');
  } catch (err) {
    toast(err.message, 'err');
  }
  renderAnswer(result);
}

async function toggleSourceBookmark(index) {
  const result = S.askResult;
  const src = result && result.sources && result.sources[index];
  if (!src) return;
  const current = S.studyByRef.get(src.ref);
  const next = !(current && current.bookmarked);
  try {
    await savePassage({ ref: src.ref, open: src.ref, he: src.he || '', en: src.en || '', bookmarked: next });
    toast(next ? `Bookmarked ${src.ref}` : `Bookmark removed from ${src.ref}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  renderAnswer(result);
}

/* ------------------------------------------------------------------ view */

const NB_FILTERS = [
  ['all', 'All'],
  ['bookmarks', 'Bookmarks'],
  ['notes', 'Notes'],
  ['answers', 'Answers'],
];

function notebookMatches(item) {
  if (S.nbFilter === 'bookmarks' && !(item.kind === 'passage' && item.bookmarked)) return false;
  if (S.nbFilter === 'notes' && !item.note) return false;
  if (S.nbFilter === 'answers' && item.kind !== 'answer') return false;
  const q = S.nbQuery.trim().toLowerCase();
  if (!q) return true;
  const hay = item.kind === 'passage'
    ? [item.ref, item.he, item.en, item.note]
    : [item.question, item.answer, item.note, ...(item.sources || []).map((s) => s.ref)];
  return hay.some((part) => String(part || '').toLowerCase().includes(q));
}

function nbDate(at) {
  if (!at) return '';
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function nbNoteHtml(item) {
  if (S.nbEdit === item.id) return noteEditorHtml(`data-nb-save="${esc(item.id)}"`, S.noteDraft, Boolean(item.note));
  return item.note ? `<p class="nb-note">${esc(item.note)}</p>` : '';
}

function nbFootHtml(item, extra = '') {
  if (S.nbConfirm === item.id) {
    return `<footer class="nb-foot">
        <span class="muted small">Remove this entry${item.note ? ' and its note' : ''}?</span>
        <button class="ghost small nb-danger" data-nb-remove-yes="${esc(item.id)}">Remove</button>
        <button class="ghost small" data-nb-remove-no>Keep</button>
      </footer>`;
  }
  return `<footer class="nb-foot">
      ${extra}
      ${S.nbEdit === item.id ? '' : `<button class="ghost small" data-nb-edit="${esc(item.id)}">${item.note ? 'Edit note' : 'Add note'}</button>`}
      <button class="ghost small" data-nb-remove="${esc(item.id)}">Remove</button>
      <span class="nb-date">${esc(nbDate(item.updatedAt))}</span>
    </footer>`;
}

function nbPassageHtml(item) {
  return `<article class="search-hit nb-item">
      <div class="nb-head">
        <button class="search-hit-ref" data-nb-open="${esc(item.id)}">${esc(item.ref)}</button>
        ${item.bookmarked ? '<span class="pill nb-star">★ Bookmark</span>' : ''}
        ${item.note ? '<span class="pill">Note</span>' : ''}
      </div>
      ${S.showHebrew && item.he ? `<p class="nb-he" dir="rtl">${esc(item.he)}</p>` : ''}
      ${S.showEnglish && item.en ? `<p class="search-snippet" dir="auto">${esc(item.en)}</p>` : ''}
      ${nbNoteHtml(item)}
      ${nbFootHtml(item)}
    </article>`;
}

function nbAnswerHtml(item) {
  const sources = (item.sources || []).map((s) =>
    `<button class="lex-ref" data-open-ref="${esc(s.ref)}" title="${esc(s.justification || '')}">${esc(s.ref)}</button>`).join('');
  return `<article class="search-hit nb-item">
      <div class="nb-head">
        <span class="pill">Answer</span>
        ${item.model ? `<span class="muted small">${esc(item.model)}</span>` : ''}
      </div>
      <h3 class="nb-question">${esc(item.question)}</h3>
      <p class="nb-answer">${esc(item.answer)}</p>
      ${item.caveats ? `<p class="caveat">${esc(item.caveats)}</p>` : ''}
      ${sources ? `<div class="nb-sources">${sources}</div>` : ''}
      ${nbNoteHtml(item)}
      ${nbFootHtml(item, `<button class="ghost small" data-nb-ask="${esc(item.id)}">Ask again</button>`)}
    </article>`;
}

function renderNotebook() {
  const host = $('#nb-list');
  const meta = $('#nb-meta');
  if (!host || !meta) return;
  const tabs = $('#nb-filter');
  if (tabs) {
    tabs.innerHTML = NB_FILTERS.map(([id, label]) =>
      `<button data-nb-filter="${id}" class="${S.nbFilter === id ? 'is-active' : ''}">${label}</button>`).join('');
  }
  const exportBtn = $('#nb-export');
  if (exportBtn) exportBtn.disabled = !S.study.length;

  if (!S.study.length) {
    meta.textContent = '';
    host.innerHTML = `
      <div class="empty-state">
        <h3>Nothing saved yet</h3>
        <p class="muted small" style="margin:0">In the reader, ☆ beside a verse bookmarks it and ✎ writes a note on it. An answer in Ask has <b>Save to notebook</b>. Everything you keep is listed here and stays on this computer.</p>
      </div>`;
    return;
  }

  const shown = S.study.filter(notebookMatches);
  const passages = S.study.filter((i) => i.kind === 'passage').length;
  const answers = S.study.length - passages;
  meta.textContent = `${passages} passage${passages === 1 ? '' : 's'} · ${answers} answer${answers === 1 ? '' : 's'}`
    + (shown.length !== S.study.length ? ` · showing ${shown.length}` : '');

  host.innerHTML = shown.length
    ? shown.map((item) => (item.kind === 'answer' ? nbAnswerHtml(item) : nbPassageHtml(item))).join('')
    : `<div class="empty-state"><h3>Nothing matches</h3>
        <p class="muted small" style="margin:0">Try another filter, or clear the search box.</p></div>`;
}

async function saveNotebookNote(id, { clear = false } = {}) {
  const input = document.querySelector('#nb-list [data-note-input]');
  const note = clear ? '' : (input ? input.value : S.noteDraft);
  try {
    const { item } = await api.rpc('study.setNote', { id, note });
    applyStudyChange(item ? { item } : { removedId: id });
    toast(note.trim() ? 'Note saved' : (item ? 'Note deleted' : 'Note deleted; the entry had nothing else to keep'));
  } catch (err) {
    toast(err.message, 'err');
  }
  S.nbEdit = '';
  S.noteDraft = '';
  renderNotebook();
}

async function removeNotebookItem(id) {
  try {
    await api.rpc('study.remove', { id });
    applyStudyChange({ removedId: id });
    toast('Removed from the notebook');
  } catch (err) {
    toast(err.message, 'err');
  }
  S.nbConfirm = '';
  renderNotebook();
}

async function exportNotebook() {
  try {
    const out = await api.rpc('study.export');
    await navigator.clipboard.writeText(out.markdown);
    toast(`Notebook copied as Markdown: ${out.passages} passage${out.passages === 1 ? '' : 's'}, ${out.answers} answer${out.answers === 1 ? '' : 's'}`);
  } catch (err) {
    toast(`Could not copy the notebook: ${err.message}`, 'err');
  }
}

/* ------------------------------------------------------------------ events */

// Delegated from the document: the reader body, the answer and the notebook
// list are all redrawn wholesale, so handlers must outlive every render.
document.addEventListener('click', (e) => {
  const hit = (selector) => (e.target.closest ? e.target.closest(selector) : null);
  let el;

  // reader
  if ((el = hit('[data-bm]'))) { toggleBookmark(Number(el.dataset.bm)); return; }
  if ((el = hit('[data-note-save]'))) {
    saveNote(Number(el.dataset.noteSave), { clear: el.hasAttribute('data-note-clear') });
    return;
  }
  if ((el = hit('[data-nb-save]'))) {
    saveNotebookNote(el.dataset.nbSave, { clear: el.hasAttribute('data-note-clear') });
    return;
  }
  if (hit('[data-note-cancel]')) {
    S.noteOpen = '';
    S.nbEdit = '';
    S.noteDraft = '';
    if (S.view === 'notebook') renderNotebook(); else renderReaderBody();
    return;
  }
  if ((el = hit('[data-note]'))) { openNote(Number(el.dataset.note)); return; }

  // ask
  if (hit('[data-save-answer]')) { saveAnswer(); return; }
  if (hit('[data-view-notebook]')) { setView('notebook'); return; }
  if ((el = hit('[data-bm-src]'))) { toggleSourceBookmark(Number(el.dataset.bmSrc)); return; }

  // notebook
  if ((el = hit('[data-nb-filter]'))) { S.nbFilter = el.dataset.nbFilter; renderNotebook(); return; }
  if ((el = hit('[data-nb-open]'))) {
    const item = S.study.find((i) => i.id === el.dataset.nbOpen);
    if (item) openRef(item.open || item.ref, { focus: item.ref });
    return;
  }
  if ((el = hit('[data-nb-edit]'))) {
    const item = S.study.find((i) => i.id === el.dataset.nbEdit);
    S.nbEdit = el.dataset.nbEdit;
    S.nbConfirm = '';
    S.noteDraft = item ? item.note || '' : '';
    renderNotebook();
    focusNoteInput($('#nb-list'));
    return;
  }
  if ((el = hit('[data-nb-remove]'))) { S.nbConfirm = el.dataset.nbRemove; S.nbEdit = ''; renderNotebook(); return; }
  if (hit('[data-nb-remove-no]')) { S.nbConfirm = ''; renderNotebook(); return; }
  if ((el = hit('[data-nb-remove-yes]'))) { removeNotebookItem(el.dataset.nbRemoveYes); return; }
  if ((el = hit('[data-nb-ask]'))) {
    const item = S.study.find((i) => i.id === el.dataset.nbAsk);
    if (item) { setView('ask'); runAsk(item.question); }
    return;
  }
  if (hit('#nb-export')) exportNotebook();
});

document.addEventListener('keydown', (e) => {
  const input = e.target && e.target.matches && e.target.matches('[data-note-input]') ? e.target : null;
  if (!input) return;
  const editor = input.closest('.note-editor');
  if (e.key === 'Escape') {
    e.preventDefault();
    editor.querySelector('[data-note-cancel]').click();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    editor.querySelector('.primary').click();
  }
});

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'nb-search') {
    S.nbQuery = e.target.value;
    renderNotebook();
  }
});
