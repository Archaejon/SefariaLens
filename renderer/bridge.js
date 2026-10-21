'use strict';

/**
 * One interface, two hosts: the Electron preload bridge in the packaged app, and
 * a POST /rpc endpoint when the renderer is opened through tools/devserver.js.
 */
(function () {
  if (window.sefariaLens && typeof window.sefariaLens.rpc === 'function') {
    window.api = window.sefariaLens;
    if (typeof window.api.onEvent !== 'function') window.api.onEvent = () => () => {};
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
    // Server-sent events over the harness: the same payloads the desktop app
    // sends over IPC, so streaming works in the browser too.
    onEvent: (cb) => {
      if (typeof EventSource === 'undefined') return () => {};
      const source = new EventSource('/events');
      source.onmessage = (event) => {
        try { cb(JSON.parse(event.data)); } catch { /* keep listening */ }
      };
      return () => source.close();
    },
  };
})();
