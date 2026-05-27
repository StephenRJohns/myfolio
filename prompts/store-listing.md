# MyFolio — Chrome Web Store Listing Copy

Copy-paste these fields into the Chrome Web Store Developer Console when creating or updating the listing.

---

## Store Listing Fields

### Name
```
MyFolio
```

### Summary (≤ 132 characters)
```
Modern dashboard overlay for LPL AccountView — overview, holdings, transactions, performance charts. No personal data collected.
```

### Detailed Description
```
MyFolio puts a clean, modern dashboard on top of your LPL AccountView retirement or brokerage account — using data your browser already has. No extra login. No credentials. No new requests to the brokerage.

HOW IT WORKS
Log in to accountview.lpl.com as normal. Click "◆ MyFolio View" to open your dashboard. Click again to return to the standard site.

WHAT YOU GET
▸ Overview — Total portfolio value, today's change, per-account cards. Click any card to drill into a single account. Hover the Value Over Time or Account Performance Comparison chart to expand it and see a vertical crosshair tooltip with exact values for any date.
▸ Holdings — Full positions table with allocation %, gain/loss $, and gain/loss %. Sortable. Allocation donut chart.
▸ Transactions — Chronological activity with color-coded type badges.
▸ Activity — Cash flows only: deposits, withdrawals, rollovers, and transfers. Shows net contributions and one-click data loading.
▸ Performance — "Growth of $10,000" chart comparing your portfolio against benchmark ETFs (SPY, VTI, QQQ, IWM, VXUS, AGG, TLT, TIP, VNQ, GLD). Hover either chart to expand it; the Growth of $10,000 crosshair tooltip shows each line's value plus its percentage of the best performer at that date. Period returns table (YTD / 1Y / 3Y / 5Y).
▸ Custom date ranges — Pick any start/end date on the Overview chart.
▸ Debug tab — Triple-tap Shift to reveal a network-response log for troubleshooting.

PRIVACY
MyFolio collects NO personal data. Your account data never leaves your browser. The only outbound requests are optional public ETF benchmark prices from Stooq or Yahoo Finance — only the ticker symbol and date range are sent.

NOTICES
• Personal-use tool. Built by an individual developer who wanted a clearer view of their own account. Shared freely.
• JJJJJ Enterprises, LLC has NO affiliation with LPL Financial LLC — no partnership, no endorsement, no business relationship of any kind. "LPL", "LPL Financial", and "AccountView" are trademarks of LPL Financial LLC, referenced solely for compatibility identification.
• Not investment advice. Always verify figures against your official brokerage statements.
• Provided as-is with no warranty. See Terms of Service and Privacy Policy.

OPEN SOURCE
MIT License — https://github.com/StephenRJohns/myfolio
```

---

## Category & Metadata

| Field | Value |
|---|---|
| **Primary category** | Productivity |
| **Language** | English (United States) |
| **Version** | 1.6.8 |
| **Homepage URL** | https://github.com/StephenRJohns/myfolio |
| **Support URL** | https://github.com/StephenRJohns/myfolio/issues |
| **Privacy policy URL** | https://github.com/StephenRJohns/myfolio/blob/main/legal/PRIVACY.md |

---

## Permission Justifications

Fill these in when the CWS console asks "Why does your extension need this permission?"

| Permission | Justification |
|---|---|
| `storage` | Saves benchmark ticker preferences and rolling load-time samples in browser-local storage only. No external server involved. |
| `scripting` | Injects the dashboard overlay into the brokerage page so the UI can be displayed to the user. |
| `https://accountview.lpl.com/*` | The brokerage website where the extension operates. The extension reads JSON API responses the browser already receives. |
| `https://stooq.com/*`, `https://*.stooq.com/*` | Fetches public ETF price history (ticker + date range only) for optional benchmark comparison charts on the Performance tab. |
| `https://query1.finance.yahoo.com/*`, `https://query2.finance.yahoo.com/*` | Automatic fallback for ETF price history if Stooq is blocked on the user's network. Same data, same privacy posture. |

---

## Screenshots Needed

The CWS requires at least 1 screenshot (max 5). Dimensions: **1280×800** or **640×400** PNG or JPEG.

Suggested shots (take these in Chrome with the extension loaded at accountview.lpl.com):

1. **Overview tab** — Full dashboard showing portfolio total, account cards, and Value Over Time chart
2. **Holdings tab** — Positions table + allocation donut chart
3. **Performance tab** — Growth-of-$10k chart with benchmark overlays selected
4. **Transactions tab** — Activity list with color-coded badges
5. **Drill-in view** — Single-account view with "← All Accounts" breadcrumb visible

## Store Icon

Use `icons/icon128.png` (already sized correctly at 128×128).

## Promotional Tile (optional, 440×280)

A dark-background tile featuring the "◆ MyFolio" gradient logo and tagline "A cleaner view of your retirement account." Not required for submission but improves store visibility.

---

## Submission Checklist

- [ ] ZIP the extension folder (exclude `.git/`, `.claude/`, `prompts/`, `lpl/`)
- [ ] Log in to https://chrome.google.com/webstore/devconsole (one-time $5 developer fee if not already paid)
- [ ] Click **New item** → upload ZIP
- [ ] Fill in all listing fields above
- [ ] Upload at least 1 screenshot
- [ ] Set privacy policy URL
- [ ] Fill in permission justifications
- [ ] Submit for review (typically 1–3 business days)
- [ ] After approval, update `README.md` and `HOW-TO.md` with the final store URL
