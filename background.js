// MyFolio — background service worker
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
//
// Proxies cross-origin fetches the content script can't make itself. In
// Manifest V3, content-script fetches obey the host page's CORS rules; the
// service worker uses the extension's own origin and (with host_permissions)
// can fetch hosts that don't return CORS headers, like Stooq.

const ALLOWED_HOSTS = [/^https:\/\/(?:www\.)?stooq\.com\//i];

function isAllowed(url) {
  if (typeof url !== 'string') return false;
  return ALLOWED_HOSTS.some(re => re.test(url));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'MF_FETCH_TEXT') return false;
  const url = msg.url;
  if (!isAllowed(url)) {
    sendResponse({ ok: false, error: 'URL not allowed' });
    return false;
  }
  // Explicit options: no credentials, no referrer leak. cors mode is the
  // default but spelled out for clarity. Cache: 'no-cache' avoids stale
  // responses if Stooq returns 304s.
  fetch(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-cache',
    headers: { 'Accept': 'text/csv,text/plain,*/*' },
  })
    .then(async (resp) => {
      if (!resp.ok) {
        sendResponse({ ok: false, error: `HTTP ${resp.status}`, status: resp.status });
        return;
      }
      const text = await resp.text();
      sendResponse({ ok: true, text, finalUrl: resp.url });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: String((err && err.message) || err || 'unknown fetch error') });
    });
  return true; // keep the message channel open for the async response
});
