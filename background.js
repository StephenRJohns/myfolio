// MyFolio — background service worker
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
//
// Proxies cross-origin fetches the content script can't make itself. In
// Manifest V3, content-script fetches obey the host page's CORS rules; the
// service worker uses the extension's own origin and (with host_permissions)
// can fetch hosts that don't return CORS headers, like Stooq.
//
// Uses chrome.runtime.connect ports because sendMessage-based RPC can fail
// silently when the service worker is suspended mid-fetch — ports explicitly
// keep the worker alive while the port is open.

console.log('[MyFolio SW] service worker started, build 1.6.0');

const ALLOWED_HOSTS = [
  /^https:\/\/(?:www\.)?stooq\.com\//i,
  /^https:\/\/query[12]\.finance\.yahoo\.com\//i,
];

function isAllowed(url) {
  if (typeof url !== 'string') return false;
  return ALLOWED_HOSTS.some(re => re.test(url));
}

// Defensive port.postMessage — the content script may have disconnected the
// port (timeout, success, navigation) before our fetch resolves. Without
// this, the SW raises "Attempting to use a disconnected port object" which
// surfaces in the chrome://extensions errors page.
function safePost(port, msg) {
  try { port.postMessage(msg); }
  catch (e) { console.log('[MyFolio SW] (port already closed, dropping response)'); }
}

// Port-based fetch proxy. While a port is connected, Chrome keeps the SW
// alive — fetches can take seconds without risk of premature termination.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mf-fetch') return;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    console.log('[MyFolio SW] port closed');
  });
  console.log('[MyFolio SW] port opened');
  port.onMessage.addListener(async (msg) => {
    const { id, type, url } = msg || {};
    if (type !== 'fetch') return;
    console.log('[MyFolio SW] fetch request:', id, url);
    if (!isAllowed(url)) {
      safePost(port, { id, ok: false, error: 'URL not allowed' });
      return;
    }
    try {
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-cache',
      });
      if (disconnected) return;
      console.log('[MyFolio SW] response:', resp.status, resp.url, 'ok=', resp.ok);
      if (!resp.ok) {
        safePost(port, { id, ok: false, error: `HTTP ${resp.status}`, status: resp.status });
        return;
      }
      const text = await resp.text();
      if (disconnected) return;
      console.log('[MyFolio SW] body length:', text.length);
      safePost(port, { id, ok: true, text, finalUrl: resp.url });
    } catch (err) {
      // Use console.warn rather than console.error — many of these are
      // expected (e.g. Stooq blocked on this network, with Yahoo fallback
      // handling the actual result) and console.error surfaces a red
      // banner on the chrome://extensions errors page.
      console.warn('[MyFolio SW] fetch failed:', err && err.name, err && err.message);
      safePost(port, { id, ok: false, error: String((err && err.message) || err || 'unknown'), name: err && err.name });
    }
  });
});

// Legacy MF_FETCH_TEXT / MF_PING sendMessage handlers retained for back-compat
// while content scripts roll forward to ports.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== 'MF_FETCH_TEXT' && msg.type !== 'MF_PING')) return false;
  const url = msg.type === 'MF_PING' ? 'https://stooq.com/q/d/l/?s=spy.us&i=d' : msg.url;
  console.log('[MyFolio SW] sendMessage:', msg.type, url);
  if (!isAllowed(url)) {
    sendResponse({ ok: false, error: 'URL not allowed' });
    return false;
  }
  fetch(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache' })
    .then(async (resp) => {
      if (!resp.ok) { sendResponse({ ok: false, error: `HTTP ${resp.status}`, status: resp.status }); return; }
      const text = await resp.text();
      sendResponse({ ok: true, text, finalUrl: resp.url });
    })
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});
