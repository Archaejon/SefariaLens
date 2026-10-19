'use strict';

/**
 * One interface, two hosts: the Electron preload bridge in the packaged app, and
 * a POST /rpc endpoint when the renderer is opened through tools/devserver.js.
 */
(function () {
  if (window.sefariaLens && typeof window.sefariaLens.rpc === 'function') {
    window.api = window.sefariaLens;
    return;
  }
  window.api = {
    isDesktop: false,
    platform: 'browser',
    rpc: async (method, params) => {
      const res = await fetch('/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params: params || {} }),
      });
      if (!res.ok) {
        const err = new Error(`Request failed (${res.status})`);
        err.code = 'HTTP';
        throw err;
      }
      const json = await res.json();
      if (!json.ok) {
        const err = new Error((json.error && json.error.message) || 'Request failed');
        err.code = (json.error && json.error.code) || 'ERROR';
        throw err;
      }
      return json.data;
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
  };
})();
