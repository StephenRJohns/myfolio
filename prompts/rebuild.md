# MyFolio — AI Rebuild Prompt

Use this prompt to reconstruct MyFolio from scratch with an AI coding assistant. It captures every significant architectural, design, and legal decision.

---

## What To Build

A **Chrome extension (Manifest V3)** called **MyFolio** that overlays a clean, modern dashboard on the LPL AccountView brokerage website (`accountview.lpl.com`). The extension passively reads JSON API responses the browser already receives and displays them in a polished UI — it makes no new requests to the brokerage.

**Publisher:** JJJJJ Enterprises, LLC
**License:** MIT
**Current version:** 1.5.1
**Language:** Vanilla JavaScript (ES2020+), no build step, no npm, no bundler, no external libraries

---

## File Structure

```
myfolio/
├── manifest.json         # MV3 manifest
├── content.js            # Main content script: parses data, renders UI
├── interceptor.js        # MAIN-world interceptor: patches fetch/XHR/WS
├── background.js         # Service worker: cross-origin fetch proxy
├── popup.html            # Toolbar popup UI
├── popup.js              # Popup script
├── style.css             # Minimal stylesheet
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── legal/
│   ├── TERMS.md
│   ├── PRIVACY.md
│   └── DISCLAIMER.md
├── LICENSE               # MIT
├── NOTICE                # IP/trademark notices
├── README.md
├── HOW-TO.md
├── CHANGELOG.md
└── SITEMAP.md
```

---

## Architecture & Data Flow

### 1. Interception (interceptor.js — MAIN world)

Injected at `document_start` in the MAIN world. Monkey-patches `window.fetch`, `XMLHttpRequest`, and `WebSocket` to clone every JSON API response and forward it to the content script via `window.postMessage({ type: 'MF_API', url, method, reqBody, data }, origin)`. Posts network-status events as `{ type: 'MF_NET', url, status, ok }`.

### 2. Parsing & State (content.js — isolated world)

Listens for `MF_API` messages and identifies endpoints by URL-pattern matching:

| Pattern | Data Extracted |
|---|---|
| `account-summary`, `portfolioSummary` | Account list, balances, day changes |
| `position`, `holdings` | Holdings / positions per account |
| `transaction`, `activity` | Transaction history |
| `performance`, `value-over-time` | Period returns, daily portfolio values |
| `account-vot` | Per-account daily value series |

All parsed data is stored in a single `state` object (no framework, no reactive library):

```js
const state = {
  accounts: [],
  positions: [],
  transactions: [],
  performance: {},
  dailyValues: [],            // [{date, value}] — portfolio-level aggregate
  accountDailyValues: {},     // accountId -> [{date, value}]
  flatLinedAccounts: [],      // accounts that fell back to flat-line synthesis (set by synthesizeMissingAccountDailies)
  selectedAccountId: null,    // null = all; string = drill-in
  selectedAssetClass: null,
  selectedSymbol: null,
  activeTab: 'overview',      // 'overview' | 'holdings' | 'transactions' | 'performance' | 'debug'
  helpOpen: false,
  holdingsPage: 1, holdingsPageSize: 10,
  holdingsSort: { col: 'value', dir: 'desc' },
  txnPage: 1, txnPageSize: 10,
  txnSort: { col: 'date', dir: 'desc' },
  overviewChartPeriod: 'ytd',        // 'all' | '1y' | 'ytd' | '1m' | 'custom'
  overviewChartCustomStart: null,    // YYYY-MM-DD
  overviewChartCustomEnd: null,      // YYYY-MM-DD
  overviewChartCustomPickerOpen: false,
  overlayOpen: false,
  apiCallCount: 0,
  lastApiTime: null,
  loadStart: null,
  avgLoadMs: null,
  sessionRecorded: false,
  logs: [],                          // debug log entries (max 200)
};
```

### 3. Benchmark Fetches (background.js → content.js)

The content script opens a `chrome.runtime.connect` port named `'mf-fetch'`. The service worker holds the port open (keeping the SW alive) and proxies GET requests to:

- **Primary:** `https://stooq.com/q/d/l/?s={ticker}.us&d1={YYYYMMDD}&d2={YYYYMMDD}&i=d` — returns CSV of daily prices
- **Fallback:** `https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}?interval=1d&range=5y` (failover to query2 if query1 fails)

Results are cached in `chrome.storage.local` for 24 hours. Only the ticker symbol and date range are sent — no personal data.

Legacy `sendMessage` handlers (`MF_FETCH_TEXT`, `MF_PING`) are retained for backwards compatibility.

### 4. UI Rendering

The overlay is a single `<div id="mf-root">` injected into the page at `document_start`. All rendering is done by direct DOM manipulation — no virtual DOM, no framework. A `render()` function rebuilds the relevant subtree whenever state changes.

A `◆ MyFolio View` / `◆ Standard View` toggle button (fixed, bottom-right) controls overlay visibility.

---

## Dashboard Tabs

### Overview
- Total portfolio value (large), today's $ and % change, YTD return
- Per-account cards: account name, type badge, value, day change, unrealized G/L
- Zero-balance / closed accounts auto-hide; status bar shows inline count: `4 accounts (2 $0/closed hidden)`
- Clicking an account card enters **drill-in mode** — all tabs filter to that account; a `← All Accounts` breadcrumb returns to full view
- **Value Over Time chart** (canvas): period tabs `All | 1Y | YTD | 1M | Custom`
  - Custom period opens an inline date range picker (two `<input type="date">` fields with live preview)

### Holdings
- Sortable positions table; columns: Symbol, Name, Qty, Price, Market Value, Alloc%, G/L $, G/L%
- Default sort: market value descending; pagination (10/page)
- Allocation donut chart (canvas) — breakdown by asset class or top-N holdings

### Transactions
- Chronological activity (newest first); color-coded type badges; pagination (10/page)
- Columns: Date, Type, Symbol, Description, Qty, Price, Amount

### Performance
- Portfolio value over time chart (canvas)
- "Growth of $10,000" multi-line chart vs. up to 10 selectable benchmark ETFs: SPY, VTI, QQQ, IWM, VXUS, AGG, TLT, TIP, VNQ, GLD
- Period returns table: YTD / 1Y / 3Y / 5Y (portfolio + each benchmark)

### Debug (hidden)
- Revealed by triple-tapping the Shift key
- Scrollable log of up to 200 timestamped entries (info / ok / warn / err)
- `⎘ Copy debug log` button — formats log for GitHub issues or AI pasting

---

## Key Implementation Details

### Account Value Normalization
`normalizeBrokerageAccount` tries a wide set of field names before falling back:
`endingMarketValue`, `currentMarketValue`, `endBalance`, `currentBalance`, `accountBalance`, `endingBalance`, `assetMarketValue`, `marketVal`, `mktVal`, `mktValue`, `acctValue`, `portfolioValue`, `endValue`, `endingValue`, `totalMarketValue`, `value`, plus nested `balance.marketValue` and `summary.*`.

### History Reconstruction
When an account has no daily value history (e.g. recently opened via rollover or beneficiary transfer), `synthesizeMissingAccountDailies()` reconstructs the series by walking captured cash-flow transactions backwards from today's balance:

```
value(date) = currentValue − sum_of_cash_flows_strictly_after(date)
```

Cash-flow value is determined by `cashFlowImpact(txn)`:
- If `txn.amount` is non-zero: use it directly (positive = inflow, negative = outflow)
- If `txn.amount` is 0 (in-kind security transfer — CDW, XFRSEC, etc.): estimate as `txn.quantity × current_price` from `state.positions`

Both `modifiedDietzReturn` and `buildTwrSeries` **must also use `cashFlowImpact()`** — not raw `txn.amount` — so that security transfers with `amount=0` are correctly excluded from period returns and the Growth chart. Using `txn.amount` directly causes deposits to inflate returns.

All date comparisons use `dayOf(d) = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()` to normalize both local-midnight series entries and UTC-timestamped transactions to the same calendar day.

Reconstruction requires the user to visit the brokerage Activity page once per session. Transactions are then persisted in `cachedTransactions` so subsequent page loads don't lose the data.

### Extension Context Safety
All `chrome.*` calls are wrapped in guards that silently swallow "Extension context invalidated" errors (thrown when the extension is reloaded while a tab is still open). A global `window.addEventListener('error', ...)` sink suppresses any that escape async paths.

### Local Storage Keys
`chrome.storage.local` (extension-scoped):
- `mf_benchmark_{ticker}` — cached benchmark CSV/prices (24-hour TTL)
- `mf_avg_load_ms` / `loadTimes` — rolling load-time samples
- `cachedDailyValues`, `cachedAccountDailyValues` — persisted daily-value series (schema-versioned; cleared on version bump)
- `cachedTransactions` — persisted activity-history transactions so CDW/deposit data survives page reloads without requiring the user to revisit the Activity page
- `cachedLplProvidedIds` — account IDs that returned native history (so synthesis doesn't overwrite them)
- `activityHistoryRequest` — URL + method + body of the last activity-history request, used for proactive replay
- `cacheSchemaVersion` — integer; bumped when cache layout changes to force a clean re-fetch

`localStorage` (domain-scoped, survives extension updates):
- `mf_benchmarks` — selected benchmark tickers

---

## UI Design Spec

| Property | Value |
|---|---|
| Background | `#0f172a` (slate-900) |
| Surface | `#1e293b` (slate-800) |
| Border | `#334155` (slate-700) |
| Text primary | `#f1f5f9` |
| Text secondary | `#94a3b8` |
| Accent gradient | `#818cf8` → `#c4b5fd` (indigo-400 → violet-300) |
| Font | `system-ui, sans-serif` |
| Logo | `◆ MyFolio` with gradient fill via `-webkit-background-clip: text` |
| Charts | Pure canvas — no chart library |
| Transitions | CSS `transition: opacity 0.2s, transform 0.2s` |

---

## Permissions & Manifest

```json
{
  "manifest_version": 3,
  "name": "MyFolio",
  "version": "1.5.1",
  "description": "A cleaner, modern dashboard overlay for LPL AccountView. Personal-use tool — no personal data ever leaves your browser.",
  "homepage_url": "https://github.com/StephenRJohns/myfolio",
  "permissions": ["storage", "scripting"],
  "host_permissions": [
    "https://accountview.lpl.com/*",
    "https://stooq.com/*",
    "https://*.stooq.com/*",
    "https://query1.finance.yahoo.com/*",
    "https://query2.finance.yahoo.com/*"
  ]
}
```

**Permission justifications (for CWS submission):**
- `storage` — saves benchmark ticker preferences and rolling load-time samples locally
- `scripting` — injects the dashboard overlay into the brokerage page
- `accountview.lpl.com` — the brokerage site where the extension operates
- `stooq.com` / `yahoo.com` — public ETF price history for benchmark comparison charts

---

## Legal / IP Requirements

### Source File Headers (all .js files)
```js
// MyFolio — [description]
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
```

### In-Extension Disclosures (popup and overlay)
Every user-visible surface must make clear:
1. No affiliation with LPL Financial LLC
2. No personal data collection or transmission
3. Not investment advice
4. Verify figures against official statements

### Legal Documents
- `LICENSE` — MIT, Copyright © 2026 JJJJJ Enterprises, LLC
- `NOTICE` — Trademark fair-use notices; Stooq + Yahoo Finance disclosures; fork guidance
- `legal/TERMS.md` — ToS: free/as-is, no warranty, Texas law, Travis County venue
- `legal/PRIVACY.md` — Privacy: nothing collected; Stooq + Yahoo Finance requests documented
- `legal/DISCLAIMER.md` — No affiliation, no warranty, no investment advice, no liability, trademark table

### What Is Absolutely Prohibited
- Any analytics, telemetry, crash reporting, or error logging to any external server
- Any user account system or backend infrastructure
- Any API keys or credentials from the user
- Paid features, subscriptions, or in-app purchases
- npm dependencies, build steps, or bundled third-party libraries
- Executing remote code of any kind

---

## Contact / Distribution

- GitHub: https://github.com/StephenRJohns/myfolio
- Chrome Web Store: https://chrome.google.com/webstore/detail/myfolio
- General: admin@jjjjjenterprises.com
- Legal / IP: legal@jjjjjenterprises.com
