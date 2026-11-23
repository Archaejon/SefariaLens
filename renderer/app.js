'use strict';

/* global api */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  view: 'ask',
  settings: null,
  info: null,
  style: 'modern',
  diacritics: true,
  showTranslit: true,
  showEnglish: true,
  showHebrew: true,
  showCommentaries: true,
  fontSize: 20,
  pageSize: 0,
  readerShown: 0,
  category: '',
  askResult: null,
  askContext: null,
  reader: null,
  busy: false,
  library: null,
  libFilter: '',
  libMatches: [],
  libPath: [],
  libScroll: 0,
  libReturnPath: null,
  // Chapters of the work selected on the Library shelf, and of the passage
  // open in the reader (keyed by title, so switching back is instant).
  libChapters: null,
  libChaptersFor: '',
  libChapterError: '',
  libSection: 0,
  // Library search: the query, its hits, and how far into Sefaria's result set
  // they reach. Kept while the view is left and returned to.
  searchQuery: '',
  searchHits: [],
  searchTotal: 0,
  searchStart: 0,
  searchTook: 0,
  searchMore: false,
  searchBusy: false,
  searchError: '',
  searchSeq: 0,
  searchScope: '',
  searchWork: '',
  workListReady: false,
  workListLoading: false,
  chaptersCache: new Map(),
  shapeSeq: 0,
  readerChapterRef: '',
  // Per-verse commentary state: fetched choosers, the open one, and picks.
  verseComm: {},
  verseSel: {},
  verseOpen: null,
  vcLoading: '',
  vcError: '',
  vcMore: new Set(),
  // The request whose progress events the interface should honour, and the
  // draft answer as it streams in. Any other request id is stale and ignored.
  askRequestId: '',
  askDraft: '',
  translateBusy: false,
  translateReq: '',
  autoTranslate: false,
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const enc = encodeURIComponent;

// The four letters with their pointing stripped, so a pointed or unpointed form
// both count when the reader is told which reading the transliteration used.
const hasDivineName = (he) => Boolean(he)
  && String(he).replace(/[\u0591-\u05C7]/g, '').includes('יהוה');

/* ------------------------------------------------------------------ utils */

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3600);
}

/* ------------------------------------------------------------- AI status */

let aiStatusTimer = null;

/**
 * One unobtrusive line for whatever the model is doing. It never blocks
 * anything and never needs a second one: a new message replaces the last.
 */
function setAiStatus(message, kind = '') {
  const el = $('#ai-status');
  if (!el) return;
  clearTimeout(aiStatusTimer);
  if (!message) { el.classList.add('hidden'); return; }
  el.textContent = message;
  el.className = `ai-status ${kind}`;
  el.classList.remove('hidden');
  if (kind !== 'busy') aiStatusTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

/** Progress events from a running generation, routed by request id. */
function handleAiEvent(event) {
  if (!event) return;
  const mine = event.requestId && S.askRequestId && event.requestId === S.askRequestId;
  if (event.type === 'ask' && event.requestId && !mine) return;

  if (event.phase === 'draft') {
    S.askDraft = String(event.text || '');
    const draft = $('#ask-draft');
    if (draft) draft.textContent = S.askDraft;
    return;
  }
  if (event.type === 'translate') {
    if (event.phase === 'generating') {
      setAiStatus(`Translating…${event.batch != null ? ` batch ${event.batch + 1} of ${event.total}` : ''}`, 'busy');
    } else if (event.phase === 'done') {
      setAiStatus('Translation ready', 'ok');
    }
    return;
  }
  if (event.phase === 'queued') setAiStatus('Waiting for the model to finish…', 'busy');
  else if (event.phase === 'starting') setAiStatus(`Connecting to ${event.model || 'the model'}…`, 'busy');
  else if (event.phase === 'preparing') setAiStatus(`Preparing ${event.model || 'the model'} — loading it into memory`, 'busy');
  else if (event.phase === 'generating') setAiStatus('Generating…', 'busy');
  else if (event.phase === 'done') {
    // The planning step finishing is not the end of the answer; the run itself
    // reports completion. Just stop claiming the model is working.
    if (event.timings) S.lastTimings = event.timings;
    setAiStatus('');
  } else if (event.phase === 'error') setAiStatus(event.message || 'The model stopped.', 'err');
}

function setView(view) {
  S.view = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  $$('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  if (view === 'settings') fillSettings();
  if (view === 'library') ensureLibrary();
  if (view === 'search') {
    renderSearchScopes();
    updateThisWork();
    if ($('#search-input')) $('#search-input').value = S.searchQuery;
    renderSearch();
  }
  if (view === 'reader' && !S.reader) {
    $('#reader-text').innerHTML = '';
    $('#reader-meta').innerHTML = '';
  }
  $('#main')?.scrollTo?.(0, 0);
  document.querySelector('.main').scrollTop = 0;
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  if (label) btn.textContent = busy ? 'Working…' : label;
}

const CORE_STYLES = ['modern', 'ashkenazi', 'mizrahi'];
const STYLE_LABELS = {
  modern: 'Modern', ashkenazi: 'Ashkenazi', mizrahi: 'Mizrahi', yemeni: 'Yemeni', kavkazi: 'Kavkazi',
  ancient: 'Ancient', 'ancient-hard': 'Ancient (hard)',
};

function applyReadingSettings() {
  document.documentElement.style.setProperty('--reader-size', `${S.fontSize}px`);
  $$('#style-seg button').forEach((b) => b.classList.toggle('is-active', b.dataset.style === S.style));
  const more = $('#style-more');
  if (more) {
    const extra = !CORE_STYLES.includes(S.style);
    more.value = extra ? S.style : '';
    more.classList.toggle('has-value', extra);
  }
  $('#tgl-translit').checked = S.showTranslit;
  $('#tgl-english').checked = S.showEnglish;
  $('#tgl-hebrew').checked = S.showHebrew;
  $('#tgl-commentaries').checked = S.showCommentaries;
  $('#set-show-translit').checked = S.showTranslit;
  $('#set-show-english').checked = S.showEnglish;
  $('#set-show-hebrew').checked = S.showHebrew;
  const page = String(S.pageSize || 0);
  if ($('#reader-page-size')) $('#reader-page-size').value = page;
  if ($('#set-page-size')) $('#set-page-size').value = page;
}

/* ------------------------------------------------------------------ panel */

function setPanel({ kicker = 'Study panel', title = 'Word study', body = '', loading = false }) {
  $('#app').classList.remove('no-context');
  $('#ctx-title').textContent = title;
  $('.ctx-kicker').textContent = kicker;
  const bodyEl = $('#ctx-body');
  if (loading) {
    bodyEl.innerHTML = `<div class="skeleton" style="width:55%"></div><div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:75%"></div>`;
  } else {
    bodyEl.innerHTML = body;
  }
  bodyEl.scrollTop = 0;
}

/* ------------------------------------------------------------------ ask */

const EXAMPLES = [
  'What does the Torah say about caring for strangers?',
  'How do the sources understand “love your neighbor as yourself”?',
  'What is the Talmudic debate about the death penalty?',
  'How does Maimonides describe the levels of tzedakah?',
  'Why do we light two candles on Shabbat?',
];

function renderExamples() {
  if ($('#ask-output').dataset.filled === '1') return;
  $('#ask-output').dataset.filled = '1';
  $('#ask-output').innerHTML = `
    <div class="empty-state">
      <h3>Start with a question, not a keyword</h3>
      <p class="muted small" style="margin:0 0 14px">The app searches Sefaria, reads the candidate passages, then selects the ones that actually bear on your question — and says why.</p>
      <div class="examples">
        ${EXAMPLES.map((q) => `<button class="example" data-example="${esc(q)}">${esc(q)}</button>`).join('')}
      </div>
    </div>`;
}

function renderCategoryChips() {
  const cats = (S.info && S.info.categories) || [];
  $('#category-chips').innerHTML = [
    `<button class="chip ${S.category ? '' : 'is-active'}" data-cat="">All of Sefaria</button>`,
    ...cats.map((c) => `<button class="chip ${S.category === c ? 'is-active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`),
  ].join('');
}

async function runAsk(question) {
  const q = String(question || '').trim();
  if (!q || S.busy) return;
  $('#ask-input').value = q;
  const context = askContextText(S.askContext);
  S.busy = true;
  setBusy($('#ask-btn'), true, 'Ask');

  const stages = [
    'Planning search queries…',
    'Searching the Sefaria library…',
    'Reading candidate passages…',
    'Weighing the sources…',
  ];
  let stage = 0;
  const started = Date.now();
  // The service aborts the model call for this id when Stop is pressed.
  const requestId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `ask-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  S.askRequestId = requestId;
  S.askDraft = '';
  let stopped = false;
  $('#ask-output').dataset.filled = '0';
  $('#ask-output').innerHTML = `
    <div class="loading-card">
      <div class="spinner"></div>
      <div class="loading-copy"><div id="stage">${stages[0]}</div>
      <div class="muted small" id="elapsed">0s</div></div>
      <button type="button" class="ghost small" id="ask-cancel">Stop</button>
    </div>
    <div id="ask-draft" class="answer-draft"></div>`;
  const cancelBtn = $('#ask-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      stopped = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Stopping…';
      const stageEl = $('#stage');
      if (stageEl) stageEl.textContent = 'Stopping…';
      try {
        await api.rpc('ask.cancel', { requestId });
      } catch { /* the ask call itself reports the outcome */ }
    });
  }
  const timer = setInterval(() => {
    stage = (stage + 1) % stages.length;
    const stageEl = $('#stage');
    if (stageEl) stageEl.textContent = stages[stage];
    const elapsed = $('#elapsed');
    if (elapsed) {
      const secs = Math.round((Date.now() - started) / 1000);
      elapsed.textContent = secs >= 15 && isLocalProvider(S.settings && S.settings.provider)
        ? `${secs}s · a local model can take a minute`
        : `${secs}s`;
    }
  }, 2400);

  try {
    const result = await api.rpc('ask', { question: q, category: S.category || null, limit: 4, requestId, context });
    S.askResult = result;
    renderAnswer(result);
    const t = S.lastTimings || {};
    setAiStatus(t.tokensPerSecond ? `Answered · ${t.tokensPerSecond} tok/s` : '', 'ok');
    S.lastTimings = null;
  } catch (err) {
    if (stopped || err.code === 'CANCELLED') renderAskCancelled();
    else renderAskError(err);
    setAiStatus('');
  } finally {
    clearInterval(timer);
    S.busy = false;
    S.askRequestId = '';
    S.askDraft = '';
    setBusy($('#ask-btn'), false, 'Ask');
  }
}

/**
 * What the model receives alongside the question. The selected words alone can
 * be ambiguous (a pronoun, half a clause); the verse and its reference let the
 * retrieval and ranking steps read the selection in place.
 */
function askContextText(context) {
  if (!context || !context.text) return null;
  const parts = [`Selected text: ${context.text}`];
  if (context.ref) parts.push(`Reference: ${context.ref}`);
  if (context.contextHe && context.contextHe !== context.text) {
    parts.push(`Surrounding verse (Hebrew/Aramaic): ${context.contextHe}`);
  }
  if (context.contextEn && context.contextEn !== context.text) {
    parts.push(`Surrounding verse (English): ${context.contextEn}`);
  }
  return parts.join('\n');
}

function renderAskContext() {
  const box = $('#ask-context');
  if (!box) return;
  if (!S.askContext || !S.askContext.text) {
    box.classList.add('hidden');
    $('#ask-context-text').textContent = '';
    if ($('#ask-context-meta')) $('#ask-context-meta').textContent = '';
    $('#ask-input').placeholder = 'How do the sources understand “love your neighbor as yourself”?';
    return;
  }
  box.classList.remove('hidden');
  $('#ask-context-text').textContent = S.askContext.text;
  const words = S.askContext.text.trim().split(/\s+/).filter(Boolean).length;
  const meta = [S.askContext.ref, `${words} word${words === 1 ? '' : 's'} selected`].filter(Boolean);
  if ($('#ask-context-meta')) $('#ask-context-meta').textContent = meta.join(' · ');
}

function renderAskError(err) {
  const noKey = err.code === 'NO_API_KEY';
  const badKey = err.code === 'BAD_KEY';
  const localIssue = err.code === 'LOCAL_DOWN' || err.code === 'MODEL_NOT_FOUND';
  const title = noKey ? 'Add an AI provider to answer questions'
    : badKey ? 'The API key was rejected'
      : localIssue ? 'The local model is not ready'
        : 'That search did not complete';
  const body = noKey
    ? 'Question answering uses an AI model to choose among Sefaria passages and explain the choice. Search, reading, transliteration, and the lexicon work without a key.'
    : esc(err.message);
  $('#ask-output').innerHTML = `
    <div class="error-card">
      <strong>${esc(title)}</strong>
      ${body}
      ${noKey || badKey || localIssue ? '<div><button class="ghost" data-open-settings>Open settings</button></div>' : ''}
    </div>`;
}

function renderAskCancelled() {
  $('#ask-output').innerHTML = `
    <div class="error-card">
      <strong>Cancelled</strong>
      The question was stopped before the model finished. Ask it again whenever you like.
    </div>`;
}

function confidencePill(confidence) {
  const cls = confidence === 'high' ? 'ok' : confidence === 'low' ? 'low' : '';
  return `<span class="pill ${cls}">${esc(confidence || 'medium')} confidence</span>`;
}

function renderAnswer(result) {
  const meta = result.meta || {};
  const bits = [];
  bits.push(`<span>${result.sources.length} source${result.sources.length === 1 ? '' : 's'}</span>`);
  if (meta.considered) bits.push(`<span>${meta.considered} passages read</span>`);
  if (meta.queries && meta.queries.length) bits.push(`<span>${meta.queries.length} queries</span>`);
  if (meta.tiers) {
    const order = ['primary', 'commentary', 'thought'];
    const labels = { primary: 'primary', commentary: 'commentary', thought: 'thought/mussar' };
    const tally = order.filter((t) => meta.tiers[t]).map((t) => `${meta.tiers[t]} ${labels[t]}`);
    if (tally.length > 1) bits.push(`<span>${tally.join(' · ')}</span>`);
  }
  if (meta.model) bits.push(`<span>${esc(meta.model)}</span>`);
  const ms = meta.elapsedMs || 0;
  bits.push(`<span>${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}</span>`);

  const answerCard = `
    <div class="answer-card">
      <div class="eyebrow">Grounded answer ${confidencePill(result.confidence)}</div>
      <p class="answer-text">${esc(result.answer)}</p>
      ${result.caveats ? `<p class="caveat">${esc(result.caveats)}</p>` : ''}
      ${meta.ai === false ? `<p class="caveat">Ranking was not AI-assisted, so these are raw relevance results. <button class="ghost small" data-open-settings>Add a provider</button></p>` : ''}
      <div class="answer-meta">${bits.join('')}</div>
    </div>`;

  const sources = result.sources.map((src, i) => {
    const translit = src.translit ? (src.translit[S.style] || '') : '';
    const license = src.enVersion && src.enVersion.license ? src.enVersion.license : (src.license || '');
    const versionTitle = src.enVersion && src.enVersion.title ? src.enVersion.title : '';
    return `
      <article class="source-card" data-index="${i}">
        <header class="source-head">
          <div class="source-rank">${i + 1}</div>
          <div class="source-titles">
            <button class="source-ref" data-open-ref="${esc(src.ref)}">${esc(src.ref)}</button>
            <div class="source-sub">
              ${src.tier ? `<span class="tier-badge tier-${esc(src.tier)}">${esc(src.tierLabel || '')}</span>` : ''}
              ${S.showHebrew && src.heRef ? `<span dir="rtl" style="font-family:var(--hebrew-font)">${esc(src.heRef)}</span>` : ''}
              ${(src.categories || []).length ? `<span>·</span><span>${esc((src.categories || []).join(' › '))}</span>` : ''}
            </div>
          </div>
          ${src.relevance != null ? `
            <div class="relevance" title="Model relevance">
              <span>${Math.round(src.relevance * 100)}%</span>
              <div class="relevance-bar"><span style="width:${Math.max(4, Math.min(100, src.relevance * 100))}%"></span></div>
            </div>` : ''}
        </header>
        <div class="source-body">
          ${S.showHebrew && src.he ? `<p class="he-block" data-he="${enc(src.he)}">${esc(src.he)}</p>` : ''}
          ${S.showTranslit && translit ? `<p class="translit-block">${esc(translit)}</p>` : ''}
          ${S.showEnglish && src.machineTranslation ? '<span class="mtag">AI translation</span>' : ''}
          ${S.showEnglish
            ? (src.en
              ? `<p class="en-block" data-en="${enc(src.en)}">${esc(src.en)}</p>`
              : '<p class="en-block muted" style="font-style:italic">No English translation in this edition. Add an AI provider in Settings to generate one.</p>')
            : ''}
          ${src.justification ? `<div class="justification"><b>Why this source</b>${esc(src.justification)}</div>` : ''}
        </div>
        <footer class="source-foot">
          <button class="ghost small" data-open-ref="${esc(src.ref)}">Open in reader</button>
          <button class="ghost small" data-copy-ref="${esc(src.ref)}">Copy citation</button>
          <span class="license" title="${esc(versionTitle)}">${esc(versionTitle)}${license ? ` · ${esc(license)}` : ''}</span>
        </footer>
      </article>`;
  }).join('');

  $('#ask-output').innerHTML = answerCard + sources;
  $('#ask-output').dataset.filled = '1';
}

/* ------------------------------------------------------------------ reader */

function renderVersionPicker(data) {
  const wrap = $('#version-wrap');
  const select = $('#reader-version');
  const options = (Array.isArray(data.versionOptions) && data.versionOptions.length)
    ? data.versionOptions
    : (data.availableVersions || []).map((title) => ({ title, language: 'english', languageLabel: 'English' }));
  const current = data.enVersion ? data.enVersion.title : '';
  if (options.length < 2) {
    wrap.classList.add('hidden');
    select.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  select.innerHTML = options.map((v) => {
    const label = v.language && v.language !== 'english'
      ? `${v.title} — ${v.languageLabel}`
      : v.title;
    return `<option value="${esc(v.title)}" data-lang="${esc(v.language || 'english')}" ${v.title === current ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

/** The chapter unit a loaded passage belongs to; longest ref wins. */
function chapterMatchFor(book, ref) {
  const clean = String(ref || '').trim();
  let best = null;
  for (const section of book.sections || []) {
    for (const unit of section.units || []) {
      if (clean !== unit.ref && !clean.startsWith(`${unit.ref} `) && !clean.startsWith(`${unit.ref}:`)) continue;
      if (!best || unit.ref.length > best.ref.length) best = unit;
    }
  }
  return best;
}

/**
 * The reader's jump control: every chapter of the open work, grouped by section
 * for complex works (Zohar's parashot, a siddur's services).
 */
async function renderChapterPicker(data) {
  const wrap = $('#chapter-wrap');
  const select = $('#reader-chapter');
  if (!wrap || !select) return;
  const title = (data && data.title) || '';
  if (!title) { wrap.classList.add('hidden'); return; }
  let book = S.chaptersCache.get(title);
  if (!book) {
    const token = ++S.shapeSeq;
    wrap.classList.add('hidden');
    try { book = await api.rpc('library.chapters', { title }); } catch { return; }
    if (token !== S.shapeSeq) return;
    S.chaptersCache.set(title, book);
  }
  if (S.reader !== data) return;
  const sections = book.sections || [];
  const units = sections.reduce((all, s) => all.concat(s.units || []), []);
  if (units.length < 2) { wrap.classList.add('hidden'); return; }
  const match = chapterMatchFor(book, data.ref);
  S.readerChapterRef = match ? match.ref : '';
  const label = $('#chapter-label');
  if (label) label.textContent = book.unitLabel === 'daf' ? 'Daf' : 'Chapter';
  // A grouped option reads "2" inside its optgroup, but a closed select shows
  // only that label — so complex works carry the section name in the option.
  const option = (u, section) => `<option value="${esc(u.ref)}">${esc(sections.length > 1 && section ? `${section.label} ${u.label}` : u.label)}</option>`;
  select.innerHTML = sections.length > 1
    ? sections.map((s) => `<optgroup label="${esc(s.label)}${s.heTitle ? ` · ${esc(s.heTitle)}` : ''}">${(s.units || []).map((u) => option(u, s)).join('')}</optgroup>`).join('')
    : units.map((u) => option(u)).join('');
  if (match) select.value = match.ref;
  wrap.classList.remove('hidden');
}

function renderReaderMeta(data) {
  const cats = data.categories || [];
  // The category path is the way back into the library: Genesis sits under
  // Tanakh › Torah, so each segment is a button that reopens that shelf.
  const crumbs = cats.map((c, i) =>
    `<button class="crumb" data-lib-path="${esc(cats.slice(0, i + 1).join(' › '))}">${esc(c)}</button>`)
    .join('<span class="crumb-sep">›</span>');
  $('#reader-meta').innerHTML = `
    <div>
      <div class="reader-crumbs">
        <button class="crumb crumb-root" data-lib-root>← Library</button>
        ${crumbs ? `<span class="crumb-sep">›</span>${crumbs}` : ''}
      </div>
      <div>
        ${data.title
          ? `<button class="ref-title ref-title-btn" data-lib-work-at="${esc(data.title)}" title="Choose a chapter in the library">${esc(data.title)}</button>`
          : `<span class="ref-title">${esc(data.ref)}</span>`}
        ${S.showHebrew ? `<span class="he-title">${esc(data.heTitle || '')}</span>` : ''}
      </div>
      <div class="crumbs">${data.heVersion ? esc(data.heVersion.title) : ''}${data.enVersion && data.enVersion.language !== 'english' ? ` · <span class="pill">${esc(data.enVersion.languageLabel)}</span>` : ''}${data.machineTranslation ? ' · <span class="pill">AI English translation</span>' : ''}</div>
    </div>`;
  $('#reader-ref').value = data.ref;
  renderVersionPicker(data);
}

// Hebrew letters plus combining marks (niqqud, dagesh, cantillation), but not
// the punctuation that sits in the same Unicode block (maqaf, paseq, sof pasuq).
const HE_WORD = /[\u05D0-\u05EA][\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]*(?:[\u05D0-\u05EA][\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]*)*/g;

function hebrewWordsHtml(text, segIndex) {
  return esc(text).replace(HE_WORD, (word) =>
    `<span class="word" data-seg="${segIndex}" data-word="${enc(word)}">${word}</span>`);
}

/* ------------------------------------------------------------- commentaries */

/* ------------------------------------------------------------- commentaries */

// Commentary choices are per verse. Sefaria links each commentary to the verse
// it comments on, so asking for the links of "Genesis 1:2" returns only works
// that actually address that verse — not every work that touches the chapter.
// A passage with no verse refs (a Talmud daf) gets one list for the passage,
// addressed by index -1 and keyed "passage".

function isPrimarySource(data) {
  const path = (data.categories || []).map((c) => String(c).toLowerCase());
  if (/\bon\b/.test(data.title || '')) return false;
  return ['tanakh', 'mishnah', 'talmud'].some((c) => path.includes(c));
}

function commentaryName(work) {
  return work.collectiveTitle || work.title.replace(/^.*:\s*/, '');
}

function commKey(index) {
  return index === -1 ? 'passage' : String(index);
}

function commRef(data, index) {
  if (!data) return '';
  if (index === -1) return data.ref;
  return (data.segRefs && data.segRefs[index]) || data.ref;
}

function resetCommentaryState() {
  S.verseComm = {};
  S.verseSel = {};
  S.verseOpen = null;
  S.vcMore = new Set();
  S.vcLoading = '';
  S.vcError = '';
}

async function toggleCommentaries(index) {
  if (!S.reader) return;
  const key = commKey(index);
  if (S.verseOpen === key) {
    S.verseOpen = null;
    renderReaderBody();
    renderPassageCommentaries();
    return;
  }
  S.verseOpen = key;
  S.vcError = '';
  const readerRef = S.reader.ref;
  if (!S.verseComm[key]) {
    S.vcLoading = key;
    renderReaderBody();
    renderPassageCommentaries();
    try {
      const data = await api.rpc('commentaries', { ref: commRef(S.reader, index) });
      if (!S.reader || S.reader.ref !== readerRef) return;
      S.verseComm[key] = data;
    } catch (err) {
      if (!S.reader || S.reader.ref !== readerRef) return;
      S.verseComm[key] = { error: err.message, groups: [], total: 0 };
    }
    S.vcLoading = '';
  }
  if (!S.reader || S.reader.ref !== readerRef) return;
  renderReaderBody();
  renderPassageCommentaries();
}

async function chooseCommentary(index, work, sourceRef) {
  if (!S.reader) return;
  const key = commKey(index);
  if (S.verseSel[key] && S.verseSel[key].work === work) {
    delete S.verseSel[key];
    renderReaderBody();
    renderPassageCommentaries();
    return;
  }
  const readerRef = S.reader.ref;
  S.vcLoading = `${key}|${work}`;
  S.vcError = '';
  renderReaderBody();
  renderPassageCommentaries();
  try {
    const data = await api.rpc('commentary', { ref: commRef(S.reader, index), work, sourceRef: sourceRef || '' });
    if (!S.reader || S.reader.ref !== readerRef) return;
    if (!data || !Array.isArray(data.segments)) throw new Error('That commentary came back empty');
    S.verseSel[key] = data;
    S.verseOpen = key;
  } catch (err) {
    if (!S.reader || S.reader.ref !== readerRef) return;
    S.vcError = `${work}: ${err.message}`;
    toast(err.message, 'err');
  }
  S.vcLoading = '';
  renderReaderBody();
  renderPassageCommentaries();
}

function commentaryPanelHtml(index) {
  const key = commKey(index);
  const data = S.verseComm[key];
  const ref = commRef(S.reader, index);
  if (!data) {
    return S.vcLoading === key
      ? `<div class="vc-panel"><p class="muted small">Loading commentaries on ${esc(ref)}…</p></div>`
      : '';
  }
  if (data.error) {
    return `<div class="vc-panel"><p class="rc-error">Commentaries could not be loaded: ${esc(data.error)}</p></div>`;
  }
  if (!data.total) {
    return `<div class="vc-panel"><p class="muted small">Sefaria lists no commentary on ${esc(ref)}.</p></div>`;
  }
  const perGroup = 8;
  const groups = (data.groups || []).map((group) => {
    const moreKey = `${key}|${group.category}`;
    const open = S.vcMore.has(moreKey);
    const shown = open ? group.works : group.works.slice(0, perGroup);
    const chips = shown.map((work) => {
      const active = S.verseSel[key] && S.verseSel[key].work === work.title;
      const busy = S.vcLoading === `${key}|${work.title}`;
      return `<button class="rc-chip${active ? ' is-active' : ''}${busy ? ' is-busy' : ''}"
        data-vc-work="${esc(work.title)}" data-vc-index="${index}" data-vc-source="${esc(work.sourceRef || '')}"
        title="${esc(work.title)} — ${work.verses} ${work.verses === 1 ? 'verse' : 'verses'}${work.hasEnglish ? ', with English' : ', Hebrew only'}">
        <span class="rc-name">${esc(commentaryName(work))}</span>
        <span class="rc-he" dir="rtl">${esc(work.heTitle ? work.heTitle.split(' ')[0] : '')}</span>
      </button>`;
    }).join('');
    const more = group.works.length > perGroup && !open
      ? `<button class="ghost small" data-vc-more="${esc(moreKey)}">+${group.works.length - perGroup} more</button>`
      : '';
    return `<div class="rc-group"><span class="rc-cat">${esc(group.category)}</span><div class="rc-chips">${chips}${more}</div></div>`;
  }).join('');
  return `<div class="vc-panel">
    <div class="vc-head">
      <span class="muted small">${data.total} ${data.total === 1 ? 'work comments' : 'works comment'} on ${esc(ref)}</span>
      <button class="ghost small" data-vc-close>Hide list</button>
    </div>
    ${S.vcError ? `<p class="rc-error">${esc(S.vcError)}</p>` : ''}
    <div class="rc-groups">${groups}</div>
  </div>`;
}

function selectedCommentaryHtml(index) {
  const key = commKey(index);
  const sel = S.verseSel[key];
  if (!sel || !Array.isArray(sel.segments) || !sel.segments.length) return '';
  const where = index === -1 ? 'the passage' : `verse ${index + 1}`;
  const blocks = sel.segments.map((seg) => `
    ${S.showHebrew && seg.he ? `<p class="sc-he">${esc(seg.he)}</p>` : ''}
    ${S.showEnglish && seg.en ? `<p class="sc-en">${esc(seg.en)}</p>` : ''}`).join('');
  return `<div class="seg-commentary">
    <div class="sc-head">${esc(sel.title || sel.work)} <span class="sc-verse">· ${esc(where)}</span>
      <button class="ghost small" data-vc-hide="${index}">Hide</button></div>
    ${blocks}
    ${sel.license ? `<p class="sc-license">${esc(sel.license)}</p>` : ''}
  </div>`;
}

function commentaryControlsHtml(index) {
  const key = commKey(index);
  const selected = S.verseSel[key];
  const open = S.verseOpen === key;
  return `<div class="seg-comm-controls">
    <button class="seg-comm-btn${open ? ' is-active' : ''}${selected ? ' has-selection' : ''}" data-vc-open="${index}"
      title="Commentaries on ${esc(commRef(S.reader, index))}">
      <span class="sc-mark" aria-hidden="true">✦</span>
      <span>${selected ? esc(selected.title || selected.work) : 'Commentaries'}</span>
    </button>
    ${open ? commentaryPanelHtml(index) : ''}
  </div>`;
}

function renderPassageCommentaries() {
  const host = $('#reader-commentaries');
  const data = S.reader;
  if (!host) return;
  // Verse-based passages put the chooser under each verse instead.
  const show = Boolean(data) && S.showCommentaries && isPrimarySource(data)
    && !(data.segRefs && data.segRefs.length);
  host.classList.toggle('hidden', !show);
  if (!show) {
    host.innerHTML = '';
    host.dataset.ref = '';
    return;
  }
  host.dataset.ref = data.ref;
  host.innerHTML = `<div class="rc-head">
      <span class="rc-title">Commentaries</span>
      <span class="muted small">${esc(data.ref)}</span>
    </div>
    ${commentaryControlsHtml(-1)}
    ${selectedCommentaryHtml(-1)}`;
}

// Delegated from the document and registered when the script runs: the body is
// re-rendered constantly, so the handler must outlive every render.
document.addEventListener('click', (e) => {
  const open = e.target.closest && e.target.closest('[data-vc-open]');
  if (open) { toggleCommentaries(Number(open.dataset.vcOpen)); return; }
  const work = e.target.closest && e.target.closest('[data-vc-work]');
  if (work) { chooseCommentary(Number(work.dataset.vcIndex), work.dataset.vcWork, work.dataset.vcSource); return; }
  const close = e.target.closest && e.target.closest('[data-vc-close]');
  if (close) {
    S.verseOpen = null;
    renderReaderBody();
    renderPassageCommentaries();
    return;
  }
  const hide = e.target.closest && e.target.closest('[data-vc-hide]');
  if (hide) {
    delete S.verseSel[commKey(Number(hide.dataset.vcHide))];
    renderReaderBody();
    renderPassageCommentaries();
    return;
  }
  const more = e.target.closest && e.target.closest('[data-vc-more]');
  if (more) {
    const key = more.dataset.vcMore;
    if (S.vcMore.has(key)) S.vcMore.delete(key); else S.vcMore.add(key);
    renderReaderBody();
    renderPassageCommentaries();
  }
});

function renderReaderBody() {
  const data = S.reader;
  if (!data) return;
  const rows = data.rows || [];
  const shown = S.pageSize > 0
    ? Math.min(Math.max(S.readerShown || S.pageSize, S.pageSize), rows.length)
    : rows.length;
  const visible = rows.slice(0, shown);
  const remaining = rows.length - visible.length;
  // Only verse-addressable primary texts get a per-verse chooser; a daf or a
  // commentary page uses the passage-level list instead.
  const perVerse = S.showCommentaries && isPrimarySource(data)
    && Array.isArray(data.segRefs) && data.segRefs.length > 0;
  const enDir = data.enVersion && data.enVersion.direction === 'rtl' ? 'rtl' : 'ltr';
  $('#reader-text').innerHTML = visible.map((row, i) => {
    const translit = row.translit ? (row.translit[S.style] || '') : '';
    const hasHe = Boolean(S.showHebrew && row.he);
    const hasTranslit = Boolean(S.showTranslit && translit);
    const hasEn = Boolean(S.showEnglish && row.en);
    const original = hasHe || hasTranslit;
    // Original on the right, translation on the left, verse by verse. With
    // Hebrew off the transliteration is a reading aid, not a second column: the
    // English takes the full width and the translit sits above it.
    const parallel = hasHe && hasEn;
    return `
      <div class="segment${parallel ? ' is-parallel' : ''}" data-seg="${i}">
        <div class="seg-num">${i + 1}</div>
        <div class="seg-body">
          ${original ? `<div class="seg-col seg-col-orig">
            ${hasHe ? `<p class="he-text">${hebrewWordsHtml(row.he, i)}</p>` : ''}
            ${hasTranslit ? `<p class="seg-translit">${esc(translit)}</p>` : ''}
          </div>` : ''}
          ${hasEn ? `<div class="seg-col seg-col-en"><p class="seg-en" dir="${enDir}">${esc(row.en)}</p></div>` : ''}
          ${perVerse ? `<div class="seg-extra">${commentaryControlsHtml(i)}${selectedCommentaryHtml(i)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  const more = $('#reader-more');
  if (more) {
    if (remaining > 0) {
      const unit = data.segRefs && data.segRefs.length ? 'verses' : 'segments';
      const step = S.pageSize > 0 ? Math.min(S.pageSize, remaining) : remaining;
      more.classList.remove('hidden');
      more.innerHTML = `<span>Showing ${visible.length} of ${rows.length} ${unit}.</span>
        <button class="ghost small" id="reader-show-more">Show ${step} more</button>`;
    } else {
      more.classList.add('hidden');
      more.innerHTML = '';
    }
  }
}

function renderReader() {
  const data = S.reader;
  if (!data) return;
  renderReaderMeta(data);
  renderChapterPicker(data);
  renderReaderBody();
  renderPassageCommentaries();

  const enTitle = data.machineTranslation
    ? 'AI English translation'
    : (data.enVersion
      ? `${data.enVersion.title}${data.enVersion.language && data.enVersion.language !== 'english' ? ` (${data.enVersion.languageLabel})` : ''}`
      : '');
  const license = data.license ? ` · ${data.license}` : '';
  // Say which reading the transliteration used, but only when the passage
  // actually carries the name — otherwise it is noise on every page.
  const nameNote = S.showTranslit && Array.isArray(data.rows) && data.rows.some((r) => hasDivineName(r.he))
    ? ` · Divine name read as ${data.divineName === 'adonai' ? 'Adonai' : 'HaShem'}`
    : '';
  // Filling the gaps is an offer, not a side effect of opening the page.
  const missing = Number(data.missingEnglish) || 0;
  const canTranslate = Boolean(data.canAiTranslate) && missing > 0 && !S.translateBusy;
  const translateCtl = S.translateBusy
    ? '<span class="muted small">Translating…</span> <button class="ghost small" id="reader-translate-stop">Stop</button>'
    : (canTranslate
      ? `<button class="ghost small" id="reader-translate-ai">Translate ${missing} segment${missing === 1 ? '' : 's'} with AI</button>`
      : '');
  $('#reader-foot').innerHTML = `
    <span>${esc(enTitle)}${esc(license)}${esc(nameNote)}</span>
    <span>${data.translationNote ? esc(data.translationNote) : (data.availableVersions && data.availableVersions.length
      ? `${data.availableVersions.length} English versions available on Sefaria`
      : '')}</span>
    <span>${translateCtl}</span>`;
  const translateBtn = $('#reader-translate-ai');
  if (translateBtn) translateBtn.onclick = () => translateMissing();
  const translateStop = $('#reader-translate-stop');
  if (translateStop) {
    translateStop.onclick = async () => {
      translateStop.disabled = true;
      translateStop.textContent = 'Stopping…';
      try { await api.rpc('translate.cancel'); } catch { /* the call in flight reports the rest */ }
    };
  }

  $('#reader-prev').disabled = !data.prev;
  $('#reader-next').disabled = !data.next;
}

let openSeq = 0;

/**
 * Translate the segments of the open passage that Sefaria leaves untranslated.
 * Only ever runs from the button (or the explicit setting), and the server
 * cancels the previous batch if another passage is translated first.
 */
async function translateMissing() {
  const data = S.reader;
  if (!data || S.translateBusy) return;
  const missing = [];
  data.rows.forEach((row, index) => {
    if (row.he && row.he.trim() && !(row.en && row.en.trim())) missing.push({ index, he: row.he });
  });
  if (!missing.length) return;
  const requestId = `tr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  S.translateBusy = true;
  S.translateReq = requestId;
  renderReader();
  setAiStatus(`Translating ${missing.length} segment${missing.length === 1 ? '' : 's'}…`, 'busy');
  try {
    const res = await api.rpc('translate.missing', {
      ref: data.ref,
      segments: missing.map((m) => m.he),
      requestId,
    });
    let filled = 0;
    missing.forEach((m, i) => {
      const en = String((res.en && res.en[i]) || '').trim();
      if (!en) return;
      data.rows[m.index].en = en;
      data.rows[m.index].machineTranslation = true;
      filled += 1;
    });
    data.machineTranslation = filled > 0;
    data.canAiTranslate = false;
    data.missingEnglish = 0;
    data.translationNote = res.note || data.translationNote;
    if (filled) toast(`Added ${filled} AI translation${filled === 1 ? '' : 's'}`);
  } catch (err) {
    if (err.code === 'CANCELLED') toast('Translation stopped');
    else toast(err.message, 'err');
  } finally {
    S.translateBusy = false;
    S.translateReq = '';
    setAiStatus('');
    renderReader();
  }
}

function renderLoadedText(data, { recent = true } = {}) {
  const previous = S.reader && S.reader.ref;
  S.reader = data;
  S.readerShown = S.pageSize > 0 ? S.pageSize : 0;
  // Reopening the same passage keeps any commentary already chosen; only a
  // different passage starts from a clean slate.
  if (previous !== data.ref) resetCommentaryState();
  renderReader();
  $('#reader-external').onclick = () => api.openExternal(`https://www.sefaria.org/${enc(data.ref.replace(/ /g, '_'))}`);
  if (recent) addRecent(data.ref);
  document.querySelector('.main').scrollTop = 0;
  // Opt-in only: the setting says the person accepts a minute of local
  // inference per untranslated passage.
  if (S.autoTranslate && data.canAiTranslate && !data.autoStarted) {
    data.autoStarted = true;
    translateMissing();
  }
}

async function openRef(ref, { recent = true, version } = {}) {
  const target = String(ref || '').trim();
  if (!target) return;
  const token = ++openSeq;
  setView('reader');
  $('#reader-meta').innerHTML = '';
  // The old passage's commentary must not stay clickable while a new one loads.
  resetCommentaryState();
  renderPassageCommentaries();
  $('#reader-commentaries').innerHTML = '';
  $('#reader-commentaries').classList.add('hidden');
  $('#reader-text').innerHTML = `<div class="loading-card"><div class="spinner"></div><div>Opening ${esc(target)}…</div></div>`;
  try {
    const data = await api.rpc('text', { ref: target, version: version || 'english' });
    // A later Open wins: an earlier response must not overwrite it.
    if (token !== openSeq) return;
    renderLoadedText(data, { recent });
  } catch (err) {
    $('#reader-text').innerHTML = `
      <div class="error-card">
        <strong>Could not open that reference</strong>
        ${esc(err.message)}
        <div><button class="ghost" data-example-open="Genesis 1:1">Try Genesis 1:1</button></div>
      </div>`;
  }
}

/* ------------------------------------------------------------------ library */

function flattenWorks(nodes, path, out) {
  for (const node of nodes || []) {
    const name = node.title || node.category;
    if (!name) continue;
    const nextPath = [...path, name];
    if (Array.isArray(node.contents) && node.contents.length) {
      flattenWorks(node.contents, nextPath, out);
    } else if (node.title) {
      out.push({ title: node.title, heTitle: node.heTitle || '', path });
    }
  }
  return out;
}

function allWorks() {
  if (!S.library) return [];
  if (!S._allWorks) S._allWorks = flattenWorks(S.library, [], []);
  return S._allWorks;
}

/** Work leaves carry a title and no children; everything else is a shelf. */
function isWorkNode(node) {
  return Boolean(node && node.title && !(Array.isArray(node.contents) && node.contents.length));
}

/** The node at a full path, or null when the path does not exist. */
function libNodeAt(path) {
  let nodes = S.library || [];
  let node = null;
  for (const name of path) {
    node = (nodes || []).find((n) => (n.title || n.category) === name) || null;
    if (!node) return null;
    nodes = node.contents || [];
  }
  return node;
}

function libChildrenAt(depth) {
  let nodes = S.library || [];
  for (let i = 0; i < depth; i++) {
    const node = (nodes || []).find((n) => (n.title || n.category) === S.libPath[i]);
    if (!node) return [];
    nodes = node.contents || [];
  }
  return nodes || [];
}

/** The work whose chapters belong in the last column, if one is selected. */
function selectedWork() {
  const node = S.libPath.length ? libNodeAt(S.libPath) : null;
  return isWorkNode(node) ? node : null;
}

/** How many works sit under a shelf, memoised per node. */
function workCount(node) {
  if (!node || !Array.isArray(node.contents) || !node.contents.length) return 0;
  if (!S._libCounts) S._libCounts = new WeakMap();
  if (S._libCounts.has(node)) return S._libCounts.get(node);
  const n = node.contents.reduce((sum, child) => sum + (isWorkNode(child) ? 1 : workCount(child)), 0);
  S._libCounts.set(node, n);
  return n;
}

function shelfRow(node, depth) {
  const name = node.title || node.category;
  const work = isWorkNode(node);
  const count = work ? 0 : workCount(node);
  const selected = S.libPath[depth] === name;
  return `<button class="shelf-row${work ? ' is-work' : ''}${selected ? ' is-selected' : ''}"
      data-lib-select="${esc(name)}" data-lib-level="${depth}" title="${esc(name)}">
    <span class="shelf-name">${esc(name)}</span>
    ${node.heTitle ? `<span class="shelf-he" dir="rtl">${esc(node.heTitle)}</span>` : ''}
    ${count ? `<span class="shelf-note">${count} work${count === 1 ? '' : 's'}</span>` : ''}
  </button>`;
}

function shelfColumn(depth) {
  const nodes = libChildrenAt(depth);
  if (!nodes.length) return '';
  const label = depth === 0
    ? 'Tradition'
    : (nodes.every(isWorkNode) ? 'Work' : 'Category');
  return `<div class="shelf" data-depth="${depth}">
    <div class="shelf-head"><span>${label}</span><span class="shelf-count">${nodes.length}</span></div>
    <div class="shelf-body">${nodes.map((n) => shelfRow(n, depth)).join('')}</div>
  </div>`;
}

function chapterColumn() {
  const work = selectedWork();
  const loaded = work && S.libChaptersFor === work.title ? S.libChapters : null;
  const unitName = loaded && loaded.unitLabel === 'daf' ? 'Daf' : 'Chapter';
  const head = (count) => `<div class="shelf-head"><span>${unitName}</span><span class="shelf-count">${count || ''}</span></div>`;
  if (!work) {
    return `<div class="shelf shelf-chapters">${head('')}
      <div class="shelf-body shelf-empty">Pick a work to see its chapters.</div></div>`;
  }
  const title = work.title;
  if (S.libChaptersFor === title && S.libChapterError) {
    return `<div class="shelf shelf-chapters">${head('')}
      <div class="shelf-body"><div class="shelf-empty">Could not list chapters: ${esc(S.libChapterError)}
        <div><button class="ghost small" data-lib-open="${esc(title)}">Open the work instead</button></div>
      </div></div></div>`;
  }
  const book = loaded;
  if (!book) {
    return `<div class="shelf shelf-chapters">${head('')}
      <div class="shelf-body"><div class="loading-card"><div class="spinner"></div><div>Loading ${esc(title)}…</div></div></div></div>`;
  }
  const sections = book.sections || [];
  const index = Math.min(S.libSection || 0, Math.max(0, sections.length - 1));
  const section = sections[index];
  if (!section) {
    return `<div class="shelf shelf-chapters">${head('')}
      <div class="shelf-body"><div class="shelf-empty">Sefaria lists no chapters for ${esc(title)}.
        <div><button class="ghost small" data-lib-open="${esc(title)}">Open the work</button></div>
      </div></div></div>`;
  }
  const unitWord = book.unitLabel === 'daf'
    ? (book.total === 1 ? 'daf' : 'dapim')
    : (book.total === 1 ? 'chapter' : 'chapters');
  const current = S.reader ? String(S.reader.ref || '') : '';
  const isCurrent = (unit) => current === unit.ref || current.startsWith(`${unit.ref} `) || current.startsWith(`${unit.ref}:`);
  const startButton = section.units[0]
    ? `<button class="primary small" data-open-ref="${esc(section.units[0].ref)}">Start reading →</button>`
    : '';
  const picker = sections.length > 1
    ? `<select id="lib-section" class="chap-section" aria-label="Section of ${esc(title)}">
        ${sections.map((s, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${esc(s.label)}${s.heTitle ? ` · ${esc(s.heTitle)}` : ''}</option>`).join('')}
      </select>`
    : '';
  return `<div class="shelf shelf-chapters">${head(book.total)}
    <div class="shelf-body">
      <div class="chap-work">
        <div>
          <div><span class="ref-title">${esc(book.title)}</span>${book.heTitle ? `<span class="he-title">${esc(book.heTitle)}</span>` : ''}</div>
          <div class="chap-note">${book.total} ${unitWord}${book.complex ? ` in ${sections.length} sections` : ''}</div>
        </div>
        ${startButton}
      </div>
      ${picker}
      <div class="chap-grid">
        ${section.units.map((u) => `<button class="chap${isCurrent(u) ? ' is-current' : ''}" data-open-ref="${esc(u.ref)}" title="${esc(u.ref)}">${esc(u.label)}</button>`).join('')}
      </div>
    </div>
  </div>`;
}

function renderShelves() {
  const host = $('#lib-shelves');
  if (!host || !S.library) return;
  const cols = [];
  for (let depth = 0; depth <= S.libPath.length; depth++) cols.push(shelfColumn(depth));
  cols.push(chapterColumn());
  host.innerHTML = cols.filter(Boolean).join('');
  const active = host.querySelector('.shelf-row.is-selected');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderLibrary() {
  const host = $('#lib-shelves');
  if (!host) return;
  if (!S.library) return;
  const q = S.libFilter.trim().toLowerCase();
  renderLibraryBreadcrumb();

  if (q.length >= 2) {
    const matches = allWorks().filter((w) =>
      w.title.toLowerCase().includes(q) || (w.heTitle || '').includes(S.libFilter.trim()));
    S.libMatches = matches.slice(0, 150);
    $('#lib-count').textContent = `${matches.length}${matches.length > 150 ? '+' : ''} matching works`;
    host.innerHTML = `<div class="shelf shelf-results">
      <div class="shelf-head"><span>Matches</span><span class="shelf-count">${S.libMatches.length}</span></div>
      <div class="shelf-body">${S.libMatches.length
        ? S.libMatches.map((w) => `
          <button class="shelf-row is-work" data-lib-work="${esc(w.title)}" data-lib-work-path="${esc(w.path.join(' › '))}">
            <span class="shelf-name">${esc(w.title)}</span>
            ${w.heTitle ? `<span class="shelf-he" dir="rtl">${esc(w.heTitle)}</span>` : ''}
            <span class="shelf-note">${esc(w.path.join(' › '))}</span>
          </button>`).join('')
        : '<div class="shelf-empty">No works match that filter.</div>'}
      </div>
    </div>`;
    return;
  }

  $('#lib-count').textContent = `${allWorks().length} works`;
  renderShelves();
  renderLibraryBreadcrumb();
}

/** Chapters for the work picked on the shelf; the column shows a spinner until they arrive. */
async function loadLibChapters(title) {
  if (!title || S.libChaptersFor === title) return;
  S.libChaptersFor = title;
  S.libChapters = null;
  S.libChapterError = '';
  S.libSection = 0;
  renderShelves();
  try {
    const book = await api.rpc('library.chapters', { title });
    if (S.libChaptersFor !== title) return;
    S.libChapters = book;
  } catch (err) {
    if (S.libChaptersFor !== title) return;
    S.libChapterError = err.message;
  }
  renderShelves();
}

/** The trail back up the shelf: All works › Tanakh › Torah. */
function renderLibraryBreadcrumb() {
  const host = $('#lib-breadcrumb');
  if (!host) return;
  if (!S.libPath.length) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = '<button class="crumb crumb-root" data-lib-root>All works</button>'
    + S.libPath.map((c, i) =>
      `<span class="crumb-sep">›</span><button class="crumb" data-lib-path="${esc(S.libPath.slice(0, i + 1).join(' › '))}">${esc(c)}</button>`).join('');
}

/**
 * Trim a path the table of contents cannot follow (a text's category names do
 * not always match the shelf) to the deepest level that exists, preferring the
 * known path of the work when one is given.
 */
function resolveLibraryPath(target) {
  if (!target.length || libNodeAt(target)) return target;
  const title = target[target.length - 1];
  const hit = allWorks().find((w) => w.title === title);
  if (hit) return [...hit.path, hit.title];
  const path = [];
  let nodes = S.library || [];
  for (const name of target) {
    const found = (nodes || []).find((n) => (n.title || n.category) === name);
    if (!found) break;
    path.push(name);
    nodes = found.contents || [];
  }
  return path;
}

/**
 * Open the library at a path — category levels, optionally ending on a work so
 * its chapter grid is showing. Used by the reader breadcrumb and title.
 */
function showLibraryAt(path) {
  const target = (path || []).filter(Boolean);
  S.libFilter = '';
  if ($('#lib-filter')) $('#lib-filter').value = '';
  S.libPath = target.slice();
  setView('library');
  const reveal = () => {
    S.libPath = resolveLibraryPath(target);
    renderLibrary();
    renderLibraryBreadcrumb();
    const work = selectedWork();
    if (work) loadLibChapters(work.title);
  };
  ensureLibrary().then(reveal);
}

async function ensureLibrary() {
  if (S.library) { renderLibrary(); return; }
  $('#lib-shelves').innerHTML = '<div class="loading-card"><div class="spinner"></div><div>Loading the Sefaria library…</div></div>';
  $('#lib-count').textContent = '';
  try {
    S.library = await api.rpc('library.toc');
    S._allWorks = null;
    S._libCounts = null;
    renderLibrary();
  } catch (err) {
    $('#lib-shelves').innerHTML = `<div class="error-card"><strong>Could not load the library</strong>${esc(err.message)}<div><button class="ghost" data-lib-retry>Retry</button></div></div>`;
  }
}

async function openWork(title) {
  if (!title) return;
  // Remember where in the shelf we were, so "back to the library" returns there.
  S.libScroll = document.querySelector('.main').scrollTop;
  S.libReturnPath = S.libPath.slice();
  setView('reader');
  $('#reader-meta').innerHTML = '';
  $('#reader-text').innerHTML = `<div class="loading-card"><div class="spinner"></div><div>Opening ${esc(title)}…</div></div>`;
  try {
    const data = await api.rpc('library.open', { title });
    renderLoadedText(data);
  } catch (err) {
    $('#reader-text').innerHTML = `<div class="error-card"><strong>Could not open that work</strong>${esc(err.message)}<div><button class="ghost" data-lib-back>Back to library</button></div></div>`;
  }
}

/* ------------------------------------------------------------------ search */

// Rows the reader sees per page. Sefaria returns one hit per version, so a
// page asks for twice that and is deduplicated by ref afterwards.
const SEARCH_PAGE = 20;
const SEARCH_EXAMPLES = [
  'עולם הבא',
  'love your neighbor as yourself',
  'Shabbat candles',
  'Rashi on Genesis 1',
];

function clipSnippet(text, max = 280) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

/** The category list comes from the service, which knows what the index holds. */
function renderSearchScopes() {
  const select = $('#search-scope');
  if (!select) return;
  const scopes = (S.info && S.info.searchScopes) || [];
  if (!scopes.length) return;
  select.innerHTML = '<option value="">All of Sefaria</option>'
    + scopes.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  select.value = S.searchScope;
}

/** Read the two filter controls into state; a work is narrower than a category. */
function readSearchFilters() {
  const scopeEl = $('#search-scope');
  const workEl = $('#search-work');
  const work = workEl ? workEl.value.trim() : '';
  S.searchWork = work;
  S.searchScope = work ? '' : (scopeEl ? scopeEl.value : '');
  if (scopeEl && work) scopeEl.value = '';
  return { scope: S.searchScope, work: S.searchWork };
}

/**
 * Offer the work titles the library knows, once, the first time the work field
 * is focused. The field stays usable as plain text while the shelf loads.
 */
function fillWorkList() {
  if (S.workListReady || S.workListLoading) return;
  S.workListLoading = true;
  ensureLibrary()
    .then(() => {
      const list = $('#search-work-list');
      if (list) list.innerHTML = allWorks().map((w) => `<option value="${esc(w.title)}"></option>`).join('');
      S.workListReady = true;
    })
    .catch(() => { /* the field still accepts a typed title */ })
    .finally(() => { S.workListLoading = false; });
}

/** "This work" is only meaningful while a passage is open in the reader. */
function updateThisWork() {
  const btn = $('#search-this-work');
  if (!btn) return;
  const title = (S.reader && S.reader.title) || '';
  btn.classList.toggle('hidden', !title);
  if (title) btn.title = `Limit the search to ${title}`;
}

/**
 * Open the Search view and run `query`. The only entry point, so the nav, the
 * form, and the selection toolbar leave the same state behind.
 */
function goSearch(query) {
  const q = String(query || '').trim();
  readSearchFilters();
  S.searchQuery = q;
  setView('search');
  if ($('#search-input')) $('#search-input').value = q;
  runSearch(q);
}

async function runSearch(query, { append = false } = {}) {
  const q = String(query || '').trim();
  const token = ++S.searchSeq;
  if (!q) {
    S.searchQuery = '';
    S.searchHits = [];
    S.searchTotal = 0;
    S.searchStart = 0;
    S.searchMore = false;
    S.searchError = '';
    S.searchBusy = false;
    renderSearch();
    return;
  }
  const from = append ? S.searchStart : 0;
  S.searchQuery = q;
  if (!append) {
    S.searchHits = [];
    S.searchTotal = 0;
    S.searchStart = 0;
    S.searchMore = false;
  }
  S.searchBusy = true;
  S.searchError = '';
  renderSearch();
  try {
    const res = await api.rpc('search', {
      query: q, size: SEARCH_PAGE * 2, start: from, scope: S.searchScope, work: S.searchWork,
    });
    if (token !== S.searchSeq) return;
    const raw = res.hits || [];
    // Sefaria indexes each version separately, so one verse arrives twice (once
    // Hebrew, once English). One row per passage is what a results list wants.
    const seen = new Set(S.searchHits.map((h) => h.ref));
    const fresh = raw.filter((h) => {
      if (!h.ref || seen.has(h.ref)) return false;
      seen.add(h.ref);
      return true;
    });
    S.searchHits = append ? S.searchHits.concat(fresh) : fresh;
    S.searchStart = from + raw.length;
    S.searchMore = raw.length === SEARCH_PAGE * 2;
    S.searchTotal = Number(res.total) || S.searchHits.length;
    S.searchTook = Number(res.took) || 0;
  } catch (err) {
    if (token !== S.searchSeq) return;
    S.searchError = err.message;
  } finally {
    if (token === S.searchSeq) {
      S.searchBusy = false;
      renderSearch();
    }
  }
}

function renderSearch() {
  const meta = $('#search-meta');
  const host = $('#search-results');
  if (!meta || !host) return;

  if (!S.searchQuery) {
    meta.textContent = '';
    host.innerHTML = `
      <div class="empty-state">
        <h3>Search the texts themselves</h3>
        <p class="muted small" style="margin:0 0 14px">Every version Sefaria publishes is searched, so a phrase can be found in Hebrew or in translation. Open a result to read it with its translation and commentaries.</p>
        <div class="examples">
          ${SEARCH_EXAMPLES.map((s) => `<button class="example" data-search-example="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>
      </div>`;
    return;
  }

  if (S.searchError) {
    meta.textContent = '';
    host.innerHTML = `<div class="error-card"><strong>Search failed</strong>${esc(S.searchError)}
      <div><button class="ghost" data-search-retry>Try again</button></div></div>`;
    return;
  }

  if (S.searchBusy && !S.searchHits.length) {
    meta.textContent = '';
    host.innerHTML = `<div class="loading-card"><div class="spinner"></div>
      <div>Searching for “${esc(S.searchQuery)}”…</div></div>`;
    return;
  }

  const shown = S.searchHits.length;
  const where = S.searchWork || S.searchScope;
  const facts = [`${S.searchTotal} match${S.searchTotal === 1 ? '' : 'es'}`];
  if (S.searchTook) facts.push(`${S.searchTook} ms`);
  // Sefaria counts indexed versions, not distinct passages, so "showing" is only
  // useful while there is another page to ask for.
  if (S.searchMore && shown < S.searchTotal) facts.push(`showing ${shown}`);
  meta.textContent = `“${S.searchQuery}”${where ? ` in ${where}` : ''} · ${facts.join(' · ')}`;

  if (!shown) {
    host.innerHTML = `
      <div class="empty-state">
        <h3>No matches${where ? ` in ${esc(where)}` : ''}</h3>
        <p class="muted small" style="margin:0">Sefaria's search is lexical: try fewer words, a name, or the Hebrew term.${where ? ' Or widen the limit above.' : ''}</p>
      </div>`;
    return;
  }

  host.innerHTML = S.searchHits.map((hit) => {
    const lang = hit.lang === 'he' ? 'Hebrew' : hit.lang === 'en' ? 'English' : String(hit.lang || '').toUpperCase();
    return `<article class="search-hit">
      <button class="search-hit-ref" data-open-ref="${esc(hit.ref)}">${esc(hit.ref)}</button>
      <div class="search-hit-sub">
        <span class="pill">${esc(lang)}</span>
        ${hit.versionTitle ? `<span>${esc(hit.versionTitle)}</span>` : ''}
      </div>
      ${hit.highlight ? `<p class="search-snippet" dir="auto">${esc(clipSnippet(hit.highlight))}</p>` : ''}
    </article>`;
  }).join('') + (S.searchMore
    ? `<button class="ghost search-more" data-search-more ${S.searchBusy ? 'disabled' : ''}>${S.searchBusy ? 'Searching…' : 'Show more results'}</button>`
    : '');
}

/* ------------------------------------------------------------------ word panel */

async function showWord(word, segIndex, el) {
  $$('.he-text .word.is-active').forEach((w) => w.classList.remove('is-active'));
  if (el) el.classList.add('is-active');

  const row = S.reader && S.reader.rows ? S.reader.rows[segIndex] : null;
  setPanel({ kicker: 'Word study', title: word, loading: true });

  try {
    const data = await api.rpc('gloss', {
      word,
      verseHe: row ? row.he : '',
      verseEn: row ? row.en : '',
      divineName: S.reader ? S.reader.divineName : '',
    });
    renderWordPanel(data, row, word, segIndex);
  } catch (err) {
    setPanel({
      kicker: 'Word study',
      title: word,
      body: `<div class="error-card"><strong>Lookup failed</strong>${esc(err.message)}</div>`,
    });
  }
}

/**
 * The three main traditions stay visible; whichever extra tradition is in use
 * (Yemeni, Kavkazi, either Ancient) is appended as a fourth row so the panel
 * never hides the style in use, without adding permanent rows nobody asked for.
 */
function translitRows(pick) {
  const styles = CORE_STYLES.includes(S.style) ? CORE_STYLES : [...CORE_STYLES, S.style];
  return styles.map((style) => `
    <div class="trio-row ${style === S.style ? 'is-primary' : ''}">
      <span class="label">${STYLE_LABELS[style] || style}</span>
      <span class="value">${esc(pick(style) || '—')}</span>
    </div>`).join('');
}

function renderWordPanel(data, row, word, segIndex) {
  const t = data.translit || {};
  const trio = translitRows((style) => (t[style] && t[style] !== t.he ? t[style] : '—'));

  const lex = (data.entries || []).map((entry) => {
    const senses = (entry.senses || []).map((s) =>
      `<li style="margin-left:${Math.min(3, s.depth) * 11}px">${esc(s.text)}</li>`).join('');
    return `
      <div class="lex-entry">
        <div class="lex-head">
          <span class="lex-name">${esc(entry.lexicon)}</span>
          <span class="lex-morph">${esc(entry.morphology || entry.strong || '')}</span>
        </div>
        ${senses ? `<ul class="lex-senses">${senses}</ul>` : '<p class="note">No definition text in this entry.</p>'}
        ${entry.refs && entry.refs.length ? `<div class="lex-refs">${entry.refs.slice(0, 5).map((r) =>
          `<button class="lex-ref" data-open-ref="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
      </div>`;
  }).join('') || '<p class="note">No dictionary entry found for this form. Unpointed or inflected forms may not resolve.</p>';

  const body = `
    <p class="word-title">${esc(word || '')}</p>
    <div class="word-sub">${esc(S.reader ? S.reader.ref : '')}${Number.isInteger(segIndex) ? ` · segment ${segIndex + 1}` : ''}</div>
    <div class="trio">${trio}</div>
    <div class="panel-section">
      <h3>In this verse</h3>
      <p class="gloss">${esc(data.gloss || 'No contextual gloss available.')}</p>
      ${data.note ? `<p class="note">${esc(data.note)}</p>` : ''}
      ${(data.root || data.binyan) ? `<div class="tagrow" style="margin-top:9px">
        ${data.root ? `<span class="tag">root ${esc(data.root)}</span>` : ''}
        ${data.binyan ? `<span class="tag">${esc(data.binyan)}</span>` : ''}
      </div>` : ''}
    </div>
    <div class="panel-section">
      <h3>Dictionary</h3>
      ${lex}
    </div>`;
  setPanel({ kicker: 'Word study', title: 'Word', body });
}

/* ------------------------------------------------------------------ selection */

let selContext = null;

function currentContext() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (!text || text.length > 800) return null;
  const range = sel.getRangeAt(0);
  let node = range.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  const host = node.closest('#reader-text, #ask-output, #ctx-body');
  if (!host) return null;

  const seg = node.closest('.segment');
  const card = node.closest('.source-card');
  let contextHe = '';
  let contextEn = '';
  let ref = '';
  if (seg && S.reader) {
    const index = Number(seg.dataset.seg);
    const row = S.reader.rows[index];
    if (row) { contextHe = row.he; contextEn = row.en; }
    ref = (S.reader.segRefs && S.reader.segRefs[index]) || S.reader.ref || '';
  } else if (card && S.askResult) {
    const src = S.askResult.sources[Number(card.dataset.index)];
    if (src) { contextHe = src.he; contextEn = src.en; ref = src.ref || ''; }
  }
  return { text, rect: range.getBoundingClientRect(), contextHe, contextEn, ref };
}

function showSelectionToolbar() {
  const ctx = currentContext();
  const tool = $('#seltool');
  if (!ctx) { tool.classList.add('hidden'); selContext = null; return; }
  selContext = ctx;
  const barWidth = 300;
  const left = Math.min(
    Math.max(10, ctx.rect.left + ctx.rect.width / 2 - barWidth / 2),
    window.innerWidth - barWidth - 10,
  );
  const top = Math.max(10, ctx.rect.top - 44);
  tool.style.left = `${left}px`;
  tool.style.top = `${top}px`;
  tool.classList.remove('hidden');
}

document.addEventListener('mouseup', () => setTimeout(showSelectionToolbar, 10));
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) $('#seltool').classList.add('hidden');
});

function clearSelection() {
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  $('#seltool').classList.add('hidden');
}

async function translateSelection(text, contextHe, contextEn) {
  const isHebrew = /[\u0590-\u05FF]/.test(text);
  setPanel({ kicker: 'Selection', title: isHebrew ? 'Translation' : 'Hebrew rendering', loading: true });
  try {
    const data = await api.rpc('translate', {
      text,
      contextHe,
      contextEn,
      divineName: S.reader ? S.reader.divineName : '',
    });
    const translit = data.translit || {};
    const trio = translitRows((style) => translit[style]);
    const body = `
      <div class="panel-section">
        <h3>${isHebrew ? 'Selected text' : 'Selection'}</h3>
        <p class="${isHebrew ? 'he-block' : 'en-block'}" style="font-size:${isHebrew ? '20px' : '15px'}">${esc(text)}</p>
      </div>
      <div class="panel-section">
        <h3>${isHebrew ? 'Translation' : 'Hebrew'}</h3>
        <p class="gloss">${esc(data.translation || 'No translation returned.')}</p>
        ${data.note ? `<p class="note">${esc(data.note)}</p>` : ''}
      </div>
      ${isHebrew ? `<div class="panel-section"><h3>Transliteration</h3><div class="trio">${trio}</div></div>` : ''}
      <div class="panel-section">
        <h3>Context</h3>
        <p class="note">${esc(contextEn || contextHe || 'No surrounding verse available.')}</p>
      </div>`;
    setPanel({ kicker: 'Selection', title: isHebrew ? 'Translation' : 'Hebrew', body });
  } catch (err) {
    setPanel({
      kicker: 'Selection',
      title: 'Translation',
      body: `<div class="error-card"><strong>Translation unavailable</strong>${esc(err.message)}</div>`,
    });
  }
}

async function translitSelection(text) {
  setPanel({ kicker: 'Selection', title: 'Transliteration', loading: true });
  try {
    const data = await api.rpc('translit', {
      text,
      style: S.style,
      divineName: S.reader ? S.reader.divineName : '',
    });
    const all = data.all || {};
    const trio = translitRows((style) => all[style] || (style === S.style ? data.out : ''));
    const body = `
      <div class="panel-section">
        <h3>Selected text</h3>
        <p class="he-block" style="font-size:20px">${esc(text)}</p>
      </div>
      <div class="panel-section">
        <h3>Transliteration</h3>
        <div class="trio">${trio}</div>
        <p class="note">Stress is not marked. Qamatz qatan and a minority of shva cases are approximated by rule.</p>
      </div>`;
    setPanel({ kicker: 'Selection', title: 'Transliteration', body });
  } catch (err) {
    setPanel({ kicker: 'Selection', title: 'Transliteration', body: `<div class="error-card">${esc(err.message)}</div>` });
  }
}

/* ------------------------------------------------------------------ settings */

function providerPreset(id) {
  return (S.info && S.info.providers && S.info.providers[id]) || {};
}

function isLocalProvider(id) {
  return Boolean(providerPreset(id).local);
}

let localCheckSeq = 0;

function fillModelChoices(target, models) {
  const list = $(target === 'setup' ? '#setup-model-list' : '#set-model-list');
  if (list) list.innerHTML = (models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
}

/**
 * Ask the service whether the chosen local provider is up and the model is
 * installed, then say what to do about it. Uses the fields as they are now, so
 * it can report on a provider the person has not saved yet.
 */
async function refreshLocalStatus(target) {
  const setup = target === 'setup';
  const providerField = $(setup ? '#setup-provider' : '#set-provider');
  const modelField = $(setup ? '#setup-model' : '#set-model');
  const statusEl = $(setup ? '#setup-local-status' : '#set-local-status');
  const checkBtn = $(setup ? '#setup-local-check' : '#set-local-check');
  if (!providerField || !statusEl) return;
  const id = providerField.value;
  if (!isLocalProvider(id)) {
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
    if (checkBtn) checkBtn.classList.add('hidden');
    return;
  }

  const token = ++localCheckSeq;
  statusEl.classList.remove('hidden');
  statusEl.className = 'local-status';
  statusEl.textContent = 'Looking for a local model server…';
  if (checkBtn) checkBtn.classList.remove('hidden');

  let status;
  try {
    status = await api.rpc('llm.status', {
      provider: id,
      model: modelField ? modelField.value.trim() : '',
    });
  } catch (err) {
    if (token !== localCheckSeq) return;
    statusEl.classList.add('err');
    statusEl.textContent = err.message;
    return;
  }
  if (token !== localCheckSeq) return;

  fillModelChoices(target, status.models);
  if (modelField && !modelField.value.trim() && status.models.length) {
    // Offer something that is actually installed rather than a preset name the
    // person would have to pull first.
    modelField.value = status.models[0];
    return refreshLocalStatus(target);
  }

  statusEl.className = 'local-status';
  statusEl.textContent = status.message;
  statusEl.classList.add(status.ready ? 'ok' : 'warn');
}

function renderProviderOptions() {
  const providers = (S.info && S.info.providers) || {};
  $('#set-provider').innerHTML = Object.entries(providers).map(([id, p]) =>
    `<option value="${esc(id)}">${esc(p.label)}</option>`).join('');
}

function fillSettings() {
  if (!S.settings) return;
  const s = S.settings;
  $('#set-provider').value = s.provider || 'openai';
  $('#set-model').value = s.model || '';
  $('#set-baseurl').value = s.baseUrl || '';
  $('#set-apikey').value = '';
  $('#set-apikey').placeholder = s.hasKey
    ? 'a key is saved — type to replace'
    : 'stored locally, encrypted when the OS supports it';
  $('#set-style').value = s.style || 'modern';
  $('#set-font').value = s.fontSize || 20;
  $('#set-diacritics').checked = s.diacritics !== false;
  $('#set-show-translit').checked = S.showTranslit;
  $('#set-show-english').checked = S.showEnglish;
  $('#set-show-hebrew').checked = S.showHebrew;
  $('#set-page-size').value = String(S.pageSize || 0);
  if ($('#set-keepalive')) $('#set-keepalive').value = s.keepAlive != null ? String(s.keepAlive) : '15m';
  if ($('#set-numctx')) $('#set-numctx').value = String(s.numCtx || 4096);
  if ($('#set-autotranslate')) $('#set-autotranslate').checked = s.autoTranslate === true;
  updateProviderHint();
  renderStyleNotes();
  if (S.info) {
    $('#app-info').textContent = `Version ${S.info.version} · ${S.info.platform} · cache ${S.info.cacheDir}`;
  }
}

function updateProviderHint() {
  const id = $('#set-provider').value;
  const p = providerPreset(id);
  const modelField = $('#set-model');
  const urlField = $('#set-baseurl');
  if (!modelField.value) modelField.placeholder = p.model || 'model name';
  urlField.placeholder = p.baseUrl || 'https://…/v1';
  $('#set-apikey').disabled = Boolean(p.local);
  refreshLocalStatus('settings');
  if (id === 'ollama') {
    $('#set-provider-hint').innerHTML = 'Runs entirely on this machine. Start Ollama first; no API key is needed.';
  } else if (id === 'freebuff') {
    $('#set-provider-hint').innerHTML = 'Questions go through a local named pipe to your Freebuff worker. Start it with <code>npm run freebuff-fifo</code>; the path below is the pipe.';
  } else if (id === 'custom') {
    $('#set-provider-hint').innerHTML = 'Any OpenAI-compatible endpoint: base URL plus model name.';
  } else {
    $('#set-provider-hint').innerHTML = p.docs
      ? `API keys: <a href="${esc(p.docs)}" data-external>${esc(p.docs)}</a>. The key stays on this device.`
      : '';
  }
}

function renderStyleNotes() {
  const styles = (S.info && S.info.styles) || {};
  $('#style-notes').innerHTML = Object.entries(styles)
    .map(([, v]) => `<strong>${esc(v.label)}</strong> — ${esc(v.blurb)}`).join('<br>');
}

/* -------------------------------------------------------------- first run */

function setupPreset() {
  const id = $('#setup-provider').value;
  return (S.info && S.info.providers && S.info.providers[id]) || {};
}

function fillSetupProviders() {
  const providers = (S.info && S.info.providers) || {};
  $('#setup-provider').innerHTML = Object.entries(providers).map(([id, p]) =>
    `<option value="${esc(id)}">${esc(p.label)}</option>`).join('');
  const preferred = (S.settings && S.settings.provider) || 'openai';
  if (providers[preferred]) $('#setup-provider').value = preferred;
  setupProviderChanged();
}

function setupProviderChanged() {
  const id = $('#setup-provider').value;
  const p = setupPreset();
  const local = Boolean(p.local);
  $('#setup-model').placeholder = p.model || 'model name';
  $('#setup-base').placeholder = p.baseUrl || 'https://…/v1';
  // Custom endpoints have no preset, so they need the URL; the Freebuff
  // provider needs to show its pipe path. Other presets can hide it.
  $('#setup-base-wrap').classList.toggle('hidden', id !== 'custom' && id !== 'freebuff' && !p.baseUrl);
  $('#setup-key').disabled = local;
  $('#setup-key').placeholder = local
    ? (id === 'freebuff' ? 'not needed for the local pipe' : 'not needed for Ollama')
    : 'paste your key';
  $('#setup-hint').textContent = id === 'freebuff'
    ? 'Questions go through a local named pipe. Start the worker with “npm run freebuff-fifo”; no key is needed.'
    : local
      ? 'Ollama runs on this machine. Start it first; no key is needed.'
      : id === 'custom'
        ? 'Any OpenAI-compatible /chat/completions endpoint: base URL, model, and key.'
        : (p.docs ? `Get a key at ${p.docs}. It is stored locally and encrypted when the OS supports it.` : '');
  refreshLocalStatus('setup');
}

function openSetup({ firstRun = false } = {}) {
  if (!S.info) return;
  S.setupFirstRun = firstRun;
  fillSetupProviders();
  $('#setup-model').value = '';
  $('#setup-base').value = '';
  $('#setup-key').value = '';
  $('#setup-status').textContent = '';
  $('#setup-status').className = 'status';
  $('#setup-skip').textContent = firstRun ? 'Skip for now' : 'Cancel';
  $('#setup-modal').classList.remove('hidden');
  setTimeout(() => $('#setup-provider').focus(), 40);
}

function closeSetup() {
  $('#setup-modal').classList.add('hidden');
}

async function saveSetup({ test = false } = {}) {
  const provider = $('#setup-provider').value;
  const preset = setupPreset();
  const key = $('#setup-key').value.trim();
  const baseUrl = $('#setup-base').value.trim();
  const model = $('#setup-model').value.trim();
  const status = $('#setup-status');
  const local = Boolean(preset.local);

  if (!local && !key) {
    status.className = 'status err';
    status.textContent = 'Paste an API key, or choose Ollama to run locally.';
    return;
  }
  if (provider === 'custom' && !baseUrl) {
    status.className = 'status err';
    status.textContent = 'A custom provider needs its base URL.';
    return;
  }

  status.className = 'status';
  status.textContent = 'Saving…';
  const patch = { provider, model, baseUrl, setupComplete: true };
  if (key) patch.apiKey = key;
  const saved = await saveSettings(patch, { quiet: true });
  if (!saved) {
    status.className = 'status err';
    status.textContent = 'Could not save the provider.';
    return;
  }
  if (S.info) S.info.needsKey = !local && !key;
  if (!test) {
    closeSetup();
    toast('AI provider saved');
    return;
  }

  status.textContent = 'Testing…';
  try {
    const res = await api.rpc('llm.test');
    status.className = 'status ok';
    status.textContent = `Connected — ${res.model} replied “${res.reply}”.`;
    setTimeout(closeSetup, 900);
  } catch (err) {
    status.className = 'status err';
    status.textContent = err.message;
  }
}

async function skipSetup() {
  await saveSettings({ setupComplete: true }, { quiet: true });
  closeSetup();
}

async function saveSettings(patch, { quiet = false } = {}) {
  try {
    S.settings = await api.rpc('settings.set', patch);
    S.style = S.settings.style || S.style;
    S.diacritics = S.settings.diacritics !== false;
    S.fontSize = S.settings.fontSize || S.fontSize;
    S.showTranslit = S.settings.showTranslit !== false;
    S.showEnglish = S.settings.showEnglish !== false;
    S.showHebrew = S.settings.showHebrew !== false;      S.showCommentaries = S.settings.showCommentaries !== false;
    S.pageSize = Number(S.settings.pageSize) || 0;
    S.autoTranslate = S.settings.autoTranslate === true;
    applyReadingSettings();
    if (S.askResult) renderAnswer(S.askResult);
    if (S.reader) renderReader();
    fillSettings();
    if (!quiet) toast('Settings saved');
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
}

function collectSettings() {
  const patch = {
    provider: $('#set-provider').value,
    model: $('#set-model').value.trim(),
    baseUrl: $('#set-baseurl').value.trim(),
    style: $('#set-style').value,
    fontSize: Number($('#set-font').value),
    diacritics: $('#set-diacritics').checked,
    keepAlive: $('#set-keepalive') ? $('#set-keepalive').value : undefined,
    numCtx: $('#set-numctx') ? Number($('#set-numctx').value) : undefined,
    autoTranslate: $('#set-autotranslate') ? $('#set-autotranslate').checked : false,
  };
  for (const k of ['keepAlive', 'numCtx']) if (patch[k] === undefined) delete patch[k];
  const key = $('#set-apikey').value.trim();
  if (key) patch.apiKey = key;
  if ($('#set-apikey').dataset.clear === '1') { patch.apiKey = ''; $('#set-apikey').dataset.clear = '0'; }
  return patch;
}

/* ------------------------------------------------------------------ recents */

function loadRecents() {
  try { return JSON.parse(localStorage.getItem('recents') || '[]'); } catch { return []; }
}

function addRecent(ref) {
  const list = loadRecents().filter((r) => r !== ref);
  list.unshift(ref);
  localStorage.setItem('recents', JSON.stringify(list.slice(0, 8)));
  renderRecents();
}

function renderRecents() {
  const list = loadRecents();
  $('#recents').innerHTML = list.length
    ? list.map((r) => `<button class="recent" data-open-ref="${esc(r)}">${esc(r)}</button>`).join('')
    : '<p class="muted small">Nothing yet.</p>';
}

/* ------------------------------------------------------------------ events */

function bindEvents() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (btn) setView(btn.dataset.view);
  });

  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    $('#theme-toggle').textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
  });

  // ask
  $('#ask-context-clear').addEventListener('click', () => {
    S.askContext = null;
    renderAskContext();
    $('#ask-input').focus();
  });
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runAsk($('#ask-input').value);
  });
  $('#category-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    S.category = chip.dataset.cat || '';
    renderCategoryChips();
    if (S.askResult) runAsk(S.askResult.question);
  });

  // search
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    goSearch($('#search-input').value);
  });
  $('#search-scope').addEventListener('change', () => {
    // Two limits at once would be ambiguous: a category clears a work.
    if ($('#search-work').value) $('#search-work').value = '';
    readSearchFilters();
    if (S.searchQuery) runSearch(S.searchQuery);
  });
  $('#search-work').addEventListener('focus', fillWorkList);
  $('#search-this-work').addEventListener('click', () => {
    if (!S.reader || !S.reader.title) return;
    $('#search-work').value = S.reader.title;
    $('#search-scope').value = '';
    readSearchFilters();
    if (S.searchQuery) runSearch(S.searchQuery);
    else $('#search-input').focus();
  });

  // reader controls
  $('#reader-go').addEventListener('click', () => openRef($('#reader-ref').value));
  $('#reader-ref').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); openRef($('#reader-ref').value); }
  });
  $('#reader-prev').addEventListener('click', () => S.reader && S.reader.prev && openRef(S.reader.prev));
  $('#reader-next').addEventListener('click', () => S.reader && S.reader.next && openRef(S.reader.next));
  $('#reader-version').addEventListener('change', (e) => {
    if (!S.reader) return;
    const title = e.target.value;
    const option = e.target.selectedOptions && e.target.selectedOptions[0];
    const language = (option && option.dataset.lang) || 'english';
    openRef(S.reader.ref, { recent: false, version: `${language}|${title}` });
  });
  $('#style-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    S.style = btn.dataset.style;
    applyReadingSettings();
    saveSettings({ style: S.style }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  $('#style-more').addEventListener('change', (e) => {
    if (!e.target.value) return;
    S.style = e.target.value;
    applyReadingSettings();
    saveSettings({ style: S.style }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  $('#tgl-translit').addEventListener('change', (e) => {
    S.showTranslit = e.target.checked;
    saveSettings({ showTranslit: S.showTranslit }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  $('#tgl-english').addEventListener('change', (e) => {
    S.showEnglish = e.target.checked;
    saveSettings({ showEnglish: S.showEnglish }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  $('#tgl-hebrew').addEventListener('change', (e) => {
    S.showHebrew = e.target.checked;
    saveSettings({ showHebrew: S.showHebrew }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  const changePageSize = (value) => {
    S.pageSize = Number(value) || 0;
    S.readerShown = S.pageSize > 0 ? S.pageSize : 0;
    applyReadingSettings();
    saveSettings({ pageSize: S.pageSize }, { quiet: true });
    if (S.reader) renderReaderBody();
  };
  $('#reader-page-size').addEventListener('change', (e) => changePageSize(e.target.value));
  $('#set-page-size').addEventListener('change', (e) => changePageSize(e.target.value));
  $('#reader-more').addEventListener('click', (e) => {
    if (!e.target.closest('#reader-show-more') || !S.reader) return;
    const total = (S.reader.rows || []).length;
    S.readerShown = Math.min(total, (S.readerShown || S.pageSize || total) + Math.max(S.pageSize, 1));
    renderReaderBody();
  });
  $('#tgl-commentaries').addEventListener('change', (e) => {
    S.showCommentaries = e.target.checked;
    saveSettings({ showCommentaries: S.showCommentaries }, { quiet: true });
    if (!S.showCommentaries) S.verseOpen = null;
    if (S.reader) renderReaderBody();
  });
  $('#set-show-translit').addEventListener('change', (e) => {
    S.showTranslit = e.target.checked;
    saveSettings({ showTranslit: S.showTranslit }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  $('#set-show-english').addEventListener('change', (e) => {
    S.showEnglish = e.target.checked;
    saveSettings({ showEnglish: S.showEnglish }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  $('#set-show-hebrew').addEventListener('change', (e) => {
    S.showHebrew = e.target.checked;
    saveSettings({ showHebrew: S.showHebrew }, { quiet: true });
    if (S.reader) renderReader();
    if (S.askResult) renderAnswer(S.askResult);
  });
  const changeFont = (delta) => {
    S.fontSize = Math.max(16, Math.min(32, S.fontSize + delta));
    applyReadingSettings();
    saveSettings({ fontSize: S.fontSize }, { quiet: true });
  };
  $('#font-up').addEventListener('click', () => changeFont(1));
  $('#font-down').addEventListener('click', () => changeFont(-1));

  // library
  let libTimer = null;
  $('#lib-filter').addEventListener('input', (e) => {
    S.libFilter = e.target.value;
    clearTimeout(libTimer);
    libTimer = setTimeout(renderLibrary, 120);
  });
  $('#lib-shelves').addEventListener('click', (e) => {
    const row = e.target.closest('[data-lib-select]');
    if (row) {
      const level = Number(row.dataset.libLevel);
      const name = row.dataset.libSelect;
      if (S.libPath[level] === name && S.libPath.length === level + 1) return;
      S.libPath = S.libPath.slice(0, level).concat(name);
      const node = libNodeAt(S.libPath);
      if (isWorkNode(node)) {
        loadLibChapters(node.title);
      } else {
        // A different shelf: the last work's chapters no longer apply.
        S.libChaptersFor = '';
        S.libChapters = null;
        S.libChapterError = '';
        renderLibrary();
      }
      renderLibraryBreadcrumb();
      return;
    }
    // A filtered work: place it on its shelf and show its chapters.
    const hit = e.target.closest('[data-lib-work]');
    if (hit) {
      const path = String(hit.dataset.libWorkPath || '').split(' › ').filter(Boolean);
      showLibraryAt([...path, hit.dataset.libWork]);
    }
  });
  $('#lib-shelves').addEventListener('change', (e) => {
    if (e.target.id !== 'lib-section') return;
    S.libSection = Number(e.target.value) || 0;
    renderShelves();
  });

  // reader chapter jump
  $('#reader-chapter').addEventListener('change', (e) => {
    const ref = e.target.value;
    if (!ref || ref === S.readerChapterRef) return;
    openRef(ref);
  });

  // word clicks
  $('#reader-text').addEventListener('click', (e) => {
    const word = e.target.closest('.word');
    if (word) {
      e.preventDefault();
      showWord(decodeURIComponent(word.dataset.word), Number(word.dataset.seg), word);
    }
  });

  // delegated refs / answers
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-ref]');
    if (open) {
      clearSelection();
      openRef(open.dataset.openRef);
      return;
    }
    const copy = e.target.closest('[data-copy-ref]');
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copyRef).then(() => toast('Citation copied'));
      return;
    }
    const example = e.target.closest('[data-example]');
    if (example) { runAsk(example.dataset.example); return; }
    const searchExample = e.target.closest('[data-search-example]');
    if (searchExample) { goSearch(searchExample.dataset.searchExample); return; }
    const searchMore = e.target.closest('[data-search-more]');
    if (searchMore) { runSearch(S.searchQuery, { append: true }); return; }
    const searchRetry = e.target.closest('[data-search-retry]');
    if (searchRetry) { runSearch(S.searchQuery); return; }
    const exOpen = e.target.closest('[data-example-open]');
    if (exOpen) { openRef(exOpen.dataset.exampleOpen); return; }
    const settingsBtn = e.target.closest('[data-open-settings]');
    if (settingsBtn) { setView('settings'); return; }
    const libRetry = e.target.closest('[data-lib-retry]');
    if (libRetry) { S.library = null; ensureLibrary(); return; }
    const libBack = e.target.closest('[data-lib-back]');
    if (libBack) { setView('library'); return; }
    const libRoot = e.target.closest('[data-lib-root]');
    if (libRoot) {
      S.libPath = [];
      S.libChaptersFor = '';
      S.libChapters = null;
      setView('library');
      renderLibrary();
      document.querySelector('.main').scrollTop = 0;
      return;
    }
    const libWorkAt = e.target.closest('[data-lib-work-at]');
    if (libWorkAt) {
      const cats = (S.reader && S.reader.categories) || [];
      showLibraryAt([...cats, libWorkAt.dataset.libWorkAt]);
      return;
    }
    const libOpen = e.target.closest('[data-lib-open]');
    if (libOpen) { openWork(libOpen.dataset.libOpen); return; }
    const libPath = e.target.closest('[data-lib-path]');
    if (libPath) {
      showLibraryAt(String(libPath.dataset.libPath || '').split(' › ').filter(Boolean));
      return;
    }
    const external = e.target.closest('[data-external]');
    if (external) {
      e.preventDefault();
      api.openExternal(external.getAttribute('href'));
    }
  });

  // context panel close
  $('#ctx-close').addEventListener('click', () => {
    $('#app').classList.add('no-context');
    $$('.he-text .word.is-active').forEach((w) => w.classList.remove('is-active'));
  });

  // selection toolbar
  $('#seltool').addEventListener('mousedown', (e) => e.preventDefault());
  $('#seltool').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !selContext) return;
    const ctx = selContext;
    $('#seltool').classList.add('hidden');
    if (btn.dataset.sel === 'translate') await translateSelection(ctx.text, ctx.contextHe, ctx.contextEn);
    if (btn.dataset.sel === 'translit') await translitSelection(ctx.text);
    if (btn.dataset.sel === 'search') {
      clearSelection();
      goSearch(ctx.text);
    }
    if (btn.dataset.sel === 'ask') {
      S.askContext = {
        text: ctx.text,
        ref: ctx.ref || '',
        contextHe: ctx.contextHe || '',
        contextEn: ctx.contextEn || '',
      };
      clearSelection();
      setView('ask');
      renderAskContext();
      $('#ask-input').value = '';
      $('#ask-input').placeholder = 'Ask a question about the selected text…';
      $('#ask-input').focus();
    }
  });
  document.addEventListener('scroll', () => $('#seltool').classList.add('hidden'), true);

  // settings
  $('#set-provider').addEventListener('change', () => {
    $('#set-model').value = '';
    $('#set-baseurl').value = '';
    updateProviderHint();
  });
  $('#set-save').addEventListener('click', async () => {
    const ok = await saveSettings(collectSettings());
    if (ok) $('#set-status').textContent = '';
  });
  $('#set-test').addEventListener('click', async () => {
    const status = $('#set-status');
    status.className = 'status';
    status.textContent = 'Saving and testing…';
    const ok = await saveSettings(collectSettings(), { quiet: true });
    if (!ok) { status.className = 'status err'; status.textContent = 'Could not save settings.'; return; }
    try {
      const res = await api.rpc('llm.test');
      status.className = 'status ok';
      status.textContent = `Connected — ${res.model} replied “${res.reply}”.`;
    } catch (err) {
      status.className = 'status err';
      status.textContent = err.message;
    }
  });
  $('#set-apikey').addEventListener('input', (e) => { $('#set-status').textContent = ''; });

  // first-run setup
  $('#setup-provider').addEventListener('change', setupProviderChanged);
  $('#setup-save').addEventListener('click', () => saveSetup());
  $('#setup-test').addEventListener('click', () => saveSetup({ test: true }));
  $('#setup-skip').addEventListener('click', skipSetup);
  $('#set-wizard').addEventListener('click', () => openSetup());
  $('#setup-key').addEventListener('input', () => { $('#setup-status').textContent = ''; });
  $('#set-local-check').addEventListener('click', () => refreshLocalStatus('settings'));
  $('#setup-local-check').addEventListener('click', () => refreshLocalStatus('setup'));

  // Local model resources: report what is loaded, and give the memory back on
  // request rather than waiting for keep_alive to expire.
  $('#set-ps').addEventListener('click', async () => {
    const out = $('#set-resource-status');
    out.textContent = 'Checking what is loaded…';
    try {
      const { models } = await api.rpc('llm.ps');
      out.textContent = models.length
        ? models.map((m) => `${m.name}: ${m.size || '?'} GB, ${m.vram ? `${Math.round((m.vram / m.size) * 100)}% in VRAM` : 'CPU'}, context ${m.contextLength || '?'}`).join(' · ')
        : 'No model is loaded right now.';
    } catch (err) {
      out.textContent = err.message;
    }
  });
  $('#set-free').addEventListener('click', async () => {
    const out = $('#set-resource-status');
    out.textContent = 'Unloading…';
    try {
      const res = await api.rpc('llm.free');
      out.textContent = res.unloaded ? `${res.model} unloaded; its memory is free until the next request.` : res.reason;
    } catch (err) {
      out.textContent = err.message;
    }
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setView('ask');
      $('#ask-input').focus();
      $('#ask-input').select();
    }
    if (e.key === 'Escape') {
      $('#seltool').classList.add('hidden');
      // Escape leaves the first-run wizard for next launch rather than
      // recording a choice the user did not make.
      if (!$('#setup-modal').classList.contains('hidden')) closeSetup();
    }
  });
}

/* ------------------------------------------------------------------ init */

async function init() {
  const theme = localStorage.getItem('theme') || 'dark';
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';


  bindEvents();
  renderRecents();
  // Progress from a running generation (drafts, phases, timings). Subscribing
  // once is enough: payloads carry the request id they belong to.
  if (api.onEvent) api.onEvent(handleAiEvent);

  try {
    const [settings, info] = await Promise.all([api.rpc('settings.get'), api.rpc('app.info')]);
    S.settings = settings;
    S.info = info;
    S.style = settings.style || 'modern';
    S.diacritics = settings.diacritics !== false;
    S.fontSize = settings.fontSize || 20;
    S.showTranslit = settings.showTranslit !== false;
    S.showEnglish = settings.showEnglish !== false;
    S.showHebrew = settings.showHebrew !== false;
    S.showCommentaries = settings.showCommentaries !== false;
    S.pageSize = Number(settings.pageSize) || 0;
    S.autoTranslate = settings.autoTranslate === true;
  } catch (err) {
    toast(`Could not reach the service layer: ${err.message}`, 'err');
  }

  applyReadingSettings();
  renderSearchScopes();
  renderCategoryChips();
  renderProviderOptions();
  fillSettings();
  renderExamples();

  // A wide window has room for the study panel; a narrow one opens it on demand.
  if (window.innerWidth >= 1200) $('#app').classList.remove('no-context');

  // First launch: no provider yet and the wizard has not been answered.
  if (S.settings && S.info && !S.settings.setupComplete && S.info.needsKey) {
    openSetup({ firstRun: true });
  }
}

init();
