// MyFolio — background service worker
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
//
// In Manifest V3, content-script fetches use the host page's origin and are
// subject to its CORS rules. Stooq does not send Access-Control-Allow-Origin
// for accountview.lpl.com, so the content-script fetch fails. The service
// worker, on the other hand, uses the extension's own origin and is granted
// cross-origin access via host_permissions. The content script proxies its
// Stooq requests through here.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'MF_FETCH_TEXT') return false;
  const url = msg.url;
  if (typeof url !== 'string' || !url.startsWith('https://stooq.com/')) {
    sendResponse({ ok: false, error: 'URL not allowed' });
    return false;
  }
  fetch(url)
    .then(async (resp) => {
      if (!resp.ok) {
        sendResponse({ ok: false, error: `HTTP ${resp.status}` });
        return;
      }
      const text = await resp.text();
      sendResponse({ ok: true, text });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    });
  return true; // keep the message channel open for the async response
});
