# LPL Modern Dashboard — How-To Guide

A Chrome browser extension that overlays a clean, modern dashboard on top of LPL AccountView. No separate login, no credential handling — it works with your existing browser session.

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
2. Navigate to and select the folder:
   ```
   /home/stephen-johns/github/lpl
   ```
3. The extension appears in your list as **LPL Modern Dashboard**

### Step 4 — Pin the Extension (Optional)

Click the puzzle-piece icon in Chrome's toolbar, find **LPL Modern Dashboard**, and click the pin icon so it stays visible in your toolbar.

---

## Using the Dashboard

### Opening It

1. Go to `https://accountview.lpl.com` and log in as you normally would
2. Once logged in, look for the **◆ Enhanced View** button in the bottom-right corner of the page
3. Click it to open the full-screen dashboard

Click it again (or press the **✕** button inside) to close the dashboard and return to the original LPL interface.

### Loading Your Data

The extension captures data as you navigate LPL's site. To populate all four tabs:

| Dashboard Tab | Navigate to in LPL |
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
- Color-coded type badges: Buy (green), Sell (red), Dividend (purple), Transfer (blue)
- Columns: Date, Type, Symbol, Description, Quantity, Price, Amount

### Performance
- Your portfolio returns compared side-by-side with three benchmark indexes:
  - S&P 500 (SPY)
  - Total Market (VTI)
  - Bonds (AGG)
- Time periods: YTD, 1 Year, 3 Year, 5 Year
- Green = positive return, red = negative return

---

## Troubleshooting

**The ◆ Enhanced View button doesn't appear**
- Make sure you are on `accountview.lpl.com` (the extension only runs on that domain)
- Try reloading the page after the extension is installed

**A tab shows "—" instead of values**
- LPL's API field names may differ slightly from what the extension expects
- Navigate to that section of LPL's site (e.g., the Holdings page) to trigger a fresh data load
- If it still shows "—", open Chrome DevTools → Network tab, filter by XHR/Fetch, and look for API responses containing your account data — share a sample and the field names can be added

**Data is missing after logging back in**
- Session data is not persisted between logins; navigate to each LPL page once to re-capture it

**The extension disappeared from the list**
- Chrome occasionally disables unpacked extensions after updates; return to `chrome://extensions` and click **Enable**

---

## Updating the Extension

If changes are made to the extension files:

1. Go to `chrome://extensions`
2. Find **LPL Modern Dashboard**
3. Click the circular refresh icon on the extension card
4. Reload any open LPL tabs

---

## Privacy & Security

- **No data leaves your browser.** The extension reads API responses that your browser already receives from LPL and displays them in a local overlay.
- **No credentials are stored or transmitted.** Authentication is handled entirely by LPL's own login flow.
- **No external libraries or CDNs.** The extension is 100% local — no network requests of its own.
