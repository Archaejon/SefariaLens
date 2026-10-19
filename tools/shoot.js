'use strict';

/**
 * Screenshot harness: loads the dev server in an offscreen Electron window,
 * runs a scenario, and writes PNGs. Used to verify rendering without relying on
 * the chat preview surface.
 *
 * Usage: electron tools/shoot.js <baseUrl> <outDir>
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:4174';
const OUT = process.argv[3] || path.join(__dirname, '..', 'screenshots');

console.log('shoot start', process.argv.slice(2).join(' '));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, img.toPNG());
  console.log('wrote', file);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(10);

  await win.loadURL(`${BASE}/`);
  await sleep(1200);
  await win.webContents.executeJavaScript(`
    localStorage.setItem('theme', 'dark');
    document.documentElement.dataset.theme = 'dark';
    document.querySelector('#theme-toggle').textContent = 'Light mode';
  `);
  await sleep(300);

  await shot(win, '06-answer-empty.png');

  // Ask a question end to end.
  await win.webContents.executeJavaScript(`
    (() => {
      const i = document.querySelector('#ask-input');
      i.value = 'How do the sources understand love your neighbor as yourself?';
      document.querySelector('#ask-form').requestSubmit();
    })()
  `);
  for (let i = 0; i < 40; i++) {
    const done = await win.webContents.executeJavaScript('Boolean(document.querySelector(".answer-card"))');
    if (done) break;
    await sleep(500);
  }
  await sleep(700);
  await shot(win, '06-answer.png');

  // Reader with transliteration.
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#nav [data-view="reader"]').click();
      const r = document.querySelector('#reader-ref');
      r.value = 'Genesis 1:1-3';
      document.querySelector('#reader-go').click();
    })()
  `);
  for (let i = 0; i < 40; i++) {
    const done = await win.webContents.executeJavaScript('document.querySelectorAll(".segment").length > 0');
    if (done) break;
    await sleep(500);
  }
  await win.webContents.executeJavaScript(`document.querySelector('#style-seg [data-style="modern"]').click()`);
  await sleep(700);
  await shot(win, '07-reader.png');

  // Mizrahi marks: begedkefet fricatives and emphatics.
  await win.webContents.executeJavaScript(`document.querySelector('#style-seg [data-style="mizrahi"]').click()`);
  await sleep(600);
  await shot(win, '07b-reader-mizrahi.png');

  // Switch English edition from the same picker Sefaria offers.
  const versions = await win.webContents.executeJavaScript(
    "(() => { const s = document.querySelector('#reader-version'); return s ? s.options.length : 0; })()");
  console.log('versions in picker', versions);
  if (versions > 2) {
    await win.webContents.executeJavaScript(`
      (() => {
        const s = document.querySelector('#reader-version');
        s.selectedIndex = 2;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(2000);
    await shot(win, '07c-version-switch.png');
    await win.webContents.executeJavaScript(`document.querySelector('#style-seg [data-style="modern"]').click()`);
    await sleep(500);
  }

  // Word panel.
  await win.webContents.executeJavaScript(`
    document.querySelector('.segment:first-child .word').click()
  `);
  await sleep(2500);
  await shot(win, '08-word.png');

  // Selection toolbar + transliteration panel.
  await win.webContents.executeJavaScript(`
    (() => {
      const words = [...document.querySelectorAll('.segment:first-child .word')].slice(0, 3);
      const range = document.createRange();
      range.setStartBefore(words[0]);
      range.setEndAfter(words[2]);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()
  `);
  await sleep(600);
  await shot(win, '09-selection.png');

  await win.webContents.executeJavaScript(`document.querySelector('#seltool [data-sel="translit"]').click()`);
  await sleep(1200);
  await shot(win, '10-selection-translit.png');

  // Settings.
  await win.webContents.executeJavaScript(`document.querySelector('#nav [data-view="settings"]').click()`);
  await sleep(600);
  await shot(win, '11-settings.png');

  // Library tree.
  await win.webContents.executeJavaScript(`document.querySelector('#nav [data-view="library"]').click()`);
  for (let i = 0; i < 60; i++) {
    const ready = await win.webContents.executeJavaScript('document.querySelectorAll(".lib-row").length > 5');
    if (ready) break;
    await sleep(500);
  }
  await sleep(500);
  await shot(win, '13-library.png');

  await win.webContents.executeJavaScript(`
    (() => {
      const tanakh = [...document.querySelectorAll('[data-lib-toggle]')].find((b) => b.textContent.includes('Tanakh'));
      if (tanakh) tanakh.click();
    })()
  `);
  await sleep(500);
  await win.webContents.executeJavaScript(`
    (() => {
      const torah = [...document.querySelectorAll('[data-lib-toggle]')].find((b) => b.textContent.includes('Torah'));
      if (torah) torah.click();
    })()
  `);
  await sleep(500);
  await shot(win, '14-library-expanded.png');

  await win.webContents.executeJavaScript(`
    (() => {
      const filter = document.querySelector('#lib-filter');
      filter.value = 'Berakhot';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(700);
  await shot(win, '15-library-filter.png');

  // Open a work with no published English to show the AI translation path.
  await win.webContents.executeJavaScript(`
    (() => {
      const filter = document.querySelector('#lib-filter');
      filter.value = 'Machzor Rosh Hashanah Sefard';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(700);
  await win.webContents.executeJavaScript(`document.querySelector('[data-lib-work]').click()`);
  for (let i = 0; i < 40; i++) {
    const done = await win.webContents.executeJavaScript('document.querySelectorAll(".segment").length > 0');
    if (done) break;
    await sleep(500);
  }
  await sleep(600);
  await shot(win, '16-machine-translation.png');

  // Light theme.
  await win.webContents.executeJavaScript(`
    getSelection().removeAllRanges();
    document.querySelector('#theme-toggle').click();
    document.querySelector('#nav [data-view="reader"]').click();
  `);
  await sleep(800);
  await shot(win, '12-reader-light.png');

  app.quit();
}).catch((err) => {
  console.error('shoot failed', err);
  app.exit(1);
});
