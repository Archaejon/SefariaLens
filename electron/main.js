'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createService } = require('../src/service.js');

// Headless verification hook for the packaged binary: SEFARIA_LENS_SMOKE=1
const SMOKE = process.env.SEFARIA_LENS_SMOKE === '1';
// Test hook: run against a throwaway profile, so the first-run wizard can be
// exercised without touching the real settings. The smoke test writes to the
// notebook, so it never runs against a real profile: without an explicit
// folder it gets a fresh temporary one.
const profileDir = process.env.SEFARIA_LENS_USER_DATA
  || (SMOKE ? fs.mkdtempSync(path.join(os.tmpdir(), 'sefaria-lens-smoke-')) : '');
if (profileDir) {
  try { app.setPath('userData', profileDir); } catch { /* keep default */ }
}

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

  if (SMOKE) require('./smoke.js').attachSmoke(mainWindow, () => service);

  // A reload or a navigation tears down the page that was waiting for an
  // answer. Stop the model instead of letting it finish into nothing.
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) service.abortAll();
  });
  mainWindow.on('closed', () => { service.abortAll(); mainWindow = null; });

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
      const data = await service.call(method, params, {
        emit: (payload) => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send('event', payload);
        },
      });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: { message: err.message, code: err.code || 'ERROR' } };
    }
  });

  ipcMain.handle('open-external', (_event, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  });

  // The page can only offer text and a suggested name; where it goes is
  // whatever the person chooses in the dialog, and nothing is written if they
  // cancel.
  ipcMain.handle('save-file', async (_event, file) => {
    const content = file && typeof file.content === 'string' ? file.content : null;
    if (content === null || content.length > 20 * 1024 * 1024) return { saved: false };
    const name = path.basename(String((file && file.name) || '')).replace(/[^\w.\- ]/g, '_') || 'notebook.md';
    const choice = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (choice.canceled || !choice.filePath) return { saved: false };
    await fs.promises.writeFile(choice.filePath, content, 'utf8');
    return { saved: true, path: choice.filePath };
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
