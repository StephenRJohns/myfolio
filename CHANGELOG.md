# Changelog

All notable changes to MyFolio will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
