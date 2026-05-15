// MyFolio — Chrome extension content script
// Copyright (c) 2026 JJJJJ Enterprises, LLC.
// Licensed under the MIT License (see LICENSE).
//
// Listens for API captures from interceptor.js, parses brokerage account data,
// and injects/updates the MyFolio dashboard overlay. No data leaves the browser
// except public ETF price fetches to stooq.com for benchmark comparisons.

const state = {
  accounts: [],
  positions: [],
  transactions: [],
  performance: {},
  dailyValues: [],         // [{date, value}] aggregated across accounts
  accountDailyValues: {},  // accountId -> [{date, value}]
  selectedAccountId: null, // null = view all; 'portfolio' acts the same as null
  selectedAssetClass: null, // asset-class label set by clicking an allocation slice
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

// Load historical timing data from storage on startup
chrome.storage.local.get(['loadTimes'], (result) => {
  const times = result.loadTimes || [];
  if (times.length) {
    state.avgLoadMs = times.reduce((a, b) => a + b, 0) / times.length;
  }
});

function recordLoadTime(ms) {
  if (state.sessionRecorded) return;
  state.sessionRecorded = true;
  chrome.storage.local.get(['loadTimes'], (result) => {
    const times = result.loadTimes || [];
    times.push(ms);
    if (times.length > 10) times.shift(); // keep last 10 sessions
    state.avgLoadMs = times.reduce((a, b) => a + b, 0) / times.length;
    chrome.storage.local.set({ loadTimes: times });
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
    const { url, data } = msg;
    const topKeys = data && typeof data === 'object' ? Object.keys(data) : [];
    dbg('info', `JSON body parsed`, { url, topKeys, type: Array.isArray(data) ? `array[${data.length}]` : typeof data });
    parseApiResponse(url, data);
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
    if (Array.isArray(actd?.accounts) && !state.transactions.length) {
      const all = [];
      for (const acct of actd.accounts) {
        if (Array.isArray(acct.activities)) {
          for (const t of acct.activities) all.push(normalizeBrokerageTxn(t, acct));
        }
      }
      if (all.length) {
        dbg('ok', `Intraday activityIntraDay: ${all.length} transactions`, all[0]);
        state.transactions = all;
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
        const acctSeries = [];
        for (const dv of (cd.dailyValues || [])) {
          const d = dv.date || dv.asOfDate || dv.Date;
          const v = toNum(dv.endValue ?? dv.value ?? dv.portfolioValue ?? dv.Value ?? dv.EndValue);
          if (d && v != null) {
            byDate[d] = (byDate[d] || 0) + v;
            acctSeries.push({ date: d, value: v });
          }
        }
        acctDiag.push({ id: acctId, name: acct.accountName || acct.nickName || '', days: acctSeries.length, ytd: cd.PeriodTotalReturn });
        if (acctId && acctSeries.length) {
          acctSeries.sort((a, b) => a.date.localeCompare(b.date));
          perAcct[acctId] = acctSeries;
        }
        // Patch returns onto the matching state.accounts entry (account-vot's
        // PeriodTotalReturn = YTD per LPL's chart query default)
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
      backfillAccountValues();

      const sorted = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
      if (sorted.length) {
        state.dailyValues = sorted.map(([date, value]) => ({ date, value }));
        dbg('ok', `account-vot: ${sorted.length} daily values across ${Object.keys(perAcct).length} accounts`, { latest: sorted[sorted.length - 1], perAccount: acctDiag });
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
// by account-vot. Runs from both endpoints so it works regardless of arrival
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

// ── Brokerage-specific normalizers (field names from awsp.myaccountviewonline.com) ─
const ACCOUNT_VALUE_FIELDS = [
  'marketValue', 'totalValue', 'accountValue', 'balance',
  'endingMarketValue', 'currentMarketValue', 'endBalance',
  'currentBalance', 'accountBalance', 'endingBalance',
  'assetMarketValue', 'marketVal', 'mktVal', 'mktValue',
  'acctValue', 'portfolioValue', 'endValue', 'endingValue',
  'totalMarketValue', 'value', 'acctMktVal', 'assetValue',
  'currentValue', 'totalAssets', 'currentAssetValue',
  'acctBalance', 'totalBalance', 'marketBalance',
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
    dbg('warn', `Account value NOT detected for "${a.accountName || a.nickName || id}" — paste this in your bug report`, dump);
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
  return {
    accountId: parentAcct ? String(parentAcct.accountId || parentAcct.accountNumber || '') : '',
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
      <div class="mf-logo">◆ MyFolio</div>
      <nav class="mf-nav">
        <button class="mf-tab active" data-tab="overview">Overview</button>
        <button class="mf-tab" data-tab="holdings">Holdings</button>
        <button class="mf-tab" data-tab="transactions">Transactions</button>
        <button class="mf-tab" data-tab="performance">Performance</button>
      </nav>
      <button class="mf-close" id="mf-close-btn" title="Close">✕</button>
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
  overlay.querySelectorAll('.mf-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.mf-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      renderContent();
    });
  });

  // Delegated click handling for account-card drill-in and breadcrumb back
  const bodyEl = document.getElementById('mf-body');
  if (bodyEl) {
    bodyEl.addEventListener('click', (e) => {
      if (e.target.closest('#mf-back-all')) {
        state.selectedAccountId = null;
        renderContent();
        return;
      }
      if (e.target.closest('#mf-clear-class')) {
        state.selectedAssetClass = null;
        renderContent();
        return;
      }
      const card = e.target.closest('.mf-account-card[data-acct-id]');
      if (card) {
        const id = card.dataset.acctId;
        if (id === 'portfolio') {
          // Clicking the Total Portfolio card clears any active filter
          state.selectedAccountId = null;
          state.selectedAssetClass = null;
        } else {
          state.selectedAccountId = id;
        }
        renderContent();
      }
    });
    bodyEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.mf-account-card[data-acct-id]');
      if (card) {
        e.preventDefault();
        const id = card.dataset.acctId;
        if (id === 'portfolio') {
          state.selectedAccountId = null;
          state.selectedAssetClass = null;
        } else {
          state.selectedAccountId = id;
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
    const callNote = state.apiCallCount ? ` · ${state.apiCallCount} API calls seen` : '';
    el.textContent = etaS > 0
      ? `Loading… ${elapsedS}s elapsed · avg ${fmtSec(avg)} · ~${fmtSec(etaMs)} remaining${callNote}`
      : `Almost there… ${elapsedS}s elapsed (avg ${fmtSec(avg)})${callNote}`;
    bar.classList.remove('mf-status-warn');
    setProgressWidth(pct);
  } else {
    // No history yet
    const callNote = state.apiCallCount ? `${state.apiCallCount} API calls captured, parsing…` : 'Listening for data…';
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
  return acct ? state.transactions.filter(t => t.accountId === acct.id) : state.transactions;
}

function filteredDailyValues() {
  const acct = getSelectedAccount();
  if (acct && state.accountDailyValues[acct.id]) return state.accountDailyValues[acct.id];
  return state.dailyValues;
}

// Compute MTD / YTD / 1-Year returns from a [{date, value}] series.
// Returns null for any frame where there isn't enough history.
function periodFramesFromSeries(dv) {
  if (!dv || dv.length < 2) return { mtd: null, ytd: null, oneY: null };
  const latest = dv[dv.length - 1];
  const latestDate = new Date(latest.date);
  if (isNaN(latestDate)) return { mtd: null, ytd: null, oneY: null };

  const findStart = (predicate) => {
    // Walk backwards to find the most recent point that satisfies `predicate`
    // (i.e. the last bar from before the period boundary). Falls back to the
    // first bar in the series if no prior bar exists.
    for (let i = dv.length - 1; i >= 0; i--) {
      if (predicate(new Date(dv[i].date))) return dv[i];
    }
    return dv[0];
  };
  const pct = s => (s && s.value > 0) ? ((latest.value - s.value) / s.value) * 100 : null;

  const monthStart = new Date(latestDate.getFullYear(), latestDate.getMonth(), 1);
  const yearStart  = new Date(latestDate.getFullYear(), 0, 1);
  const oneYearAgo = new Date(latestDate.getFullYear() - 1, latestDate.getMonth(), latestDate.getDate());

  // Only emit MTD when we have a point from before the current month boundary;
  // otherwise it's the same as ITD for that account and is misleading.
  const firstDate = new Date(dv[0].date);
  const mtd  = firstDate < monthStart ? pct(findStart(d => d < monthStart)) : null;
  const ytd  = firstDate < yearStart  ? pct(findStart(d => d < yearStart))  : null;
  const oneY = firstDate <= oneYearAgo ? pct(findStart(d => d <= oneYearAgo)) : null;
  return { mtd, ytd, oneY };
}

function renderBreadcrumb() {
  const acct = getSelectedAccount();
  const cls = state.selectedAssetClass;
  if (!acct && !cls) return '';
  const chips = [];
  if (acct) {
    chips.push(`<span class="mf-chip">Account: <strong>${escHtml(acct.name)}</strong>${acct.type ? ` · ${escHtml(acct.type)}` : ''} <button class="mf-chip-x" id="mf-back-all" title="Clear account filter">×</button></span>`);
  }
  if (cls) {
    chips.push(`<span class="mf-chip">Asset class: <strong>${escHtml(cls)}</strong> <button class="mf-chip-x" id="mf-clear-class" title="Clear asset-class filter">×</button></span>`);
  }
  return `<div class="mf-breadcrumb">${chips.join('')}</div>`;
}

// ── Tab renderers ────────────────────────────────────────────────────────────
function renderContent() {
  const body = document.getElementById('mf-body');
  if (!body) return;
  const tab = state.activeTab || 'overview';
  if (tab === 'overview') body.innerHTML = renderOverview();
  else if (tab === 'holdings') body.innerHTML = renderHoldings();
  else if (tab === 'transactions') body.innerHTML = renderTransactions();
  else if (tab === 'performance') { body.innerHTML = renderPerformance(); initPerformanceCharts(); return; }
  else if (tab === 'debug') renderDebugTab();

  if (tab === 'overview' || tab === 'holdings') renderAllocationChart();
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
    // Exclude portfolio sentinel from the per-account sum, but use it if present for accuracy
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

  // MTD / YTD / 1Y computed from the (filtered) daily-value series. If LPL
  // already gave us a YTD figure on the account we trust that one.
  const dv = filteredDailyValues();
  const framed = periodFramesFromSeries(dv);
  if (ytd == null) ytd = framed.ytd;
  const mtd = framed.mtd;
  const oneY = framed.oneY;

  const positionsCount = filteredPositions().length;

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
        ${mtd != null ? `
        <div class="mf-kpi">
          <div class="mf-kpi-label">MTD Return</div>
          <div class="mf-kpi-value ${mtd >= 0 ? 'pos' : 'neg'}">${fmtPct(mtd)}</div>
        </div>` : ''}
        ${ytd != null ? `
        <div class="mf-kpi">
          <div class="mf-kpi-label">YTD Return</div>
          <div class="mf-kpi-value ${ytd >= 0 ? 'pos' : 'neg'}">${fmtPct(ytd)}</div>
        </div>` : ''}
        ${oneY != null ? `
        <div class="mf-kpi">
          <div class="mf-kpi-label">1-Year Return</div>
          <div class="mf-kpi-value ${oneY >= 0 ? 'pos' : 'neg'}">${fmtPct(oneY)}</div>
        </div>` : ''}
        ${positionsCount ? `
        <div class="mf-kpi">
          <div class="mf-kpi-label">Positions</div>
          <div class="mf-kpi-value">${positionsCount}</div>
        </div>` : ''}
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
      <canvas id="mf-alloc-chart" width="400" height="220"></canvas>` : ''}
    </div>
  `;
}

function renderHoldings() {
  const positions = filteredPositions();
  if (!positions.length) {
    return `
      <div class="mf-section">
        ${renderBreadcrumb()}
        <div class="mf-empty">${getSelectedAccount() ? 'No holdings found for this account.' : 'No holdings data captured yet. Navigate to your holdings page.'}</div>
      </div>`;
  }

  const sorted = [...positions].sort((a, b) => (b.value || 0) - (a.value || 0));
  const total = sorted.reduce((s, p) => s + (p.value || 0), 0);

  return `
    <div class="mf-section">
      ${renderBreadcrumb()}
      <h3 class="mf-section-title">Holdings <span class="mf-badge">${sorted.length}</span></h3>
      <canvas id="mf-alloc-chart" width="400" height="220" style="margin-bottom:24px"></canvas>
      <table class="mf-table">
        <thead><tr>
          <th>Symbol</th><th>Name</th><th class="right">Qty</th>
          <th class="right">Price</th><th class="right">Value</th>
          <th class="right">Alloc</th><th class="right">G/L</th><th class="right">G/L %</th>
        </tr></thead>
        <tbody>
          ${sorted.map(p => `
            <tr>
              <td class="symbol">${p.symbol}</td>
              <td class="name">${p.name}</td>
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
          <td colspan="4"><strong>Total</strong></td>
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
        <div class="mf-empty">${getSelectedAccount() ? 'No transactions found for this account.' : 'No transaction data captured yet. Navigate to your activity/history page.'}</div>
      </div>`;
  }

  const sorted = [...txns].sort((a, b) => new Date(b.date) - new Date(a.date));

  return `
    <div class="mf-section">
      ${renderBreadcrumb()}
      <h3 class="mf-section-title">Recent Transactions <span class="mf-badge">${sorted.length}</span></h3>
      <table class="mf-table">
        <thead><tr>
          <th>Date</th><th>Type</th><th>Symbol</th><th>Description</th>
          <th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th>
        </tr></thead>
        <tbody>
          ${sorted.map(t => `
            <tr>
              <td class="date">${fmtDate(t.date)}</td>
              <td><span class="mf-txn-badge ${t.type.toLowerCase()}">${t.type}</span></td>
              <td class="symbol">${t.symbol || '—'}</td>
              <td class="name">${t.description}</td>
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

// ── Stooq benchmark fetcher (CSV, 24-hour cache) ────────────────────────────
async function loadBenchmarkSeries(ticker) {
  const key = ticker.toLowerCase();
  if (state.benchmarkSeries[key]) return state.benchmarkSeries[key];
  if (state.benchmarkLoading.has(key)) return null;
  state.benchmarkLoading.add(key);

  try {
    const cached = await chrome.storage.local.get(`bm_${key}`);
    const entry = cached[`bm_${key}`];
    if (entry && Date.now() - entry.fetchedAt < 24 * 60 * 60 * 1000) {
      state.benchmarkSeries[key] = entry.data;
      state.benchmarkLoading.delete(key);
      return entry.data;
    }

    const end = new Date();
    const start = new Date(end.getTime() - 1825 * 86400000); // 5 years back
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://stooq.com/q/d/l/?s=${key}.us&d1=${fmt(start)}&d2=${fmt(end)}&i=d`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const data = parseStooqCsv(text);
    if (!data.length) throw new Error('Empty or unparseable CSV');

    state.benchmarkSeries[key] = data;
    await chrome.storage.local.set({ [`bm_${key}`]: { data, fetchedAt: Date.now() } });
    dbg('ok', `Stooq: fetched ${data.length} bars for ${ticker}`);
    return data;
  } catch (err) {
    state.benchmarkErrors[key] = String(err.message || err);
    dbg('warn', `Stooq fetch failed for ${ticker}`, { error: state.benchmarkErrors[key] });
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

      ${hasPortfolioHistory && allBenchmarksLoaded ? `
        <h3 class="mf-section-title">Growth of $10,000</h3>
        <p class="mf-note" style="margin-top:-8px;margin-bottom:12px">Normalized to $10,000 invested at the start of available history. Compares your portfolio against selected benchmarks.</p>
        <canvas id="mf-perf-growth" style="width:100%;display:block;margin-bottom:28px;height:300px"></canvas>
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
        <p class="mf-note">No historical portfolio data captured yet. Open your brokerage's performance page (My Accounts → Performance) so MyFolio can capture the daily value history needed for charts.</p>
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
  setupCanvas(canvas, 300);

  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth, H = 300;
  const pad = { top: 16, right: 100, bottom: 36, left: 80 };
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

  // Legend (right side)
  const lx = pad.left + cw + 10, ly = pad.top + 8;
  normalized.forEach((l, i) => {
    const y = ly + i * 20;
    ctx.fillStyle = l.color;
    ctx.fillRect(lx, y, 12, 3);
    ctx.fillStyle = '#cbd5e1'; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(l.label, lx + 18, y + 4);
    const final = l.points[l.points.length - 1].value;
    ctx.fillStyle = final >= 10000 ? '#4ade80' : '#f87171';
    ctx.font = '10px system-ui';
    ctx.fillText(fmt$(Math.round(final)), lx + 18, y + 16);
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
  const dt = new Date(d);
  if (isNaN(dt)) return String(d).slice(0, 10);
  return dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
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
          <span>API calls intercepted: <strong>${state.apiCallCount}</strong></span>
          <span>Accounts: <strong>${state.accounts.length}</strong></span>
          <span>Positions: <strong>${state.positions.length}</strong></span>
          <span>Transactions: <strong>${state.transactions.length}</strong></span>
        </div>
        <button class="mf-reload-btn" onclick="location.reload()">↺ Reload page</button>
        <button class="mf-reload-btn" id="mf-copy-log">⎘ Copy for Claude</button>
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
      if (btn) { btn.textContent = '✔ Copied!'; setTimeout(() => { btn.textContent = '⎘ Copy for Claude'; }, 2000); }
    });
  });
}

function buildCopyPayload() {
  const lines = [];
  lines.push('=== MyFolio Debug Report ===');
  lines.push(`Page URL: ${location.href}`);
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`API calls intercepted: ${state.apiCallCount}`);
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
  // Use the LPL asset-class field if present; otherwise infer from symbol/name
  if (p.assetClass) return p.assetClass;
  const text = `${p.symbol || ''} ${p.name || ''}`.toUpperCase();
  if (/CASH|MONEY MKT|MONEY MARKET|MMKT|FDIC|SWEEP/.test(text)) return 'Cash and Cash Equivalents';
  if (/\bETF\b|\bFUND\b|TRUST|ISHARES|VANGUARD|SPDR/.test(text)) return 'Mutual Funds, ETPs, and CIs';
  if (/BOND|NOTE|TREASUR|BILL|GOV/.test(text)) return 'Fixed Income';
  return 'Uncategorized';
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

  const colors = ['#6366f1','#8b5cf6','#a78bfa','#c4b5fd','#818cf8',
                   '#4f46e5','#7c3aed','#5b21b6','#4338ca','#64748b'];

  const cx = 110, cy = 110, r = 90, hole = 52;
  let angle = -Math.PI / 2;
  const slices = []; // for hit-testing

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const highlightLabel = state.selectedAssetClass;

  groups.forEach((g, i) => {
    const sliceAngle = (g.total / total) * 2 * Math.PI;
    const isHighlighted = highlightLabel === g.label;
    const isDimmed = highlightLabel && !isHighlighted;
    const startAngle = angle;
    const endAngle = angle + sliceAngle;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r + (isHighlighted ? 4 : 0), startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.globalAlpha = isDimmed ? 0.35 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.stroke();
    slices.push({ label: g.label, start: startAngle, end: endAngle, color: colors[i % colors.length] });
    angle = endAngle;
  });

  // Hole
  ctx.beginPath();
  ctx.arc(cx, cy, hole, 0, 2 * Math.PI);
  ctx.fillStyle = '#0f172a';
  ctx.fill();

  // Center label
  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 13px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(fmt$(total), cx, cy - 4);
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(highlightLabel ? 'Filtered' : 'Total', cx, cy + 14);

  // Legend — every category, full name, value + %
  const lx = 240, ly = 14;
  ctx.font = '12px system-ui';
  groups.forEach((g, i) => {
    const y = ly + i * 22;
    const isHighlighted = highlightLabel === g.label;
    const isDimmed = highlightLabel && !isHighlighted;
    ctx.globalAlpha = isDimmed ? 0.4 : 1;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(lx, y, 12, 12);
    ctx.fillStyle = isHighlighted ? '#f1f5f9' : '#cbd5e1';
    ctx.font = (isHighlighted ? 'bold ' : '') + '12px system-ui';
    ctx.textAlign = 'left';
    // Truncate label to fit
    const maxLabelWidth = 200;
    let label = g.label;
    while (ctx.measureText(label).width > maxLabelWidth && label.length > 4) {
      label = label.slice(0, -2);
    }
    if (label !== g.label) label += '…';
    ctx.fillText(label, lx + 18, y + 11);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(fmtPct((g.total / total) * 100), lx + 270, y + 11);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  });

  // Wire up click hit-testing once per canvas instance
  if (!canvas.dataset.mfWired) {
    canvas.dataset.mfWired = '1';
    canvas.style.cursor = 'pointer';
    canvas.title = 'Click a slice to filter Holdings by asset class';
    canvas.addEventListener('click', (e) => {
      const slices = canvas.__mfSlices;
      if (!slices || !slices.length) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const dx = x - 110, dy = y - 110;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 95 || dist < 52) return; // outside the donut ring
      // Convert atan2 result to match drawing convention (start at -π/2, sweep CW positive)
      let a = Math.atan2(dy, dx);
      // Normalize to [-π/2, 3π/2) so it lines up with stored slice ranges
      while (a < -Math.PI / 2) a += 2 * Math.PI;
      while (a >= 3 * Math.PI / 2) a -= 2 * Math.PI;
      const hit = slices.find(s => a >= s.start && a < s.end);
      if (!hit) return;
      // Toggle: clicking the active slice clears the filter
      if (state.selectedAssetClass === hit.label) {
        state.selectedAssetClass = null;
      } else {
        state.selectedAssetClass = hit.label;
        // Jump to Holdings if we aren't already there
        if (state.activeTab !== 'holdings') {
          state.activeTab = 'holdings';
          document.querySelectorAll('.mf-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === 'holdings');
          });
        }
      }
      renderContent();
    });
  }
  canvas.__mfSlices = slices;
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
