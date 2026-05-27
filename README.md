# MyFolio

A cleaner, modern dashboard overlay for your LPL AccountView retirement / brokerage account. Chrome extension, free and open source under the MIT License, built for personal use.

> ## ⚠️ Important Notices — Read These First
>
> **Personal-use tool.** MyFolio was built by an individual developer who wanted a clearer view of their own account. It is shared freely in case others find it useful. The publishing entity (JJJJJ Enterprises, LLC) exists only as a legal home for the project — there is no commercial operation behind it, no support team, no paid features, and no commitment to ongoing development.
>
> **No affiliation whatsoever.** JJJJJ Enterprises, LLC has **no business relationship of any kind** with LPL Financial LLC — no partnership, agreement, sponsorship, employment, or contract. LPL Financial LLC did not commission, review, approve, or endorse this tool. "LPL", "LPL Financial", and "AccountView" are trademarks of LPL Financial LLC, referenced solely to identify the website with which MyFolio is technically compatible (nominative fair use).
>
> **Not investment advice.** MyFolio is a data-visualization tool only. Numbers shown may be wrong, stale, mis-categorized, or missing entirely. **Always verify against your official account statements before making any financial decision.** Do not make investment, tax, retirement, withdrawal, or any other decision based on data shown by MyFolio alone.
>
> **No data is collected.** MyFolio collects nothing about you. It transmits nothing to any server. There is no MyFolio backend — the developer has no way to see your data because there is nowhere for it to go. See [Privacy Policy § 2](legal/PRIVACY.md) for the full itemized list of what is not collected.
>
> **No warranty. No suitability. No liability.** The tool is provided strictly as-is. See [LICENSE](LICENSE), [Terms § 8–9](legal/TERMS.md), and [Disclaimer § 3–4](legal/DISCLAIMER.md).

---

## What It Does

- **Overview** — total portfolio value, today's $ and % change, per-account cards showing account name, last four digits of the account number, day change, and unrealized gain/loss, plus a Value Over Time chart with period tabs (All / 1Y / YTD / 1M / Custom date range). Hover either chart (Value Over Time or Account Performance Comparison) to expand it and see a vertical crosshair tooltip with exact values for any date. Closed/zero-balance accounts auto-hide.
- **Click any account card** to drill into a single account. Every tab — Overview, Holdings, Transactions, Performance, Activity — filters to just that account. A "← All Accounts" breadcrumb returns you to the full view.
- **Holdings** — sortable table of all positions with allocation %, gain/loss $ and %, and an allocation donut chart.
- **Transactions** — recent activity in a clean, color-coded chronological table.
- **Performance** — portfolio value over time and "Growth of $10,000" comparison vs. up to 10 selectable benchmark ETFs (SPY, VTI, QQQ, IWM, VXUS, AGG, TLT, TIP, VNQ, GLD), plus a period-return table (YTD, 1Y, 3Y, 5Y). Hover either chart to expand it; the Growth of $10,000 crosshair tooltip shows each line's value plus its percentage of the best performer at that date.
- **Activity** — external cash flows (deposits, withdrawals, rollovers, transfers, journal entries) with a summary bar showing Total Deposited, Total Withdrawn, and Net Contributions. Also feeds the chart reconstruction for recently-opened accounts. A "Load Activity Data" button opens the brokerage activity page in a new tab, captures the data automatically, and closes the tab — no manual navigation required.
- **Debug tab** — triple-tap Shift to reveal a network-response log. Useful for diagnosing unexpected behavior; a "⎘ Copy debug log" button packages logs for pasting into a GitHub issue or any AI assistant.

## How It Works

1. You log in to your brokerage account normally — MyFolio doesn't touch your credentials, MFA codes, or session cookies.
2. The extension reads the JSON API responses your browser is already receiving from LPL AccountView.
3. It parses those responses into a clean data model and renders a modern dashboard as an overlay in the same tab.
4. The original site is one click away — the **◆ MyFolio View** / **◆ Standard View** toggle button switches between them.

**Daily-value chart reconstruction.** When the brokerage's chart endpoint returns an empty history for a recently-opened account (e.g. one funded by a beneficiary transfer or rollover), MyFolio reconstructs the missing series by walking your captured transactions backwards from today's balance. To make that work you need to visit the brokerage's **Activity** page once — that fires the endpoint MyFolio caches. From then on the transactions persist across page loads and reconstruction runs automatically.

**Benchmark comparisons** on the Performance tab fetch public ETF price history from `stooq.com` first; if that's blocked on your network MyFolio automatically falls back to Yahoo Finance (`query1/2.finance.yahoo.com`). Both sources are cached locally for 24 hours. Only the ticker symbol and date range are sent — no personal data.

## What It Does NOT Do

MyFolio **does not**:

- Send any data to JJJJJ Enterprises, LLC — there is no MyFolio server
- Send any data to the developer personally — there is no developer-facing log
- Access or store your login credentials, MFA codes, or session cookies
- Track your IP, browser fingerprint, or device identifier
- Use analytics, telemetry, error reporting, or crash reporting
- Set cookies of its own
- Maintain any user database, account system, or persistent record of anything about you

See [Privacy Policy § 2](legal/PRIVACY.md) for the complete itemized list.

## Installation

### From the Chrome Web Store (Recommended)

1. Open the [MyFolio listing on the Chrome Web Store](https://chromewebstore.google.com/detail/myfolio/nadgcomlmnbjmehjgkjafjkecfeefaoa) and click **Add to Chrome**
2. Pin the extension via the puzzle-piece icon in your toolbar
3. Open your account at `https://accountview.lpl.com/` and click **◆ MyFolio View** at the bottom-right

### Developer / Sideload Install

If you prefer to install directly from source:

1. Clone or download this repository:
   ```
   git clone https://github.com/StephenRJohns/myfolio.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Toggle **Developer mode** ON (top-right)
4. Click **Load unpacked** and select the cloned `myfolio` folder
5. Pin the extension via the puzzle-piece icon in your toolbar
6. Open your brokerage account at `https://accountview.lpl.com/` and click **◆ MyFolio View** at the bottom-right of the page

See [HOW-TO.md](HOW-TO.md) for full instructions and troubleshooting.

## Compatibility

MyFolio currently parses the LPL AccountView (`accountview.lpl.com`) JSON API. It does not work with other brokerages without code changes. Because the brokerage's API is undocumented and may change at any time, MyFolio may break without warning. If that happens, please open a GitHub issue with a Debug-tab log so the field-name mapping can be updated.

## Legal

- **[LICENSE](LICENSE)** — MIT License. Use, copy, modify, fork, and redistribute freely. No warranty.
- **[NOTICE](NOTICE)** — Additional context: no-affiliation, trademark fair-use, third-party Terms of Service, fork obligations.
- **[legal/TERMS.md](legal/TERMS.md)** — Terms covering the official distribution by JJJJJ Enterprises, LLC (free, as-is, liability disclaimed).
- **[legal/PRIVACY.md](legal/PRIVACY.md)** — Privacy Policy (itemized list of what is not collected).
- **[legal/DISCLAIMER.md](legal/DISCLAIMER.md)** — Disclaimer (no affiliation, no warranty, no suitability, no investment advice).

MIT permits anyone to fork and modify MyFolio. The TERMS / PRIVACY / DISCLAIMER documents speak to the official distribution by JJJJJ Enterprises, LLC; forks that materially change behavior should write their own.

## Status

MyFolio is a personal-use tool offered free of charge and as-is. There is no commitment to ongoing development, bug fixes, support, or compatibility maintenance. If the brokerage changes its website in a way that breaks MyFolio, MyFolio may simply stop working. If LPL Financial LLC objects to the tool, we reserve the right to discontinue distribution.

This project is governed by Texas law; see [Terms § 14](legal/TERMS.md) for the full dispute-resolution provisions.

## Contributing

Pull requests are welcome but not guaranteed to be reviewed or merged. Bug reports are appreciated — please include:

1. What you expected to see
2. What you actually saw (a screenshot helps)
3. The contents of the Debug tab (triple-tap Shift → "⎘ Copy debug log")

## Support (Best-Effort Only)

- Bug reports and feature requests: [GitHub Issues](https://github.com/StephenRJohns/myfolio/issues)
- Other inquiries: admin@jjjjjenterprises.com

We respond as time allows. There is no SLA. There is no commitment to address any issue.

---

Copyright © 2026 JJJJJ Enterprises, LLC. Licensed under the [MIT License](LICENSE).
