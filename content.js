// Listens for API captures from interceptor.js, parses LPL data,
// and injects/updates the modern dashboard overlay.

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
  btn.textContent = '◆ Enhanced View';
  btn.title = 'Switch to LPL Enhanced Dashboard';
  btn.addEventListener('click', toggleOverlay);
  document.body.appendChild(btn);
}

function setToggleLabel(open) {
  const btn = document.getElementById('lpl-toggle-btn');
  if (!btn) return;
  btn.textContent = open ? '◆ Standard View' : '◆ Enhanced View';
  btn.title = open ? 'Return to standard LPL view' : 'Switch to LPL Enhanced Dashboard';
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
      <div class="lpl-logo">◆ LPL Enhanced Dashboard</div>
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

// All available benchmarks (approximate annualized returns, updated periodically)
const ALL_BENCHMARKS = [
  { id: 'spy',  label: 'S&P 500',          ticker: 'SPY',  ytd:  5.5, oneY: 12.3, threeY:  8.7, fiveY: 13.1 },
  { id: 'vti',  label: 'US Total Market',  ticker: 'VTI',  ytd:  5.1, oneY: 11.8, threeY:  8.4, fiveY: 12.7 },
  { id: 'qqq',  label: 'Nasdaq 100',       ticker: 'QQQ',  ytd:  4.2, oneY: 17.6, threeY: 10.1, fiveY: 19.4 },
  { id: 'iwm',  label: 'Russell 2000',     ticker: 'IWM',  ytd: -8.3, oneY: -4.2, threeY:  1.0, fiveY:  6.8 },
  { id: 'vxus', label: 'Intl Stocks',      ticker: 'VXUS', ytd:  6.9, oneY:  8.2, threeY:  3.1, fiveY:  5.4 },
  { id: 'agg',  label: 'US Bonds',         ticker: 'AGG',  ytd:  1.2, oneY:  2.8, threeY: -1.4, fiveY:  0.9 },
  { id: 'tlt',  label: 'Long-Term Bonds',  ticker: 'TLT',  ytd: -4.1, oneY: -2.3, threeY:-11.2, fiveY: -3.8 },
  { id: 'tip',  label: 'TIPS (Inflation)', ticker: 'TIP',  ytd:  2.8, oneY:  4.1, threeY:  1.2, fiveY:  3.1 },
  { id: 'vnq',  label: 'Real Estate',      ticker: 'VNQ',  ytd: -3.2, oneY:  2.1, threeY: -2.8, fiveY:  3.9 },
  { id: 'gld',  label: 'Gold',             ticker: 'GLD',  ytd: 23.1, oneY: 35.2, threeY: 13.4, fiveY: 13.8 },
];

// Persist selected benchmark IDs across sessions
function getSelectedBenchmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem('lpl_benchmarks') || 'null');
    if (Array.isArray(saved)) return saved;
  } catch (e) {}
  return ['spy', 'vti', 'agg'];  // defaults
}
function saveSelectedBenchmarks(ids) {
  localStorage.setItem('lpl_benchmarks', JSON.stringify(ids));
}

function renderPerformance() {
  const perf = state.performance;
  const hasPerf = Object.keys(perf).length > 0;
  const selected = getSelectedBenchmarks();
  const activeBenchmarks = ALL_BENCHMARKS.filter(b => selected.includes(b.id));

  const periods = [
    { keys: ['ytdReturn', 'ytd'],             label: 'YTD' },
    { keys: ['oneYearReturn', '1y'],           label: '1 Year' },
    { keys: ['threeYearReturn', '3y'],         label: '3 Year' },
    { keys: ['fiveYearReturn', '5y'],          label: '5 Year' },
  ];

  const portfolioVals = periods.map(p => p.keys.map(k => perf[k]).find(v => v != null) ?? null);

  const portfolioRow = portfolioVals.map(val =>
    `<td class="right ${val > 0 ? 'pos' : val < 0 ? 'neg' : ''}">${val != null ? fmtPct(val) : '—'}</td>`
  ).join('');

  const bmValues = [null, ...activeBenchmarks.map(b => b.ytd)];  // null = portfolio placeholder for bar chart

  return `
    <div class="lpl-section">
      ${state.dailyValues.length ? `
      <h3 class="lpl-section-title">Portfolio Value Over Time</h3>
      <canvas id="lpl-perf-line" width="1000" height="260" style="width:100%;display:block;margin-bottom:28px"></canvas>
      ` : ''}

      <h3 class="lpl-section-title">Returns vs Benchmarks</h3>
      <canvas id="lpl-perf-bar" width="1000" height="240" style="width:100%;display:block;margin-bottom:24px"></canvas>

      <table class="lpl-table" style="margin-bottom:24px">
        <thead><tr>
          <th>Portfolio / Index</th>
          ${periods.map(p => `<th class="right">${p.label}</th>`).join('')}
        </tr></thead>
        <tbody>
          <tr class="highlight">
            <td><strong>Your Portfolio</strong></td>${portfolioRow}
          </tr>
          ${activeBenchmarks.map(b => `
            <tr>
              <td>${b.label} <span style="color:#475569;font-size:11px">${b.ticker}</span></td>
              <td class="right ${b.ytd >= 0 ? 'pos' : 'neg'}">${fmtPct(b.ytd)}</td>
              <td class="right ${b.oneY >= 0 ? 'pos' : 'neg'}">${fmtPct(b.oneY)}</td>
              <td class="right ${b.threeY >= 0 ? 'pos' : 'neg'}">${fmtPct(b.threeY)}</td>
              <td class="right ${b.fiveY >= 0 ? 'pos' : 'neg'}">${fmtPct(b.fiveY)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <h3 class="lpl-section-title">Compare Against</h3>
      <div class="lpl-bm-picker" id="lpl-bm-picker">
        ${ALL_BENCHMARKS.map(b => `
          <label class="lpl-bm-chip ${selected.includes(b.id) ? 'active' : ''}">
            <input type="checkbox" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''} style="display:none">
            ${b.label} <span class="lpl-bm-ticker">${b.ticker}</span>
          </label>
        `).join('')}
      </div>

      <p class="lpl-note">Benchmark returns are approximate annualized figures as of ${new Date().toLocaleDateString('en-US', {month:'short',year:'numeric'})}. ${!hasPerf ? 'Navigate to your LPL performance page to load your actual returns.' : ''}</p>
    </div>
  `;
}

function initPerformanceCharts() {
  // Benchmark picker
  document.getElementById('lpl-bm-picker')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const ids = [...document.querySelectorAll('#lpl-bm-picker input:checked')].map(i => i.value);
      saveSelectedBenchmarks(ids);
      renderContent();
    });
  });
  drawLineChart();
  drawBarChart();
}

function drawLineChart() {
  const canvas = document.getElementById('lpl-perf-line');
  if (!canvas || !state.dailyValues.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 1000, H = 260;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 20, right: 20, bottom: 36, left: 72 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const vals = state.dailyValues;
  const values = vals.map(d => d.value);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const xOf = i => pad.left + (i / (vals.length - 1)) * cw;
  const yOf = v => pad.top + ch - ((v - minV) / range) * ch;

  // Background
  ctx.fillStyle = '#0a1020';
  ctx.fillRect(0, 0, W, H);

  // Zero/grid lines
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    const label = fmt$(minV + (range / 4) * (4 - i));
    ctx.fillStyle = '#64748b'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(label, pad.left - 6, y + 4);
  }

  // Fill under line
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(99,102,241,0.35)');
  grad.addColorStop(1, 'rgba(99,102,241,0.02)');
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

  // X-axis date labels (show ~5)
  ctx.fillStyle = '#64748b'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
  const step = Math.floor(vals.length / 5) || 1;
  for (let i = 0; i < vals.length; i += step) {
    ctx.fillText(fmtDateShort(vals[i].date), xOf(i), H - 8);
  }
  ctx.fillText(fmtDateShort(vals[vals.length - 1].date), xOf(vals.length - 1), H - 8);
}

function drawBarChart() {
  const canvas = document.getElementById('lpl-perf-bar');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 1000, H = 240;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const perf = state.performance;
  const selected = getSelectedBenchmarks();
  const active = ALL_BENCHMARKS.filter(b => selected.includes(b.id));

  const periods = ['YTD', '1Y', '3Y', '5Y'];
  const portfolioVals = [
    perf.ytdReturn ?? perf.ytd ?? null,
    perf.oneYearReturn ?? perf['1y'] ?? null,
    perf.threeYearReturn ?? perf['3y'] ?? null,
    perf.fiveYearReturn ?? perf['5y'] ?? null,
  ];

  const rows = [
    { label: 'Portfolio', color: '#6366f1', vals: portfolioVals },
    ...active.map((b, i) => ({
      label: b.ticker,
      color: ['#475569','#64748b','#94a3b8','#cbd5e1','#e2e8f0'][i % 5],
      vals: [b.ytd, b.oneY, b.threeY, b.fiveY],
    })),
  ];

  const allVals = rows.flatMap(r => r.vals).filter(v => v != null);
  if (!allVals.length) { ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, W, H); return; }

  const maxAbs = Math.max(Math.abs(Math.min(...allVals)), Math.abs(Math.max(...allVals)), 5);
  const pad = { top: 20, right: 20, bottom: 28, left: 40 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const zeroY = pad.top + ch * (maxAbs / (maxAbs * 2));

  ctx.fillStyle = '#0a1020'; ctx.fillRect(0, 0, W, H);

  // Zero line
  ctx.strokeStyle = '#334155'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(pad.left + cw, zeroY); ctx.stroke();

  const groupW = cw / periods.length;
  const barW = Math.min(24, (groupW - 16) / rows.length);

  periods.forEach((period, pi) => {
    const gx = pad.left + pi * groupW;
    const totalBarW = barW * rows.length + 4 * (rows.length - 1);
    let bx = gx + (groupW - totalBarW) / 2;

    rows.forEach(row => {
      const val = row.vals[pi];
      if (val != null) {
        const barH = Math.abs(val / maxAbs) * (ch / 2);
        const by = val >= 0 ? zeroY - barH : zeroY;
        ctx.fillStyle = val >= 0 ? row.color : '#f87171';
        ctx.fillRect(bx, by, barW, barH);

        ctx.fillStyle = '#94a3b8'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
        const labelY = val >= 0 ? by - 3 : by + barH + 10;
        ctx.fillText(fmtPct(val), bx + barW / 2, labelY);
      }
      bx += barW + 4;
    });

    // Period label
    ctx.fillStyle = '#64748b'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(period, gx + groupW / 2, H - 6);
  });

  // Legend
  const lx = pad.left, ly = 4;
  rows.forEach((row, i) => {
    const x = lx + i * 80;
    ctx.fillStyle = row.color; ctx.fillRect(x, ly, 10, 10);
    ctx.fillStyle = '#94a3b8'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(row.label, x + 14, ly + 9);
  });
}

function fmtDateShort(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d).slice(0, 10);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
