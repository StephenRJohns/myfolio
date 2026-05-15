# MyFolio — How-To Guide

A Chrome browser extension that overlays a clean, modern dashboard on top of LPL AccountView. No separate login, no credential handling — it works with your existing browser session.

> **Unofficial.** MyFolio is not affiliated with, endorsed by, or sponsored by LPL Financial LLC. "LPL", "LPL Financial", and "AccountView" are trademarks of LPL Financial LLC.

---

## Installation

### Step 1 — Open Chrome Extensions

In Chrome, navigate to:

```
chrome://extensions
```

### Step 2 — Enable Developer Mode

In the top-right corner of the Extensions page, toggle **Developer mode** ON.

### Step 3 — Load the Extension

1. Click **Load unpacked**
2. Navigate to and select the folder containing MyFolio
3. The extension appears in your list as **MyFolio**

### Step 4 — Pin the Extension (Optional)

Click the puzzle-piece icon in Chrome's toolbar, find **MyFolio**, and click the pin icon so it stays visible in your toolbar.

---

## Using the Dashboard

### Opening It

1. Go to `https://accountview.lpl.com` and log in as you normally would
2. Once logged in, look for the **◆ MyFolio View** button in the bottom-right corner of the page
3. Click it to open the full-screen MyFolio dashboard

Click **◆ Standard View** (the same button, now relabeled) or the **✕** button to return to the original LPL interface.

### Loading Your Data

The extension captures data as you navigate LPL's site. To populate all tabs:

| MyFolio Tab | Navigate to in LPL |
|---|---|
| Overview | Account overview / summary page |
| Holdings | Portfolio / positions / holdings page |
| Transactions | Activity / transaction history page |
| Performance | Performance / returns page |

You only need to visit each page once per session — the data is captured automatically in the background as pages load.

---

## Dashboard Tabs

### Overview
- Total portfolio value with today's dollar and percent change
- YTD return (if your performance page has been visited)
- Individual account cards showing value, daily change, and unrealized gain/loss
- Allocation donut chart (once holdings data is loaded)

### Holdings
- Full positions table sorted by value, largest first
- Columns: Symbol, Name, Quantity, Price, Market Value, Allocation %, Gain/Loss, G/L %
- Allocation donut chart broken out by asset class or top holdings

### Transactions
- Chronological activity list, most recent first
- Color-coded type badges
- Columns: Date, Type, Symbol, Description, Quantity, Price, Amount

### Performance
- Portfolio value over time (when LPL has historical data available)
- Benchmark comparison vs. ETFs you select (data fetched from public sources)

---

## Troubleshooting

**The ◆ MyFolio View button doesn't appear**
- Make sure you are on `accountview.lpl.com` (the extension only runs on that domain)
- Try reloading the page after the extension is installed

**A tab shows "—" instead of values**
- Triple-tap the Shift key to open the hidden Debug tab and use **⎘ Copy for Claude** to capture diagnostics
- Navigate to the corresponding LPL page to trigger a fresh data load

**Data is missing after logging back in**
- Session data is not persisted between logins; navigate to each LPL page once to re-capture it

**The extension disappeared from the list**
- Chrome occasionally disables unpacked extensions after updates; return to `chrome://extensions` and click **Enable**

---

## Updating the Extension

If changes are made to the extension files:

1. Go to `chrome://extensions`
2. Find **MyFolio**
3. Click the circular refresh icon on the extension card
4. Reload any open LPL tabs

---

## Privacy & Security

- **No personal data leaves your browser.** The extension reads API responses that your browser already receives from LPL and displays them in a local overlay.
- **No credentials are stored or transmitted.** Authentication is handled entirely by LPL's own login flow.
- **External data**: When the Performance tab fetches benchmark comparisons, MyFolio requests public ETF price history from `stooq.com`. No personal data is sent — only the benchmark ticker symbols (e.g., SPY, VTI, AGG).
- See [legal/PRIVACY.md](legal/PRIVACY.md) for the full privacy policy.
