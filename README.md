# MyFolio

A cleaner, modern dashboard overlay for your retirement account. A Chrome browser extension built for personal use and shared freely.

> ## ⚠️ Important Notices — Read These First
>
> **Personal-use tool.** MyFolio was built by an individual developer who wanted a clearer view of their own retirement account. It was shared freely in case others might find it useful. There is no company behind it, no support team, no paid features, and no commitment to ongoing development.
>
> **No affiliation whatsoever.** JJJJJ Enterprises, LLC has **no business relationship of any kind** with LPL Financial LLC — no partnership, no agreement, no sponsorship, no employment, no contract, nothing. LPL Financial LLC did not commission, review, approve, or endorse this tool. "LPL", "LPL Financial", and "AccountView" are trademarks of LPL Financial LLC referenced solely to identify the website with which MyFolio is technically compatible (nominative fair use).
>
> **Not investment advice.** MyFolio is a data visualization tool only. Numbers shown may be wrong, stale, mis-categorized, or missing entirely. **Always verify against your official account statements before making any financial decision.** Do not make investment, tax, retirement, withdrawal, or any other decision based on data shown by MyFolio alone.
>
> **No data is collected.** MyFolio collects nothing about you. It transmits nothing to any server. There is no MyFolio backend. The developer cannot see your data because there is nowhere for the data to go. See [Privacy Policy § 2](legal/PRIVACY.md) for the full itemized list of what is not collected.
>
> **No warranty. No suitability. No liability.** The tool is provided strictly as-is, with maximum aggregate liability capped at $0.00. See [Terms § 8–9](legal/TERMS.md) and [Disclaimer § 3–4](legal/DISCLAIMER.md).

---

## What It Does

- **Overview** — total portfolio value, today's $ and % change, per-account cards with unrealized gain/loss
- **Holdings** — sortable table of all positions with allocation %, gain/loss, and an allocation donut chart
- **Transactions** — recent activity in a clean, color-coded chronological table
- **Performance** — portfolio value over time, "Growth of $10,000" comparison vs. up to 10 selectable benchmark ETFs (SPY, VTI, QQQ, IWM, VXUS, AGG, TLT, TIP, VNQ, GLD), and period-return table
- **Hidden debug tab** — triple-tap Shift to reveal a network-call log

## How It Works

1. You log in to your brokerage account normally — MyFolio doesn't touch your credentials
2. The extension reads the JSON API responses your browser is already receiving
3. It parses those responses into a clean data model and renders a modern dashboard as an overlay in your browser
4. The original site is one click away (the toggle button switches between views)

For the Performance tab's benchmark comparisons, MyFolio fetches public ETF price history from `stooq.com` (no API key needed) and caches it locally for 24 hours. Only the ticker symbol and date range are sent — no personal data.

## What It Does NOT Do

MyFolio **does not**:

- Send any data to JJJJJ Enterprises, LLC — there is no MyFolio server
- Send any data to the developer personally — there is no developer-facing log
- Access or store your login credentials, MFA codes, or session cookies
- Track your IP, browser fingerprint, or device identifier
- Use analytics, telemetry, error reporting, or crash reporting
- Set cookies of its own
- Maintain any user database, user account system, or persistent record of anything about you

See [Privacy Policy § 2](legal/PRIVACY.md) for the complete itemized list.

## Installation (Development / Sideload)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Toggle **Developer mode** ON (top-right)
4. Click **Load unpacked** and select the cloned folder
5. Pin the extension via the puzzle-piece icon in your toolbar
6. Open your brokerage account in a tab and click **◆ MyFolio View** at the bottom-right

See [HOW-TO.md](HOW-TO.md) for full instructions and troubleshooting.

## Legal

- **[LICENSE](LICENSE)** — proprietary, all rights reserved by JJJJJ Enterprises, LLC. Personal-use license; redistribution not permitted.
- **[legal/TERMS.md](legal/TERMS.md)** — Terms of Service (free, as-is, $0 liability cap)
- **[legal/PRIVACY.md](legal/PRIVACY.md)** — Privacy Policy (itemized: what is not collected)
- **[legal/DISCLAIMER.md](legal/DISCLAIMER.md)** — Disclaimer (no affiliation, no warranty, no suitability, no advice)

## Status

MyFolio is a personal-use tool offered free of charge and provided as-is. There is no commitment to ongoing development, bug fixes, support, or compatibility maintenance. If the brokerage changes its website in a way that breaks MyFolio, MyFolio may simply stop working. If LPL Financial LLC asks us to discontinue the tool, we will.

## Support (Best-Effort Only)

Bug reports and feature requests: [GitHub Issues](https://github.com/StephenRJohns/myfolio/issues)

We respond as time allows. There is no SLA. There is no commitment to address any issue.

Other inquiries: admin@jjjjjenterprises.com

---

Copyright © 2026 JJJJJ Enterprises, LLC. All rights reserved.
