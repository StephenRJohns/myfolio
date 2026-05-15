// MyFolio — Chrome extension content script
// Copyright (c) 2026 JJJJJ Enterprises, LLC. All rights reserved.
// Licensed under the MyFolio Proprietary Software License (see LICENSE).
//
// Listens for API captures from interceptor.js, parses LPL AccountView data,
// and injects/updates the MyFolio dashboard overlay. No data leaves the browser
// except public ETF price fetches to stooq.com for benchmark comparisons.

const state = {
  accounts: [],
  positions: [],
  transactions: [],
  performance: {},
  dailyValues: [],   // [{date, value}] aggregated across accounts
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
  if (!msg?.type?.startsWith('LPL_')) return;

  if (msg.type === 'LPL_NET') {
    dbg('info', `${msg.ok ? '✔' : '✘'} ${msg.status}  ${msg.url}`);
  } else if (msg.type === 'LPL_API') {
    const { url, data } = msg;
    const topKeys = data && typeof data === 'object' ? Object.keys(data) : [];
    dbg('info', `JSON body parsed`, { url, topKeys, type: Array.isArray(data) ? `array[${data.length}]` : typeof data });
    parseApiResponse(url, data);
  } else if (msg.type === 'LPL_WS_OPEN') {
    dbg('warn', `WebSocket opened — LPL may push data through this`, { url: msg.url });
  } else if (msg.type === 'LPL_WS_MSG') {
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
      const accts = Array.isArray(cd.accounts) ? cd.accounts.map(normalizeLplAccount) : [];
      state.accounts = accts.length ? [portfolio, ...accts] : [portfolio];
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
            all.push(normalizeLplPosition(p));
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
          for (const p of acct.position) all.push(normalizeLplPosition(p));
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
          for (const t of acct.activities) all.push(normalizeLplTxn(t));
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

      // Aggregate dailyValues across all accounts by date
      const byDate = {};
      for (const acct of accts) {
        for (const dv of (acct.chartData?.dailyValues || [])) {
          const d = dv.date || dv.asOfDate || dv.Date;
          const v = toNum(dv.endValue ?? dv.value ?? dv.portfolioValue ?? dv.Value ?? dv.EndValue);
          if (d && v != null) byDate[d] = (byDate[d] || 0) + v;
        }
      }
      const sorted = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
      if (sorted.length) {
        state.dailyValues = sorted.map(([date, value]) => ({ date, value }));
        dbg('ok', `account-vot: ${sorted.length} daily values`, sorted[sorted.length - 1]);
      } else {
        dbg('info', 'account-vot: no dailyValues (may need to select a longer date range in LPL)');
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

// ── Normalizers (handle various LPL field name conventions) ─────────────────
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

// ── LPL-specific normalizers (field names from awsp.myaccountviewonline.com) ─
function normalizeLplAccount(a) {
  return {
    id: String(a.accountId || a.accountNumber || ''),
    name: a.accountName || a.nickName || a.accountNumber || '',
    type: a.accountClassName || a.accountClassCode || '',
    value: toNum(a.marketValue ?? a.totalValue ?? a.accountValue ?? a.balance ?? null),
    change: toNum(a.dayChange ?? a.mktValChange ?? null),
    changePct: toNum(a.dayChangePercentage ?? a.dayChangePct ?? null),
    ytdReturn: toNum(a.ytdReturn ?? null),
    unrealizedGL: toNum(a.unrealizedGainLoss ?? a.uglt ?? null),
  };
}

function normalizeLplPosition(p) {
  return {
    // Real LPL field names from debug log
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

function normalizeLplTxn(t) {
  return {
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
  if (document.getElementById('lpl-toggle-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'lpl-toggle-btn';
  btn.textContent = '◆ MyFolio View';
  btn.title = 'Switch to MyFolio dashboard';
  btn.addEventListener('click', toggleOverlay);
  document.body.appendChild(btn);
}

function setToggleLabel(open) {
  const btn = document.getElementById('lpl-toggle-btn');
  if (!btn) return;
  btn.textContent = open ? '◆ Standard View' : '◆ MyFolio View';
  btn.title = open ? 'Return to standard LPL view' : 'Switch to MyFolio dashboard';
}

function toggleOverlay() {
  state.overlayOpen = !state.overlayOpen;
  const overlay = document.getElementById('lpl-overlay');
  if (overlay) overlay.classList.toggle('lpl-hidden', !state.overlayOpen);
  if (state.overlayOpen && !overlay) buildOverlay();
  setToggleLabel(state.overlayOpen);
}

function refreshOverlay() {
  if (!state.overlayOpen) return;
  const overlay = document.getElementById('lpl-overlay');
  if (!overlay) buildOverlay();
  else renderContent();
}

function buildOverlay() {
  state.loadStart = Date.now();
  const overlay = document.createElement('div');
  overlay.id = 'lpl-overlay';
  overlay.innerHTML = `
    <div class="lpl-topbar">
      <div class="lpl-logo">◆ MyFolio</div>
      <nav class="lpl-nav">
        <button class="lpl-tab active" data-tab="overview">Overview</button>
        <button class="lpl-tab" data-tab="holdings">Holdings</button>
        <button class="lpl-tab" data-tab="transactions">Transactions</button>
        <button class="lpl-tab" data-tab="performance">Performance</button>
      </nav>
      <button class="lpl-close" id="lpl-close-btn" title="Close">✕</button>
    </div>
    <div class="lpl-statusbar" id="lpl-statusbar">
      <span class="lpl-spinner"></span>
      <span id="lpl-status-text">Listening for data…</span>
      <button class="lpl-reload-btn" id="lpl-reload-btn" title="Reload page to re-capture data">↺ Reload page</button>
    </div>
    <div class="lpl-progress" id="lpl-progress">
      <div class="lpl-progress-fill" id="lpl-progress-fill"></div>
    </div>
    <div class="lpl-body" id="lpl-body"></div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('lpl-close-btn').addEventListener('click', toggleOverlay);
  document.getElementById('lpl-reload-btn').addEventListener('click', () => location.reload());
  overlay.querySelectorAll('.lpl-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.lpl-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      renderContent();
    });
  });

  state.activeTab = 'overview';
  renderContent();
  updateStatusBar();
}

// ── Status bar ──────────────────────────────────────────────────────────────
function updateStatusBar() {
  const el = document.getElementById('lpl-status-text');
  const bar = document.getElementById('lpl-statusbar');
  const spinner = bar?.querySelector('.lpl-spinner');
  if (!el || !bar) return;

  const hasData = state.accounts.length || state.positions.length || state.transactions.length;

  if (hasData) {
    const parts = [];
    if (state.accounts.length) parts.push(`${state.accounts.length} account${state.accounts.length > 1 ? 's' : ''}`);
    if (state.positions.length) parts.push(`${state.positions.length} positions`);
    if (state.transactions.length) parts.push(`${state.transactions.length} transactions`);
    const elapsed = state.loadStart ? ((Date.now() - state.loadStart) / 1000).toFixed(1) : '?';
    el.textContent = `Loaded in ${elapsed}s — ${parts.join(' · ')}`;
    bar.classList.remove('lpl-status-warn');
    bar.classList.add('lpl-status-ok');
    if (spinner) spinner.classList.add('lpl-spinner-done');
    const prog = document.getElementById('lpl-progress');
    if (prog) prog.style.display = 'none';
    return;
  }

  // Still waiting — compute ETA
  const elapsedMs = state.loadStart ? Date.now() - state.loadStart : 0;
  const elapsedS = Math.round(elapsedMs / 1000);
  bar.classList.remove('lpl-status-ok');

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
    bar.classList.add('lpl-status-warn');
    if (spinner) spinner.classList.remove('lpl-spinner-done');
  } else if (avg) {
    // ETA available
    const etaMs = avg - elapsedMs;
    const etaS = Math.max(0, Math.round(etaMs / 1000));
    const pct = Math.min(100, Math.round((elapsedMs / avg) * 100));
    const callNote = state.apiCallCount ? ` · ${state.apiCallCount} API calls seen` : '';
    el.textContent = etaS > 0
      ? `Loading… ${elapsedS}s elapsed · avg ${fmtSec(avg)} · ~${fmtSec(etaMs)} remaining${callNote}`
      : `Almost there… ${elapsedS}s elapsed (avg ${fmtSec(avg)})${callNote}`;
    bar.classList.remove('lpl-status-warn');
    setProgressWidth(pct);
  } else {
    // No history yet
    const callNote = state.apiCallCount ? `${state.apiCallCount} API calls captured, parsing…` : 'Listening for data…';
    el.textContent = elapsedS > 8
      ? `${elapsedS}s — ${callNote} (first session, no ETA yet)`
      : callNote;
    if (elapsedMs > 30000) bar.classList.add('lpl-status-warn');
    else bar.classList.remove('lpl-status-warn');
    if (spinner) spinner.classList.remove('lpl-spinner-done');
  }
}

function fmtSec(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function setProgressWidth(pct) {
  const bar = document.getElementById('lpl-progress-fill');
  if (bar) bar.style.width = pct + '%';
}

// Tick every second while waiting
setInterval(() => {
  if (!state.overlayOpen) return;
  const hasData = state.accounts.length || state.positions.length || state.transactions.length;
  if (!hasData) updateStatusBar();
}, 1000);

// ── Tab renderers ────────────────────────────────────────────────────────────
function renderContent() {
  const body = document.getElementById('lpl-body');
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
  const total = state.accounts.reduce((s, a) => s + (a.value || 0), 0);
  const totalChange = state.accounts.reduce((s, a) => s + (a.change || 0), 0);
  const changePct = total > 0 ? (totalChange / (total - totalChange)) * 100 : 0;
  const hasAccounts = state.accounts.length > 0;

  return `
    <div class="lpl-section">
      <div class="lpl-kpi-row">
        <div class="lpl-kpi">
          <div class="lpl-kpi-label">Total Portfolio Value</div>
          <div class="lpl-kpi-value">${hasAccounts ? fmt$(total) : '—'}</div>
          ${hasAccounts ? `<div class="lpl-kpi-sub ${totalChange >= 0 ? 'pos' : 'neg'}">${totalChange >= 0 ? '▲' : '▼'} ${fmt$(Math.abs(totalChange))} (${fmtPct(changePct)}) today</div>` : `<div class="lpl-kpi-waiting"><span class="lpl-spinner"></span> Waiting for data…</div>`}
        </div>
        ${state.performance.ytdReturn != null ? `
        <div class="lpl-kpi">
          <div class="lpl-kpi-label">YTD Return</div>
          <div class="lpl-kpi-value ${state.performance.ytdReturn >= 0 ? 'pos' : 'neg'}">${fmtPct(state.performance.ytdReturn)}</div>
        </div>` : ''}
        ${state.positions.length ? `
        <div class="lpl-kpi">
          <div class="lpl-kpi-label">Positions</div>
          <div class="lpl-kpi-value">${state.positions.length}</div>
        </div>` : ''}
      </div>

      ${hasAccounts ? `
      <h3 class="lpl-section-title">Accounts</h3>
      <div class="lpl-account-grid">
        ${state.accounts.map(a => `
          <div class="lpl-account-card">
            <div class="lpl-account-name">${a.name}</div>
            <div class="lpl-account-type">${a.type}</div>
            <div class="lpl-account-value">${fmt$(a.value)}</div>
            ${a.change != null ? `<div class="lpl-account-change ${a.change >= 0 ? 'pos' : 'neg'}">${a.change >= 0 ? '▲' : '▼'} ${fmt$(Math.abs(a.change))} (${fmtPct(a.changePct)}) today</div>` : ''}
            ${a.unrealizedGL != null ? `<div class="lpl-account-gl">Unrealized G/L: <span class="${a.unrealizedGL >= 0 ? 'pos' : 'neg'}">${fmt$(a.unrealizedGL)}</span></div>` : ''}
          </div>
        `).join('')}
      </div>` : `<div class="lpl-empty">Waiting for account data — navigate to your account overview page.</div>`}

      ${state.positions.length ? `
      <h3 class="lpl-section-title">Allocation</h3>
      <canvas id="lpl-alloc-chart" width="400" height="220"></canvas>` : ''}
    </div>
  `;
}

function renderHoldings() {
  if (!state.positions.length) return `<div class="lpl-empty">No holdings data captured yet. Navigate to your holdings page.</div>`;

  const sorted = [...state.positions].sort((a, b) => (b.value || 0) - (a.value || 0));
  const total = sorted.reduce((s, p) => s + (p.value || 0), 0);

  return `
    <div class="lpl-section">
      <h3 class="lpl-section-title">Holdings <span class="lpl-badge">${sorted.length}</span></h3>
      <canvas id="lpl-alloc-chart" width="400" height="220" style="margin-bottom:24px"></canvas>
      <table class="lpl-table">
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
  if (!state.transactions.length) return `<div class="lpl-empty">No transaction data captured yet. Navigate to your activity/history page.</div>`;

  const sorted = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));

  return `
    <div class="lpl-section">
      <h3 class="lpl-section-title">Recent Transactions <span class="lpl-badge">${sorted.length}</span></h3>
      <table class="lpl-table">
        <thead><tr>
          <th>Date</th><th>Type</th><th>Symbol</th><th>Description</th>
          <th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th>
        </tr></thead>
        <tbody>
          ${sorted.map(t => `
            <tr>
              <td class="date">${fmtDate(t.date)}</td>
              <td><span class="lpl-txn-badge ${t.type.toLowerCase()}">${t.type}</span></td>
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
  const hasPortfolioHistory = state.dailyValues.length >= 2;

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
    ? periodReturns(state.dailyValues.map(d => ({ date: d.date, close: d.value })))
    : { ytd: perf.ytdReturn ?? perf.ytd ?? null, oneY: null, threeY: null, fiveY: null };

  const hasAnyReturns = portfolioReturns.ytd != null || hasAnyBenchmarkData;

  return `
    <div class="lpl-section">
      ${hasPortfolioHistory ? `
        <h3 class="lpl-section-title">Portfolio Value Over Time</h3>
        <canvas id="mf-perf-value" style="width:100%;display:block;margin-bottom:28px;height:260px"></canvas>
      ` : ''}

      ${hasPortfolioHistory && allBenchmarksLoaded ? `
        <h3 class="lpl-section-title">Growth of $10,000</h3>
        <p class="lpl-note" style="margin-top:-8px;margin-bottom:12px">Normalized to $10,000 invested at the start of available history. Compares your portfolio against selected benchmarks.</p>
        <canvas id="mf-perf-growth" style="width:100%;display:block;margin-bottom:28px;height:300px"></canvas>
      ` : ''}

      ${hasAnyReturns ? `
        <h3 class="lpl-section-title">Period Returns</h3>
        <table class="lpl-table" style="margin-bottom:24px">
          <thead><tr>
            <th>Portfolio / Benchmark</th>
            <th class="right">YTD</th>
            <th class="right">1 Year</th>
            <th class="right">3 Year</th>
            <th class="right">5 Year</th>
          </tr></thead>
          <tbody>
            <tr class="highlight">
              <td><strong>Your Portfolio</strong></td>
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

      <h3 class="lpl-section-title">Compare Against</h3>
      <div class="lpl-bm-picker" id="mf-bm-picker">
        ${ALL_BENCHMARKS.map(b => `
          <label class="lpl-bm-chip ${selected.includes(b.id) ? 'active' : ''}">
            <input type="checkbox" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''} style="display:none">
            ${b.label} <span class="lpl-bm-ticker">${b.ticker}</span>
          </label>
        `).join('')}
      </div>

      ${!hasPortfolioHistory ? `
        <p class="lpl-note">No historical portfolio data captured yet. Open your LPL performance page (My Accounts → Performance) so MyFolio can capture the daily value history needed for charts.</p>
      ` : ''}

      <p class="lpl-note">Benchmark price data is fetched from public sources (stooq.com) and cached for 24 hours. Returns are calculated from total price change and do not include dividend reinvestment. For informational purposes only — not investment advice.</p>
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
  if (!canvas || !state.dailyValues.length) return;
  setupCanvas(canvas, 260);
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth, H = 260;
  const pad = { top: 16, right: 20, bottom: 36, left: 80 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const vals = state.dailyValues;
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
  if (!canvas) return;
  if (!state.dailyValues.length) return;
  setupCanvas(canvas, 300);

  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth, H = 300;
  const pad = { top: 16, right: 100, bottom: 36, left: 80 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  // Determine common date range based on portfolio history
  const portfolioStart = state.dailyValues[0].date;
  const portfolioEnd = state.dailyValues[state.dailyValues.length - 1].date;

  // Build series list: portfolio + each selected benchmark
  const selected = getSelectedBenchmarks();
  const lines = [{
    label: 'Your Portfolio',
    color: '#818cf8',
    width: 3,
    series: state.dailyValues.map(d => ({ date: d.date, close: d.value })),
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
  const allDates = state.dailyValues.map(d => d.date);
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
  const body = document.getElementById('lpl-body');
  if (!body) return;

  const levelIcon = { info: '●', ok: '✔', warn: '▲', err: '✖' };

  body.innerHTML = `
    <div class="lpl-section lpl-debug-section">
      <div class="lpl-debug-header">
        <h3 class="lpl-section-title" style="margin:0">Debug Log <span class="lpl-badge">${state.logs.length}</span></h3>
        <div class="lpl-debug-summary">
          <span>API calls intercepted: <strong>${state.apiCallCount}</strong></span>
          <span>Accounts: <strong>${state.accounts.length}</strong></span>
          <span>Positions: <strong>${state.positions.length}</strong></span>
          <span>Transactions: <strong>${state.transactions.length}</strong></span>
        </div>
        <button class="lpl-reload-btn" onclick="location.reload()">↺ Reload page</button>
        <button class="lpl-reload-btn" id="lpl-copy-log">⎘ Copy for Claude</button>
        <button class="lpl-reload-btn" id="lpl-clear-log">✕ Clear</button>
      </div>
      <div class="lpl-debug-log" id="lpl-debug-log">
        ${state.logs.length === 0
          ? '<div class="lpl-debug-empty">No log entries yet. API calls will appear here as they are intercepted.</div>'
          : state.logs.map(e => `
            <div class="lpl-debug-entry lpl-dbg-${e.level}">
              <span class="lpl-dbg-time">${e.t}</span>
              <span class="lpl-dbg-icon">${levelIcon[e.level] || '●'}</span>
              <span class="lpl-dbg-msg">${escHtml(e.msg)}</span>
              ${e.detail ? `<pre class="lpl-dbg-detail">${escHtml(e.detail)}</pre>` : ''}
            </div>
          `).join('')}
      </div>
    </div>
  `;

  document.getElementById('lpl-clear-log')?.addEventListener('click', () => {
    state.logs = [];
    renderDebugTab();
  });

  document.getElementById('lpl-copy-log')?.addEventListener('click', () => {
    const text = buildCopyPayload();
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('lpl-copy-log');
      if (btn) { btn.textContent = '✔ Copied!'; setTimeout(() => { btn.textContent = '⎘ Copy for Claude'; }, 2000); }
    });
  });
}

function buildCopyPayload() {
  const lines = [];
  lines.push('=== LPL Enhanced Dashboard Debug Report ===');
  lines.push(`Page URL: ${location.href}`);
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`API calls intercepted: ${state.apiCallCount}`);
  lines.push(`Accounts parsed: ${state.accounts.length}`);
  lines.push(`Positions parsed: ${state.positions.length}`);
  lines.push(`Transactions parsed: ${state.transactions.length}`);
  lines.push('');
  lines.push('=== All Network Requests (newest first) ===');
  // Pull just the LPL_NET entries to show every URL seen
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
function renderAllocationChart() {
  const canvas = document.getElementById('lpl-alloc-chart');
  if (!canvas || !state.positions.length) return;

  const ctx = canvas.getContext('2d');
  const total = state.positions.reduce((s, p) => s + (p.value || 0), 0);
  if (total === 0) return;

  // Group by asset class or top-10 by value
  const grouped = {};
  const sorted = [...state.positions].sort((a, b) => (b.value || 0) - (a.value || 0));
  const top = sorted.slice(0, 9);
  const other = sorted.slice(9);

  for (const p of top) {
    const label = p.assetClass || p.symbol || 'Other';
    grouped[label] = (grouped[label] || 0) + (p.value || 0);
  }
  if (other.length) {
    grouped['Other'] = other.reduce((s, p) => s + (p.value || 0), 0);
  }

  const colors = ['#6366f1','#8b5cf6','#a78bfa','#c4b5fd','#818cf8',
                   '#4f46e5','#7c3aed','#5b21b6','#4338ca','#64748b'];

  const entries = Object.entries(grouped);
  const cx = 110, cy = 110, r = 90, hole = 52;
  let angle = -Math.PI / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  entries.forEach(([label, val], i) => {
    const slice = (val / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.stroke();
    angle += slice;
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
  ctx.fillText('Total', cx, cy + 14);

  // Legend
  const lx = 240, ly = 20;
  entries.forEach(([label, val], i) => {
    const y = ly + i * 22;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(lx, y, 12, 12);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(`${label}`, lx + 18, y + 11);
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    ctx.fillText(fmtPct((val / total) * 100), lx + 160, y + 11);
    ctx.textAlign = 'left';
  });
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
  const overlay = document.getElementById('lpl-overlay');
  if (overlay) overlay.classList.remove('lpl-hidden');
  overlay?.querySelectorAll('.lpl-tab').forEach(b => b.classList.remove('active'));
  // Ensure debug tab button exists (add it if hidden)
  let debugBtn = overlay?.querySelector('[data-tab="debug"]');
  if (!debugBtn) {
    const nav = overlay?.querySelector('.lpl-nav');
    if (nav) {
      debugBtn = document.createElement('button');
      debugBtn.className = 'lpl-tab lpl-tab-debug';
      debugBtn.dataset.tab = 'debug';
      debugBtn.textContent = 'Debug';
      debugBtn.addEventListener('click', () => {
        overlay.querySelectorAll('.lpl-tab').forEach(b => b.classList.remove('active'));
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
