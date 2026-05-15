// MyFolio — Chrome extension content script
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
//
// Listens for API captures from interceptor.js, parses brokerage account data,
// and injects/updates the MyFolio dashboard overlay. No data leaves the browser
// except public ETF price fetches to stooq.com for benchmark comparisons.

const MF_VERSION = 'v1.4.15';

const state = {
  accounts: [],
  positions: [],
  transactions: [],
  performance: {},
  dailyValues: [],         // [{date, value}] aggregated across accounts
  accountDailyValues: {},  // accountId -> [{date, value}]
  selectedAccountId: null,    // null = view all; 'portfolio' acts the same as null
  selectedAssetClass: null,   // asset-class label set by clicking an allocation slice
  selectedSymbol: null,       // ticker drilled into from a Holdings row
  helpOpen: false,
  holdingsPage: 1, holdingsPageSize: 10,
  holdingsSort: { col: 'value', dir: 'desc' },
  txnPage: 1, txnPageSize: 10,
  txnSort: { col: 'date', dir: 'desc' },
  overviewChartPeriod: 'ytd',
  overlayOpen: false,
  apiCallCount: 0,
  lastApiTime: null,
  loadStart: null,
  avgLoadMs: null,
  sessionRecorded: false,
  logs: [],
};

function dbg(level, msg, detail) {
  const entry = {
    t: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    ms: Date.now(),
    level,   // 'info' | 'ok' | 'warn' | 'err'
    msg,
    detail: detail !== undefined ? JSON.stringify(detail, null, 2) : null,
  };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.pop();
  if (state.activeTab === 'debug') renderDebugTab();
}

// Defensive wrappers for chrome.* APIs. When the extension is reloaded while
// a page is still open, the old content script loses its connection and every
// chrome.* call throws "Extension context invalidated." These helpers swallow
// that case quietly — the page will re-inject the new content script on the
// next reload.
function extensionContextValid() {
  try { return !!chrome?.runtime?.id; } catch (e) { return false; }
}

// Global safety net: suppress "Extension context invalidated" errors that
// escape any other guard. There are async paths (promise microtasks, setTimeout
// callbacks scheduled by chrome.* internals, etc.) that can throw after the
// extension is reloaded — they're harmless because the new content script will
// take over on the next page load, but they pollute the chrome://extensions
// errors page if left to bubble.
(function installContextInvalidatedSink() {
  const isCtxErr = (m) => typeof m === 'string' && m.includes('Extension context invalidated');
  window.addEventListener('error', (e) => {
    const m = (e && (e.error && e.error.message)) || (e && e.message) || '';
    if (isCtxErr(String(m))) { e.preventDefault(); e.stopImmediatePropagation && e.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const m = (e && e.reason && e.reason.message) || (e && e.reason) || '';
    if (isCtxErr(String(m))) { e.preventDefault(); e.stopImmediatePropagation && e.stopImmediatePropagation(); }
  }, true);
})();
function safeStorageGet(keys, cb) {
  if (!extensionContextValid()) { cb && cb({}); return; }
  try {
    const p = chrome.storage.local.get(keys, (r) => {
      try { void chrome.runtime?.lastError; } catch (e) {}
      try { cb && cb(r || {}); } catch (e) {}
    });
    if (p && typeof p.catch === 'function') p.catch(() => { cb && cb({}); });
  } catch (e) { cb && cb({}); }
}
function safeStorageSet(items) {
  if (!extensionContextValid()) return;
  try {
    const p = chrome.storage.local.set(items, () => {
      try { void chrome.runtime?.lastError; } catch (e) {}
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}
function safeStorageRemove(keys) {
  if (!extensionContextValid()) return;
  try {
    const p = chrome.storage.local.remove(keys, () => {
      try { void chrome.runtime?.lastError; } catch (e) {}
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

// Load persisted data from storage on startup
const DAILY_VALUES_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_SCHEMA_VERSION = 4;  // bump to invalidate older cached series
safeStorageGet(['loadTimes', 'cachedDailyValues', 'cachedAccountDailyValues', 'cachedLplProvidedIds', 'cachedTransactions', 'cacheSchemaVersion'], (result) => {
  const times = result.loadTimes || [];
  if (times.length) state.avgLoadMs = times.reduce((a, b) => a + b, 0) / times.length;

  // Invalidate cached series written by a prior schema
  if (result.cacheSchemaVersion !== CACHE_SCHEMA_VERSION) {
    safeStorageRemove(['cachedDailyValues', 'cachedAccountDailyValues', 'cachedLplProvidedIds', 'cachedTransactions']);
    safeStorageSet({ cacheSchemaVersion: CACHE_SCHEMA_VERSION });
    dbg('info', 'Daily-value cache cleared (schema upgrade)');
    return;
  }

  // Restore cached daily values (expire after 24h so stale data doesn't linger)
  const dv = result.cachedDailyValues;
  if (dv && dv.data?.length && (Date.now() - (dv.savedAt || 0)) < DAILY_VALUES_TTL) {
    state.dailyValues = dv.data;
    dbg('info', `Restored ${dv.data.length} daily values from cache (saved ${new Date(dv.savedAt).toLocaleTimeString()})`);
  }
  const adv = result.cachedAccountDailyValues;
  if (adv && adv.data && (Date.now() - (adv.savedAt || 0)) < DAILY_VALUES_TTL) {
    state.accountDailyValues = adv.data;
    dbg('info', `Restored per-account daily values from cache`);
  }
  // Restore which account IDs LPL natively delivered. Critical for the
  // synthesis eviction logic to work correctly when account-vot doesn't run
  // this session (e.g. when the user lands directly on /web/activity).
  const lid = result.cachedLplProvidedIds;
  if (lid && Array.isArray(lid.ids) && (Date.now() - (lid.savedAt || 0)) < DAILY_VALUES_TTL) {
    state.lplProvidedAccountIds = new Set(lid.ids);
    dbg('info', `Restored LPL-provided account ids from cache: [${lid.ids.join(', ')}]`);
  }
  // Restore activity-history transactions. The proactive /activity-process
  // fetch is unreliable (cross-origin POST, server requires specific headers
  // we don't capture), so once we've captured this data from a natural visit
  // to /web/activity, we cache it so the chart's synthesis has it on every
  // future load without the user having to revisit Activity each time.
  const tx = result.cachedTransactions;
  if (tx && Array.isArray(tx.data) && tx.data.length && (Date.now() - (tx.savedAt || 0)) < DAILY_VALUES_TTL) {
    state.transactions = tx.data;
    dbg('info', `Restored ${tx.data.length} transactions from cache (saved ${new Date(tx.savedAt).toLocaleTimeString()})`);
  }
  // If daily-value cache + transactions are both restored, re-synthesize
  // immediately so the chart reflects the cached cash flows rather than
  // flat-line until account-vot arrives.
  if (state.dailyValues.length >= 2 && state.transactions.length) {
    synthesizeMissingAccountDailies();
  }
});

// Proactively re-fetch the value-over-time data using saved request details.
// This replays the same request the browser already made, using the browser's
// own session cookie. The request is identical to one the page initiated.
// Runs when we have account data but no daily value history yet.
async function proactiveFetchVot() {
  if (state.dailyValues.length >= 2) return;
  if (!extensionContextValid()) return;
  const result = await new Promise((resolve) => safeStorageGet(['accountVotRequest'], resolve));
  const req = result.accountVotRequest;
  if (!req?.url) {
    dbg('info', 'Proactive VoT fetch: no saved URL yet — will capture on first account-vot intercept');
    return;
  }
  // Don't replay a week-old URL (session will have expired)
  if (Date.now() - req.savedAt > 7 * 24 * 60 * 60 * 1000) {
    dbg('info', 'Proactive VoT fetch: saved request too old, skipping');
    return;
  }
  dbg('info', `Proactive VoT fetch (${req.method})`, { url: req.url });
  try {
    const init = { credentials: 'include' };
    if (req.method === 'POST' && req.reqBody) {
      init.method = 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = typeof req.reqBody === 'string' ? req.reqBody : JSON.stringify(req.reqBody);
    }
    const resp = await fetch(req.url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    dbg('ok', 'Proactive VoT fetch succeeded — parsing daily values');
    parseApiResponse(req.url, data);
    refreshOverlay();
  } catch (err) {
    dbg('warn', 'Proactive VoT fetch failed', { err: String(err) });
  }
}

// Same idea, for the historical activity endpoint. After the user visits
// LPL's Activity page once, the URL is saved; from then on we replay it on
// every load so the deposit transactions are always available for synthesis.
async function proactiveFetchActivity() {
  if (!extensionContextValid()) return;
  const result = await new Promise((resolve) => safeStorageGet(['activityHistoryRequest'], resolve));
  const req = result.activityHistoryRequest;
  if (!req?.url) {
    dbg('info', 'Proactive activity fetch: no saved URL — user has not visited /web/activity yet');
    return;
  }
  if (Date.now() - req.savedAt > 7 * 24 * 60 * 60 * 1000) {
    dbg('info', 'Proactive activity fetch: saved request too old, skipping');
    return;
  }
  dbg('info', `Proactive activity fetch (${req.method})`, { url: req.url });
  try {
    const init = { credentials: 'include' };
    if (req.method === 'POST' && req.reqBody) {
      init.method = 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = typeof req.reqBody === 'string' ? req.reqBody : JSON.stringify(req.reqBody);
    }
    const resp = await fetch(req.url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    dbg('ok', 'Proactive activity fetch succeeded — parsing transactions');
    parseApiResponse(req.url, data);
    refreshOverlay();
  } catch (err) {
    dbg('warn', 'Proactive activity fetch failed', { err: String(err) });
  }
}

function recordLoadTime(ms) {
  if (state.sessionRecorded) return;
  state.sessionRecorded = true;
  safeStorageGet(['loadTimes'], (result) => {
    const times = result.loadTimes || [];
    times.push(ms);
    if (times.length > 10) times.shift(); // keep last 10 sessions
    state.avgLoadMs = times.reduce((a, b) => a + b, 0) / times.length;
    safeStorageSet({ loadTimes: times });
  });
}

// ── API data parser ─────────────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg?.type?.startsWith('MF_')) return;

  if (msg.type === 'MF_NET') {
    dbg('info', `${msg.ok ? '✔' : '✘'} ${msg.status}  ${msg.url}`);
  } else if (msg.type === 'MF_API') {
    const { url, method, reqBody, data } = msg;
    const topKeys = data && typeof data === 'object' ? Object.keys(data) : [];
    dbg('info', `JSON body parsed`, { url, topKeys, type: Array.isArray(data) ? `array[${data.length}]` : typeof data });
    parseApiResponse(url, data);
    const lc = url.toLowerCase();
    // Save endpoint URLs we want to replay on future page loads
    if (lc.includes('account-vot')) {
      safeStorageSet({ accountVotRequest: { url, method: method || 'GET', reqBody: reqBody || null, savedAt: Date.now() } });
    }
    if (lc.includes('activity') && !lc.includes('intraday')) {
      safeStorageSet({ activityHistoryRequest: { url, method: method || 'GET', reqBody: reqBody || null, savedAt: Date.now() } });
    }
  } else if (msg.type === 'MF_WS_OPEN') {
    dbg('warn', `WebSocket opened — data may flow through this`, { url: msg.url });
  } else if (msg.type === 'MF_WS_MSG') {
    const topKeys = msg.data && typeof msg.data === 'object' ? Object.keys(msg.data) : [];
    dbg('info', `WebSocket message`, { url: msg.url, topKeys });
    if (msg.data && typeof msg.data === 'object') parseApiResponse(msg.url, msg.data);
  }
});

function parseApiResponse(url, data) {
  state.apiCallCount++;
  state.lastApiTime = Date.now();
  const hadData = state.accounts.length || state.positions.length || state.transactions.length;
  const u = url.toLowerCase();

  // ── AccountInfo → portfolio summary + per-account list ───────────────────
  if (u.includes('accountinfo-process') && u.includes('accountinfo')) {
    const cd = data?.clientData;
    if (cd?.portfolioBalance != null) {
      // Build a single portfolio-level account from the summary fields
      const portfolio = {
        id: 'portfolio',
        name: 'Total Portfolio',
        type: '',
        value: toNum(cd.portfolioBalance),
        change: toNum(cd.dayChange),
        changePct: toNum(cd.dayChangePercentage),
        ytdReturn: null,
        unrealizedGL: null,
      };
      // Per-account entries
      const accts = Array.isArray(cd.accounts) ? cd.accounts.map(normalizeBrokerageAccount) : [];
      state.accounts = accts.length ? [portfolio, ...accts] : [portfolio];
      backfillAccountValues();
      dbg('ok', `AccountInfo: portfolio $${cd.portfolioBalance}, ${accts.length} accounts`, { dayChange: cd.dayChange, dayChangePct: cd.dayChangePercentage });
      refreshOverlay();
      // If account-vot hasn't delivered daily values yet, proactively fetch
      // it. On /web/overview the brokerage fires it naturally — wait 5s so
      // we don't double-fetch. On every other page (activity, holdings,
      // transactions, etc.) it never fires, so go after it almost
      // immediately.
      const isOverviewPage = /\/web\/overview/i.test(window.location.pathname);
      const votDelay = isOverviewPage ? 5000 : 1500;
      const actDelay = isOverviewPage ? 6000 : 2000;
      setTimeout(() => { if (!state.dailyValues.length) proactiveFetchVot(); }, votDelay);
      setTimeout(() => { proactiveFetchActivity(); }, actDelay);
      // Retry once more if the first attempt didn't deliver — e.g. brief
      // network hiccup, slow LPL server, etc.
      setTimeout(() => { if (!state.dailyValues.length) proactiveFetchVot(); }, votDelay + 8000);
    } else {
      dbg('warn', 'AccountInfo: missing portfolioBalance', { keys: Object.keys(cd || {}), sample: JSON.stringify(data).slice(0, 400) });
    }
  }

  // ── Position → flatten clientData.account[].position[] ──────────────────
  if (u.includes('position-process') && u.includes('position')) {
    const acctList = data?.clientData?.account;
    if (Array.isArray(acctList) && acctList.length) {
      const all = [];
      for (const acct of acctList) {
        if (Array.isArray(acct.position)) {
          for (const p of acct.position) {
            all.push(normalizeBrokeragePosition(p, acct));
          }
        }
      }
      if (all.length) {
        dbg('ok', `Position: ${all.length} positions across ${acctList.length} accounts`, all[0]);
        state.positions = all;
        refreshOverlay();
      } else {
        dbg('warn', 'Position: account array found but no positions inside', { accountCount: acctList.length, firstAcctKeys: Object.keys(acctList[0] || {}) });
      }
    } else {
      dbg('warn', 'Position: no clientData.account array', { keys: Object.keys(data?.clientData || {}), sample: JSON.stringify(data).slice(0, 400) });
    }
  }

  // ── Activity history (loaded when user navigates to Activity page) ───────
  // The intraday endpoint only delivers TODAY's transactions; historical
  // deposits/withdrawals/transfers (e.g. a $46k contribution made last week)
  // live in a separate endpoint that fires when the brokerage's Activity tab
  // is opened. We accept any URL containing "activity" but not "intraday",
  // and try several common data shapes.
  if (u.includes('activity') && !u.includes('activityintraday') && !u.includes('intraday')) {
    const harvested = [];
    const tryShape = (acctList) => {
      if (!Array.isArray(acctList)) return;
      for (const acct of acctList) {
        const acts = acct.activities || acct.activity || acct.transactions || acct.txns || [];
        if (Array.isArray(acts)) {
          for (const t of acts) harvested.push(normalizeBrokerageTxn(t, acct));
        }
      }
    };
    // Common LPL response shapes
    tryShape(data?.clientData?.account);
    tryShape(data?.clientData?.accounts);
    tryShape(data?.data?.accounts);
    tryShape(data?.accounts);
    // Flat list shapes
    const flat = data?.clientData?.activities || data?.activities || data?.data?.activities;
    if (Array.isArray(flat)) {
      for (const t of flat) harvested.push(normalizeBrokerageTxn(t, { accountId: t.accountId || t.accountNumber || '' }));
    }

    if (harvested.length) {
      // Merge with existing — dedup by accountId + date + amount + symbol
      const key = (t) => `${t.accountId}|${t.date}|${t.amount}|${t.symbol}`;
      const existing = new Map(state.transactions.map(t => [key(t), t]));
      let added = 0;
      for (const t of harvested) {
        if (!existing.has(key(t))) { existing.set(key(t), t); added++; }
      }
      state.transactions = Array.from(existing.values());
      // Diagnostic: count unique transaction types AND per-account distribution
      // so we can see which codes the brokerage uses for cash flows and which
      // account each transaction is tagged with.
      const typeCounts = {};
      const accountCounts = {};
      for (const t of harvested) {
        const k = String(t.type || '').trim() || '(empty)';
        typeCounts[k] = (typeCounts[k] || 0) + 1;
        const a = String(t.accountId || '').trim() || '(none)';
        accountCounts[a] = (accountCounts[a] || 0) + 1;
      }
      dbg('ok', `Activity history: parsed ${harvested.length} rows, added ${added} new (total ${state.transactions.length})`, { typeCounts, accountCounts, sample: harvested[0] });
      // Persist transactions so they survive page reloads — the
      // /activity-process endpoint is a cross-origin POST that fails when
      // we try to replay it proactively, so we have to keep what we caught.
      safeStorageSet({ cachedTransactions: { data: state.transactions, savedAt: Date.now() } });
      // Re-synthesize accounts now that we may have the missing cash flows
      if (state.dailyValues.length) synthesizeMissingAccountDailies();
      refreshOverlay();
    } else {
      const sample = Object.keys(data || {}).slice(0, 10);
      dbg('info', `Activity-looking URL didn't match known shapes — keys: [${sample.join(', ')}]`, { url, sample: JSON.stringify(data).slice(0, 400) });
    }
  }

  // ── Intraday → best-available balances, positions, transactions ──────────
  if (u.includes('intraday')) {
    // Portfolio totals from accountIntraDay.clientData
    const aid = data?.accountIntraDay?.clientData;
    if (aid?.portfolioBalance != null && !state.accounts.length) {
      state.accounts = [{
        id: 'portfolio', name: 'Total Portfolio', type: '',
        value: toNum(aid.portfolioBalance),
        change: toNum(aid.dayChange),
        changePct: toNum(aid.dayChangePercentage),
        ytdReturn: null, unrealizedGL: null,
      }];
      dbg('ok', `Intraday accountIntraDay: portfolio $${aid.portfolioBalance}`, { dayChange: aid.dayChange });
      refreshOverlay();
    }

    // Positions from positionIntraDay.clientData.account[].position[]
    const pid = data?.positionIntraDay?.clientData;
    if (Array.isArray(pid?.account) && !state.positions.length) {
      const all = [];
      for (const acct of pid.account) {
        if (Array.isArray(acct.position)) {
          for (const p of acct.position) all.push(normalizeBrokeragePosition(p, acct));
        }
      }
      if (all.length) {
        dbg('ok', `Intraday positionIntraDay: ${all.length} positions`, all[0]);
        state.positions = all;
        refreshOverlay();
      }
    }

    // Transactions from activityIntraDay.clientData.accounts[].activities[]
    const actd = data?.activityIntraDay?.clientData;
    if (Array.isArray(actd?.accounts)) {
      const all = [];
      for (const acct of actd.accounts) {
        if (Array.isArray(acct.activities)) {
          for (const t of acct.activities) all.push(normalizeBrokerageTxn(t, acct));
        }
      }
      if (all.length) {
        // MERGE into existing transactions instead of replacing — the cache
        // may already hold 41 activity-history rows from a prior visit to
        // /web/activity, and replacing them would lose the deposit data
        // synthesis depends on.
        const key = (t) => `${t.accountId}|${t.date}|${t.amount}|${t.symbol}`;
        const existing = new Map(state.transactions.map(t => [key(t), t]));
        let added = 0;
        for (const t of all) {
          if (!existing.has(key(t))) { existing.set(key(t), t); added++; }
        }
        state.transactions = Array.from(existing.values());
        dbg('ok', `Intraday activityIntraDay: parsed ${all.length}, added ${added} new (total ${state.transactions.length})`, all[0]);
        // Persist so the cache stays in sync with the merged set
        safeStorageSet({ cachedTransactions: { data: state.transactions, savedAt: Date.now() } });
        // If account-vot already ran, re-synthesize so newly-arrived cash flows
        // are factored into accounts that don't have native daily history.
        if (state.dailyValues.length) synthesizeMissingAccountDailies();
        refreshOverlay();
      }
    }
  }

  // ── account-vot → performance / period returns + daily chart data ────────
  if (u.includes('account-vot')) {
    const accts = data?.clientData?.account;
    if (Array.isArray(accts)) {
      const live = accts.find(a => !a.noData && a.chartData?.PeriodTotalReturn != null);
      if (live) {
        state.performance = {
          ...state.performance,
          ytdReturn: toNum(live.chartData.PeriodTotalReturn),
          itdReturn: toNum(live.chartData.ITDTotalReturn),
          itdReturnAnnualized: toNum(live.chartData.ITDReturnAnnualized),
        };
        dbg('ok', 'account-vot: performance', { ytd: live.chartData.PeriodTotalReturn, itd: live.chartData.ITDTotalReturn });
      }

      // Aggregate dailyValues across all accounts by date + capture per-account
      // series, per-account YTD/ITD returns, and (when available) longer-frame returns.
      const byDate = {};
      const perAcct = {};
      const acctDiag = [];
      for (const acct of accts) {
        const acctId = String(acct.accountId || acct.accountNumber || '');
        const cd = acct.chartData || {};
        // LPL uses various field names for the daily series — try them all
        const dvArray = cd.dailyValues || cd.DailyValues || cd.dailyValue ||
                        cd.chartPoints || cd.dataPoints || cd.points ||
                        cd.performanceData || cd.historicalData || cd.data || [];
        const cdKeys = Object.keys(cd);
        if (cdKeys.length && !dvArray.length) {
          dbg('info', `account-vot chartData keys for ${acctId} (no dailyValues found)`, { keys: cdKeys, sample: JSON.stringify(cd).slice(0, 300) });
        }
        const acctSeries = [];
        for (const dv of dvArray) {
          const d = dv.date || dv.asOfDate || dv.Date || dv.dt || dv.d || dv.tradingDate;
          const v = toNum(dv.endValue ?? dv.value ?? dv.portfolioValue ?? dv.Value ??
                          dv.EndValue ?? dv.totalValue ?? dv.marketValue ?? dv.balance ??
                          dv.close ?? dv.v ?? dv.amount);
          if (d && v != null && v > 0) {
            byDate[d] = (byDate[d] || 0) + v;
            acctSeries.push({ date: d, value: v });
          }
        }
        acctDiag.push({ id: acctId, name: acct.accountName || acct.nickName || '', days: acctSeries.length, ytd: cd.PeriodTotalReturn });
        if (acctId && acctSeries.length) {
          acctSeries.sort((a, b) => a.date.localeCompare(b.date));
          perAcct[acctId] = acctSeries;
        }
        // Patch returns onto the matching state.accounts entry.
        // PeriodTotalReturn in this payload represents the period's total return
        // (typically YTD when the request uses the default date window).
        if (acctId) {
          const accIdx = state.accounts.findIndex(x => x.id === acctId);
          if (accIdx >= 0) {
            const a = state.accounts[accIdx];
            if (a.ytdReturn == null) a.ytdReturn = toNum(cd.PeriodTotalReturn);
            a.itdReturn = toNum(cd.ITDTotalReturn);
            a.itdReturnAnnualized = toNum(cd.ITDReturnAnnualized);
          }
        }
      }
      state.accountDailyValues = perAcct;
      // Remember which account ids had REAL native series from LPL — synthesis
      // will preserve these and re-do only the others on subsequent runs.
      state.lplProvidedAccountIds = new Set(Object.keys(perAcct));
      backfillAccountValues();

      const sorted = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
      if (sorted.length) {
        state.dailyValues = sorted.map(([date, value]) => ({ date, value }));
        dbg('ok', `account-vot: ${sorted.length} daily values across ${Object.keys(perAcct).length} accounts`, { latest: sorted[sorted.length - 1], perAccount: acctDiag });
        // Drop any rows dated past today (defensive: prevents future-dated
        // placeholders from pulling the chart down at the right edge)
        dropFutureDatedValues();
        // Fill in any accounts that have a current value but no daily history
        synthesizeMissingAccountDailies();
        // Persist so the chart survives page reloads without revisiting Performance page
        const now = Date.now();
        safeStorageSet({
          cachedDailyValues: { data: state.dailyValues, savedAt: now },
          cachedAccountDailyValues: { data: state.accountDailyValues, savedAt: now },
          cachedLplProvidedIds: { ids: Array.from(state.lplProvidedAccountIds || []), savedAt: now },
        });
      } else {
        dbg('info', 'account-vot: no dailyValues (may need a longer date range)', { perAccount: acctDiag });
      }

      refreshOverlay();
    }
  }

  // Record load time on the first session that delivers account data
  const nowHasData = state.accounts.length || state.positions.length || state.transactions.length;
  if (!hadData && nowHasData && state.loadStart) {
    recordLoadTime(Date.now() - state.loadStart);
  }

  updateStatusBar();
}

// ── Normalizers (handle various brokerage field name conventions) ───────────
function normalizeAccount(a) {
  return {
    id: a.accountId || a.id || a.accountNumber || '',
    name: a.accountName || a.name || a.displayName || 'Account',
    type: a.accountType || a.type || '',
    value: toNum(a.accountValue ?? a.totalValue ?? a.balance ?? a.marketValue ?? a.totalMarketValue),
    change: toNum(a.dayChange ?? a.dailyChange ?? a.changeAmount ?? 0),
    changePct: toNum(a.dayChangePct ?? a.dailyChangePct ?? a.changePercent ?? 0),
    ytdReturn: toNum(a.ytdReturn ?? a.ytdGainLoss ?? a.yearToDateReturn ?? null),
    unrealizedGL: toNum(a.unrealizedGainLoss ?? a.unrealizedGL ?? null),
  };
}

function normalizePosition(p) {
  return {
    symbol: p.symbol || p.ticker || p.securitySymbol || '',
    name: p.securityDescription || p.description || p.name || p.symbol || '',
    quantity: toNum(p.quantity ?? p.shares ?? p.units ?? 0),
    price: toNum(p.price ?? p.currentPrice ?? p.lastPrice ?? 0),
    value: toNum(p.marketValue ?? p.value ?? p.currentValue ?? 0),
    costBasis: toNum(p.costBasis ?? p.totalCostBasis ?? null),
    gl: toNum(p.unrealizedGainLoss ?? p.gainLoss ?? null),
    glPct: toNum(p.unrealizedGainLossPct ?? p.gainLossPct ?? null),
    assetClass: p.assetClass || p.assetType || p.category || '',
  };
}

function normalizeTxn(t) {
  return {
    date: t.tradeDate || t.transactionDate || t.date || t.settlementDate || '',
    type: t.transactionType || t.activityType || t.type || '',
    symbol: t.symbol || t.ticker || '',
    description: t.description || t.transactionDescription || '',
    amount: toNum(t.amount ?? t.netAmount ?? t.value ?? 0),
    quantity: toNum(t.quantity ?? t.shares ?? 0),
    price: toNum(t.price ?? t.tradePrice ?? 0),
  };
}

function flattenPerf(data) {
  const out = {};
  const keys = ['ytdReturn', 'oneYearReturn', 'threeYearReturn', 'fiveYearReturn', 'sinceInception',
                 'ytd', '1y', '3y', '5y', 'inception'];
  for (const k of keys) {
    if (data[k] != null) out[k] = toNum(data[k]);
  }
  return out;
}

// Backfill missing per-account values from the daily-value series captured
// by the value-over-time payload. Runs from both response handlers so it works regardless of arrival
// order (accountinfo before account-vot, or the reverse).
function backfillAccountValues() {
  if (!state.accounts.length || !state.accountDailyValues) return;
  let patched = 0;
  for (const acct of state.accounts) {
    if (acct.id === 'portfolio') continue;
    if (acct.value != null && acct.value !== 0) continue;
    const series = state.accountDailyValues[acct.id];
    if (!series || !series.length) continue;
    acct.value = series[series.length - 1].value;
    patched++;
  }
  if (patched) dbg('ok', `Backfilled value for ${patched} account${patched > 1 ? 's' : ''} from account-vot daily values`);
}

// Synthesize a daily-value series for accounts that have a current value but
// no daily history (the brokerage returned an empty dailyValues array). Walks
// backwards from today's value, subtracting cash flows from later dates:
//   account_value(date) = current_value - sum_of_cash_flows_strictly_after(date)
//
// When cash-flow transactions exist, the resulting series captures real
// deposit/withdrawal timing. When none are available, the series degenerates
// to a flat line at the current value. Flat-line is misleading about history
// but keeps the chart's ending total consistent with the Total Portfolio KPI
// — without it, the chart silently drops the account and the two numbers
// disagree. The "flatLinedAccounts" state tracks which accounts fell back so
// the banner can disclose this honestly.
function synthesizeMissingAccountDailies() {
  if (!state.dailyValues.length || !state.accounts.length) return;

  // Evict previously-synthesized per-account series so they can be re-done
  // with whatever cash flows have arrived. ONLY when state.lplProvidedAccountIds
  // is populated — if it's still empty (e.g., we restored from cache but
  // account-vot hasn't run yet this session), eviction would wipe legitimate
  // native data and force everything to flat-line. Better to wait.
  if (state.lplProvidedAccountIds && state.lplProvidedAccountIds.size > 0) {
    for (const id of Object.keys(state.accountDailyValues || {})) {
      if (!state.lplProvidedAccountIds.has(id)) {
        delete state.accountDailyValues[id];
      }
    }
  }

  const dates = state.dailyValues.map(d => d.date);
  let reconstructed = 0;
  state.flatLinedAccounts = [];

  for (const acct of state.accounts) {
    if (acct.id === 'portfolio') continue;
    if (!acct.value || acct.value <= 0) continue;
    const existing = state.accountDailyValues[acct.id];
    if (existing && existing.length >= 2) continue;

    // Gather this account's cash flows from the transactions list. Use
    // cashFlowImpact so security transfers (amount=0 but quantity>0) get
    // counted at their estimated dollar value.
    const allAcctTxns = state.transactions.filter(t => t.accountId === acct.id);
    const acctTxns = allAcctTxns.filter(t => isCashFlow(t));
    const cfList = [];
    const rejected = [];
    for (const t of acctTxns) {
      const td = parseDateLoose(t.date);
      const impact = cashFlowImpact(t);
      if (td && Math.abs(impact) >= 0.01) {
        cfList.push({ date: td, amount: impact });
      } else {
        rejected.push({ type: t.type, symbol: t.symbol, qty: t.quantity, amt: t.amount, reason: !td ? 'bad-date' : 'zero-impact' });
      }
    }
    dbg('info', `Synthesis for ${acct.name} (${acct.id}): ${allAcctTxns.length} txns, ${acctTxns.length} classified as cash flows, ${cfList.length} with non-zero impact (total $${cfList.reduce((s,cf)=>s+cf.amount,0).toFixed(2)})`, { cfSample: cfList.slice(0, 5).map(cf => ({d: cf.date.toISOString().slice(0,10), a: cf.amount.toFixed(2)})), rejected: rejected.slice(0, 5) });

    const synth = [];
    for (const dateStr of dates) {
      const dt = parseDateLoose(dateStr);
      if (!dt) continue;
      let after = 0;
      for (const cf of cfList) { if (cf.date > dt) after += cf.amount; }
      const v = acct.value - after;
      if (v > 0) synth.push({ date: dateStr, value: v });
    }
    if (synth.length >= 2) {
      state.accountDailyValues[acct.id] = synth;
      if (cfList.length > 0) {
        reconstructed++;
        dbg('ok', `Reconstructed ${synth.length} daily values for ${acct.name} from ${cfList.length} cash flows`, { current: acct.value });
      } else {
        state.flatLinedAccounts.push({ name: acct.name, value: acct.value });
        dbg('info', `Flat-lined ${acct.name} ($${Math.round(acct.value)}) at current value — no cash-flow transactions to reconstruct timing. Visit Activity page to load deposit history.`);
      }
    }
  }

  // Rebuild state.dailyValues from scratch by summing ALL per-account series
  // (LPL-provided + freshly synthesized). This avoids stale carry-over from
  // a previous run that wrote synthesized values onto state.dailyValues.
  const aggMap = new Map();
  for (const id of Object.keys(state.accountDailyValues)) {
    for (const d of state.accountDailyValues[id] || []) {
      aggMap.set(d.date, (aggMap.get(d.date) || 0) + d.value);
    }
  }
  state.dailyValues = Array.from(aggMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, value }));

  if (reconstructed || state.flatLinedAccounts.length) {
    dbg('ok', `Aggregate rebuilt: ${reconstructed} reconstructed, ${state.flatLinedAccounts.length} flat-lined, ${state.dailyValues.length} aggregated dates`);
  }
}

// Drop any daily-value entries dated after today. Brokerages occasionally
// return placeholder rows for the current trading day with $0 (pre-market
// settlement) or stale values that would visually pull the chart down.
function dropFutureDatedValues() {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const isPastOrToday = (dateStr) => {
    const d = parseDateLoose(dateStr);
    return d && d <= today;
  };
  if (state.dailyValues.length) {
    const before = state.dailyValues.length;
    state.dailyValues = state.dailyValues.filter(x => isPastOrToday(x.date));
    if (state.dailyValues.length !== before) {
      dbg('info', `Filtered ${before - state.dailyValues.length} future-dated daily value(s) from the aggregate`);
    }
  }
  for (const id of Object.keys(state.accountDailyValues || {})) {
    state.accountDailyValues[id] = state.accountDailyValues[id].filter(x => isPastOrToday(x.date));
  }
}

// ── Brokerage-specific normalizers (observed response field names) ─
const ACCOUNT_VALUE_FIELDS = [
  // Explicit account-total field observed in production responses (highest priority)
  'totalAccountValue',
  // Common explicit names
  'marketValue', 'totalValue', 'accountValue', 'balance',
  'endingMarketValue', 'currentMarketValue', 'endBalance',
  'currentBalance', 'accountBalance', 'endingBalance',
  'assetMarketValue', 'marketVal', 'mktVal', 'mktValue',
  'acctValue', 'portfolioValue', 'endValue', 'endingValue',
  'totalMarketValue', 'value', 'acctMktVal', 'assetValue',
  'currentValue', 'totalAssets', 'currentAssetValue',
  'acctBalance', 'totalBalance', 'marketBalance',
  // Do NOT include prvDayMarketValue / prvDaySecurityValue here —
  // those are yesterday's values and would silently show stale data.
];

function detectAccountValue(a) {
  // 1) Try known explicit field names
  for (const f of ACCOUNT_VALUE_FIELDS) {
    if (a[f] != null) {
      const v = toNum(a[f]);
      if (v != null) return { value: v, source: f };
    }
  }
  // 2) Try a few common nested containers
  for (const sub of ['balance', 'summary', 'assets', 'totals', 'balances']) {
    const obj = a[sub];
    if (obj && typeof obj === 'object') {
      for (const f of ACCOUNT_VALUE_FIELDS) {
        const v = toNum(obj[f]);
        if (v != null) return { value: v, source: `${sub}.${f}` };
      }
    }
  }
  // 3) Heuristic: scan numeric fields, exclude change/percent fields,
  //    pick the largest value-looking number (matches keywords value/balance/market/total/asset).
  const candidates = [];
  for (const [k, v] of Object.entries(a)) {
    const n = toNum(v);
    if (n == null) continue;
    if (n < 1 || n > 1e10) continue;
    if (/change|pct|percent|return|gain|loss/i.test(k)) continue;
    if (/value|balance|market|total|asset|portfolio|amount|principal/i.test(k)) {
      candidates.push({ k, v: n });
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.v - a.v);
    return { value: candidates[0].v, source: `inferred:${candidates[0].k}`, candidates };
  }
  return { value: null };
}

function normalizeBrokerageAccount(a) {
  const id = String(a.accountId || a.accountNumber || '');
  const det = detectAccountValue(a);
  if (det.source && det.source.startsWith('inferred:')) {
    dbg('warn', `Account value inferred (no known field) for "${a.accountName || a.nickName || id}": ${det.source}=${det.value}`, det.candidates || {});
  } else if (det.value == null) {
    // Dump everything primitive so the right field can be spotted in the Debug tab
    const dump = {};
    for (const [k, v] of Object.entries(a)) {
      if (v == null) continue;
      if (typeof v === 'object') {
        if (Array.isArray(v)) dump[k] = `[Array length=${v.length}]`;
        else dump[k] = `{keys: ${Object.keys(v).slice(0, 12).join(', ')}}`;
      } else {
        dump[k] = v;
      }
    }
    dbg('warn', `Account value NOT detected for "${a.accountName || a.nickName || id}" — copy this from the Debug tab and open a GitHub issue`, dump);
  }
  return {
    id,
    accountNumber: String(a.accountNumber || ''),
    name: a.accountName || a.nickName || a.accountNumber || '',
    type: a.accountClassName || a.accountClassCode || '',
    value: det.value,
    change: toNum(a.dayChange ?? a.mktValChange ?? null),
    changePct: toNum(a.dayChangePercentage ?? a.dayChangePct ?? null),
    ytdReturn: toNum(a.ytdReturn ?? null),
    unrealizedGL: toNum(a.unrealizedGainLoss ?? a.uglt ?? null),
  };
}

function normalizeBrokeragePosition(p, parentAcct = null) {
  return {
    accountId: parentAcct ? String(parentAcct.accountId || parentAcct.accountNumber || '') : '',
    // Real field names from observed responses
    symbol: p.symbolCusip || p.symbol || p.cusip || '',
    name: (p.description || p.longName || '').replace(/\r\n/g, ' ').replace(/\s+/g, ' ').trim(),
    quantity: toNum(p.quantity ?? p.shares ?? 0),
    price: toNum(p.price ?? p.closePrice ?? 0),
    value: toNum(p.value ?? p.cusipValue ?? p.marketValue ?? 0),
    costBasis: toNum(p.costBasis ?? p.adjustedCostBasis ?? null),
    gl: toNum(p.unrealizedGainLoss ?? p.uglt ?? p.gainLoss ?? null),
    glPct: toNum(p.unrealizedGainLossPct ?? p.ugltPct ?? null),
    assetClass: p.investmentType || p.securityType || p.assetClass || '',
    allocPct: toNum(p.cusipAccountPercentage ?? null),
  };
}

function normalizeBrokerageTxn(t, parentAcct = null) {
  // Prefer accountId from the transaction itself if present — the activity
  // endpoint sometimes returns all rows under a single parent block but
  // tags each row with its own accountId/accountNumber. Fall back to the
  // parent block's id only when the row doesn't carry one.
  const ownId = t.accountId || t.accountNumber;
  const parentId = parentAcct && (parentAcct.accountId || parentAcct.accountNumber);
  return {
    accountId: String(ownId || parentId || ''),
    date: t.asOfDate || t.tradeDate || t.transactionDate || '',
    type: t.transCode || t.transactionType || t.activityType || '',
    symbol: t.symbolCusip || t.symbol || '',
    description: (t.description || '').replace(/\r\n/g, ' ').trim(),
    amount: toNum(t.amount ?? 0),
    quantity: toNum(t.quantity ?? t.shares ?? 0),
    price: toNum(t.price ?? 0),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function extractArray(data, keys) {
  for (const k of keys) {
    if (Array.isArray(data?.[k]) && data[k].length) return data[k];
  }
  if (Array.isArray(data) && data.length) return data;
  return [];
}

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,%]/g, ''));
  return isNaN(n) ? null : n;
}

// ── Overlay lifecycle ────────────────────────────────────────────────────────
function injectToggleButton() {
  if (document.getElementById('mf-toggle-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'mf-toggle-btn';
  btn.textContent = '◆ MyFolio View';
  btn.title = 'Switch to MyFolio dashboard';
  btn.addEventListener('click', toggleOverlay);
  document.body.appendChild(btn);
}

function setToggleLabel(open) {
  const btn = document.getElementById('mf-toggle-btn');
  if (!btn) return;
  btn.textContent = open ? '◆ Standard View' : '◆ MyFolio View';
  btn.title = open ? 'Return to standard brokerage view' : 'Switch to MyFolio dashboard';
}

function toggleOverlay() {
  state.overlayOpen = !state.overlayOpen;
  const overlay = document.getElementById('mf-overlay');
  if (overlay) overlay.classList.toggle('mf-hidden', !state.overlayOpen);
  if (state.overlayOpen && !overlay) buildOverlay();
  setToggleLabel(state.overlayOpen);
}

function refreshOverlay() {
  if (!state.overlayOpen) return;
  const overlay = document.getElementById('mf-overlay');
  if (!overlay) buildOverlay();
  else renderContent();
}

function buildOverlay() {
  state.loadStart = Date.now();
  const overlay = document.createElement('div');
  overlay.id = 'mf-overlay';
  overlay.innerHTML = `
    <div class="mf-topbar">
      <div class="mf-logo">◆ MyFolio <span class="mf-version">${escHtml(MF_VERSION)}</span></div>
      <nav class="mf-nav">
        <button class="mf-tab active" data-tab="overview">Overview</button>
        <button class="mf-tab" data-tab="holdings">Holdings</button>
        <button class="mf-tab" data-tab="transactions">Transactions</button>
        <button class="mf-tab" data-tab="performance">Performance</button>
      </nav>
      <button class="mf-help-btn" id="mf-help-btn" title="Help for this tab">?</button>
      <button class="mf-close" id="mf-close-btn" title="Close">✕</button>
    </div>
    <div class="mf-help-panel mf-hidden" id="mf-help-panel">
      <div class="mf-help-header">
        <h3 id="mf-help-title">Help</h3>
        <button class="mf-help-close" id="mf-help-close" title="Close help">✕</button>
      </div>
      <div class="mf-help-body" id="mf-help-body"></div>
    </div>
    <div class="mf-statusbar" id="mf-statusbar">
      <span class="mf-spinner"></span>
      <span id="mf-status-text">Listening for data…</span>
      <button class="mf-reload-btn" id="mf-reload-btn" title="Reload page to re-capture data">↺ Reload page</button>
    </div>
    <div class="mf-progress" id="mf-progress">
      <div class="mf-progress-fill" id="mf-progress-fill"></div>
    </div>
    <div class="mf-body" id="mf-body"></div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('mf-close-btn').addEventListener('click', toggleOverlay);
  document.getElementById('mf-reload-btn').addEventListener('click', () => location.reload());
  document.getElementById('mf-help-btn').addEventListener('click', toggleHelp);
  document.getElementById('mf-help-close').addEventListener('click', toggleHelp);
  overlay.querySelectorAll('.mf-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.mf-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      renderContent();
      // Keep the help panel in sync with the current tab if it's open
      if (state.helpOpen) renderHelpPanel();
    });
  });

  // Delegated click handling for account-card drill-in and breadcrumb back
  const bodyEl = document.getElementById('mf-body');
  if (bodyEl) {
    bodyEl.addEventListener('click', (e) => {
      // Breadcrumb chip clears
      if (e.target.closest('#mf-back-all'))     { e.stopPropagation(); state.selectedAccountId = null; renderContent(); return; }
      if (e.target.closest('#mf-clear-class'))  { e.stopPropagation(); state.selectedAssetClass = null; renderContent(); return; }
      if (e.target.closest('#mf-clear-symbol')) { e.stopPropagation(); state.selectedSymbol = null;     renderContent(); return; }

      // Overview chart period tab
      const periodBtn = e.target.closest('.mf-chart-period[data-chart-period]');
      if (periodBtn) {
        e.preventDefault();
        e.stopPropagation();
        state.overviewChartPeriod = periodBtn.dataset.chartPeriod;
        renderContent();
        return;
      }

      // Positions KPI → Holdings tab
      if (e.target.closest('#mf-positions-kpi')) {
        state.activeTab = 'holdings';
        document.querySelectorAll('.mf-tab').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === 'holdings');
        });
        renderContent();
        return;
      }

      // Pagination button
      const pager = e.target.closest('.mf-pager');
      if (pager) {
        handlePagerClick(pager.dataset.scope, pager.dataset.page);
        return;
      }

      // Sortable column header
      const sortHeader = e.target.closest('th.mf-sortable[data-col]');
      if (sortHeader) {
        handleSortClick(sortHeader.dataset.scope, sortHeader.dataset.col);
        return;
      }

      // Holdings row → drill into a single symbol
      const row = e.target.closest('.mf-row-clickable[data-symbol]');
      if (row && row.dataset.symbol) {
        state.selectedSymbol = row.dataset.symbol;
        state.txnPage = 1;
        if (state.activeTab !== 'transactions') {
          state.activeTab = 'transactions';
          document.querySelectorAll('.mf-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === 'transactions');
          });
        }
        renderContent();
        return;
      }

      // Account card → filter (Total Portfolio card resets)
      const card = e.target.closest('.mf-account-card[data-acct-id]');
      if (card) {
        const id = card.dataset.acctId;
        if (id === 'portfolio') {
          state.selectedAccountId = null;
          state.selectedAssetClass = null;
          state.selectedSymbol = null;
        } else {
          state.selectedAccountId = id;
        }
        state.holdingsPage = 1; state.txnPage = 1;
        renderContent();
      }
    });
    bodyEl.addEventListener('change', (e) => {
      const ps = e.target.closest('.mf-pagesize');
      if (!ps) return;
      const scope = ps.dataset.scope;
      const v = ps.value === 'all' ? 'all' : parseInt(ps.value, 10);
      if (scope === 'holdings') { state.holdingsPageSize = v; state.holdingsPage = 1; }
      else if (scope === 'txn') { state.txnPageSize = v; state.txnPage = 1; }
      renderContent();
    });
    bodyEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const sortHeader = e.target.closest('th.mf-sortable[data-col]');
      if (sortHeader) {
        e.preventDefault();
        handleSortClick(sortHeader.dataset.scope, sortHeader.dataset.col);
        return;
      }
      const card = e.target.closest('.mf-account-card[data-acct-id]');
      if (card) {
        e.preventDefault();
        const id = card.dataset.acctId;
        if (id === 'portfolio') {
          state.selectedAccountId = null;
          state.selectedAssetClass = null;
          state.selectedSymbol = null;
        } else {
          state.selectedAccountId = id;
        }
        state.holdingsPage = 1; state.txnPage = 1;
        renderContent();
        return;
      }
      const row = e.target.closest('.mf-row-clickable[data-symbol]');
      if (row && row.dataset.symbol) {
        e.preventDefault();
        state.selectedSymbol = row.dataset.symbol;
        state.txnPage = 1;
        if (state.activeTab !== 'transactions') {
          state.activeTab = 'transactions';
          document.querySelectorAll('.mf-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === 'transactions');
          });
        }
        renderContent();
      }
    });
  }

  state.activeTab = 'overview';
  renderContent();
  updateStatusBar();
}

// ── Status bar ──────────────────────────────────────────────────────────────
function updateStatusBar() {
  const el = document.getElementById('mf-status-text');
  const bar = document.getElementById('mf-statusbar');
  const spinner = bar?.querySelector('.mf-spinner');
  if (!el || !bar) return;

  const hasData = state.accounts.length || state.positions.length || state.transactions.length;

  if (hasData) {
    // Count the real (non-portfolio) accounts, and note how many are hidden
    const realAccounts = state.accounts.filter(a => a.id !== 'portfolio');
    const hiddenCount = realAccounts.filter(isHiddenZeroAccount).length;
    const parts = [];
    if (realAccounts.length) {
      const star = hiddenCount > 0 ? `<span class="mf-footnote-mark">*</span>` : '';
      parts.push(`${realAccounts.length} account${realAccounts.length === 1 ? '' : 's'}${star}`);
    }
    if (state.positions.length) parts.push(`${state.positions.length} positions`);
    if (state.transactions.length) parts.push(`${state.transactions.length} transactions`);
    const elapsed = state.loadStart ? ((Date.now() - state.loadStart) / 1000).toFixed(1) : '?';
    const footnote = hiddenCount > 0
      ? ` <span class="mf-footnote-note">*${hiddenCount} $0/closed account${hiddenCount > 1 ? 's' : ''} hidden</span>`
      : '';
    el.innerHTML = `Loaded in ${elapsed}s — ${parts.join(' · ')}${footnote}`;
    bar.classList.remove('mf-status-warn');
    bar.classList.add('mf-status-ok');
    if (spinner) spinner.classList.add('mf-spinner-done');
    const prog = document.getElementById('mf-progress');
    if (prog) prog.style.display = 'none';
    return;
  }

  // Still waiting — compute ETA
  const elapsedMs = state.loadStart ? Date.now() - state.loadStart : 0;
  const elapsedS = Math.round(elapsedMs / 1000);
  bar.classList.remove('mf-status-ok');

  const avg = state.avgLoadMs;
  const STUCK_THRESHOLD = avg ? Math.max(avg * 2, 45000) : 60000; // 2x avg or 60s floor

  if (elapsedMs > STUCK_THRESHOLD) {
    // Stuck
    const mins = Math.floor(elapsedS / 60);
    const secs = elapsedS % 60;
    const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    el.textContent = avg
      ? `Stuck — ${elapsed} elapsed (usually loads in ${fmtSec(avg)}). Try ↺ Reload page.`
      : `Stuck — ${elapsed} with no data. Try ↺ Reload page.`;
    bar.classList.add('mf-status-warn');
    if (spinner) spinner.classList.remove('mf-spinner-done');
  } else if (avg) {
    // ETA available
    const etaMs = avg - elapsedMs;
    const etaS = Math.max(0, Math.round(etaMs / 1000));
    const pct = Math.min(100, Math.round((elapsedMs / avg) * 100));
    const callNote = state.apiCallCount ? ` · ${state.apiCallCount} responses observed` : '';
    el.textContent = etaS > 0
      ? `Loading… ${elapsedS}s elapsed · avg ${fmtSec(avg)} · ~${fmtSec(etaMs)} remaining${callNote}`
      : `Almost there… ${elapsedS}s elapsed (avg ${fmtSec(avg)})${callNote}`;
    bar.classList.remove('mf-status-warn');
    setProgressWidth(pct);
  } else {
    // No history yet
    const callNote = state.apiCallCount ? `${state.apiCallCount} responses received, parsing…` : 'Listening for data…';
    el.textContent = elapsedS > 8
      ? `${elapsedS}s — ${callNote} (first session, no ETA yet)`
      : callNote;
    if (elapsedMs > 30000) bar.classList.add('mf-status-warn');
    else bar.classList.remove('mf-status-warn');
    if (spinner) spinner.classList.remove('mf-spinner-done');
  }
}

function fmtSec(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function setProgressWidth(pct) {
  const bar = document.getElementById('mf-progress-fill');
  if (bar) bar.style.width = pct + '%';
}

// Tick every second while waiting
setInterval(() => {
  if (!state.overlayOpen) return;
  const hasData = state.accounts.length || state.positions.length || state.transactions.length;
  if (!hasData) updateStatusBar();
}, 1000);

// ── Account filtering helpers ───────────────────────────────────────────────
function isHiddenZeroAccount(a) {
  if (!a || a.id === 'portfolio') return false;
  const zeroVal = a.value === 0 || a.value == null;
  const zeroChange = (a.change == null || a.change === 0) && (a.changePct == null || a.changePct === 0);
  return zeroVal && zeroChange;
}

function getSelectedAccount() {
  const id = state.selectedAccountId;
  if (!id || id === 'portfolio') return null;
  return state.accounts.find(a => a.id === id) || null;
}

// Positions filtered by account only — used by the allocation chart so the
// user keeps category context after clicking a slice.
function accountFilteredPositions() {
  const acct = getSelectedAccount();
  return acct ? state.positions.filter(p => p.accountId === acct.id) : state.positions;
}

function filteredPositions() {
  let positions = accountFilteredPositions();
  if (state.selectedAssetClass) {
    positions = positions.filter(p => classifyPosition(p) === state.selectedAssetClass);
  }
  return positions;
}

function filteredTransactions() {
  const acct = getSelectedAccount();
  let txns = acct ? state.transactions.filter(t => t.accountId === acct.id) : state.transactions;
  if (state.selectedSymbol) {
    const sym = state.selectedSymbol.toUpperCase();
    txns = txns.filter(t => (t.symbol || '').toUpperCase() === sym);
  }
  return txns;
}

function filteredDailyValues() {
  const acct = getSelectedAccount();
  if (acct) {
    const perAcct = state.accountDailyValues[acct.id];
    if (perAcct && perAcct.length >= 2) return perAcct;
    // No per-account series yet (user hasn't visited LPL Performance page for this
    // account). Fall back to the aggregate so charts still render.
    if (state.dailyValues.length >= 2) {
      dbg('info', `No per-account daily values for ${acct.name} — showing aggregate series`);
      return state.dailyValues;
    }
  }
  return state.dailyValues;
}

// Defensive date parser: handles ISO, "YYYY-MM-DD", "YYYYMMDD", "MM/DD/YYYY"
// and falls back to Date.parse. Returns null on failure.
function parseDateLoose(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d) ? null : d;
  const s = String(d).trim();
  let dt = new Date(s);
  if (!isNaN(dt)) return dt;
  if (/^\d{8}$/.test(s)) {
    dt = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    if (!isNaN(dt)) return dt;
  }
  return null;
}

// Compute MTD / YTD / 1-Year returns from a [{date, value}] series.
// Returns null for any frame where there isn't enough history.
function periodFramesFromSeries(dv) {
  if (!dv || dv.length < 2) return { mtd: null, ytd: null, oneY: null };

  // Pre-parse dates once; drop entries where parsing fails
  const parsed = dv.map(d => ({ date: parseDateLoose(d.date), value: d.value }))
                   .filter(d => d.date && d.value != null);
  if (parsed.length < 2) {
    dbg('warn', 'periodFramesFromSeries: could not parse enough dates', { sample: dv.slice(0, 3) });
    return { mtd: null, ytd: null, oneY: null };
  }
  const latest = parsed[parsed.length - 1];
  const latestDate = latest.date;

  const monthStart = new Date(latestDate.getFullYear(), latestDate.getMonth(), 1);
  const yearStart  = new Date(latestDate.getFullYear(), 0, 1);
  const oneYearAgo = new Date(latestDate.getFullYear() - 1, latestDate.getMonth(), latestDate.getDate());

  // Walk backwards to find the latest bar STRICTLY BEFORE the boundary date.
  // If no such bar exists, returns null (period is unknowable).
  const findBaseline = (boundary) => {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].date < boundary) return parsed[i];
    }
    return null;
  };
  const pct = s => (s && s.value > 0) ? ((latest.value - s.value) / s.value) * 100 : null;

  return {
    mtd:  pct(findBaseline(monthStart)),
    ytd:  pct(findBaseline(yearStart)),
    oneY: pct(findBaseline(oneYearAgo)),
  };
}

// ── Modified Dietz return ─────────────────────────────────────────────────────
// True time-weighted-ish return that adjusts for cash flows during the period.
// R = (EV - BV - NetFlow) / (BV + Σ Cn × Wn)
// where Wn = (totalDays − daysSincePeriodStart) / totalDays.
//
// We treat anything that looks like an external deposit/withdrawal/transfer/
// rollover/distribution as a cash flow. Internal market activity (buys/sells/
// dividends/interest reinvested in the account) is NOT a cash flow.
const CASH_FLOW_TYPE_RE = /^(DEP|DEPO|CT|CTBN|WD|WDR|DIST|DSTR|RMD|TF|TFI|TFO|XFR|XFRI|XFRO|ROL|ROLI|ROLO|CONTR|WTHDRW|JRNL|JOURN|JNL|JI|JO|JOI|ACH|WIRE|RMTC|FUND|RVST|REIN|ACH FUNDS|BENEFICIARY|JOURNAL)$/;
const CASH_FLOW_DESC_RE = /\bDEPOSIT\b|\bWITHDRAW|\bTRANSFER\b|ROLLOVER|CONTRIBUT|DISTRIBUT|JOURNAL|\bJNL\b|\bACH\b|\bWIRE\b|FUNDING|REDEMPTION|BENEFICIARY|DEATH DISTRIBUTION|FR A\/C|TO A\/C/i;
const SECURITIES_TRADE_TYPE_RE = /^(BUY|BOT|BUYTOOPEN|BUYTOCLOSE|SELL|SLD|SELLTOOPEN|SELLTOCLOSE|DIV|DIVIDEND|INT|INTEREST|FEE|COMM|EXCH|TAX|SPLIT|MERG)$/;
// Cash-sweep symbol patterns. The brokerage uses these for the insured cash
// account product. Sweep transactions (LPL type "mms") are INTERNAL — they
// offset every external journal/ACH with an equal-and-opposite entry, so
// counting them would double-count with the wrong sign. Excluded explicitly.
const CASH_SWEEP_SYMBOL_RE = /^(9999\d+|INSCASH)$/i;
const SWEEP_TYPE_RE = /^(MMS|MM|SWEEP)$/;

function isCashFlow(txn) {
  if (!txn) return false;
  const t = (txn.type || '').toUpperCase().trim();
  const d = (txn.description || '');
  // Explicit exclusion: cash-sweep records are internal accounting offsets,
  // not external flows. Check first so they don't slip through later rules.
  if (SWEEP_TYPE_RE.test(t)) return false;
  if (CASH_SWEEP_SYMBOL_RE.test(String(txn.symbol || ''))) return false;
  // Recognised cash-flow types or descriptions
  if (CASH_FLOW_TYPE_RE.test(t)) return true;
  if (CASH_FLOW_DESC_RE.test(d)) return true;
  // Heuristic: a transaction with no symbol and a non-zero amount that
  // isn't a known securities-trade type is likely an external cash flow.
  if (!txn.symbol && txn.amount != null && txn.amount !== 0 && !SECURITIES_TRADE_TYPE_RE.test(t)) return true;
  return false;
}

// Estimated dollar impact of a cash-flow transaction. For ordinary cash
// movements (deposits, withdrawals, ACH, journals), use the amount field.
// For security TRANSFERS (e.g. beneficiary inheritance — quantity>0,
// amount=0), estimate value using the position's current price (the only
// price we have). Sign is + for inflows, − for outflows; we infer direction
// from the description if amount is 0.
function cashFlowImpact(txn) {
  if (!txn) return 0;
  // Plain cash transactions: use amount directly
  if (txn.amount && Math.abs(txn.amount) >= 0.01) return txn.amount;
  // Security transfer: amount=0 but quantity != 0 — estimate value using
  // the position's current price. Look in the same account first, then any
  // account (the inherited shares might not be tagged in the same account
  // yet, and price is fungible across accounts anyway).
  if (txn.symbol && txn.quantity && Math.abs(txn.quantity) >= 0.001) {
    let pos = state.positions.find(p => p.symbol === txn.symbol && p.accountId === txn.accountId);
    if (!pos) pos = state.positions.find(p => p.symbol === txn.symbol);
    const price = (pos && pos.price) || txn.price || 0;
    if (price > 0) {
      // Direction: positive quantity = inflow, negative = outflow
      return txn.quantity * price;
    }
  }
  return 0;
}

function modifiedDietzReturn(series, transactions, periodStart) {
  if (!series || series.length < 2) return null;
  const parsed = series.map(d => ({ date: parseDateLoose(d.date), value: d.value }))
                       .filter(d => d.date && d.value != null);
  if (parsed.length < 2) return null;
  const latest = parsed[parsed.length - 1];

  // Find the baseline: the latest bar strictly before periodStart.
  let bvBar = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i].date < periodStart) { bvBar = parsed[i]; break; }
  }
  if (!bvBar) return null;
  const BV = bvBar.value;
  const startDate = bvBar.date;
  const endDate = latest.date;
  const totalDays = (endDate - startDate) / 86400000;
  if (BV <= 0 || totalDays < 1) return null;

  let netFlow = 0;
  let weightedFlow = 0;
  for (const txn of transactions || []) {
    if (!isCashFlow(txn)) continue;
    const td = parseDateLoose(txn.date);
    if (!td) continue;
    if (td < startDate || td > endDate) continue;
    const C = txn.amount || 0;
    if (C === 0) continue;
    const daysSinceStart = (td - startDate) / 86400000;
    const W = (totalDays - daysSinceStart) / totalDays;
    netFlow += C;
    weightedFlow += C * W;
  }

  const denominator = BV + weightedFlow;
  if (denominator <= 0) return null;
  return ((latest.value - BV - netFlow) / denominator) * 100;
}

// Compute MTD / YTD / 1Y using Modified Dietz, falling back to simple
// series-delta when there aren't enough transactions to bother. Note: LPL's
// own per-account PeriodTotalReturn (true TWR) is still preferred — this
// function provides MTD and 1Y, plus a YTD fallback if LPL didn't supply one.
function periodFramesAccurate(series, transactions) {
  if (!series || series.length < 2) return { mtd: null, ytd: null, oneY: null };
  const parsed = series.map(d => ({ date: parseDateLoose(d.date), value: d.value }))
                       .filter(d => d.date && d.value != null);
  if (parsed.length < 2) return { mtd: null, ytd: null, oneY: null };
  const latestDate = parsed[parsed.length - 1].date;
  const monthStart = new Date(latestDate.getFullYear(), latestDate.getMonth(), 1);
  const yearStart  = new Date(latestDate.getFullYear(), 0, 1);
  const oneYearAgo = new Date(latestDate.getFullYear() - 1, latestDate.getMonth(), latestDate.getDate());

  const simple = periodFramesFromSeries(series);
  const txns = transactions || [];

  const md = (start, fallback) => {
    const r = modifiedDietzReturn(series, txns, start);
    return r != null ? r : fallback;
  };
  return {
    mtd:  md(monthStart, simple.mtd),
    ytd:  md(yearStart, simple.ytd),
    oneY: md(oneYearAgo, simple.oneY),
  };
}

// ── Tab-specific help content ────────────────────────────────────────────────
const HELP_CONTENT = {
  overview: {
    title: 'Overview tab',
    body: `
      <p>The Overview is your starting point. It summarizes your whole portfolio (or a single account you have drilled into) and lets you slice your data with one click.</p>
      <h4>What each KPI shows</h4>
      <ul>
        <li><strong>Total Portfolio Value</strong> — current market value plus today's $ and % change. Switches to <em>Account Value</em> when a single account is selected.</li>
        <li><strong>MTD / YTD / 1-Year Return</strong> — period returns computed with the <em>Modified Dietz</em> formula, which adjusts for deposits, withdrawals, and transfers during the period. The brokerage's own YTD (true time-weighted return) is preferred when available. A value only appears when enough history has been captured; otherwise the card shows —.</li>
        <li><strong>Positions</strong> — number of holdings visible after the current filter. <strong>Click this card</strong> to jump to the Holdings tab.</li>
      </ul>
      <h4>Value Over Time panel</h4>
      <ul>
        <li>The stats panel to the left of the chart shows, for the selected period:
          <ul>
            <li><strong>Starting Market Value</strong> — portfolio value at the start of the period.</li>
            <li><strong>Deposits &amp; Withdrawals</strong> — net external cash flows during the period.</li>
            <li><strong>Investment Returns</strong> — gain or loss attributable to market performance (ending − starting − net cash flows).</li>
            <li><strong>Ending Market Value</strong> — most recent captured portfolio value.</li>
          </ul>
        </li>
        <li>Use the <strong>All / 1 Year / YTD / 1 Month</strong> buttons above the chart to change the time window. The stats panel updates to match. A date-range label at the bottom-left of the chart confirms what's shown.</li>
        <li>The blue line is your portfolio value; the orange dotted line is cumulative invested capital. <strong>$</strong> markers indicate captured cash-flow dates.</li>
      </ul>
      <h4>Account cards</h4>
      <ul>
        <li><strong>Click any account card</strong> to filter the entire dashboard (Overview, Holdings, Transactions, Performance) to just that account.</li>
        <li>While filtered to a single account, an "← All Accounts" chip returns you to the full portfolio view. Click the × on any active filter chip to clear it individually.</li>
        <li>Accounts with $0 balance and no activity (closed or transfer-only) are hidden automatically. The status bar shows a footnote indicating how many are hidden.</li>
      </ul>
      <h4>Allocation donut</h4>
      <ul>
        <li>Slices are grouped by asset class, using the broker's classification when available.</li>
        <li><strong>Click any slice — or any row of the legend table</strong> — to filter the Holdings tab to that class and jump there. Click the same item again to clear.</li>
        <li>An identical donut also appears at the top of the Holdings tab; on that tab, clicking a slice/row filters in place without switching tabs.</li>
      </ul>
    `,
  },
  holdings: {
    title: 'Holdings tab',
    body: `
      <p>Every position you currently hold. The page leads with the same allocation donut as the Overview, then a sortable table.</p>
      <h4>Columns</h4>
      <ul>
        <li><strong>Symbol</strong>, <strong>Name</strong> — security identifier and full description.</li>
        <li><strong>Qty</strong>, <strong>Price</strong> — current share count and last reported price.</li>
        <li><strong>Value</strong> — quantity × price (market value).</li>
        <li><strong>Alloc</strong> — this position's share of total portfolio value (or the filtered subtotal).</li>
        <li><strong>G/L</strong> &amp; <strong>G/L %</strong> — <em>unrealized</em> gain or loss vs. cost basis as reported by the broker. Realized gains from sales are not included here — see the Transactions tab.</li>
      </ul>
      <h4>Working with the table</h4>
      <ul>
        <li><strong>Click any column header</strong> to sort by that column. Click the same header again to flip ascending ↔ descending. ▲ / ▼ shows the active sort direction.</li>
        <li><strong>Click any row</strong> to drill into that symbol — you'll jump to the Transactions tab filtered to that ticker. The symbol filter shows as a removable chip you can clear later.</li>
        <li>Use the <strong>page-size dropdown</strong> at the top of the table to control how many rows show at once (10, 25, 50, 100, or All). Page through with ⏮ ◀ ▶ ⏭. Buttons disable at the first and last page.</li>
      </ul>
      <h4>Filters &amp; donut</h4>
      <ul>
        <li>Active filters (account, asset class, symbol) show as chips at the top. Click the × on any chip to clear it independently.</li>
        <li>The donut still reflects the current account context even when an asset-class filter is active, so you don't lose your bearings.</li>
        <li>The table footer always totals 100% of the visible rows.</li>
      </ul>
    `,
  },
  transactions: {
    title: 'Transactions tab',
    body: `
      <p>Every captured activity — buys, sells, dividends, deposits, withdrawals, fees, and journal entries (internal transfers between accounts).</p>
      <h4>Reading the rows</h4>
      <ul>
        <li><strong>Date</strong> — trade or activity date as reported by the broker.</li>
        <li><strong>Type</strong> — the broker's transaction code (e.g. BUY, SELL, DIV for dividend, DEP for deposit, WD for withdrawal, FEE, JNL for journal). The small colored badge groups codes for quick scanning.</li>
        <li><strong>Symbol</strong> and <strong>Description</strong> — the security involved and a human-readable detail (e.g. fund name, dividend kind).</li>
        <li><strong>Qty</strong>, <strong>Price</strong> — share count and per-share price for trades.</li>
        <li><strong>Amount</strong> — always shown as a positive number, color-coded by direction:
          <ul>
            <li><span style="color:#4ade80">green</span> = money <em>into</em> the account (deposit, sell proceeds, dividend).</li>
            <li><span style="color:#f87171">red</span> = money <em>out</em> of the account (buy, withdrawal, fee).</li>
          </ul>
        </li>
      </ul>
      <h4>Sorting &amp; paging</h4>
      <ul>
        <li>Every column is sortable. Default sort is by date descending (most recent first). The sort state persists across tab switches within the session.</li>
        <li>Page-size and navigation controls work just like the Holdings tab (10, 25, 50, 100, or All).</li>
      </ul>
      <h4>Drilling in</h4>
      <ul>
        <li>You can land here filtered to a single symbol by clicking a row on the Holdings tab, or filtered to a single account by clicking an account card on Overview.</li>
        <li>Active filters appear as chips at the top. Click the × on any chip to clear it independently. There is no built-in date-range filter.</li>
      </ul>
    `,
  },
  performance: {
    title: 'Performance tab',
    body: `
      <p>Detailed return analysis. Use this to answer "how have I actually done" beyond today's change.</p>
      <h4>Getting data to load</h4>
      <ul>
        <li>Charts populate from the same daily-value data the Overview's Value Over Time panel uses — your brokerage delivers it automatically when the Overview page is open. Spending a few seconds on the brokerage's Overview before clicking <strong>◆ MyFolio View</strong> ensures the data is captured.</li>
        <li>The Growth of $10,000 chart additionally requires at least one benchmark to be selected below.</li>
      </ul>
      <h4>What's shown</h4>
      <ul>
        <li><strong>Portfolio Value Over Time</strong> — your full captured daily-value history, in dollars. Unlike the Overview's chart, this one is not period-filtered.</li>
        <li><strong>Growth of $10,000</strong> — your portfolio (or selected account) normalized to a $10,000 start, plotted against every selected benchmark on the same axes. This is the apples-to-apples comparison view.</li>
        <li><strong>Period Returns table</strong> — YTD, 1-Year, 3-Year, 5-Year. Your portfolio appears in the highlighted row; benchmarks below it. 3-Year and 5-Year for your portfolio show — unless you have that much daily-value history captured; benchmarks can show them immediately because Stooq returns up to 5 years of price history.</li>
      </ul>
      <h4>Compare Against (benchmark picker)</h4>
      <ul>
        <li>Ten ETF benchmarks shown as toggleable chips — broad equity, international, bonds, real estate, and gold. Check any combination.</li>
        <li>Defaults to SPY (S&amp;P 500), VTI (US Total Market), and AGG (US Bonds). Selecting a new benchmark immediately triggers a price-history fetch.</li>
        <li>Selections persist across sessions.</li>
        <li>Price data is fetched from <code>stooq.com</code> and cached for 24 hours. The only thing sent is the ticker symbol and date range — no personal data.</li>
        <li>Benchmark returns are computed from price change only (no dividend reinvestment), so SPY/VTI will read slightly lower than the total-return figures you'd see on Morningstar. For informational purposes only.</li>
      </ul>
      <h4>About the math</h4>
      <ul>
        <li>Overview KPIs use the <em>Modified Dietz</em> formula to adjust for deposits/withdrawals. The Period Returns table on this tab uses simple percentage change from the start to the end of the period as a faster approximation. Always cross-check against your official statements before acting.</li>
      </ul>
    `,
  },
  debug: {
    title: 'Debug tab',
    body: `
      <p>The debug tab — reachable by triple-tapping <kbd>Shift</kbd> — shows every response MyFolio has observed, in order, with full JSON detail when available.</p>
      <h4>When to use it</h4>
      <ul>
        <li>Something looks wrong (a missing value, a misclassified asset, an account that didn't appear).</li>
        <li>You want to file a bug or request a fix. Click <strong>⎘ Copy debug log</strong> to package the log for pasting into a GitHub issue or any AI assistant.</li>
        <li>Click <strong>↺ Reload page</strong> to re-trigger the LPL API calls and capture fresh data.</li>
      </ul>
      <h4>What you'll see</h4>
      <ul>
        <li>Successful captures (✔), informational events (●), warnings (▲), and errors (✖).</li>
        <li>When MyFolio can't recognize a field name (for example an account's value field), it dumps all the available keys here so we can update the parser to handle your brokerage's shape.</li>
      </ul>
    `,
  },
};

// Shared glossary — appended to every help panel. Plain-English definitions
// for acronyms and finance terms that appear in MyFolio. (Ticker symbols are
// excluded — those are looked up by clicking through to the brokerage.)
const HELP_GLOSSARY = `
  <h4>Glossary & acronyms</h4>
  <dl class="mf-glossary">
    <dt>Day change</dt><dd>Change in market value since yesterday's close, in dollars and percent.</dd>
    <dt>MTD</dt><dd>Month-to-Date — return from the first day of the current calendar month through today.</dd>
    <dt>QTD</dt><dd>Quarter-to-Date — return from the start of the current calendar quarter through today.</dd>
    <dt>YTD</dt><dd>Year-to-Date — return from January 1 of the current year through today.</dd>
    <dt>1Y / 3Y / 5Y / 10Y</dt><dd>Trailing 1-, 3-, 5-, 10-year returns. Periods longer than one year are typically reported <em>annualized</em> (the constant per-year rate that compounds to the actual total return).</dd>
    <dt>ITD / SI</dt><dd>Inception-to-Date / Since Inception — return from the date the account was opened through today. Often reported annualized.</dd>
    <dt>TWR</dt><dd>Time-Weighted Return — the standard "investment performance" number. Eliminates the effect of deposits and withdrawals so you see how the investments themselves performed. Required by GIPS standards.</dd>
    <dt>MWR / IRR</dt><dd>Money-Weighted Return / Internal Rate of Return — measures the personal return including the timing of your contributions. Different from TWR when cash flows are significant.</dd>
    <dt>Modified Dietz</dt><dd>An approximation of TWR that adjusts for cash flows weighted by when they occurred during the period. What MyFolio uses for MTD / 1Y when LPL doesn't supply a figure.</dd>
    <dt>G/L</dt><dd>Gain/Loss — the difference between current market value and your cost basis. <em>Unrealized</em> G/L hasn't been locked in by a sale; <em>realized</em> G/L is from completed trades.</dd>
    <dt>Cost basis</dt><dd>What you paid (adjusted for splits, reinvestments, fees, etc.). Determines the taxable gain or loss when you sell.</dd>
    <dt>Allocation</dt><dd>The share of total portfolio value held in a single position or asset class, expressed as a percentage.</dd>
    <dt>Asset class</dt><dd>A category of investment with similar risk/return characteristics — e.g. cash, fixed income, equities, alternatives. LPL groups holdings into classes like "Mutual Funds, ETPs, and CIs" or "Cash and Cash Equivalents".</dd>
    <dt>ETF</dt><dd>Exchange-Traded Fund — a basket of securities that trades on an exchange like a stock.</dd>
    <dt>ETP</dt><dd>Exchange-Traded Product — broader category that includes ETFs plus exchange-traded notes (ETNs), commodity pools, etc.</dd>
    <dt>CI</dt><dd>Closed-end Investment fund or Collective Investment — a pooled fund traded on an exchange, but with a fixed share count (unlike open-end mutual funds).</dd>
    <dt>Mutual fund</dt><dd>A pooled investment that issues and redeems shares at end-of-day NAV.</dd>
    <dt>MMF / Money Market</dt><dd>Money Market Fund — a short-term, very low-risk fund that typically holds Treasury bills, commercial paper, CDs. Often used as a "sweep" for uninvested cash.</dd>
    <dt>FDIC</dt><dd>Federal Deposit Insurance Corporation — insures bank deposits up to $250,000 per depositor, per institution. Brokerage cash sweeps to FDIC-insured banks carry this coverage; market investments do not.</dd>
    <dt>SIPC</dt><dd>Securities Investor Protection Corporation — protects brokerage customers up to $500,000 (including $250,000 in cash) if the brokerage fails. Does NOT protect against market losses.</dd>
    <dt>NAV</dt><dd>Net Asset Value — the per-share value of a fund, computed daily after market close.</dd>
    <dt>RMD</dt><dd>Required Minimum Distribution — the amount the IRS requires you to withdraw annually from most retirement accounts starting at age 73.</dd>
    <dt>IRA</dt><dd>Individual Retirement Account — a tax-advantaged personal retirement account (Traditional, Roth, SEP, SIMPLE).</dd>
    <dt>Roth</dt><dd>A retirement account funded with after-tax dollars; qualified withdrawals are tax-free.</dd>
    <dt>401(k) / 403(b)</dt><dd>Employer-sponsored retirement plans. Often rolled into an IRA after leaving an employer.</dd>
    <dt>Rollover</dt><dd>Moving funds from one retirement account to another (e.g. 401(k) → IRA) without triggering tax.</dd>
    <dt>ACH</dt><dd>Automated Clearing House — the electronic bank-transfer network used for most deposits and withdrawals.</dd>
    <dt>SAM</dt><dd>Strategic Asset Management — LPL's wrap-fee managed account program. Account names like "SAM - Retirement" indicate the account is in this program.</dd>
    <dt>LPL</dt><dd>LPL Financial LLC — the broker-dealer hosting your account. The website MyFolio reads (<code>accountview.lpl.com</code>) belongs to them; MyFolio is not affiliated with or endorsed by LPL.</dd>
    <dt>Wrap account / Advisory account</dt><dd>An account where the advisor charges a single annual fee (a percentage of assets) instead of per-trade commissions.</dd>
    <dt>Benchmark</dt><dd>A market index used as a reference to measure your portfolio against. SPY tracks the S&amp;P 500; AGG tracks the US bond market; etc.</dd>
    <dt>Beneficiary</dt><dd>The person or entity who inherits the account if you pass away.</dd>
  </dl>
`;

function renderHelpPanel() {
  const panel = document.getElementById('mf-help-panel');
  const title = document.getElementById('mf-help-title');
  const body = document.getElementById('mf-help-body');
  if (!panel || !title || !body) return;
  if (!state.helpOpen) {
    panel.classList.add('mf-hidden');
    return;
  }
  const tab = state.activeTab || 'overview';
  const content = HELP_CONTENT[tab] || HELP_CONTENT.overview;
  title.textContent = content.title;
  body.innerHTML = content.body + HELP_GLOSSARY;
  panel.classList.remove('mf-hidden');
}

function toggleHelp() {
  state.helpOpen = !state.helpOpen;
  renderHelpPanel();
}

function renderBreadcrumb() {
  const acct = getSelectedAccount();
  const cls = state.selectedAssetClass;
  const sym = state.selectedSymbol;
  if (!acct && !cls && !sym) return '';
  const chips = [];
  if (acct) {
    chips.push(`<span class="mf-chip">Account: <strong>${escHtml(acct.name)}</strong>${acct.type ? ` · ${escHtml(acct.type)}` : ''} <button class="mf-chip-x" id="mf-back-all" title="Clear account filter">×</button></span>`);
  }
  if (cls) {
    chips.push(`<span class="mf-chip">Asset class: <strong>${escHtml(cls)}</strong> <button class="mf-chip-x" id="mf-clear-class" title="Clear asset-class filter">×</button></span>`);
  }
  if (sym) {
    chips.push(`<span class="mf-chip">Symbol: <strong>${escHtml(sym)}</strong> <button class="mf-chip-x" id="mf-clear-symbol" title="Clear symbol filter">×</button></span>`);
  }
  return `<div class="mf-breadcrumb">${chips.join('')}</div>`;
}

// ── Tab renderers ────────────────────────────────────────────────────────────
function renderContent() {
  const body = document.getElementById('mf-body');
  if (!body) return;
  const tab = state.activeTab || 'overview';
  if (tab === 'overview') {
    body.innerHTML = renderOverview();
    renderAllocationChart();
    initOverviewChart();
    return;
  }
  if (tab === 'holdings') { body.innerHTML = renderHoldings(); renderAllocationChart(); return; }
  if (tab === 'transactions') { body.innerHTML = renderTransactions(); return; }
  if (tab === 'performance') { body.innerHTML = renderPerformance(); initPerformanceCharts(); return; }
  if (tab === 'debug') renderDebugTab();
}

function renderOverview() {
  const selectedAcct = getSelectedAccount();
  const visibleAccounts = state.accounts.filter(a => !isHiddenZeroAccount(a));
  const hasAccounts = visibleAccounts.length > 0;

  // KPIs reflect either the selected account or the whole portfolio
  let kpiLabel, kpiValue, kpiChange, kpiChangePct, ytd;
  if (selectedAcct) {
    kpiLabel = 'Account Value';
    kpiValue = selectedAcct.value;
    kpiChange = selectedAcct.change || 0;
    kpiChangePct = selectedAcct.changePct != null ? selectedAcct.changePct : null;
    ytd = selectedAcct.ytdReturn;
  } else {
    const portfolio = state.accounts.find(a => a.id === 'portfolio');
    const indivAccts = state.accounts.filter(a => a.id !== 'portfolio' && !isHiddenZeroAccount(a));
    const total = portfolio ? portfolio.value : indivAccts.reduce((s, a) => s + (a.value || 0), 0);
    const totalChange = portfolio ? (portfolio.change || 0) : indivAccts.reduce((s, a) => s + (a.change || 0), 0);
    kpiLabel = 'Total Portfolio Value';
    kpiValue = total;
    kpiChange = totalChange;
    kpiChangePct = total > 0 && (total - totalChange) > 0 ? (totalChange / (total - totalChange)) * 100 : null;
    ytd = state.performance.ytdReturn;
  }

  const dv = filteredDailyValues();
  const txns = filteredTransactions();
  const framed = periodFramesAccurate(dv, txns);
  if (ytd == null) ytd = framed.ytd;
  const mtd = framed.mtd;
  const oneY = framed.oneY;

  const positionsCount = filteredPositions().length;
  const p = state.overviewChartPeriod || 'ytd';
  const hasDailyData = dv.length >= 2;

  // Determine how much history we have so we can show period tabs only when
  // they'd actually produce a visible change. Brokerages typically deliver
  // ~25 days at a time; without longer history, All/1Y/YTD/1M all render
  // the same series, which feels like the buttons "do nothing."
  let dataSpanDays = 0;
  if (hasDailyData) {
    const first = parseDateLoose(dv[0].date);
    const last  = parseDateLoose(dv[dv.length - 1].date);
    if (first && last) dataSpanDays = Math.round((last - first) / 86400000);
  }
  const showPeriodTabs = dataSpanDays > 31;  // need >1 month of data for periods to differ
  const dateRangeLabel = hasDailyData
    ? `${fmtDateShort(dv[0].date)} – ${fmtDateShort(dv[dv.length - 1].date)}`
    : '';

  // Flat-lined accounts (we don't have daily history for them and couldn't
  // find cash-flow transactions, so synthesis fell back to a constant equal
  // to today's value). Chart totals match the KPI, but the historical shape
  // before the flat-line starts is wrong. Disclose this honestly.
  let chartGapMsg = '';
  if (hasDailyData && !selectedAcct && Array.isArray(state.flatLinedAccounts) && state.flatLinedAccounts.length) {
    const names = state.flatLinedAccounts.map(a => `${a.name} (${fmt$(a.value)})`).join(', ');
    chartGapMsg = `Chart includes ${names} as a flat line at today's value — the brokerage did not deliver daily history for ${state.flatLinedAccounts.length > 1 ? 'these accounts' : 'this account'} and we have no cash-flow transactions to reconstruct the timing. Click your brokerage's Activity page (or Transactions / History) to capture deposit dates so the curve can be redrawn correctly.`;
  }

  return `
    <div class="mf-section">
      ${renderBreadcrumb()}
      <div class="mf-kpi-row">
        <div class="mf-kpi">
          <div class="mf-kpi-label">${kpiLabel}</div>
          <div class="mf-kpi-value">${hasAccounts || selectedAcct ? fmt$(kpiValue) : '—'}</div>
          ${(hasAccounts || selectedAcct)
            ? `<div class="mf-kpi-sub ${kpiChange >= 0 ? 'pos' : 'neg'}">${kpiChange >= 0 ? '▲' : '▼'} ${fmt$(Math.abs(kpiChange))}${kpiChangePct != null ? ` (${fmtPct(kpiChangePct)})` : ''} today</div>`
            : `<div class="mf-kpi-waiting"><span class="mf-spinner"></span> Waiting for data…</div>`}
        </div>
        <div class="mf-kpi">
          <div class="mf-kpi-label">MTD Return</div>
          <div class="mf-kpi-value ${mtd != null ? (mtd >= 0 ? 'pos' : 'neg') : 'muted'}">${mtd != null ? fmtPct(mtd) : '—'}</div>
        </div>
        <div class="mf-kpi">
          <div class="mf-kpi-label">YTD Return</div>
          <div class="mf-kpi-value ${ytd != null ? (ytd >= 0 ? 'pos' : 'neg') : 'muted'}">${ytd != null ? fmtPct(ytd) : '—'}</div>
        </div>
        <div class="mf-kpi">
          <div class="mf-kpi-label">1-Year Return</div>
          <div class="mf-kpi-value ${oneY != null ? (oneY >= 0 ? 'pos' : 'neg') : 'muted'}">${oneY != null ? fmtPct(oneY) : '—'}</div>
        </div>
        ${positionsCount ? `
        <div class="mf-kpi mf-kpi-clickable" id="mf-positions-kpi" role="button" tabindex="0" title="View Holdings">
          <div class="mf-kpi-label">Positions</div>
          <div class="mf-kpi-value">${positionsCount}</div>
          <div class="mf-kpi-sub mf-kpi-nav-hint">Holdings →</div>
        </div>` : ''}
      </div>

      <h3 class="mf-section-title">Value Over Time ${dateRangeLabel ? `<span class="mf-hint">${escHtml(dateRangeLabel)}</span>` : ''}</h3>
      <div class="mf-vot-container">
        <div class="mf-vot-left" id="mf-vot-stats">
          <div class="mf-vot-empty">Waiting for data…</div>
        </div>
        <div class="mf-vot-right">
          ${showPeriodTabs ? `
          <div class="mf-chart-period-bar">
            ${['all','1y','ytd','1m'].map(id => {
              const labels = { all: 'All', '1y': '1 Year', ytd: 'YTD', '1m': '1 Month' };
              return `<button class="mf-chart-period${p === id ? ' active' : ''}" data-chart-period="${id}">${labels[id]}</button>`;
            }).join('')}
          </div>
          ` : ''}
          <canvas id="mf-overview-chart" style="width:100%;display:block;height:220px"></canvas>
          ${!hasDailyData ? `<p class="mf-note" style="margin-top:8px">Waiting for daily value history — it loads automatically once your brokerage's Overview page has been open. If this persists after 10 seconds, try scrolling down to trigger the brokerage's chart section.</p>` : ''}
          ${chartGapMsg ? `<p class="mf-note mf-note-warn" style="margin-top:8px">${escHtml(chartGapMsg)}</p>` : ''}
        </div>
      </div>

      ${!selectedAcct && hasAccounts ? `
      <h3 class="mf-section-title">Accounts <span class="mf-hint">click any card to filter — Total Portfolio resets</span></h3>
      <div class="mf-account-grid">
        ${visibleAccounts.map(a => `
          <div class="mf-account-card mf-clickable" data-acct-id="${escHtml(a.id)}" role="button" tabindex="0">
            <div class="mf-account-name">${escHtml(a.name)}</div>
            <div class="mf-account-type">${escHtml(a.type || '')}</div>
            <div class="mf-account-value">${fmt$(a.value)}</div>
            ${a.change != null ? `<div class="mf-account-change ${a.change >= 0 ? 'pos' : 'neg'}">${a.change >= 0 ? '▲' : '▼'} ${fmt$(Math.abs(a.change))} (${fmtPct(a.changePct)}) today</div>` : ''}
            ${a.ytdReturn != null ? `<div class="mf-account-extra ${a.ytdReturn >= 0 ? 'pos' : 'neg'}">YTD ${fmtPct(a.ytdReturn)}</div>` : ''}
            ${a.unrealizedGL != null ? `<div class="mf-account-gl">Unrealized G/L: <span class="${a.unrealizedGL >= 0 ? 'pos' : 'neg'}">${fmt$(a.unrealizedGL)}</span></div>` : ''}
          </div>
        `).join('')}
      </div>` : !hasAccounts && !selectedAcct ? `<div class="mf-empty">Waiting for account data — navigate to your account overview page.</div>` : ''}

      ${positionsCount ? `
      <h3 class="mf-section-title">Allocation</h3>
      <div class="mf-alloc-container">
        <canvas id="mf-alloc-chart" width="240" height="240"></canvas>
        <div class="mf-alloc-legend" id="mf-alloc-legend"></div>
      </div>` : ''}
    </div>
  `;
}

function renderHoldings() {
  const positions = filteredPositions();
  if (!positions.length) {
    return `
      <div class="mf-section">
        ${renderBreadcrumb()}
        <div class="mf-empty">${getSelectedAccount() || state.selectedAssetClass ? 'No holdings match the current filter.' : 'No holdings data captured yet. Navigate to your holdings page.'}</div>
      </div>`;
  }

  const total = positions.reduce((s, p) => s + (p.value || 0), 0);
  const accessors = {
    symbol:   p => p.symbol,
    name:     p => p.name,
    quantity: p => p.quantity,
    price:    p => p.price,
    value:    p => p.value,
    alloc:    p => total > 0 ? (p.value / total) * 100 : 0,
    gl:       p => p.gl,
    glPct:    p => p.glPct,
  };
  const sorted = applySort(positions, 'holdings', accessors);
  const page = clampPage(state.holdingsPage, sorted.length, state.holdingsPageSize);
  state.holdingsPage = page; // persist any clamping
  const slice = pageSlice(sorted, page, state.holdingsPageSize);

  return `
    <div class="mf-section">
      ${renderBreadcrumb()}
      <h3 class="mf-section-title">Holdings <span class="mf-badge">${sorted.length}</span> <span class="mf-hint">click a row to see its transactions · click a header to sort</span></h3>
      <div class="mf-alloc-container" style="margin-bottom:24px">
        <canvas id="mf-alloc-chart" width="240" height="240"></canvas>
        <div class="mf-alloc-legend" id="mf-alloc-legend"></div>
      </div>
      ${renderPaginationBar('holdings', sorted.length, page, state.holdingsPageSize)}
      <table class="mf-table">
        <thead><tr>
          ${renderSortableHeader('holdings', 'symbol',   'Symbol')}
          ${renderSortableHeader('holdings', 'name',     'Name')}
          ${renderSortableHeader('holdings', 'quantity', 'Qty',   { right: true })}
          ${renderSortableHeader('holdings', 'price',    'Price', { right: true })}
          ${renderSortableHeader('holdings', 'value',    'Value', { right: true })}
          ${renderSortableHeader('holdings', 'alloc',    'Alloc', { right: true })}
          ${renderSortableHeader('holdings', 'gl',       'G/L',   { right: true })}
          ${renderSortableHeader('holdings', 'glPct',    'G/L %', { right: true })}
        </tr></thead>
        <tbody>
          ${slice.map(p => `
            <tr class="mf-row-clickable" data-symbol="${escHtml(p.symbol || '')}" role="button" tabindex="0">
              <td class="symbol">${escHtml(p.symbol)}</td>
              <td class="name">${escHtml(p.name)}</td>
              <td class="right">${p.quantity != null ? fmtNum(p.quantity) : '—'}</td>
              <td class="right">${p.price != null ? fmt$(p.price) : '—'}</td>
              <td class="right">${fmt$(p.value)}</td>
              <td class="right">${total > 0 ? fmtPct((p.value / total) * 100) : '—'}</td>
              <td class="right ${p.gl >= 0 ? 'pos' : p.gl < 0 ? 'neg' : ''}">${p.gl != null ? fmt$(p.gl) : '—'}</td>
              <td class="right ${p.glPct >= 0 ? 'pos' : p.glPct < 0 ? 'neg' : ''}">${p.glPct != null ? fmtPct(p.glPct) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="4"><strong>Total (all rows)</strong></td>
          <td class="right"><strong>${fmt$(total)}</strong></td>
          <td class="right">100%</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
    </div>
  `;
}

function renderTransactions() {
  const txns = filteredTransactions();
  if (!txns.length) {
    return `
      <div class="mf-section">
        ${renderBreadcrumb()}
        <div class="mf-empty">${getSelectedAccount() || state.selectedSymbol ? 'No transactions match the current filter.' : 'No transaction data captured yet. Navigate to your activity/history page.'}</div>
      </div>`;
  }

  const accessors = {
    date:        t => parseDateLoose(t.date)?.getTime() ?? 0,
    type:        t => t.type,
    symbol:      t => t.symbol,
    description: t => t.description,
    quantity:    t => t.quantity,
    price:       t => t.price,
    amount:      t => t.amount,
  };
  const sorted = applySort(txns, 'txn', accessors);
  const page = clampPage(state.txnPage, sorted.length, state.txnPageSize);
  state.txnPage = page;
  const slice = pageSlice(sorted, page, state.txnPageSize);

  return `
    <div class="mf-section">
      ${renderBreadcrumb()}
      <h3 class="mf-section-title">Recent Transactions <span class="mf-badge">${sorted.length}</span> <span class="mf-hint">click a header to sort</span></h3>
      ${renderPaginationBar('txn', sorted.length, page, state.txnPageSize)}
      <table class="mf-table">
        <thead><tr>
          ${renderSortableHeader('txn', 'date',        'Date')}
          ${renderSortableHeader('txn', 'type',        'Type')}
          ${renderSortableHeader('txn', 'symbol',      'Symbol')}
          ${renderSortableHeader('txn', 'description', 'Description')}
          ${renderSortableHeader('txn', 'quantity',    'Qty',    { right: true })}
          ${renderSortableHeader('txn', 'price',       'Price',  { right: true })}
          ${renderSortableHeader('txn', 'amount',      'Amount', { right: true })}
        </tr></thead>
        <tbody>
          ${slice.map(t => `
            <tr>
              <td class="date">${fmtDate(t.date)}</td>
              <td><span class="mf-txn-badge ${(t.type || '').toLowerCase()}">${escHtml(t.type)}</span></td>
              <td class="symbol">${escHtml(t.symbol) || '—'}</td>
              <td class="name">${escHtml(t.description)}</td>
              <td class="right">${t.quantity ? fmtNum(t.quantity) : '—'}</td>
              <td class="right">${t.price ? fmt$(t.price) : '—'}</td>
              <td class="right ${t.amount >= 0 ? 'pos' : 'neg'}">${fmt$(Math.abs(t.amount))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Pagination helpers ──────────────────────────────────────────────────────
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function totalPages(total, pageSize) {
  if (pageSize === 'all') return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

function clampPage(page, total, pageSize) {
  const tp = totalPages(total, pageSize);
  return Math.max(1, Math.min(page || 1, tp));
}

function pageSlice(arr, page, pageSize) {
  if (pageSize === 'all') return arr;
  const start = (page - 1) * pageSize;
  return arr.slice(start, start + pageSize);
}

function handlePagerClick(scope, action) {
  const cur = scope === 'holdings' ? state.holdingsPage : state.txnPage;
  const size = scope === 'holdings' ? state.holdingsPageSize : state.txnPageSize;
  const total = scope === 'holdings' ? filteredPositions().length : filteredTransactions().length;
  const tp = totalPages(total, size);
  let next = cur;
  if (action === 'first') next = 1;
  else if (action === 'prev') next = Math.max(1, cur - 1);
  else if (action === 'next') next = Math.min(tp, cur + 1);
  else if (action === 'last') next = tp;
  if (next === cur) return;
  if (scope === 'holdings') state.holdingsPage = next;
  else state.txnPage = next;
  renderContent();
}

// ── Sortable columns ────────────────────────────────────────────────────────
// Industry-standard: click a header to sort ascending; click the active header
// again to flip to descending. Indicator: ▲ (asc), ▼ (desc), ⇅ (neutral).
function renderSortableHeader(scope, col, label, opts = {}) {
  const sortState = scope === 'holdings' ? state.holdingsSort : state.txnSort;
  const active = sortState.col === col;
  const arrow = active ? (sortState.dir === 'asc' ? '▲' : '▼') : '<span class="mf-sort-neutral">⇅</span>';
  const cls = ['mf-sortable'];
  if (opts.right) cls.push('right');
  if (active) cls.push('mf-sort-active');
  return `<th class="${cls.join(' ')}" data-scope="${scope}" data-col="${col}" role="button" tabindex="0">${escHtml(label)} <span class="mf-sort-arrow">${arrow}</span></th>`;
}

function applySort(rows, scope, accessors) {
  const sortState = scope === 'holdings' ? state.holdingsSort : state.txnSort;
  const accessor = accessors[sortState.col];
  if (!accessor) return rows;
  const dir = sortState.dir === 'asc' ? 1 : -1;
  // Stable sort with mixed-type handling
  return [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

function handleSortClick(scope, col) {
  const sortState = scope === 'holdings' ? state.holdingsSort : state.txnSort;
  if (sortState.col === col) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.col = col;
    // Sensible default direction per column type
    const numericCols = ['qty', 'price', 'value', 'alloc', 'gl', 'glPct', 'amount', 'quantity'];
    sortState.dir = numericCols.includes(col) ? 'desc' : 'asc';
  }
  renderContent();
}

function renderPaginationBar(scope, total, page, pageSize) {
  const tp = totalPages(total, pageSize);
  const start = pageSize === 'all' ? 1 : (page - 1) * pageSize + 1;
  const end   = pageSize === 'all' ? total : Math.min(page * pageSize, total);
  const atFirst = page <= 1;
  const atLast  = page >= tp;
  return `
    <div class="mf-pagination" data-scope="${scope}">
      <div class="mf-pagination-info">
        Showing <strong>${start}</strong>–<strong>${end}</strong> of <strong>${total}</strong>
      </div>
      <div class="mf-pagination-controls">
        <label class="mf-pagination-label">Rows
          <select class="mf-pagesize" data-scope="${scope}">
            ${PAGE_SIZE_OPTIONS.map(n => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n}</option>`).join('')}
            <option value="all" ${pageSize === 'all' ? 'selected' : ''}>All</option>
          </select>
        </label>
        <div class="mf-pagination-buttons">
          <button class="mf-pager" data-scope="${scope}" data-page="first" ${atFirst ? 'disabled' : ''} title="First page">⏮</button>
          <button class="mf-pager" data-scope="${scope}" data-page="prev"  ${atFirst ? 'disabled' : ''} title="Previous page">◀</button>
          <span class="mf-pagination-pos">Page <strong>${page}</strong> of <strong>${tp}</strong></span>
          <button class="mf-pager" data-scope="${scope}" data-page="next"  ${atLast ? 'disabled' : ''} title="Next page">▶</button>
          <button class="mf-pager" data-scope="${scope}" data-page="last"  ${atLast ? 'disabled' : ''} title="Last page">⏭</button>
        </div>
      </div>
    </div>
  `;
}

// Benchmark catalog — real return figures are fetched from Stooq, not hardcoded.
const ALL_BENCHMARKS = [
  { id: 'spy',  label: 'S&P 500',          ticker: 'SPY'  },
  { id: 'vti',  label: 'US Total Market',  ticker: 'VTI'  },
  { id: 'qqq',  label: 'Nasdaq 100',       ticker: 'QQQ'  },
  { id: 'iwm',  label: 'Russell 2000',     ticker: 'IWM'  },
  { id: 'vxus', label: 'Intl Stocks',      ticker: 'VXUS' },
  { id: 'agg',  label: 'US Bonds',         ticker: 'AGG'  },
  { id: 'tlt',  label: 'Long-Term Bonds',  ticker: 'TLT'  },
  { id: 'tip',  label: 'TIPS (Inflation)', ticker: 'TIP'  },
  { id: 'vnq',  label: 'Real Estate',      ticker: 'VNQ'  },
  { id: 'gld',  label: 'Gold',             ticker: 'GLD'  },
];

// In-memory cache of benchmark price series, keyed by ticker
state.benchmarkSeries = {};
state.benchmarkLoading = new Set();
state.benchmarkErrors = {};

// Persist selected benchmark IDs across sessions
function getSelectedBenchmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem('myfolio_benchmarks') || 'null');
    if (Array.isArray(saved)) return saved;
  } catch (e) {}
  return ['spy', 'vti', 'agg'];
}
function saveSelectedBenchmarks(ids) {
  localStorage.setItem('myfolio_benchmarks', JSON.stringify(ids));
}

// ── Benchmark fetcher: Stooq first, Yahoo Finance fallback ──────────────────
// Generic SW-port fetch — opens a port to background.js, sends one request,
// resolves with { ok, text, finalUrl } or { ok:false, error }. Used for any
// origin the content script can't fetch directly.
async function fetchViaSW(url, timeoutMs = 25000) {
  if (!extensionContextValid()) return { ok: false, error: 'Extension not loaded' };
  return new Promise((resolve) => {
    let settled = false;
    let port;
    const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
    const done = (r) => { if (!settled) { settled = true; resolve(r); try { port && port.disconnect(); } catch (e) {} } };
    const watchdog = setTimeout(() => done({ ok: false, error: `No response within ${Math.round(timeoutMs/1000)}s` }), timeoutMs);
    try {
      port = chrome.runtime.connect({ name: 'mf-fetch' });
      port.onMessage.addListener((m) => { if (m && m.id === id) { clearTimeout(watchdog); done(m); } });
      port.onDisconnect.addListener(() => {
        const lastErr = (() => { try { return chrome.runtime?.lastError; } catch (e) { return null; } })();
        if (!settled) { clearTimeout(watchdog); done({ ok: false, error: `port disconnected${lastErr ? `: ${lastErr.message || lastErr}` : ''}` }); }
      });
      port.postMessage({ id, type: 'fetch', url });
    } catch (e) {
      clearTimeout(watchdog);
      done({ ok: false, error: `connect failed: ${e.message || e}` });
    }
  });
}

// Try Stooq's CSV download endpoint. Returns parsed series, or null on failure.
async function tryStooq(ticker, start, end) {
  const key = ticker.toLowerCase();
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=${key}.us&d1=${fmt(start)}&d2=${fmt(end)}&i=d`;
  dbg('info', `Stooq: requesting ${ticker}`, { url });
  const resp = await fetchViaSW(url);
  if (!resp.ok) { dbg('warn', `Stooq failed for ${ticker}: ${resp.error}`); return null; }
  const data = parseStooqCsv(resp.text);
  if (!data.length) { dbg('warn', `Stooq returned empty/unparseable CSV for ${ticker}`); return null; }
  dbg('ok', `Stooq: fetched ${data.length} bars for ${ticker}`);
  return data;
}

// Try Yahoo Finance's v8 chart endpoint. Yahoo returns JSON with parallel
// timestamp and close-price arrays. Free, no API key, generally CORS-friendly
// from extension origins.
async function tryYahoo(ticker, start, end) {
  const p1 = Math.floor(start.getTime() / 1000);
  const p2 = Math.floor(end.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`;
  dbg('info', `Yahoo: requesting ${ticker}`, { url });
  const resp = await fetchViaSW(url);
  if (!resp.ok) { dbg('warn', `Yahoo failed for ${ticker}: ${resp.error}`); return null; }
  let json;
  try { json = JSON.parse(resp.text); } catch (e) { dbg('warn', `Yahoo: bad JSON for ${ticker}`); return null; }
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) { dbg('warn', `Yahoo: missing timestamp array for ${ticker}`); return null; }
  const closes = result.indicators?.quote?.[0]?.close || [];
  const data = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const t = result.timestamp[i];
    const c = closes[i];
    if (t != null && c != null) {
      data.push({ date: new Date(t * 1000).toISOString().slice(0, 10), close: c });
    }
  }
  if (!data.length) { dbg('warn', `Yahoo: no usable bars for ${ticker}`); return null; }
  dbg('ok', `Yahoo: fetched ${data.length} bars for ${ticker}`);
  return data;
}

async function loadBenchmarkSeries(ticker) {
  const key = ticker.toLowerCase();
  if (state.benchmarkSeries[key]) return state.benchmarkSeries[key];
  if (state.benchmarkLoading.has(key)) return null;
  state.benchmarkLoading.add(key);

  try {
    const cached = await new Promise((resolve) => safeStorageGet(`bm_${key}`, resolve));
    const entry = cached[`bm_${key}`];
    if (entry && Date.now() - entry.fetchedAt < 24 * 60 * 60 * 1000) {
      state.benchmarkSeries[key] = entry.data;
      state.benchmarkLoading.delete(key);
      return entry.data;
    }

    const end = new Date();
    const start = new Date(end.getTime() - 1825 * 86400000); // 5 years back

    let data = await tryStooq(ticker, start, end);
    if (!data) data = await tryYahoo(ticker, start, end);
    if (!data) throw new Error('Both Stooq and Yahoo Finance failed — see Debug log');

    state.benchmarkSeries[key] = data;
    safeStorageSet({ [`bm_${key}`]: { data, fetchedAt: Date.now() } });
    return data;
  } catch (err) {
    state.benchmarkErrors[key] = String(err.message || err);
    dbg('warn', `Benchmark fetch failed for ${ticker}`, { error: state.benchmarkErrors[key] });
    return null;
  } finally {
    state.benchmarkLoading.delete(key);
  }
}

function parseStooqCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const dateIdx = header.findIndex(h => /^date$/i.test(h.trim()));
  const closeIdx = header.findIndex(h => /^close$/i.test(h.trim()));
  if (dateIdx < 0 || closeIdx < 0) return [];

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const date = cells[dateIdx];
    const close = parseFloat(cells[closeIdx]);
    if (date && !isNaN(close)) out.push({ date, close });
  }
  return out;
}

// Compute period returns from a price series
function periodReturns(series) {
  if (!series || series.length < 2) return { ytd: null, oneY: null, threeY: null, fiveY: null };
  const latest = series[series.length - 1];
  const find = (predicate) => {
    for (let i = series.length - 1; i >= 0; i--) if (predicate(series[i])) return series[i];
    return null;
  };
  const now = new Date(latest.date);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const startBars = {
    ytd:   find(d => new Date(d.date) < yearStart) || series[0],
    oneY:  find(d => new Date(d.date) <= new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())) || series[0],
    threeY:find(d => new Date(d.date) <= new Date(now.getFullYear() - 3, now.getMonth(), now.getDate())) || series[0],
    fiveY: find(d => new Date(d.date) <= new Date(now.getFullYear() - 5, now.getMonth(), now.getDate())) || series[0],
  };
  const pct = (s) => s ? ((latest.close - s.close) / s.close) * 100 : null;
  return { ytd: pct(startBars.ytd), oneY: pct(startBars.oneY), threeY: pct(startBars.threeY), fiveY: pct(startBars.fiveY) };
}

function renderPerformance() {
  const selected = getSelectedBenchmarks();
  const activeBenchmarks = ALL_BENCHMARKS.filter(b => selected.includes(b.id));
  const dailyValues = filteredDailyValues();
  const hasPortfolioHistory = dailyValues.length >= 2;
  const selectedAcct = getSelectedAccount();

  // Real returns from benchmark series (only what we have data for)
  const benchmarkRows = activeBenchmarks.map(b => {
    const series = state.benchmarkSeries[b.ticker.toLowerCase()];
    return { ...b, series, returns: series ? periodReturns(series) : null };
  });
  const hasAnyBenchmarkData = benchmarkRows.some(b => b.series);
  const allBenchmarksLoaded = activeBenchmarks.length > 0 && benchmarkRows.every(b => b.series);

  // Portfolio period returns — only show if we have either explicit performance data OR enough history
  const perf = state.performance;
  const portfolioReturns = hasPortfolioHistory
    ? periodReturns(dailyValues.map(d => ({ date: d.date, close: d.value })))
    : { ytd: selectedAcct ? (selectedAcct.ytdReturn ?? null) : (perf.ytdReturn ?? perf.ytd ?? null), oneY: null, threeY: null, fiveY: null };

  const hasAnyReturns = portfolioReturns.ytd != null || hasAnyBenchmarkData;
  const portfolioLabel = selectedAcct ? selectedAcct.name : 'Your Portfolio';

  return `
    <div class="mf-section">
      ${renderBreadcrumb()}
      ${hasPortfolioHistory ? `
        <h3 class="mf-section-title">Portfolio Value Over Time</h3>
        <canvas id="mf-perf-value" style="width:100%;display:block;margin-bottom:28px;height:260px"></canvas>
      ` : ''}

      ${hasPortfolioHistory ? `
        <h3 class="mf-section-title">Growth of $10,000</h3>
        <p class="mf-note" style="margin-top:-8px;margin-bottom:12px">Normalized to $10,000 invested at the start of available history. Compares your portfolio against selected benchmarks.</p>
        <div class="mf-chart-wrap" style="position:relative;margin-bottom:28px">
          <canvas id="mf-perf-growth" style="width:100%;display:block;height:300px"></canvas>
          <div id="mf-perf-growth-overlay" class="mf-chart-overlay mf-hidden">
            <span class="mf-spinner"></span>
            <span class="mf-chart-overlay-text">Loading benchmark data…</span>
          </div>
        </div>
      ` : ''}

      ${hasAnyReturns ? `
        <h3 class="mf-section-title">Period Returns</h3>
        <table class="mf-table" style="margin-bottom:24px">
          <thead><tr>
            <th>Portfolio / Benchmark</th>
            <th class="right">YTD</th>
            <th class="right">1 Year</th>
            <th class="right">3 Year</th>
            <th class="right">5 Year</th>
          </tr></thead>
          <tbody>
            <tr class="highlight">
              <td><strong>${escHtml(portfolioLabel)}</strong></td>
              ${returnCells(portfolioReturns)}
            </tr>
            ${benchmarkRows.map(b => b.series ? `
              <tr>
                <td>${b.label} <span style="color:#64748b;font-size:11px;font-family:monospace">${b.ticker}</span></td>
                ${returnCells(b.returns)}
              </tr>
            ` : `
              <tr>
                <td>${b.label} <span style="color:#64748b;font-size:11px;font-family:monospace">${b.ticker}</span></td>
                <td colspan="4" style="color:#64748b;font-size:12px;text-align:center;font-style:italic">
                  ${state.benchmarkErrors[b.ticker.toLowerCase()]
                    ? 'Unable to fetch market data — retry later'
                    : 'Loading market data…'}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}

      <h3 class="mf-section-title">Compare Against</h3>
      <div class="mf-bm-picker" id="mf-bm-picker">
        ${ALL_BENCHMARKS.map(b => `
          <label class="mf-bm-chip ${selected.includes(b.id) ? 'active' : ''}">
            <input type="checkbox" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''} style="display:none">
            ${b.label} <span class="mf-bm-ticker">${b.ticker}</span>
          </label>
        `).join('')}
      </div>

      ${!hasPortfolioHistory ? `
        <p class="mf-note">No historical portfolio data captured yet. Open the Overview or Performance section of your account so MyFolio can read the daily value history needed for charts.</p>
      ` : ''}

      <p class="mf-note">Benchmark price data is fetched from public sources (stooq.com) and cached for 24 hours. Returns are calculated from total price change and do not include dividend reinvestment. For informational purposes only — not investment advice.</p>
    </div>
  `;
}

function returnCells(r) {
  if (!r) return '<td class="right">—</td>'.repeat(4);
  const cell = v => `<td class="right ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v != null ? fmtPct(v) : '—'}</td>`;
  return cell(r.ytd) + cell(r.oneY) + cell(r.threeY) + cell(r.fiveY);
}

function initPerformanceCharts() {
  // Wire up the benchmark picker
  document.getElementById('mf-bm-picker')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const ids = [...document.querySelectorAll('#mf-bm-picker input:checked')].map(i => i.value);
      saveSelectedBenchmarks(ids);
      renderContent();
      // Kick off fetches for newly-selected benchmarks
      for (const id of ids) {
        const b = ALL_BENCHMARKS.find(x => x.id === id);
        if (b && !state.benchmarkSeries[b.ticker.toLowerCase()]) {
          loadBenchmarkSeries(b.ticker).then(() => {
            if (state.activeTab === 'performance') renderContent();
          });
        }
      }
    });
  });

  // Trigger fetches for any selected benchmark we don't have yet
  const selected = getSelectedBenchmarks();
  let triggered = false;
  for (const id of selected) {
    const b = ALL_BENCHMARKS.find(x => x.id === id);
    if (b && !state.benchmarkSeries[b.ticker.toLowerCase()] && !state.benchmarkLoading.has(b.ticker.toLowerCase())) {
      triggered = true;
      loadBenchmarkSeries(b.ticker).then(() => {
        if (state.activeTab === 'performance') renderContent();
      });
    }
  }

  drawPortfolioValueChart();
  drawGrowthChart();
}

// ── Portfolio value over time (single line, your portfolio in $) ────────────
function drawPortfolioValueChart() {
  const canvas = document.getElementById('mf-perf-value');
  const vals = filteredDailyValues();
  if (!canvas || !vals.length) return;
  setupCanvas(canvas, 260);
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth, H = 260;
  const pad = { top: 16, right: 20, bottom: 36, left: 80 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const values = vals.map(d => d.value);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const range = (maxV - minV) || 1;

  const xOf = i => pad.left + (i / (vals.length - 1)) * cw;
  const yOf = v => pad.top + ch - ((v - minV) / range) * ch;

  drawChartBackground(ctx, W, H);
  drawGridY(ctx, pad, cw, ch, 4, (v) => fmt$(minV + range * v));

  // Filled area under line
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(129,140,248,0.35)');
  grad.addColorStop(1, 'rgba(129,140,248,0.02)');
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(vals[0].value));
  for (let i = 1; i < vals.length; i++) ctx.lineTo(xOf(i), yOf(vals[i].value));
  ctx.lineTo(xOf(vals.length - 1), pad.top + ch);
  ctx.lineTo(xOf(0), pad.top + ch);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(vals[0].value));
  for (let i = 1; i < vals.length; i++) ctx.lineTo(xOf(i), yOf(vals[i].value));
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth = 2;
  ctx.stroke();

  drawXAxisDates(ctx, vals.map(v => v.date), xOf, H);
}

// ── Growth of $10,000 (portfolio + benchmarks, normalized) ──────────────────
function drawGrowthChart() {
  const canvas = document.getElementById('mf-perf-growth');
  const portfolioSeries = filteredDailyValues();
  if (!canvas) return;
  if (!portfolioSeries.length) return;

  // Show/hide loading overlay based on whether any selected benchmark is
  // still being fetched. The chart still draws with whatever's available
  // so the user sees a partial result while waiting for the rest.
  const overlay = document.getElementById('mf-perf-growth-overlay');
  if (overlay) {
    const stillLoading = getSelectedBenchmarks().some(id => {
      const b = ALL_BENCHMARKS.find(x => x.id === id);
      if (!b) return false;
      const key = b.ticker.toLowerCase();
      return state.benchmarkLoading.has(key) || (!state.benchmarkSeries[key] && !state.benchmarkErrors[key]);
    });
    overlay.classList.toggle('mf-hidden', !stillLoading);
  }

  setupCanvas(canvas, 300);

  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth, H = 300;
  const pad = { top: 16, right: 130, bottom: 36, left: 80 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  // Determine common date range based on portfolio history
  const portfolioStart = portfolioSeries[0].date;
  const portfolioEnd = portfolioSeries[portfolioSeries.length - 1].date;

  // Build series list: portfolio + each selected benchmark
  const selected = getSelectedBenchmarks();
  const selectedAcct = getSelectedAccount();
  const lines = [{
    label: selectedAcct ? selectedAcct.name : 'Your Portfolio',
    color: '#818cf8',
    width: 3,
    series: portfolioSeries.map(d => ({ date: d.date, close: d.value })),
  }];

  const benchmarkColors = ['#fb923c', '#34d399', '#facc15', '#60a5fa', '#f472b6', '#a78bfa', '#22d3ee', '#fbbf24', '#94a3b8', '#fda4af'];
  selected.forEach((id, i) => {
    const b = ALL_BENCHMARKS.find(x => x.id === id);
    if (!b) return;
    const series = state.benchmarkSeries[b.ticker.toLowerCase()];
    if (!series) return;
    // Trim to portfolio's date window
    const filtered = series.filter(d => d.date >= portfolioStart && d.date <= portfolioEnd);
    if (filtered.length >= 2) {
      lines.push({ label: b.ticker, color: benchmarkColors[i % benchmarkColors.length], width: 2, series: filtered });
    }
  });

  // Normalize each series to start at 10000
  const normalized = lines.map(l => {
    const base = l.series[0].close;
    return { ...l, points: l.series.map(d => ({ date: d.date, value: (d.close / base) * 10000 })) };
  });

  // Find global min/max for Y axis
  let minY = Infinity, maxY = -Infinity;
  normalized.forEach(l => l.points.forEach(p => { if (p.value < minY) minY = p.value; if (p.value > maxY) maxY = p.value; }));
  const range = (maxY - minY) || 1;

  // Get a unified date axis (union of all dates would be huge; use portfolio's)
  const allDates = portfolioSeries.map(d => d.date);
  const xOf = (date) => {
    const idx = allDates.findIndex(d => d >= date);
    const ratio = idx < 0 ? 1 : (idx / Math.max(1, allDates.length - 1));
    return pad.left + ratio * cw;
  };
  const yOf = v => pad.top + ch - ((v - minY) / range) * ch;

  drawChartBackground(ctx, W, H);

  // Reference line at $10,000 (starting value)
  const baselineY = yOf(10000);
  ctx.strokeStyle = '#334155';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.left, baselineY); ctx.lineTo(pad.left + cw, baselineY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#64748b'; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
  ctx.fillText('$10K start', pad.left - 6, baselineY + 3);

  drawGridY(ctx, pad, cw, ch, 4, (v) => fmt$(Math.round(minY + range * v)));

  // Draw each line
  normalized.forEach(l => {
    ctx.beginPath();
    l.points.forEach((p, i) => {
      const x = xOf(p.date);
      const y = yOf(p.value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    ctx.stroke();
  });

  drawXAxisDates(ctx, allDates, (date) => xOf(date), H, true);

  // Legend (right side). Each entry occupies a full row containing the
  // colour chip, the label, and the final $ value on a second line — needs
  // ~34px per row so the two text lines don't overlap.
  const ROW_H = 34;
  const lx = pad.left + cw + 12, ly = pad.top + 6;
  normalized.forEach((l, i) => {
    const y = ly + i * ROW_H;
    // Colour chip
    ctx.fillStyle = l.color;
    ctx.fillRect(lx, y + 4, 14, 3);
    // Label (line 1)
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 11px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(l.label, lx + 20, y + 8);
    // Final $ value (line 2), color-coded vs $10k baseline
    const final = l.points[l.points.length - 1].value;
    ctx.fillStyle = final >= 10000 ? '#4ade80' : '#f87171';
    ctx.font = '11px system-ui';
    ctx.fillText(fmt$(Math.round(final)), lx + 20, y + 22);
  });
}

// ── Canvas helpers ──────────────────────────────────────────────────────────
function setupCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 1000;
  canvas.width = W * dpr;
  canvas.height = height * dpr;
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
}

function drawChartBackground(ctx, W, H) {
  ctx.fillStyle = '#0a1020';
  ctx.fillRect(0, 0, W, H);
}

function drawGridY(ctx, pad, cw, ch, lines, labelFn) {
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  for (let i = 0; i <= lines; i++) {
    const y = pad.top + (ch / lines) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    const ratio = (lines - i) / lines;
    ctx.fillText(labelFn(ratio), pad.left - 6, y + 4);
  }
}

function drawXAxisDates(ctx, dates, xOf, H, byDate = false) {
  if (!dates.length) return;
  ctx.fillStyle = '#64748b'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(dates.length / 6));
  for (let i = 0; i < dates.length; i += step) {
    const x = byDate ? xOf(dates[i]) : xOf(i);
    ctx.fillText(fmtDateShort(dates[i]), x, H - 8);
  }
}

function fmtDateShort(d) {
  if (!d) return '';
  const dt = parseDateLoose(d);
  if (!dt) return String(d).slice(0, 10);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Debug tab ────────────────────────────────────────────────────────────────
function renderDebugTab() {
  const body = document.getElementById('mf-body');
  if (!body) return;

  const levelIcon = { info: '●', ok: '✔', warn: '▲', err: '✖' };

  body.innerHTML = `
    <div class="mf-section mf-debug-section">
      <div class="mf-debug-header">
        <h3 class="mf-section-title" style="margin:0">Debug Log <span class="mf-badge">${state.logs.length}</span></h3>
        <div class="mf-debug-summary">
          <span>Responses observed: <strong>${state.apiCallCount}</strong></span>
          <span>Accounts: <strong>${state.accounts.length}</strong></span>
          <span>Positions: <strong>${state.positions.length}</strong></span>
          <span>Transactions: <strong>${state.transactions.length}</strong></span>
        </div>
        <button class="mf-reload-btn" onclick="location.reload()">↺ Reload page</button>
        <button class="mf-reload-btn" id="mf-copy-log">⎘ Copy debug log</button>
        <button class="mf-reload-btn" id="mf-clear-log">✕ Clear</button>
      </div>
      <div class="mf-debug-log" id="mf-debug-log">
        ${state.logs.length === 0
          ? '<div class="mf-debug-empty">No log entries yet. API calls will appear here as they are intercepted.</div>'
          : state.logs.map(e => `
            <div class="mf-debug-entry mf-dbg-${e.level}">
              <span class="mf-dbg-time">${e.t}</span>
              <span class="mf-dbg-icon">${levelIcon[e.level] || '●'}</span>
              <span class="mf-dbg-msg">${escHtml(e.msg)}</span>
              ${e.detail ? `<pre class="mf-dbg-detail">${escHtml(e.detail)}</pre>` : ''}
            </div>
          `).join('')}
      </div>
    </div>
  `;

  document.getElementById('mf-clear-log')?.addEventListener('click', () => {
    state.logs = [];
    renderDebugTab();
  });

  document.getElementById('mf-copy-log')?.addEventListener('click', () => {
    const text = buildCopyPayload();
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('mf-copy-log');
      if (btn) { btn.textContent = '✔ Copied!'; setTimeout(() => { btn.textContent = '⎘ Copy debug log'; }, 2000); }
    });
  });
}

function buildCopyPayload() {
  const lines = [];
  lines.push('=== MyFolio Debug Report ===');
  lines.push(`Page URL: ${location.href}`);
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`Responses observed: ${state.apiCallCount}`);
  lines.push(`Accounts parsed: ${state.accounts.length}`);
  lines.push(`Positions parsed: ${state.positions.length}`);
  lines.push(`Transactions parsed: ${state.transactions.length}`);
  lines.push('');
  lines.push('=== All Network Requests (newest first) ===');
  // Pull just the MF_NET entries to show every URL seen
  const netLogs = state.logs.filter(e => e.msg.includes('http') || e.msg.match(/^\W*(✔|✘)/));
  (netLogs.length ? netLogs : state.logs).forEach(e => {
    lines.push(`[${e.t}] ${e.msg}`);
    if (e.detail) lines.push(e.detail);
  });
  lines.push('');
  lines.push('=== Full Log ===');
  state.logs.forEach(e => {
    lines.push(`[${e.t}][${e.level}] ${e.msg}`);
    if (e.detail) lines.push(e.detail);
  });
  return lines.join('\n');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Allocation donut chart (pure canvas, no dependencies) ───────────────────
function classifyPosition(p) {
  // First prefer a *granular* broker field (e.g. broadAssetClass returns
  // "US Stocks"). Skip generic catch-all fields like investmentType, which
  // typically returns "Mutual Funds, ETPs, and Closed-End Funds" — that's
  // a wrapper category, not an asset class, and collapses everything into
  // one bucket. We refine it below via text matching instead.
  const granular = p.broadAssetClass || p.assetCategory || p.subAssetClass;
  if (granular) return granular;

  const text = `${p.symbol || ''} ${p.name || ''}`.toUpperCase();

  // Cash & equivalents (check first — money-market funds often match other regexes)
  if (/CASH|MONEY MKT|MONEY MARKET|MMKT|MMF|FDIC|SWEEP|FUNDS DEPOSITED|GOVT MMK|GOVERNMENT MMK/.test(text)) return 'Cash';
  // Fixed income
  if (/\bBOND\b|\bNOTE\b|TREASUR|\bBILL\b|MUNI|GOVT|GOVERNMENT|AGGREGATE BOND|\bTIPS?\b|\bTLT\b|\bAGG\b|FIXED INCOME|HIGH YIELD|CORP BOND|CORPORATE BOND|INTERMEDIATE TERM|SHORT TERM BOND/.test(text)) return 'Bonds';
  // International / non-US equity
  if (/INTERNATIONAL|FOREIGN|EUROPE|PACIFIC|EMERGING|GLOBAL EX|EX[- ]US|\bVXUS\b|\bEFA\b|\bVEU\b|\bIEFA\b|\bVWO\b|\bEEM\b|WORLD EX|DEVELOPED MKT|EMERGING MKT|ACWI|MSCI EAFE/.test(text)) return 'Non-US Stocks';
  // Real estate
  if (/REAL ESTATE|REIT\b|\bVNQ\b|\bIYR\b|\bRWR\b/.test(text)) return 'Real Estate';
  // Commodities / metals
  if (/\bGOLD\b|\bGLD\b|\bIAU\b|COMMODIT|SILVER|\bSLV\b|PRECIOUS METAL/.test(text)) return 'Commodities';
  // Balanced / target-date / multi-asset
  if (/BALANCED|TARGET DATE|TARGET RETIREMENT|LIFECYCLE|LIFE STRATEGY|RETIREMENT 20|ALL ASSET|MULTI[- ]ASSET|ALLOCATION FUND/.test(text)) return 'Balanced';
  // US equity — broad funds, indexes, and "stock" mentions
  if (/S&P|SPDR|VANGUARD|ISHARES|FIDELITY|SCHWAB|RUSSELL|TOTAL STOCK|TOTAL MARKET|US STOCK|U\.S\. STOCK|GROWTH FUND|VALUE FUND|LARGE CAP|MID CAP|SMALL CAP|EQUITY INCOME|DIVIDEND|\bSPY\b|\bVTI\b|\bIVV\b|\bQQQ\b|\bIWM\b|EQUITY FUND/.test(text)) return 'US Stocks';
  // Fund / ETF that didn't match a specific class — likely US Stocks for most US investors
  if (/\bETF\b|\bFUND\b|TRUST|PORTFOLIO/.test(text)) return 'US Stocks';

  // Last resort: use any broker-supplied generic class
  return p.assetClass || p.investmentType || p.securityType || 'Uncategorized';
}

function buildAllocationGroups(positions) {
  // Strict grouping by asset class — no top-N truncation. Within each group
  // we keep the position list so users can drill in.
  const groups = {};
  for (const p of positions) {
    const cls = classifyPosition(p);
    if (!groups[cls]) groups[cls] = { total: 0, items: [] };
    groups[cls].total += (p.value || 0);
    groups[cls].items.push(p);
  }
  // Sort categories by total descending
  return Object.entries(groups)
    .map(([label, g]) => ({ label, total: g.total, items: g.items }))
    .sort((a, b) => b.total - a.total);
}

function renderAllocationChart() {
  const canvas = document.getElementById('mf-alloc-chart');
  const positions = accountFilteredPositions();
  if (!canvas || !positions.length) return;

  const ctx = canvas.getContext('2d');
  const total = positions.reduce((s, p) => s + (p.value || 0), 0);
  if (total === 0) return;

  const groups = buildAllocationGroups(positions);

  const colors = ['#3b82f6','#64748b','#22c55e','#f97316','#a855f7',
                   '#ef4444','#eab308','#06b6d4','#ec4899','#84cc16'];

  const size = 240;
  canvas.width = size; canvas.height = size;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';

  const cx = size / 2, cy = size / 2, r = 100, hole = 62;
  let angle = -Math.PI / 2;
  const slices = [];

  ctx.clearRect(0, 0, size, size);

  const highlightLabel = state.selectedAssetClass;

  groups.forEach((g, i) => {
    const sliceAngle = (g.total / total) * 2 * Math.PI;
    const isHighlighted = highlightLabel === g.label;
    const isDimmed = highlightLabel && !isHighlighted;
    const startAngle = angle;
    const endAngle = angle + sliceAngle;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r + (isHighlighted ? 5 : 0), startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.globalAlpha = isDimmed ? 0.3 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.stroke();
    slices.push({ label: g.label, start: startAngle, end: endAngle, color: colors[i % colors.length] });
    angle = endAngle;
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, hole, 0, 2 * Math.PI);
  ctx.fillStyle = '#0f172a';
  ctx.fill();

  // Center text
  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 14px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(fmt$(total), cx, cy - 4);
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#64748b';
  ctx.fillText(highlightLabel ? 'Filtered' : 'Total', cx, cy + 14);

  // Wire up canvas click (slice selection)
  if (!canvas.dataset.mfWired) {
    canvas.dataset.mfWired = '1';
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('click', (e) => {
      const sl = canvas.__mfSlices;
      if (!sl || !sl.length) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r + 6 || dist < hole) return;
      let a = Math.atan2(dy, dx);
      while (a < -Math.PI / 2) a += 2 * Math.PI;
      while (a >= 3 * Math.PI / 2) a -= 2 * Math.PI;
      const hit = sl.find(s => a >= s.start && a < s.end);
      if (!hit) return;
      toggleAssetClass(hit.label);
    });
  }
  canvas.__mfSlices = slices;

  // HTML legend — rendered into companion div
  const legendEl = document.getElementById('mf-alloc-legend');
  if (!legendEl) return;
  legendEl.innerHTML = `
    <div class="mf-alloc-legend-hdr">
      <span>Asset</span><span>Value</span><span>Percent</span>
    </div>
    ${groups.map((g, i) => {
      const pct = (g.total / total) * 100;
      const isActive = highlightLabel === g.label;
      return `<div class="mf-alloc-row${isActive ? ' active' : ''}" data-alloc-label="${escHtml(g.label)}">
        <span class="mf-alloc-swatch" style="background:${colors[i % colors.length]}"></span>
        <span class="mf-alloc-name">${escHtml(g.label)}</span>
        <span class="mf-alloc-val">${fmt$(g.total)}</span>
        <span class="mf-alloc-pct">${fmtPct(pct)}</span>
      </div>`;
    }).join('')}
  `;
  legendEl.querySelectorAll('.mf-alloc-row').forEach(row => {
    row.addEventListener('click', () => toggleAssetClass(row.dataset.allocLabel));
  });
}

function toggleAssetClass(label) {
  if (state.selectedAssetClass === label) {
    state.selectedAssetClass = null;
  } else {
    state.selectedAssetClass = label;
    if (state.activeTab !== 'holdings') {
      state.activeTab = 'holdings';
      document.querySelectorAll('.mf-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === 'holdings');
      });
    }
  }
  renderContent();
}

// ── Overview "Value Over Time" chart ────────────────────────────────────────
function getOverviewChartSeries() {
  const dv = filteredDailyValues();
  if (!dv.length) return [];
  const period = state.overviewChartPeriod || 'ytd';
  if (period === 'all') return dv;

  const latest = parseDateLoose(dv[dv.length - 1].date);
  if (!latest) return dv;

  let cutoff;
  if (period === '1y')  cutoff = new Date(latest.getFullYear() - 1, latest.getMonth(), latest.getDate());
  else if (period === 'ytd') cutoff = new Date(latest.getFullYear(), 0, 1);
  else if (period === '1m')  cutoff = new Date(latest.getFullYear(), latest.getMonth() - 1, latest.getDate());
  else return dv;

  const filtered = dv.filter(d => { const dt = parseDateLoose(d.date); return dt && dt >= cutoff; });
  return filtered.length >= 2 ? filtered : dv;
}

function getOverviewChartStats(series, txns) {
  if (!series || series.length < 2) return null;
  const startValue = series[0].value;
  const endValue = series[series.length - 1].value;
  const startDate = parseDateLoose(series[0].date);
  const endDate = parseDateLoose(series[series.length - 1].date);

  let netCashFlow = 0;
  const cashFlows = [];
  for (const t of txns) {
    if (!isCashFlow(t)) continue;
    const td = parseDateLoose(t.date);
    if (!td || !startDate || !endDate) continue;
    if (td >= startDate && td <= endDate) {
      netCashFlow += (t.amount || 0);
      cashFlows.push({ date: t.date, amount: t.amount || 0 });
    }
  }

  return {
    startValue, endValue, netCashFlow,
    investmentReturns: endValue - startValue - netCashFlow,
    cashFlows,
    startDate: series[0].date,
    endDate: series[series.length - 1].date,
  };
}

function renderVotStats(s) {
  const el = document.getElementById('mf-vot-stats');
  if (!el || !s) return;
  el.innerHTML = `
    <div class="mf-vot-stat">
      <div class="mf-vot-stat-label">Starting Market Value</div>
      <div class="mf-vot-stat-value">${fmt$(s.startValue)}</div>
      <div class="mf-vot-stat-date">${fmtDate(s.startDate)}</div>
    </div>
    <div class="mf-vot-stat">
      <div class="mf-vot-stat-label">Deposits &amp; Withdrawals</div>
      <div class="mf-vot-stat-value ${s.netCashFlow >= 0 ? 'pos' : 'neg'}">${fmt$(s.netCashFlow)}</div>
    </div>
    <hr class="mf-vot-divider">
    <div class="mf-vot-stat">
      <div class="mf-vot-stat-label">Investment Returns</div>
      <div class="mf-vot-stat-value ${s.investmentReturns >= 0 ? 'pos' : 'neg'}">${fmt$(s.investmentReturns)}</div>
    </div>
    <hr class="mf-vot-divider">
    <div class="mf-vot-stat">
      <div class="mf-vot-stat-label">Ending Market Value</div>
      <div class="mf-vot-stat-value mf-vot-end-value">${fmt$(s.endValue)}</div>
      <div class="mf-vot-stat-date">As of ${fmtDate(s.endDate)}</div>
    </div>
  `;
}

function initOverviewChart() {
  drawOverviewChart();
}

function drawOverviewChart() {
  const canvas = document.getElementById('mf-overview-chart');
  if (!canvas) return;

  const series = getOverviewChartSeries();
  const txns = filteredTransactions();
  const stats = getOverviewChartStats(series, txns);
  renderVotStats(stats);

  if (series.length < 2) {
    setupCanvas(canvas, 220);
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth || 600;
    drawChartBackground(ctx, W, 220);
    ctx.fillStyle = '#475569';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for LPL Value Over Time data to load…', W / 2, 110);
    return;
  }

  setupCanvas(canvas, 220);
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth, H = 220;
  const pad = { top: 20, right: 20, bottom: 44, left: 70 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  // Build cumulative-invested line: startValue + running sum of cash flows up to each date
  const cfSorted = (stats?.cashFlows || [])
    .map(cf => ({ dt: parseDateLoose(cf.date), amount: cf.amount }))
    .filter(cf => cf.dt)
    .sort((a, b) => a.dt - b.dt);

  const investedLine = series.map(d => {
    const dt = parseDateLoose(d.date);
    let cum = series[0].value;
    for (const cf of cfSorted) { if (cf.dt <= dt) cum += cf.amount; }
    return cum;
  });

  const allValues = [...series.map(d => d.value), ...investedLine];
  const minV = Math.min(...allValues), maxV = Math.max(...allValues);
  const range = (maxV - minV) || 1;
  const xOf = i => pad.left + (i / Math.max(1, series.length - 1)) * cw;
  const yOf = v => pad.top + ch - ((v - minV) / range) * ch;

  drawChartBackground(ctx, W, H);
  drawGridY(ctx, pad, cw, ch, 4, (v) => fmtAxisDollar(minV + range * v));

  // Filled area under portfolio value line
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(96,165,250,0.28)');
  grad.addColorStop(1, 'rgba(96,165,250,0.02)');
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(series[0].value));
  for (let i = 1; i < series.length; i++) ctx.lineTo(xOf(i), yOf(series[i].value));
  ctx.lineTo(xOf(series.length - 1), pad.top + ch);
  ctx.lineTo(xOf(0), pad.top + ch);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Orange dotted "time period investments" line
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(investedLine[0]));
  for (let i = 1; i < investedLine.length; i++) ctx.lineTo(xOf(i), yOf(investedLine[i]));
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Blue solid portfolio value line
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(series[0].value));
  for (let i = 1; i < series.length; i++) ctx.lineTo(xOf(i), yOf(series[i].value));
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = 2;
  ctx.stroke();

  // X-axis date labels (above cash-flow marker zone)
  drawXAxisDates(ctx, series.map(d => d.date), xOf, H - 22);

  // Cash flow $ markers — deduplicate by x pixel
  const usedX = new Set();
  for (const cf of cfSorted) {
    let bestIdx = -1, bestDelta = Infinity;
    for (let i = 0; i < series.length; i++) {
      const sd = parseDateLoose(series[i].date);
      if (!sd) continue;
      const delta = Math.abs(sd - cf.dt);
      if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
    }
    if (bestIdx < 0 || bestDelta > 5 * 86400000) continue;
    const x = Math.round(xOf(bestIdx));
    if (usedX.has(x)) continue;
    usedX.add(x);
    const markerY = H - 10;
    ctx.beginPath();
    ctx.arc(x, markerY, 8, 0, 2 * Math.PI);
    ctx.fillStyle = '#1e3a5f';
    ctx.fill();
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#93c5fd';
    ctx.font = 'bold 9px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('$', x, markerY + 3);
  }

  // Legend (top right of chart area)
  const items = [
    { color: '#60a5fa', dash: false, label: 'Value' },
    { color: '#f97316', dash: true,  label: 'Time Period Investments' },
  ];
  ctx.font = '10px system-ui';
  let lx = W - pad.right;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const tw = ctx.measureText(item.label).width;
    lx -= tw + 4;
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.fillText(item.label, lx, pad.top + 10);
    lx -= 20;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.dash ? 1.5 : 2;
    if (item.dash) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(lx, pad.top + 6);
    ctx.lineTo(lx + 14, pad.top + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    lx -= 10;
  }
}

function fmtAxisDollar(n) {
  if (n == null || isNaN(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + Math.round(n);
}

// ── Formatters ───────────────────────────────────────────────────────────────
function fmt$(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(2) + '%';
}
function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(n);
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Secret debug toggle: triple-tap Shift within 800ms ──────────────────────
(function () {
  let count = 0, timer = null;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift') return;
    count++;
    clearTimeout(timer);
    if (count >= 3) {
      count = 0;
      activateDebugTab();
    } else {
      timer = setTimeout(() => { count = 0; }, 800);
    }
  }, true);
})();

function activateDebugTab() {
  if (!state.overlayOpen) {
    state.overlayOpen = true;
    buildOverlay();
    setToggleLabel(true);
  }
  const overlay = document.getElementById('mf-overlay');
  if (overlay) overlay.classList.remove('mf-hidden');
  overlay?.querySelectorAll('.mf-tab').forEach(b => b.classList.remove('active'));
  // Ensure debug tab button exists (add it if hidden)
  let debugBtn = overlay?.querySelector('[data-tab="debug"]');
  if (!debugBtn) {
    const nav = overlay?.querySelector('.mf-nav');
    if (nav) {
      debugBtn = document.createElement('button');
      debugBtn.className = 'mf-tab mf-tab-debug';
      debugBtn.dataset.tab = 'debug';
      debugBtn.textContent = 'Debug';
      debugBtn.addEventListener('click', () => {
        overlay.querySelectorAll('.mf-tab').forEach(b => b.classList.remove('active'));
        debugBtn.classList.add('active');
        state.activeTab = 'debug';
        renderContent();
      });
      nav.appendChild(debugBtn);
    }
  }
  if (debugBtn) debugBtn.classList.add('active');
  state.activeTab = 'debug';
  renderContent();
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
  if (document.body) injectToggleButton();
  else document.addEventListener('DOMContentLoaded', injectToggleButton);
}
init();
