// MyFolio — Chrome extension page-context interceptor
// Copyright (c) 2026 JJJJJ Enterprises, LLC. All rights reserved.
// Licensed under the MyFolio Proprietary Software License (see LICENSE).
//
// Injected at document_start in MAIN world to intercept all network calls.
// Posts every request/response to the content script via window.postMessage.
// Captured data stays in the browser and is never transmitted to any server.

(function () {
  if (window.__lplCapture) return;
  window.__lplCapture = true;

  // ── Fetch interception ──────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
    let response;
    try {
      response = await _fetch(...args);
    } catch (err) {
      window.postMessage({ type: 'LPL_NET', url, status: 'fetch-error', err: String(err) }, '*');
      throw err;
    }

    // Always report the URL so we can see everything in debug
    window.postMessage({ type: 'LPL_NET', url, status: response.status, ok: response.ok }, '*');

    // Try to read JSON body for any call that might have account data
    if (response.ok && looksLikeData(response)) {
      const clone = response.clone();
      clone.json().then(data => {
        window.postMessage({ type: 'LPL_API', url, data }, '*');
      }).catch(() => {});
    }

    return response;
  };

  // ── XHR interception ────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__lplUrl = String(url);
    this.__lplMethod = method;
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const xhr = this;
    xhr.addEventListener('load', function () {
      const url = xhr.__lplUrl || '';
      window.postMessage({ type: 'LPL_NET', url, status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300 }, '*');
      try {
        const data = JSON.parse(xhr.responseText);
        window.postMessage({ type: 'LPL_API', url, data }, '*');
      } catch (e) {}
    });
    return _send.apply(this, args);
  };

  // ── WebSocket interception ───────────────────────────────────────────────
  const _WS = window.WebSocket;
  window.WebSocket = function (url, ...rest) {
    const ws = new _WS(url, ...rest);
    window.postMessage({ type: 'LPL_WS_OPEN', url }, '*');
    ws.addEventListener('message', (event) => {
      let data = event.data;
      try { data = JSON.parse(event.data); } catch (e) {}
      window.postMessage({ type: 'LPL_WS_MSG', url, data }, '*');
    });
    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;

  function looksLikeData(response) {
    const ct = response.headers.get('content-type') || '';
    return ct.includes('json') || ct.includes('javascript');
  }
})();
