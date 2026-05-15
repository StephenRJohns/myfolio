# MyFolio — How-To Guide

A Chrome browser extension that overlays a clean, modern dashboard on top of your retirement account's web interface. No separate login, no credential handling — it works with your existing browser session.

> **Personal-use tool.** MyFolio was built by an individual developer for personal use and shared freely. JJJJJ Enterprises, LLC has no affiliation, partnership, agreement, sponsorship, or business relationship of any kind with the brokerage firm whose website this tool is compatible with. See [legal/DISCLAIMER.md](legal/DISCLAIMER.md) for the full no-affiliation statement.

---

## Installation

### Option A — Chrome Web Store (Recommended)

1. Visit the [MyFolio listing on the Chrome Web Store](https://chrome.google.com/webstore/detail/myfolio) and click **Add to Chrome**
2. Confirm the permission prompt
3. Click the puzzle-piece icon in Chrome's toolbar, find **MyFolio**, and click the pin icon so it stays visible in your toolbar
4. Skip to [Using the Dashboard](#using-the-dashboard) below

### Option B — Developer / Sideload Install

Use this method if you want to run MyFolio directly from source code.

#### Step 1 — Open Chrome Extensions

In Chrome, navigate to:

```
chrome://extensions
```

#### Step 2 — Enable Developer Mode

In the top-right corner of the Extensions page, toggle **Developer mode** ON.

#### Step 3 — Load the Extension

1. Click **Load unpacked**
2. Navigate to and select the folder containing MyFolio
3. The extension appears in your list as **MyFolio**

#### Step 4 — Pin the Extension (Optional)

Click the puzzle-piece icon in Chrome's toolbar, find **MyFolio**, and click the pin icon so it stays visible in your toolbar.

---

## Using the Dashboard

### Opening It

1. Go to `accountview.lpl.com` and log in as you normally would
2. Once logged in, look for the **◆ MyFolio View** button in the bottom-right corner of the page
3. Click it to open the full-screen MyFolio dashboard

Click **◆ Standard View** (the same button, now relabeled) or the **✕** button to return to the original brokerage interface.

### Loading Your Data

The extension reads data as you navigate the brokerage site. To populate all tabs:

| MyFolio Tab | Navigate to in your account |
|---|---|
| Overview | Account overview / summary page |
| Holdings | Portfolio / positions / holdings page |
| Transactions | Activity / transaction history page |
| Performance | Performance / returns page |

You only need to visit each page once per session — the data is read automatically in the background as pages load.

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
- Portfolio value over time (when your brokerage provides historical data)
- "Growth of $10,000" comparison vs. selected benchmark ETFs (data fetched from `stooq.com`)
- Period returns table (YTD / 1Y / 3Y / 5Y)

---

## Troubleshooting

**The ◆ MyFolio View button doesn't appear**
- Make sure you are on the correct account view URL (the extension only runs on that domain)
- Try reloading the page after the extension is installed

**A tab shows "—" instead of values**
- Triple-tap the Shift key to open the hidden Debug tab and use **⎘ Copy for Claude** to capture diagnostics
- Navigate to the corresponding page in your brokerage's site to trigger a fresh data load

**Data is missing after logging back in**
- Session data is not persisted between logins; navigate to each page once to re-capture it

**The extension disappeared from the list**
- Chrome occasionally disables unpacked extensions after updates; return to `chrome://extensions` and click **Enable**

---

## Updating the Extension

1. Go to `chrome://extensions`
2. Find **MyFolio**
3. Click the circular refresh icon on the extension card
4. Reload any open brokerage tabs

---

## What MyFolio Does NOT Collect

MyFolio is a strictly local-only tool. It does **not**:

- Send your name, address, phone, email, or any personal identifier anywhere
- See, store, or transmit your login credentials
- See, store, or transmit your account balances, holdings, or transactions
- Track your IP address, browser fingerprint, or device identifier
- Use analytics, telemetry, error reporting, or crash reporting
- Set any cookies of its own
- Maintain a user database or any record about you

The only outbound network requests MyFolio makes are to `stooq.com` (primary) and Yahoo Finance (`query1/2.finance.yahoo.com`, automatic fallback), public stock-data providers, to fetch benchmark ETF price history for the comparison charts. Only the ticker symbol and date range are sent — no personal data.

See [legal/PRIVACY.md](legal/PRIVACY.md) for the full privacy policy.
