# MyFolio

A cleaner, modern dashboard overlay for LPL AccountView. A Chrome browser extension that reads the data your browser already receives from `accountview.lpl.com` and presents it in a modern visual layout — without sending anything to any server.

> ## ⚠️ Important Notices
>
> - **MyFolio is unofficial.** It is not affiliated with, endorsed by, or sponsored by **LPL Financial LLC**. "LPL", "LPL Financial", and "AccountView" are trademarks of LPL Financial LLC.
> - **MyFolio is not investment advice.** It is a data visualization tool only. All figures may contain errors. Always verify against your official LPL statement before making any financial decision.
> - **MyFolio runs entirely in your browser.** No personal data is sent to JJJJJ Enterprises, LLC or any other server. The only outbound network requests are public ETF price fetches from `stooq.com` for benchmark comparisons.

---

## Features

- **Overview** — total portfolio value, today's $ and % change, per-account cards with unrealized gain/loss
- **Holdings** — sortable table of all positions with allocation %, gain/loss, and an allocation donut chart
- **Transactions** — recent activity in a clean, color-coded chronological table
- **Performance** — portfolio value over time, "Growth of $10,000" comparison vs. up to 10 selectable benchmark ETFs (SPY, VTI, QQQ, IWM, VXUS, AGG, TLT, TIP, VNQ, GLD), and period-return table
- **Hidden debug tab** — triple-tap Shift to reveal a network-call log with a one-click "copy for diagnostics" button

## How It Works

1. You log in to `accountview.lpl.com` normally — MyFolio doesn't touch your credentials
2. The extension intercepts the JSON API responses your browser is already receiving from LPL
3. It parses those responses into a clean data model and renders a modern dashboard as an overlay
4. The original LPL site is one click away (the toggle button switches between views)

For the Performance tab's benchmark comparisons, MyFolio fetches public ETF price history from `stooq.com` (no API key needed) and caches it locally for 24 hours.

## Installation (Development / Sideload)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Toggle **Developer mode** ON (top-right)
4. Click **Load unpacked** and select the cloned folder
5. Pin the extension via the puzzle-piece icon in your toolbar
6. Visit `accountview.lpl.com` — once you're logged in, click **◆ MyFolio View** at the bottom-right

See [HOW-TO.md](HOW-TO.md) for full instructions and troubleshooting.

## Privacy & Security

- **No backend.** There is no MyFolio server. The extension cannot read your data because there's nowhere for it to send the data to.
- **No credentials handled.** LPL's normal login flow is the only authentication path. MyFolio never sees your password, MFA codes, or session cookies.
- **No analytics.** No telemetry, no tracking, no third-party scripts.
- **One outbound call type only.** `stooq.com` is contacted only to fetch public benchmark ETF prices, and only sends a ticker symbol and date range.

See [legal/PRIVACY.md](legal/PRIVACY.md) for the full privacy policy.

## Legal

- **[LICENSE](LICENSE)** — proprietary, all rights reserved by JJJJJ Enterprises, LLC. Personal-use license; redistribution not permitted.
- **[legal/TERMS.md](legal/TERMS.md)** — Terms of Service
- **[legal/PRIVACY.md](legal/PRIVACY.md)** — Privacy Policy
- **[legal/DISCLAIMER.md](legal/DISCLAIMER.md)** — Disclaimer (no advice, no warranty, third-party marks)

## Status

MyFolio is a personal-use tool. It is offered free of charge and provided as-is. There is no commitment to ongoing development, bug fixes, or compatibility maintenance.

If LPL Financial LLC changes its website or asks us to discontinue the Service, MyFolio will be removed and existing installs will stop being supported.

## Support

Bug reports and feature requests: [GitHub Issues](https://github.com/StephenRJohns/myfolio/issues)

Other inquiries: admin@jjjjjenterprises.com

---

Copyright © 2026 JJJJJ Enterprises, LLC. All rights reserved.
