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
});
