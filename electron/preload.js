'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sefariaLens', {
  isDesktop: true,
  platform: process.platform,
  rpc: async (method, params) => {
    const res = await ipcRenderer.invoke('rpc', method, params);
    if (!res.ok) {
      const err = new Error(res.error.message || 'Request failed');
      err.code = res.error.code || 'ERROR';
      throw err;
    }
    return res.data;
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Write text the page produced (a notebook export) to a file the person
  // picks in a Save dialog. Resolves { saved, path }.
  saveFile: (file) => ipcRenderer.invoke('save-file', file),
  // Progress from a running generation: token deltas, phase changes, timings.
  // The renderer routes them by request id, so an abandoned answer can never
  // paint over a newer one.
  onEvent: (cb) => {
    const handler = (_event, payload) => { try { cb(payload); } catch { /* a listener error is not fatal */ } };
    ipcRenderer.on('event', handler);
    return () => ipcRenderer.removeListener('event', handler);
  },
});
