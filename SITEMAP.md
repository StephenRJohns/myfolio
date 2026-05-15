# MyFolio — Repository Map

Quick guide to what every file does.

---

## Root

| File | Purpose |
|---|---|
| `manifest.json` | Chrome extension manifest (Manifest V3) — permissions, host rules, entry points |
| `content.js` | Main content script: listens for API captures, parses brokerage data, renders the full dashboard overlay |
| `interceptor.js` | Page-context interceptor (MAIN world, document_start): monkey-patches fetch / XHR / WebSocket and forwards JSON responses to the content script via `window.postMessage` |
| `background.js` | Service worker: proxies cross-origin fetches to stooq.com and Yahoo Finance so the content script can reach them without CORS issues |
| `popup.html` | Toolbar popup UI: quick intro, "Open your account" button, disclaimer |
| `popup.js` | Popup script: opens accountview.lpl.com, populates version number |
| `style.css` | Minimal stylesheet (most UI is inline-in-JS render functions) |
| `README.md` | Project overview, feature list, installation, compatibility, legal summary |
| `HOW-TO.md` | Detailed install + usage guide with troubleshooting |
| `CHANGELOG.md` | Version history (Keep a Changelog format) |
| `LICENSE` | MIT License, Copyright © 2026 JJJJJ Enterprises, LLC |
| `NOTICE` | Additional IP / trademark notices, third-party disclosures, fork guidance |
| `SITEMAP.md` | This file |

## icons/

| File | Use |
|---|---|
| `icon16.png` | Favicon / toolbar (small) |
| `icon48.png` | Extensions page |
| `icon128.png` | Chrome Web Store listing icon |

## legal/

| File | Purpose |
|---|---|
| `TERMS.md` | Terms of Service (JJJJJ Enterprises, LLC; free/as-is; Texas law; Travis County venue) |
| `PRIVACY.md` | Privacy Policy: itemized list of what is not collected; local-only storage; Stooq + Yahoo Finance third-party disclosures |
| `DISCLAIMER.md` | Disclaimer: no LPL affiliation, no warranty, no investment advice, no liability, trademark table |

## prompts/

| File | Purpose |
|---|---|
| `rebuild.md` | Comprehensive AI prompt for reconstructing the full project from scratch |
| `store-listing.md` | Chrome Web Store listing copy (name, summary, full description, categories, notes) |
