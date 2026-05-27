# Changelog

All notable changes to MyFolio will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.6.4] — 2026-05-27

### Added
- **Per-account value sparklines.** Each account card on the Overview tab is now taller and shows a simple value-over-time sparkline (green if up over the available history, red if down), using the de-spiked per-account daily series.

### Changed
- Removed the redundant "Total Portfolio" card from the Accounts section — the portfolio total already appears in the KPI row at the top.

---

## [1.6.3] — 2026-05-27

### Fixed
- **Daily-value spike from rollover settlement.** LPL occasionally returns the same date twice in an account's value-over-time series, and briefly shows a rollover in two accounts mid-settlement before reversing it. Both produced a phantom spike (one day showing ~$1.17M against a ~$986k real total). Per-account series are now deduplicated by date, and the aggregate is de-spiked: any day exceeding 2× both neighbors is clamped to the higher neighbor (sustained deposit steps are preserved).
- **Growth of $10,000 chart distorted by deposits.** The daily TWR reconstruction tried to strip deposits by matching cash-flow transactions to the exact day the value stepped. Settlement lag means those rarely align, so large deposits leaked in as +180% "gains" and smaller ones as spurious losses. The chart now neutralizes any day that carries a known cash flow or an implausibly large raw move (>15%), compounding only clean market days. The line now tracks benchmarks instead of leaping or dropping at deposits.

### Added
- **Deposit / withdrawal markers** on the Portfolio Value Over Time and Growth of $10,000 charts — green up-triangles for deposits, red down-triangles for withdrawals, with a dashed guide line. Hovering any marker (including the Overview chart's existing markers) shows a tooltip with the date and dollar amount.
- **Debug log search.** A search box filters log entries live (matching message or detail) with highlighting and a match count. A "Copy matches + API calls" button copies matching entries plus any log entries that share their URL, so a parsed value and the raw API call behind it travel together.

---

## [1.6.2] — 2026-05-27

### Fixed
- **Portfolio day change was wrong after large rollovers.** The `AccountInfo` endpoint returns an incorrect `dayChange` for recently-funded/rollover accounts (e.g. showing −$253k instead of the true +$1,106). The intraday endpoint always carries the correct figure but was previously ignored when `AccountInfo` had already populated the portfolio entry. The intraday handler now always overwrites the portfolio-level `change` / `changePct` fields, regardless of arrival order.
- **Activity transaction cache expired after 24 hours**, same TTL as market data. Because the `/activity-process` endpoint is a cross-origin POST that cannot be replayed proactively from the extension context (CORS preflight fails), once the 24-hour cache expired the Growth of $10,000 chart would stop stripping contributions. Transaction history is permanent and doesn't change, so the TTL is now 7 days.

### Added
- **Stale activity data dialog.** When cached transactions are more than 24 hours old, the Overview tab now shows a modal dialog explaining the issue and offering a one-click "Load Activity Data" button. Can be dismissed for the session. An amber reminder banner also appears in the Activity tab itself.

---

## [1.6.1] — 2026-05-27

### Changed
- Extension icons replaced with a Dow Jones-style upward-trending line chart in company purple.

---

## [1.6.0] — 2026-05-16

### Added
- **Activity tab** — dedicated view for external cash flows (deposits, withdrawals, rollovers, CDW/beneficiary transfers, journal entries). Shows Total Deposited, Total Withdrawn, and Net Contributions in a summary bar; transactions grouped by calendar month.
- **One-click activity data loading** — "Load Activity Data" button (on the Activity tab and in the Overview chart flat-line warning) opens `accountview.lpl.com/web/activity?mf_auto=activity` in a new tab. The extension captures the data there, saves it, and the tab closes automatically. No manual navigation required.
- **Cross-tab live update** — `chrome.storage.onChanged` listener merges transactions captured in other tabs into the running state, re-synthesizes missing account history, and refreshes the chart without a page reload.
- **Inline flat-line warning button** — the Overview chart warning for flat-lined accounts now includes a clickable "Load Activity Data" link instead of instructing the user to navigate manually.
- Help text for the new Activity tab explaining data loading, the summary bar, and how activity data feeds the chart reconstruction.

### Changed
- Flat-line chart message is now HTML (button embedded) and no longer escaped on render.

---

## [1.5.1] — 2026-05-15

### Fixed
- Period returns (MTD/YTD/1Y) no longer ignore in-kind security transfers (CDW / beneficiary distributions). `modifiedDietzReturn` was using `txn.amount` directly, which is zero for share transfers. It now uses `cashFlowImpact()` — the same function synthesis already used — which estimates value from `quantity × price` when amount is absent.
- Growth of $10,000 chart has the same fix: `buildTwrSeries` was also using raw `amount`, so deposited shares were never stripped from the chart's growth curve.
- Both functions already had the UTC/local timezone normalization (`dayOf()`) from v1.5.0 post-release fixes; this patch completes the fix by also correcting the zero-amount skip.

### Changed
- Status bar hidden-account notice is now inline: `4 accounts (2 $0/closed hidden)` replaces the previous asterisk + footnote pattern.
- Help `?` button is amber (#f59e0b) to match the Debug tab color.

---

## [1.5.0] — 2026-05-15

### Added
- **Custom date range** on the Overview Value Over Time chart — a fifth period tab opens a start/end date popover with Apply/Cancel buttons. Supports any sub-window within captured history.
- Period tabs now always render when any daily history is present (removed the ">31 days of captured data" guard that hid them for recently-opened accounts).
- `overviewChartCustomStart`, `overviewChartCustomEnd`, `overviewChartCustomPickerOpen` state fields.

### Fixed
- UTC/local timezone mismatch in `modifiedDietzReturn` and `buildTwrSeries`: transactions timestamped in UTC (e.g. `T07:00:00.000Z`) were compared directly against local-midnight daily-value entries (`T00:00:00`), causing same-day cash flows to fall outside the period window. Both functions now use `dayOf()` calendar-day normalization, matching the pattern synthesis already used.
- Performance tab Period Returns table no longer shows all dashes when history is shorter than the full period. Brokerage-provided returns from `state.performance` are used as a fallback when Modified Dietz can't compute a value.

### Changed
- Yahoo Finance (`query1/query2.finance.yahoo.com`) added as an automatic fallback when Stooq is unreachable (VPN, corporate firewall, ad-block). All legal documents (TERMS, PRIVACY, DISCLAIMER, NOTICE) updated to disclose this second data source.
- Period Returns table extended to show 3-Year and 5-Year columns (— when history is insufficient).
- `prompts/store-listing.md` added — Chrome Web Store listing copy, permission justifications, and submission checklist.
- `prompts/rebuild.md` added — comprehensive AI rebuild prompt capturing full architecture, data flow, state schema, UI design spec, and legal requirements.
- `SITEMAP.md` added — quick reference for every file in the repository.
- README and HOW-TO updated for Chrome Web Store as primary install method, Yahoo Finance disclosure, and Custom date range feature.

---

## [1.4.0 – 1.4.19] — 2026-05-15

### Added
- **Account history reconstruction** (`synthesizeMissingAccountDailies`): when the brokerage returns no daily-value series for an account (e.g. a rollover or beneficiary account), MyFolio reconstructs the series by walking captured cash-flow transactions backwards from today's balance. Requires the user to visit the Activity page once per session.
- **Activity-history endpoint parser**: captures deposits and transfers from the brokerage's activity-process URL so reconstruction has the data it needs.
- **Proactive VoT replay**: after page load, MyFolio replays the last captured Value-Over-Time request to ensure the daily series is always populated even when the user doesn't start on the Overview page.
- **Yahoo Finance fallback** (v1.4.9): when Stooq is unreachable, benchmark price history automatically retries with `query1.finance.yahoo.com` (then `query2` if that also fails).
- Activity-history transactions persisted to `chrome.storage.local` across page reloads (v1.4.15) so the CDW/deposit data survives without revisiting the Activity page.
- `cashFlowImpact()` helper: estimates dollar value of in-kind security transfers (`quantity × current price`) when the API-level `amount` field is zero.
- Recognized new cash-flow type codes: `CDW` (custody distribution withdrawal / beneficiary share transfer), `CDI/CDIN/CDOUT`, `RECCV`, `XFRSEC` (v1.4.17).

### Changed
- `classifyPosition()` now prefers granular broker fields (`broadAssetClass`, `assetCategory`, `subAssetClass`) over the generic `investmentType` wrapper, with text-inference fallback across 8 categories when broker fields are absent.
- Allocation donut groups strictly by asset class with no top-N truncation.
- Service-worker messaging switched from one-shot `sendMessage` to a persistent `chrome.runtime.connect` port to keep the worker alive during benchmark fetches.
- `isCashFlow()` extended with additional type codes; sweep transactions excluded from cash-flow classification.
- Synthesis uses calendar-day comparison (`dayOf()`) so UTC-timestamped transactions match local-midnight daily-value entries on the same calendar date (v1.4.19).
- `mf-partial-chart` banner added when one or more accounts are flat-lined due to missing history (v1.4.3); disclosed honestly with account names and instructions.

### Fixed
- Growth of $10,000 chart legend overlapped when multiple benchmarks were selected.
- Loading overlay now displays correctly when toggling benchmarks.
- `ReferenceError: method is not defined` in the activity-history URL persistence path.
- Service-worker "disconnected port" error after a resolved fetch is silenced.
- Stooq fetch failures caused by missing `https://*.stooq.com/*` host permission (v1.4.3).
- Synthesized accounts that received zero-value daily-value entries no longer collapse the portfolio aggregate to zero (v1.4.18).
- Transaction `accountId` attribution corrected so CDW rows are associated with the receiving account (v1.4.12).
- Sweep transactions excluded from cash-flow classification to prevent spurious small-amount corrections (v1.4.10).

---

## [1.3.1] — 2026-05-15

### Added
- **Value Over Time panel** on the Overview tab: left-side stats (Starting Market Value / Deposits & Withdrawals / Investment Returns / Ending Market Value) and a canvas chart with a blue value line, orange dotted invested-capital line, `$` cash-flow markers, period tabs (All / 1Y / YTD / 1M), and a date-range label.
- Allocation donut redesigned: larger ring, new color palette (blue/slate/green/orange/purple), HTML legend table (Asset / Value / Percent) with clickable rows for asset-class filtering identical to slice clicks.
- Clickable Positions KPI card (navigates to Holdings tab).

### Fixed
- `fmtDateShort` now renders "May 14" (month+day) instead of "May 26" (month+year), eliminating spurious "future date" display on Value Over Time and Performance charts.
- Zero-balance new accounts no longer collapse the aggregate daily-value series to zero.
- MTD / 1Y / YTD KPI cards always render, showing — when data is unavailable.
- `interceptor.js` now captures request method and body for proactive VoT replay.
- `totalAccountValue` promoted to first priority in `ACCOUNT_VALUE_FIELDS` to prevent `prvDayMarketValue` from being selected by the heuristic.

---

## [1.2.0] — 2026-05-15

### Added
- **Modified Dietz period returns** — R = (EV − BV − NetFlow) / (BV + Σ Cₙ × Wₙ) — adjusts MTD/YTD/1Y for deposits, withdrawals, and transfers. Falls back to simple series-delta when transactions are unavailable. LPL's own per-account YTD (true TWR) is preferred when present.
- `parseDateLoose` defensive date parser handles ISO 8601, YYYYMMDD, MM/DD/YYYY, and other formats emitted by the brokerage.
- **Pagination** on Holdings and Transactions: page-size dropdown (10/25/50/100/All), first/prev/next/last navigation buttons (disabled at boundaries), current-page indicator.
- **Sortable columns** on all tables: click header to sort ascending; click again for descending. ▲/▼/⇅ arrows indicate active direction. Numeric columns default to descending, text columns to ascending.
- **Holdings → Transactions drill**: clicking a holdings row navigates to the Transactions tab filtered to that symbol, with a removable Symbol chip in the breadcrumb.
- **Integrated help drawer**: `?` button in the top bar opens a tab-specific help panel for Overview, Holdings, Transactions, Performance, and Debug. Every panel appends a shared glossary defining MTD, YTD, TWR, Modified Dietz, G/L, cost basis, asset class, ETF, FDIC/SIPC, rollover, IRA types, benchmarks, and more.
- Version stamp displayed next to the logo so users can verify which build is running after reloading the extension.

---

## [1.1.0] — 2026-05-15

### Added
- Click an account card on the Overview tab to drill into a single account; Overview, Holdings, Transactions, and Performance all filter to that account. A "← All Accounts" breadcrumb returns to the full view.
- Per-account daily value series captured from the `account-vot` endpoint, used for filtered Performance charts and to backfill per-account values when the account-summary payload omits them.
- Positions and transactions are tagged with their parent `accountId` during parsing to support filtering.

### Changed
- `normalizeBrokerageAccount` now tries a much wider set of value-field names (`endingMarketValue`, `currentMarketValue`, `endBalance`, `currentBalance`, `accountBalance`, `endingBalance`, `assetMarketValue`, `marketVal`, `mktVal`, `mktValue`, `acctValue`, `portfolioValue`, `endValue`, `endingValue`, `totalMarketValue`, `value`, plus nested `balance.marketValue` / `summary.*`). When no field is recognized, the debug log records the available keys.
- Repository made public on GitHub.
- License switched from proprietary to **MIT License**. Source-file headers updated to match.
- TERMS § 4 (Acceptable Use) no longer prohibits redistribution / modification; clarified that the MIT grant on the source code controls, and that the listed restrictions are obligations on users of the official distribution.
- README rewritten to describe drill-in feature, MIT license, current install path, and Debug tab workflow.

### Fixed
- Individual account cards on the Overview tab no longer render as em-dash when the LPL payload omits common `marketValue` field names; value is derived from any recognized field or backfilled from the daily-value series.
- Closed / zero-balance accounts (e.g. accounts that exist only as transfer waypoints) are hidden automatically when value, day change, and day change percentage are all zero or absent.

---

## [1.0.0] — 2026-05-15

### Added
- Initial release of MyFolio Chrome extension
- Overview tab: portfolio total value, daily change, per-account cards
- Holdings tab: positions table with sorting, allocation donut chart
- Transactions tab: recent activity with color-coded type badges
- Performance tab:
  - Portfolio value over time (when LPL provides history)
  - Growth of $10,000 chart comparing portfolio vs. selected benchmarks
  - Period returns table (YTD / 1Y / 3Y / 5Y) with real benchmark data from Stooq
  - Selectable benchmarks: SPY, VTI, QQQ, IWM, VXUS, AGG, TLT, TIP, VNQ, GLD
- Hidden debug tab — triple-tap Shift to reveal
- Status bar with live ETA based on rolling load-time average
- Modern UI with dark theme, gradient logo, smooth transitions
- Full legal documentation: LICENSE, TERMS, PRIVACY, DISCLAIMER
