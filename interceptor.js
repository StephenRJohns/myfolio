// MyFolio — Chrome extension page-context interceptor
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
//
// Injected at document_start in MAIN world to passively observe network
// responses the page already makes. Posts request/response metadata to the
// content script via window.postMessage (restricted to the page's own
// origin). Captured data stays in the browser and is never transmitted to
// any server.

(function () {
  if (window.__mfCapture) return;
  window.__mfCapture = true;

  const ORIGIN = window.location.origin;

  function looksLikeJson(contentType) {
    if (!contentType) return false;
    return contentType.includes('json') || contentType.includes('javascript');
  }

  // ── Fetch interception ──────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init, ...rest) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    const method = ((init?.method) || 'GET').toUpperCase();
    const reqBody = (method !== 'GET' && method !== 'HEAD') ? (init?.body ?? null) : null;
    let response;
    try {
      response = await _fetch(input, init, ...rest);
    } catch (err) {
      window.postMessage({ type: 'MF_NET', url, status: 'fetch-error', err: String(err) }, ORIGIN);
      throw err;
    }

    window.postMessage({ type: 'MF_NET', url, status: response.status, ok: response.ok }, ORIGIN);

    if (response.ok && looksLikeJson(response.headers.get('content-type'))) {
      const clone = response.clone();
      clone.json().then(data => {
        window.postMessage({ type: 'MF_API', url, method, reqBody, data }, ORIGIN);
      }).catch(() => {});
    }

    return response;
  };

  // ── XHR interception ────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mfUrl = String(url);
    this.__mfMethod = (method || 'GET').toUpperCase();
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body, ...rest) {
    this.__mfBody = (this.__mfMethod !== 'GET' && this.__mfMethod !== 'HEAD') ? (body || null) : null;
    const xhr = this;
    xhr.addEventListener('load', function () {
      const url = xhr.__mfUrl || '';
      const method = xhr.__mfMethod || 'GET';
      window.postMessage({ type: 'MF_NET', url, status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300 }, ORIGIN);
      const ct = xhr.getResponseHeader && xhr.getResponseHeader('content-type');
      if (!looksLikeJson(ct)) return;
      try {
        const data = JSON.parse(xhr.responseText);
        window.postMessage({ type: 'MF_API', url, method, reqBody: xhr.__mfBody, data }, ORIGIN);
      } catch (e) {}
    });
    return _send.call(this, body, ...rest);
  };

  // ── WebSocket interception ───────────────────────────────────────────────
  const _WS = window.WebSocket;
  window.WebSocket = function (url, ...rest) {
    const ws = new _WS(url, ...rest);
    window.postMessage({ type: 'MF_WS_OPEN', url }, ORIGIN);
    ws.addEventListener('message', (event) => {
      let data = event.data;
      try { data = JSON.parse(event.data); } catch (e) {}
      window.postMessage({ type: 'MF_WS_MSG', url, data }, ORIGIN);
    });
    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;
})();
