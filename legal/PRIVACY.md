# MyFolio — Privacy Policy

**Effective date:** 2026-05-15
**Operator:** JJJJJ Enterprises, LLC ("we", "us", "our")
**Service:** MyFolio, a Chrome browser extension (the "Service")

This Privacy Policy explains what data the Service accesses, how it is used, and with whom it is shared. By installing or using the Service you agree to the practices described below.

---

## 1. Architecture Summary

MyFolio is a Chrome browser extension that runs entirely inside your own Chrome browser. **We operate no server, no database, and no backend that receives or stores your data.** All personal financial data the Service processes — your account balances, holdings, transactions, and performance figures — stays inside your browser. We do not have access to it, do not receive it, and cannot read it.

The Service operates by reading data that your browser already receives from LPL Financial LLC's AccountView website (`accountview.lpl.com`) and presenting that data in a modern visual layout. It does not log you in, store your credentials, or access LPL's servers on your behalf — all interaction with LPL is initiated by you through normal browser usage.

## 2. Data the Service Accesses

When you are logged in to LPL AccountView and have opened the MyFolio dashboard, the Service reads the following data from API responses that your browser receives from LPL:

| Data | How it is used |
|---|---|
| **Account information** (account names, account numbers, account types, balances, day changes) | Displayed in the MyFolio Overview tab |
| **Holdings / positions** (symbols, descriptions, quantities, prices, market values, gain/loss) | Displayed in the MyFolio Holdings tab |
| **Transaction / activity history** (dates, types, symbols, amounts, prices, quantities) | Displayed in the MyFolio Transactions tab |
| **Portfolio performance data** (period returns, daily values, chart data) | Displayed in the MyFolio Performance tab |

All of this data is read from network responses that your browser already received, and is held only in browser memory for the duration of the page session. **None of this data is transmitted to JJJJJ Enterprises, LLC, to LPL, or to any other party.** Closing the browser tab discards it.

## 3. Data the Service Stores Locally

The Service stores a small amount of non-sensitive data in your browser's local storage to provide a smooth user experience:

| Stored Data | Storage Location | Purpose |
|---|---|---|
| **Selected benchmark tickers** (e.g., `["spy","vti","agg"]`) | `localStorage` | So your benchmark preferences persist between sessions |
| **Average load time samples** (millisecond integers from prior sessions) | `chrome.storage.local` | So we can show an accurate ETA while waiting for LPL pages to load |
| **Cached benchmark price history** (public ETF prices fetched from stooq.com) | `chrome.storage.local` | So we don't re-fetch the same public data more than once every 24 hours |

This local data is stored only within your Chrome browser profile. It is never transmitted to JJJJJ Enterprises, LLC or any third party. To clear it, you can uninstall the extension or use Chrome's site data settings.

## 4. Data the Service Transmits Over the Network

The Service makes only one kind of outbound network request: fetching public ETF price history from **`stooq.com`**, a free public stock-data provider, to populate the benchmark comparisons on the Performance tab.

| Request | Information Sent | Information Received |
|---|---|---|
| `GET https://stooq.com/q/d/l/?s={ticker}.us&d1=...&d2=...&i=d` | Only the benchmark ticker symbol (e.g., "SPY", "VTI") and a date range. No personal data, no portfolio data, no user identifier. | A CSV file of daily closing prices for the public ETF, identical to what any visitor to stooq.com sees. |

Stooq's privacy practices are governed by stooq.com's own privacy policy. We do not control or audit Stooq.

The Service does **not** transmit any data to LPL Financial LLC beyond the normal browser requests that LPL's website itself initiates as part of your login session. The Service does **not** transmit any data to JJJJJ Enterprises, LLC.

## 5. Data the Service Does NOT Do

The Service does not, and will not:

- Send your personal financial data to any external server
- Collect, store, or transmit your LPL login credentials, session cookies, or any authentication tokens
- Maintain user accounts, user identifiers, or any persistent user-level records on any server
- Use analytics services, advertising networks, telemetry providers, or third-party tracking
- Set cookies (the extension itself sets no cookies; the LPL site's own cookies are unaffected)
- Train or evaluate any AI/ML model using your data
- Sell, lease, or share your data with any party

## 6. Third Parties

The Service interacts with the following parties:

| Party | Role | Data Shared by Service |
|---|---|---|
| **LPL Financial LLC** (operator of `accountview.lpl.com`) | The Service reads API responses your browser receives from LPL. We do not "share" data with LPL; the data originates from LPL and stays in your browser. | None — all data is received from LPL, not sent to LPL. |
| **Stooq sp. z o.o.** (operator of `stooq.com`) | Public stock-data provider. The Service requests public ETF price history for benchmark comparison. | Benchmark ticker symbols and date ranges only. No personal data. |
| **Google LLC** (Chrome browser, Chrome Web Store) | Distribution channel for the extension. Google receives standard Chrome Web Store install metadata. | None. The Service does not communicate with Google services. |

We do not engage any subprocessors that handle personal data, because the Service does not collect or store any personal data on any system we control.

## 7. Geographic Scope

The Service is currently offered in the United States. The Chrome Web Store listing (when published) will be region-restricted as appropriate. Because the Service does not collect personal data on any backend we operate, the geographic data-flow concerns that ordinarily arise under GDPR, UK GDPR, or other cross-border privacy frameworks do not apply to data processed by the Service — your data does not leave your own browser.

## 8. Your Privacy Rights

Because the Service does not maintain a database of users or personal data, there is no centralized record from which we could "access," "delete," or "port" data on your behalf. You exercise full control over the data the Service processes through your own browser:

- **To delete the locally-stored preferences and cache**: uninstall the extension, or use Chrome's "Clear browsing data" feature
- **To stop the Service from accessing LPL data**: simply close the LPL tab or uninstall the extension
- **To delete data inside LPL**: contact LPL directly; that data is theirs, not ours

If you are a California resident, the CCPA / CPRA grants you certain rights regarding personal information. We do not collect or maintain personal information about you (as defined under CCPA/CPRA) on any system we operate, so there is no information for us to "access," "delete," or "stop selling." We do not sell or share personal information.

If you reside in another U.S. state with a comprehensive privacy law (Virginia, Colorado, Connecticut, Utah, Texas, Oregon, Montana, Tennessee, Delaware, New Jersey, Iowa, Indiana, New Hampshire, Kentucky, Maryland, Minnesota, Nebraska, Rhode Island, or others), the same applies: we do not maintain a database of your personal information to act upon.

For questions about this policy, contact: **legal@jjjjjenterprises.com**

## 9. Children

The Service is not directed to children under 13 and we do not knowingly collect personal information from children. The Service is intended for use by adults managing their own retirement or brokerage accounts.

## 10. Data Security

Because the Service stores no personal data on any system we control, there is no central data store that could be breached. The data the Service processes lives in your own browser memory and Chrome local storage, secured by Chrome's own sandboxing and encryption.

The locally-cached benchmark data (Stooq CSVs) is public-market information, not personal data, and is encrypted at rest by Chrome's `chrome.storage.local` API.

## 11. Changes to This Policy

We may update this Privacy Policy from time to time. The "Effective date" at the top will reflect the latest revision. Material changes will be reflected in the extension's release notes on GitHub.

## 12. Contact

| Purpose | Address |
|---|---|
| Privacy questions and data-rights requests | legal@jjjjjenterprises.com |
| General inquiries | admin@jjjjjenterprises.com |
| Technical support / bug reports | [GitHub Issues](https://github.com/StephenRJohns/myfolio/issues) |
