'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createService } = require('../src/service.js');

// Headless verification hook for the packaged binary: SEFARIA_LENS_SMOKE=1
const SMOKE = process.env.SEFARIA_LENS_SMOKE === '1';
// Test hook: run against a throwaway profile, so the first-run wizard can be
// exercised without touching the real settings.
if (process.env.SEFARIA_LENS_USER_DATA) {
  try { app.setPath('userData', process.env.SEFARIA_LENS_USER_DATA); } catch { /* keep default */ }
}

const isDev = !app.isPackaged;
let service = null;
let mainWindow = null;

function buildService() {
  const encrypt = (value) => {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return `enc:${safeStorage.encryptString(value).toString('base64')}`;
      }
    } catch { /* fall through to plain storage */ }
    return value;
  };
  const decrypt = (value) => {
    if (typeof value === 'string' && value.startsWith('enc:')) {
      try {
        return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      } catch { return ''; }
    }
    return value;
  };
  return createService({
    appDataDir: app.getPath('userData'),
    version: app.getVersion(),
    platform: process.platform,
    encrypt,
    decrypt,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#14110d',
    title: 'Sefaria Lens',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { if (!SMOKE) mainWindow.show(); });

  if (SMOKE) {
    const consoleErrors = [];
    mainWindow.webContents.on('console-message', (...args) => {
      const level = typeof args[1] === 'object' ? args[1].level : args[1];
      const message = typeof args[1] === 'object' ? args[1].message : args[2];
      if (level === 'error' || level === 3 || level === 2) consoleErrors.push(String(message).slice(0, 200));
    });

    mainWindow.webContents.once('did-finish-load', async () => {
      const result = { ok: false };
      let step = 'start';
      try {
        const info = await service.call('app.info');
        const uiReady = await mainWindow.webContents.executeJavaScript(
          'Boolean(document.querySelector("#ask-input") && document.querySelector("#reader-ref"))');
        // First launch with no key: the wizard must appear, and skipping it must
        // leave the reader usable.
        const setupShown = await mainWindow.webContents.executeJavaScript(
          '!document.querySelector("#setup-modal").classList.contains("hidden")');
        if (setupShown) {
          await mainWindow.webContents.executeJavaScript(
            'document.querySelector("#setup-skip").click()');
          await new Promise((r) => setTimeout(r, 800));
        }
        const setupDismissed = await mainWindow.webContents.executeJavaScript(
          'document.querySelector("#setup-modal").classList.contains("hidden")');
        const text = await service.call('text', { ref: 'Genesis 1:3' });
        const pointed = await service.call('text', { ref: 'Genesis 1:1' });
        const toc = await service.call('library.toc');
        const opened = await service.call('library.open', { title: 'Genesis' });
        // A translation Sefaria files as "en" but tags with another language must
        // still load: this is the German/Russian/Portuguese picker path.
        const berakhot = await service.call('text', { ref: 'Berakhot 2a' });
        const foreignVersion = (berakhot.versionOptions || []).find((v) => v.language !== 'english');
        let foreignVersionOk = null;
        if (foreignVersion) {
          const translated = await service.call('text', {
            ref: 'Berakhot 2a',
            version: `${foreignVersion.language}|${foreignVersion.title}`,
          });
          foreignVersionOk = translated.versionLanguage === foreignVersion.language
            && translated.rows.some((r) => r.en && r.en.trim());
        }

        // Exercise the renderer too: open the verse and inspect a rendered word.
        step = 'reader-open';
        await mainWindow.webContents.executeJavaScript(`
          document.querySelector('#nav [data-view="reader"]').click();
          document.querySelector('#reader-ref').value = 'Genesis 1:3';
          document.querySelector('#reader-go').click();
        `);
        await new Promise((r) => setTimeout(r, 2500));
        const wordLength = await mainWindow.webContents.executeJavaScript(
          '(() => { const w = document.querySelector(".word"); return w ? w.textContent.length : 0; })()');

        // Choosing a non-English translation must actually change the page:
        // the picker sends its language, the reader shows that text, and the
        // header carries the language pill.
        step = 'translation-ui';
        await mainWindow.webContents.executeJavaScript(`
          document.querySelector('#reader-ref').value = 'Genesis 1:1';
          document.querySelector('#reader-go').click();
        `);
        await new Promise((r) => setTimeout(r, 2500));
        const translationUi = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const sel = document.querySelector('#reader-version');
            const before = document.querySelector('#reader-text').innerText;
            const opt = [...sel.options].find((o) => o.dataset.lang && o.dataset.lang !== 'english');
            if (!opt) return JSON.stringify({ lang: '', changed: false });
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            const want = opt.textContent.split(' — ').pop();
            const t0 = Date.now();
            while (Date.now() - t0 < 9000) {
              const pill = document.querySelector('#reader-meta .pill');
              if (pill && pill.textContent === want) break;
              await new Promise((r) => setTimeout(r, 200));
            }
            const after = document.querySelector('#reader-text').innerText;
            const pill = document.querySelector('#reader-meta .pill');
            return JSON.stringify({
              lang: opt.dataset.lang,
              changed: after.trim() !== before.trim(),
              length: after.trim().length,
              pill: pill ? pill.textContent : '',
            });
          })()`);
        const translation = JSON.parse(translationUi);

        // Per-verse commentary: every verse carries its own chooser, limited to
        // the works Sefaria links to that verse, and the chosen commentary
        // renders under that verse alone.
        await mainWindow.webContents.executeJavaScript(`
          document.querySelector('#reader-ref').value = 'Genesis 1:1-3';
          document.querySelector('#reader-go').click();
        `);
        let commentaryButtons = 0;
        for (let i = 0; i < 60; i++) {
          commentaryButtons = await mainWindow.webContents.executeJavaScript(
            'document.querySelectorAll("#reader-text .seg-comm-btn").length');
          if (commentaryButtons) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const verseOnlyBarHidden = await mainWindow.webContents.executeJavaScript(
          'document.querySelector("#reader-commentaries").classList.contains("hidden")');
        step = 'verse-commentaries-open';
        await mainWindow.webContents.executeJavaScript(
          `document.querySelector('#reader-text [data-vc-open="1"]')?.click()`);
        let verseChips = 0;
        for (let i = 0; i < 60; i++) {
          verseChips = await mainWindow.webContents.executeJavaScript(
            'document.querySelectorAll("[data-vc-work][data-vc-index=\\"1\\"]").length');
          if (verseChips) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        const versePanel = await mainWindow.webContents.executeJavaScript(`
          (() => {
            const panel = document.querySelector('.vc-panel');
            const chips = [...document.querySelectorAll('[data-vc-work][data-vc-index="1"]')].slice(0, 4)
              .map((c) => c.dataset.vcWork);
            return JSON.stringify({
              heading: panel ? panel.textContent.replace(/\\s+/g, ' ').slice(0, 150) : '',
              chips,
              otherVerseChips: document.querySelectorAll('[data-vc-work][data-vc-index="0"]').length,
            });
          })()`);
        // Distinguish a broken bridge from a broken click handler.
        step = 'bridge-probe';
        const bridgeProbe = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            try {
              const d = await window.api.rpc('commentary', { ref: 'Genesis 1:2', work: 'Ramban on Genesis', sourceRef: 'Ramban on Genesis 1:4:2' });
              return 'ok:' + ((d && d.segments) ? d.segments.length : 'no-segments');
            } catch (e) { return 'err:' + e.message; }
          })()`);
        step = 'commentary-click';
        const firstWork = await mainWindow.webContents.executeJavaScript(
          `(() => { const c = document.querySelector('[data-vc-work][data-vc-index="1"]'); if (!c) return ''; const w = c.dataset.vcWork; c.click(); return w; })()`);
        let commentaryBlocks = 0;
        for (let i = 0; i < 40; i++) {
          commentaryBlocks = await mainWindow.webContents.executeJavaScript(
            'document.querySelectorAll(".seg-commentary").length');
          if (commentaryBlocks) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        step = 'commentary-state';
        const commentaryState = await mainWindow.webContents.executeJavaScript(`
          (() => {
            const segs = [...document.querySelectorAll('.segment')];
            const idx = segs.findIndex((s) => s.querySelector('.seg-commentary'));
            const body = document.querySelector('.seg-commentary');
            const label = body ? (body.querySelector('.sc-verse') || {}).textContent || '' : '';
            return JSON.stringify({ verseIndex: idx, label, segments: segs.length });
          })()`);
        const commentaryText = await mainWindow.webContents.executeJavaScript(
          '(() => { const b = document.querySelector(".seg-commentary .sc-he"); return b ? b.textContent.length : 0; })()');
        // The whole section hides in one move, and comes back on the same passage.
        step = 'commentary-toggle';
        const commentaryHidden = await mainWindow.webContents.executeJavaScript(`
          (() => {
            const t = document.querySelector('#tgl-commentaries');
            t.checked = false;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            return document.querySelectorAll('.seg-comm-controls').length;
          })()`);
        const commentaryBack = await mainWindow.webContents.executeJavaScript(`
          (() => {
            const t = document.querySelector('#tgl-commentaries');
            t.checked = true;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            return document.querySelectorAll('.seg-comm-controls').length;
          })()`);
        // The reader's category breadcrumb returns to the library shelf.
        step = 'library-crumb';
        const crumbTarget = await mainWindow.webContents.executeJavaScript(
          `(() => { const b = document.querySelector('#reader-meta [data-lib-path]'); if (!b) return ''; const p = b.dataset.libPath; b.click(); return p; })()`);
        await new Promise((r) => setTimeout(r, 1500));
        const libraryCrumbState = await mainWindow.webContents.executeJavaScript(`
          (() => JSON.stringify({
            onLibrary: !document.querySelector('#view-library').classList.contains('hidden'),
            trail: document.querySelector('#lib-breadcrumb').textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
            crumbCount: document.querySelectorAll('#reader-meta [data-lib-path]').length,
          }))()`);

        result.version = info.version;
        result.uiReady = uiReady;
        result.setupShown = setupShown;
        result.setupDismissed = setupDismissed;
        result.rows = text.rows.length;
        result.translit = text.rows[0].translit.modern;
        result.maqafHyphen = text.rows[0].translit.modern.includes('vayhi-or');
        result.mizrahi = pointed.rows[0].translit.mizrahi;
        // Emphatic tsadi and spirantized tav must both be marked in Mizrahi.
        result.mizrahiMarks = /ṣ/.test(result.mizrahi) && /ṯ/.test(result.mizrahi);
        result.libraryCategories = toc.length;
        result.libraryOpened = opened.rows.length;
        result.renderedWordLength = wordLength;
        result.translationUi = translation;
        result.foreignVersion = foreignVersion ? foreignVersion.language : '';
        result.foreignVersionOk = foreignVersionOk;
        result.commentaryButtons = commentaryButtons;
        result.verseOnlyBarHidden = verseOnlyBarHidden;
        result.verseChips = verseChips;
        result.versePanel = versePanel;
        result.commentaryFirstWork = firstWork;
        result.bridgeProbe = bridgeProbe;
        result.commentaryBlocks = commentaryBlocks;
        result.commentaryState = commentaryState;
        result.commentaryTextLength = commentaryText;
        result.commentaryHiddenCount = commentaryHidden;
        result.commentaryBackCount = commentaryBack;
        result.crumbTarget = crumbTarget;
        result.libraryCrumbState = libraryCrumbState;
        result.rendererErrors = consoleErrors.slice(-4);
        result.ok = Boolean(uiReady) && text.rows.length > 0 && Boolean(text.rows[0].translit)
          && setupDismissed
          && result.maqafHyphen && result.mizrahiMarks && result.libraryCategories > 0
          && result.libraryOpened > 0 && wordLength > 4
          && translation.lang !== '' && translation.changed && translation.length > 100
          && translation.pill !== ''
          && foreignVersionOk !== false
          && commentaryButtons >= 3 && verseOnlyBarHidden && verseChips > 0
          && commentaryBlocks === 1 && commentaryText > 0
          && commentaryState.includes('"verseIndex":1')
          && commentaryHidden === 0 && commentaryBack === commentaryButtons
          && bridgeProbe.startsWith('ok:')
          && crumbTarget !== '' && libraryCrumbState.includes('"onLibrary":true');

      } catch (err) {
        result.error = `${step}: ${err.message}`;
      }
      try {
        const out = process.env.SEFARIA_LENS_SMOKE_OUT || path.join(os.tmpdir(), 'sefaria-lens-smoke.json');
        fs.writeFileSync(out, JSON.stringify(result));
      } catch { /* ignore */ }
      app.exit(result.ok ? 0 : 1);
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('org.sefaria.lens');
  service = buildService();

  ipcMain.handle('rpc', async (_event, method, params) => {
    try {
      const data = await service.call(method, params);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: { message: err.message, code: err.code || 'ERROR' } };
    }
  });

  ipcMain.handle('open-external', (_event, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
  ]));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
