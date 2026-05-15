// MyFolio — background service worker
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
//
// Proxies cross-origin fetches the content script can't make itself. In
// Manifest V3, content-script fetches obey the host page's CORS rules; the
// service worker uses the extension's own origin and (with host_permissions)
// can fetch hosts that don't return CORS headers, like Stooq.

console.log('[MyFolio SW] service worker started, build 1.4.5');

const ALLOWED_HOSTS = [/^https:\/\/(?:www\.)?stooq\.com\//i];

function isAllowed(url) {
  if (typeof url !== 'string') return false;
  return ALLOWED_HOSTS.some(re => re.test(url));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'MF_FETCH_TEXT') return false;
  const url = msg.url;
  console.log('[MyFolio SW] received fetch request:', url);
  if (!isAllowed(url)) {
    console.warn('[MyFolio SW] URL not allowed:', url);
    sendResponse({ ok: false, error: 'URL not allowed' });
    return false;
  }
  // Minimal fetch — no custom Accept header (avoids triggering a CORS
  // preflight if the server distinguishes simple vs preflighted requests).
  fetch(url, {
    method: 'GET',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-cache',
  })
    .then(async (resp) => {
      console.log('[MyFolio SW] response:', resp.status, resp.url, 'ok=', resp.ok);
      if (!resp.ok) {
        sendResponse({ ok: false, error: `HTTP ${resp.status}`, status: resp.status });
        return;
      }
      const text = await resp.text();
      console.log('[MyFolio SW] body length:', text.length);
      sendResponse({ ok: true, text, finalUrl: resp.url });
    })
    .catch((err) => {
      console.error('[MyFolio SW] fetch error:', err && err.name, err && err.message, err);
      sendResponse({ ok: false, error: String((err && err.message) || err || 'unknown fetch error'), name: err && err.name });
    });
  return true; // keep the message channel open for the async response
});

// Quick smoke test the user can trigger by sending {type:'MF_PING'} — verifies
// the SW is alive and host_permissions resolve correctly.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'MF_PING') return false;
  console.log('[MyFolio SW] ping received, running probe fetch');
  fetch('https://stooq.com/q/d/l/?s=spy.us&i=d', { method: 'GET', credentials: 'omit' })
    .then(r => sendResponse({ ok: true, status: r.status, finalUrl: r.url }))
    .catch(e => sendResponse({ ok: false, error: String(e && e.message || e), name: e && e.name }));
  return true;
});
