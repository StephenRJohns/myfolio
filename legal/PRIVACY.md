# MyFolio — Privacy Policy

**Effective date:** 2026-05-15
**Operator:** JJJJJ Enterprises, LLC ("we", "us", "our")
**Service:** MyFolio, a Chrome browser extension (the "Service")

This Privacy Policy explains what data the Service does (and does not) access, use, store, or transmit. By installing or using the Service you agree to the practices described below.

---

## 1. What This Service Actually Is

MyFolio is a personal-use Chrome browser extension that was built by an individual developer to view their own retirement account in a cleaner visual layout, and then shared freely. **There is no backend, no MyFolio user account system, no MyFolio database, no MyFolio server, and no MyFolio analytics.** We have no business operating around this tool. We never see your data because there is nowhere for the data to go.

## 2. What the Service Does NOT Collect — In Detail

The Service **does not collect, transmit, store on any external server, log, analyze, sell, share, aggregate, or otherwise process** any of the following:

### 2.1 Personal Identifiers
- Your **name**, including first name, last name, middle name, nickname, or any name variant
- Your **email address**, in any form
- Your **postal address**, mailing address, billing address, or any geographic location
- Your **phone number**, mobile or otherwise
- Your **Social Security number**, taxpayer ID, or any government-issued identifier
- Your **date of birth** or age
- Your **driver's license**, passport number, or any photo ID
- Your **employer**, occupation, job title, or income range
- Your **household composition**, beneficiaries, or family relationships
- **Any other personal identifier** that could be used to identify you as an individual

### 2.2 Authentication Information
- Your **brokerage username** or login ID
- Your **brokerage password**, in any form
- Your **multi-factor authentication codes** (SMS codes, authenticator app codes, hardware token codes)
- Your **security questions** or their answers
- Your **session cookies** or authentication tokens for the brokerage
- **Any other credential** you use to authenticate to any service

### 2.3 Financial Account Information
- Your **account numbers**, in any form (full or last-4)
- Your **account balances** or net worth
- Your **portfolio composition**, holdings, or position details
- Your **transaction history**, trades, deposits, withdrawals, or transfers
- Your **performance figures**, returns, or gain/loss data
- Your **cost basis** information
- Your **tax-lot** information
- Your **dividend, interest, or distribution** income
- Your **asset allocation**, sector exposures, or fund selections
- **Any other financial data** of any kind about you, your account, or your investments

### 2.4 Device, Browser, or Behavioral Data
- Your **IP address**, in any form
- Your **device identifier**, MAC address, or hardware serial number
- Your **browser fingerprint**, user agent, screen resolution, or installed plugins
- Your **operating system** or its version
- Your **geographic location**, GPS coordinates, or inferred location from IP
- Your **time zone** or system clock settings
- **Usage statistics** — how often you open MyFolio, which tabs you view, how long you spend, which features you use
- **Click-through events**, scroll behavior, mouse movements, or keystroke patterns
- **Error reports**, crash logs, exception stack traces, or any debug telemetry
- **Performance metrics** — page load times, render times, network timings
- **Cookies** of any kind (the extension sets no cookies)
- **Web beacons**, tracking pixels, or pixel tags
- **Local storage tracking identifiers** or other persistent device markers
- **Any data of any kind** from your computer beyond what is explicitly described in Section 4 below

### 2.5 What Is Not Done With Your Data
The Service does not:
- **Send any data to JJJJJ Enterprises, LLC** — we operate no server that could receive it
- **Send any data to the developer personally** — there is no developer-facing log
- **Send any data to LPL Financial LLC beyond what your browser already sends** as part of your normal account login session
- **Share data with any third party**, advertiser, analytics provider, data broker, AI/ML training pipeline, or any other party
- **Sell or rent any data** to anyone for any purpose
- **Aggregate, anonymize, or de-identify data for any secondary use**
- **Use data to build profiles, segments, audiences, or any inference about you**
- **Use data to train, fine-tune, evaluate, or improve any AI/ML model**, ours or anyone else's
- **Retain data** beyond the lifetime of the browser tab where it was processed

Closing the LPL tab discards all data the extension was holding in memory. Uninstalling the extension removes the small amount of local-only preference data described in Section 4.

## 3. What Data the Service DOES Read (In Memory, In Your Browser)

While you are logged in to your brokerage's website and have opened the MyFolio dashboard, the Service reads the following data **from network responses that your browser is already receiving** — it does not request anything from the brokerage that the browser wasn't already going to request:

| Category | Specific Data | Where It Goes |
|---|---|---|
| Account information | Account names, account numbers, account types, balances, day changes | Displayed in the MyFolio Overview tab in your browser. Discarded when the tab is closed. |
| Holdings / positions | Symbols, descriptions, quantities, prices, market values, gain/loss | Displayed in the MyFolio Holdings tab in your browser. Discarded when the tab is closed. |
| Transaction / activity history | Dates, types, symbols, amounts, prices, quantities | Displayed in the MyFolio Transactions tab in your browser. Discarded when the tab is closed. |
| Portfolio performance data | Period returns, daily values, chart data | Displayed in the MyFolio Performance tab in your browser. Discarded when the tab is closed. |

All of this data is **read once, held in browser memory only**, and is gone the moment you close the tab. It is never written to disk (other than the small preference cache described in Section 4), never transmitted anywhere, and never seen by anyone but you.

## 4. What the Service Stores Locally (In Your Browser, Not On Any Server)

The Service stores a small amount of non-sensitive preference data in your own browser's local storage:

| Stored Data | Where | Why |
|---|---|---|
| **Selected benchmark tickers** (e.g., `["spy","vti","agg"]`) | `localStorage` (your browser, this domain only) | So your benchmark preferences persist between sessions |
| **Average load time samples** (millisecond integers) | `chrome.storage.local` (your browser only) | So we can show an accurate ETA while waiting for pages to load |
| **Cached benchmark price history** (public ETF prices fetched from stooq.com) | `chrome.storage.local` (your browser only) | So we don't re-fetch the same public data more than once per 24 hours |

**None of this contains your name, your account number, your balance, your holdings, your transactions, or any data about you personally.** It contains preferences (which benchmarks you ticked) and public market data (ETF prices that anyone in the world can fetch). It is encrypted at rest by Chrome and is private to your browser profile.

To clear it, uninstall the extension or use Chrome's site-data settings.

## 5. The ONLY Outbound Network Request the Service Makes

The Service makes one kind of outbound network request to anywhere on the internet other than the brokerage your browser is already communicating with:

**`GET https://stooq.com/q/d/l/?s={ticker}.us&d1={start}&d2={end}&i=d`**

Where `{ticker}` is a benchmark ETF symbol like `spy` or `vti`, and `{start}`/`{end}` are date strings.

This request:
- **Sends only**: the benchmark ticker symbol and a date range — nothing else
- **Sends nothing about you**: not your name, not your account, not your IP (beyond what any HTTP request sends), not your portfolio, nothing
- **Receives**: a CSV file of daily closing prices for that public ETF, identical to what any visitor to stooq.com sees
- **Is cached**: not made more than once every 24 hours per ticker
- **Is optional**: only happens when the Performance tab is open and benchmarks are selected

Stooq sp. z o.o. operates `stooq.com` independently. We have no agreement or relationship with Stooq. Their data and privacy practices are governed by their own website. We do not direct, control, or audit Stooq.

## 6. What the Service Sends to LPL Financial LLC

**Nothing beyond what your browser already sends.** The Service does not initiate any new request to the brokerage's servers. It only reads responses that the brokerage's own page code has already requested. The brokerage cannot tell from server logs whether MyFolio is installed or not, because MyFolio adds no new requests.

## 7. What the Service Sends to Google (Chrome / Chrome Web Store)

**Nothing.** MyFolio does not communicate with Google services, does not use Google Analytics or Firebase, does not embed Google fonts or scripts, and does not call any Google API. If MyFolio is eventually distributed through the Chrome Web Store, the Chrome Web Store install platform itself may collect standard install telemetry under Google's privacy policy — that is Google's data flow, not ours, and we receive no data from it.

## 8. Third-Party Subprocessors

We have **none**. We engage no third party to process personal data on our behalf because we don't collect personal data in the first place. The only third party MyFolio touches at all is Stooq, and only for public market data, and only at your option.

## 9. Geographic Scope

The Service is offered in the United States. Because we do not collect personal data on any backend we operate, the cross-border data-flow concerns that ordinarily arise under GDPR, UK GDPR, Quebec Law 25, Brazil LGPD, or other regional privacy frameworks do not apply to data processed by the Service — your data does not leave your own browser.

## 10. Your Privacy Rights

Because we maintain no database of users, no record of who has installed MyFolio, and no log of any user activity, there is no centralized record from which we could "access," "delete," "correct," or "port" data on your behalf. You exercise full control directly:

- **To stop the Service from reading any data**: close the brokerage tab or uninstall the extension
- **To delete the locally-stored preferences and cache**: uninstall the extension, or use Chrome's "Clear browsing data" feature
- **To delete data inside your brokerage account**: contact the brokerage directly; that data is theirs, not ours

If you are a California resident, the CCPA / CPRA grants you certain rights regarding personal information. **We do not collect or maintain personal information about you** (as that term is defined under CCPA/CPRA) on any system we operate. Accordingly, there is no information to "access," "delete," "correct," or "stop selling." We have never sold or shared personal information and have no advertising integrations.

If you reside in another U.S. state with a comprehensive privacy law (Virginia, Colorado, Connecticut, Utah, Texas, Oregon, Montana, Tennessee, Delaware, New Jersey, Iowa, Indiana, New Hampshire, Kentucky, Maryland, Minnesota, Nebraska, Rhode Island, or others), the same applies.

For privacy questions, contact: **legal@jjjjjenterprises.com**

## 11. Children

The Service is not directed to children under 13. We do not knowingly process any data from children.

## 12. Data Security

Because the Service stores no personal data on any system we control, there is no central data store that could be breached. The data the Service displays lives only in your own browser's memory and Chrome's local storage, secured by Chrome's own sandboxing and at-rest encryption. The cached benchmark data from Stooq is public market information, not personal data.

## 13. Changes to This Policy

We may update this Privacy Policy. The "Effective date" at the top reflects the latest revision, and material changes will be reflected in the extension's release notes on GitHub.

## 14. Contact

| Purpose | Address |
|---|---|
| Privacy questions and data-rights requests | legal@jjjjjenterprises.com |
| General inquiries | admin@jjjjjenterprises.com |
| Technical support / bug reports | [GitHub Issues](https://github.com/StephenRJohns/myfolio/issues) |
