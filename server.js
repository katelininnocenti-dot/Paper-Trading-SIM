const express = require('express');
const cookieParser = require('cookie-parser');
const webpush = require('web-push');
const crypto = require('crypto');
const path = require('path');
const M = require('./lib-market');
const Q = require('./lib-quotes');
const db = require('./lib-db');
const { dueLiveJobs } = require('./lib-schedule');
const { starterPositions } = require('./lib-seed');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const START_CASH = 500;
const DEFAULT_WATCH = ['MRK', 'CVX', 'MDLZ'];
let WATCH = DEFAULT_WATCH.slice();
const COMMISSION = { market: 0, limit: 0, stop: 0 };
const DISCLAIMER = 'Simulated practice guidance for a paper account. Not financial advice.';

const PIN = process.env.PT_PIN || '';
let sessionSecret = process.env.SESSION_SECRET || '';
if (PIN && !sessionSecret) {
  sessionSecret = crypto.randomBytes(24).toString('hex');
  console.warn('SESSION_SECRET is not set; PIN sessions reset when the process restarts');
}
const vapidPublic = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivate = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:paper-trader@example.com';
let vapidReady = false;
function configureVapid() {
  if (vapidPublic && vapidPrivate) {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    vapidReady = true;
  } else if (vapidPublic || vapidPrivate) {
    console.warn('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable web push');
  }
}

function newAccount(id) {
  return {
    id,
    startCash: START_CASH,
    cash: START_CASH,
    positions: {},
    realized: 0,
    orders: [],
    fills: [],
    snapshots: [],
    messages: [],
    emails: [],
    seq: 1,
    createdAt: new Date().toISOString(),
  };
}
function emptyWorld() {
  return {
    live: newAccount('live'),
    sim: newAccount('sim'),
    subs: [],
    jobs: {},
    simEngine: null,
    seed: null,
    watchlist: DEFAULT_WATCH.slice(),
    bootstrap: { status: 'pending' },
  };
}

let S = emptyWorld();
let releaseReady = () => {};
const readyPromise = new Promise((resolve) => { releaseReady = resolve; });

let saveTimer = null;
let saveRunning = null;
let savePending = false;
function cloneForSave(state) {
  const snap = JSON.parse(JSON.stringify(state));
  for (const id of ['live', 'sim']) {
    for (const order of snap[id].orders || []) {
      delete order.executing;
      delete order.fillLock;
    }
  }
  return snap;
}
function save() {
  savePending = true;
  if (saveTimer || saveRunning) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveRunning = persistLoop().finally(() => { saveRunning = null; });
  }, 400);
}
async function persistLoop() {
  while (savePending) {
    savePending = false;
    try {
      await db.saveState(cloneForSave(S));
    } catch (err) {
      console.error('persist failed', err.message);
      savePending = true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
async function flushNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  savePending = true;
  if (saveRunning) {
    await saveRunning;
    if (savePending && !saveRunning) {
      saveRunning = persistLoop().finally(() => { saveRunning = null; });
      await saveRunning;
    }
    return;
  }
  saveRunning = persistLoop().finally(() => { saveRunning = null; });
  await saveRunning;
}

const clients = new Set();
function emit(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

async function push(payload) {
  if (!vapidReady || !S.subs.length) return;
  const dead = [];
  await Promise.all(S.subs.map(async (sub) => {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); }
    catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
      else console.error('push err', err.statusCode || '', err.body || err.message);
    }
  }));
  if (dead.length) {
    S.subs = S.subs.filter((sub) => !dead.includes(sub.endpoint));
    save();
  }
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const fmt$ = (x) => (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const rnd = (a, b) => a + Math.random() * (b - a);
function fmtCT(ms) {
  return new Date(ms).toLocaleString('en-US', { timeZone: M.TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
}
function ctToMs(dateStr, mins) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, mins) + 6 * 3600e3;
  for (let i = 0; i < 3; i++) {
    const parts = M.parts(new Date(guess));
    const diff = ((parts.date === dateStr ? 0 : (parts.date > dateStr ? 1440 : -1440)) + parts.mins) - mins;
    guess -= diff * 60e3;
  }
  return guess;
}

const ctx = {
  live: {
    nowMs: () => Date.now(),
    clock() { return M.parts(new Date()); },
    status() { const parts = this.clock(); return M.statusAt(parts.date, parts.mins); },
    async quote(ticker) { return Q.getQuote(ticker); },
    async history(ticker) { return Q.getHistory(ticker); },
  },
  sim: {
    nowMs: () => (S.simEngine ? S.simEngine.simMs : Date.now()),
    clock() { return M.parts(new Date(this.nowMs())); },
    status() {
      if (!S.simEngine) return { open: false, label: 'Sim not started' };
      const parts = this.clock();
      return M.statusAt(parts.date, parts.mins);
    },
    async quote(ticker) { return simQuote(ticker.toUpperCase()); },
    async history(ticker) { return simHistory(ticker.toUpperCase()); },
  },
};

async function valuation(mode) {
  const account = S[mode];
  const C = ctx[mode];
  const rows = [];
  let mv = 0;
  for (const [ticker, position] of Object.entries(account.positions)) {
    if (position.shares <= 1e-9) continue;
    let quote;
    try { quote = await C.quote(ticker); }
    catch { quote = { price: position.cost / position.shares, prevClose: position.cost / position.shares }; }
    const value = position.shares * quote.price;
    mv += value;
    rows.push({
      ticker,
      shares: r4(position.shares),
      avgCost: position.cost / position.shares,
      price: quote.price,
      prevClose: quote.prevClose,
      value,
      unreal: value - position.cost,
      unrealPct: (value - position.cost) / position.cost,
      dayChg: position.shares * (quote.price - quote.prevClose),
      quoteTime: quote.quoteTime,
    });
  }
  const total = account.cash + mv;
  const today = C.clock().date;
  const prior = [...account.snapshots].reverse().find((snap) => snap.date < today);
  const base = prior ? prior.value : account.startCash;
  return {
    positions: rows.sort((a, b) => b.value - a.value),
    cash: account.cash,
    marketValue: mv,
    total,
    dayPL: total - base,
    dayPct: (total - base) / base,
    totalPL: total - account.startCash,
    totalPct: (total - account.startCash) / account.startCash,
    realized: account.realized,
  };
}
function reserved(account, excludeId) {
  let cash = 0;
  const shares = {};
  for (const order of account.orders) {
    if (order.id === excludeId || !['pending', 'queued', 'working', 'partially filled'].includes(order.status)) continue;
    const rem = order.shares - order.filled;
    if (order.side === 'buy') cash += rem * (order.limit || order.stop || order.refPrice) * 1.001;
    else shares[order.ticker] = (shares[order.ticker] || 0) + rem;
  }
  return { cash, sh: shares };
}
function regFees(side, principal, shares) {
  if (side !== 'sell') return 0;
  const sec = Math.ceil(principal * 0.0000278 * 100) / 100;
  const taf = Math.min(8.3, Math.ceil(shares * 0.000166 * 100) / 100);
  return r2(sec + taf);
}

async function preview(mode, body) {
  const account = S[mode];
  const C = ctx[mode];
  const errors = [];
  const warnings = [];
  const ticker = String(body.ticker || '').toUpperCase().trim();
  const side = body.side === 'sell' ? 'sell' : 'buy';
  const type = ['market', 'limit', 'stop'].includes(body.type) ? body.type : null;
  const tif = body.tif === 'gtc' ? 'gtc' : 'day';
  if (!/^[A-Z.]{1,6}$/.test(ticker)) errors.push('Enter a valid ticker symbol.');
  if (!type) errors.push('Choose an order type.');
  if (errors.length) return { ok: false, errors };
  let quote;
  try { quote = await C.quote(ticker); }
  catch { return { ok: false, errors: [`Could not get a quote for ${ticker}.`] }; }
  const status = C.status();
  const limit = body.limit != null && body.limit !== '' ? Number(body.limit) : null;
  const stop = body.stop != null && body.stop !== '' ? Number(body.stop) : null;
  if (type === 'limit' && !(limit > 0)) errors.push('Limit orders need a limit price.');
  if (type === 'stop' && !(stop > 0)) errors.push('Stop orders need a stop price.');
  if (type === 'stop' && side === 'sell' && stop >= quote.price) errors.push(`Sell stop must be below the current price (${fmt$(quote.price)}).`);
  if (type === 'stop' && side === 'buy' && stop <= quote.price) errors.push(`Buy stop must be above the current price (${fmt$(quote.price)}).`);
  if (type === 'limit' && limit && Math.abs(limit - quote.price) / quote.price > 0.1) warnings.push(`Limit is ${(Math.abs(limit - quote.price) / quote.price * 100).toFixed(1)}% away from last price.`);
  const ref = type === 'limit' ? limit : type === 'stop' ? stop : quote.price;
  let shares;
  if (body.qtyMode === 'dollars') {
    if (type !== 'market') errors.push('Dollar-amount orders are market orders only (fractional shares). Switch to shares for limit/stop.');
    const dollars = Number(body.dollars);
    if (!(dollars >= 5)) errors.push('Dollar orders must be at least $5.00.');
    shares = Math.floor((dollars / (quote.price + 0.03)) * 1e4) / 1e4;
  } else {
    shares = Number(body.shares);
    if (!(shares > 0)) errors.push('Enter a share quantity.');
    else if (type !== 'market' && !Number.isInteger(shares)) errors.push(side === 'sell' ? 'Fractional shares can only be sold with a market order during market hours. Limit and stop orders must be whole shares.' : 'Limit and stop orders must be whole shares.');
    else if (Math.round(shares * 1e4) !== shares * 1e4) errors.push('Max 4 decimal places on shares.');
  }
  if (!status.open && type === 'market') errors.push('Market is closed. Market orders are only accepted 8:30 AM - 3:00 PM CT (9:30-4:00 ET) on trading days. Use a limit order to queue for the next open.');
  const principal = shares * (ref || 0);
  const commission = COMMISSION[type] || 0;
  const fees = regFees(side, principal, shares);
  const heldBack = reserved(account);
  if (side === 'buy' && principal + commission > account.cash - heldBack.cash + 1e-9) errors.push(`Insufficient buying power. Available: ${fmt$(account.cash - heldBack.cash)}; this order needs about ${fmt$(principal + commission)}.`);
  if (side === 'sell') {
    const held = (account.positions[ticker] && account.positions[ticker].shares) || 0;
    if (shares > held - (heldBack.sh[ticker] || 0) + 1e-9) errors.push(`You can sell at most ${r4(held - (heldBack.sh[ticker] || 0))} shares of ${ticker} (no short selling).`);
  }
  if (type === 'market') warnings.push('Market orders fill at the next available price, which may differ from the quote.');
  let queueNote = null;
  if (!status.open && type !== 'market') {
    const parts = C.clock();
    const nextDate = (M.isTradingDate(parts.date) && parts.mins < M.OPEN_MINS) ? parts.date : M.nextTradingDate(parts.date);
    queueNote = `Market is closed. This order will queue and become active at the next open: ${fmtCT(ctToMs(nextDate, M.OPEN_MINS))}.`;
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    queueNote,
    ticker,
    name: quote.name,
    side,
    type,
    tif: type === 'market' ? 'day' : tif,
    qtyMode: body.qtyMode === 'dollars' ? 'dollars' : 'shares',
    shares,
    limit,
    stop,
    quote: { price: quote.price, prevClose: quote.prevClose, time: quote.quoteTime, source: quote.source },
    estPrice: ref,
    principal: r2(principal),
    commission,
    fees,
    estTotal: r2(side === 'buy' ? principal + commission : principal - commission - fees),
    cashAfter: r2(side === 'buy' ? account.cash - principal - commission : account.cash + principal - commission - fees),
    market: status,
  };
}

async function placeOrder(mode, body) {
  const previewed = await preview(mode, body);
  if (!previewed.ok) return { ok: false, errors: previewed.errors };
  const account = S[mode];
  const C = ctx[mode];
  const status = C.status();
  const parts = C.clock();
  const num = `${mode === 'sim' ? 'S' : 'P'}${String(Date.now()).slice(-6)}${String(account.seq++).padStart(3, '0')}`;
  const order = {
    id: crypto.randomUUID(),
    num,
    ticker: previewed.ticker,
    name: previewed.name,
    side: previewed.side,
    type: previewed.type,
    tif: previewed.tif,
    qtyMode: previewed.qtyMode,
    shares: previewed.shares,
    dollars: body.dollars ? Number(body.dollars) : null,
    limit: previewed.limit,
    stop: previewed.stop,
    refPrice: previewed.quote.price,
    quoteAtEntry: previewed.quote,
    filled: 0,
    avgFill: null,
    status: 'pending',
    createdAt: C.nowMs(),
    events: [],
  };
  order.events.push({ at: C.nowMs(), text: `Order received: ${order.side.toUpperCase()} ${order.shares} ${order.ticker} ${order.type.toUpperCase()}${order.limit ? ' @ ' + fmt$(order.limit) : ''}${order.stop ? ' stop ' + fmt$(order.stop) : ''}` });
  if (!status.open) {
    order.status = 'queued';
    order.sessionDate = (M.isTradingDate(parts.date) && parts.mins < M.OPEN_MINS) ? parts.date : M.nextTradingDate(parts.date);
    order.events.push({ at: C.nowMs(), text: previewed.queueNote });
  } else {
    order.sessionDate = parts.date;
  }
  account.orders.unshift(order);
  save();
  emit('state', { mode });
  if (status.open) {
    if (order.type === 'market') setTimeout(() => executeMarket(mode, order.id), rnd(1200, 3500));
    else setTimeout(() => {
      order.status = 'working';
      order.events.push({ at: C.nowMs(), text: 'Order working at exchange.' });
      save();
      emit('state', { mode });
      checkResting(mode);
    }, rnd(800, 2000));
  }
  return { ok: true, order };
}

function slip(side) { return (side === 'buy' ? 1 : -1) * Math.round(rnd(1, 3.999)) / 100; }

async function executeMarket(mode, id, opts = {}) {
  const account = S[mode];
  const C = ctx[mode];
  const order = account.orders.find((item) => item.id === id);
  if (!order || ['filled', 'cancelled', 'rejected', 'expired'].includes(order.status)) return;
  if (order.fillLock) return;
  order.fillLock = true;
  try {
    if (!C.status().open) {
      order.status = 'queued';
      order.sessionDate = M.nextTradingDate(C.clock().date);
      order.events.push({ at: C.nowMs(), text: 'Market closed before execution. Order held for next open.' });
      save();
      return;
    }
    const rem = r4(order.shares - order.filled);
    let chunk = rem;
    const notional = rem * order.refPrice;
    if (!opts.noPartial && rem >= 2 && (rem >= 5 || notional >= 250) && Math.random() < 0.45) {
      chunk = Number.isInteger(rem) ? Math.max(1, Math.floor(rem * rnd(0.3, 0.7))) : r4(rem * rnd(0.3, 0.7));
    }
    let quote;
    try { quote = await C.quote(order.ticker); }
    catch { setTimeout(() => executeMarket(mode, id, opts), 3000); return; }
    let price = r2(quote.price + slip(order.side));
    if (opts.limit) price = order.side === 'buy' ? Math.min(price, opts.limit) : Math.max(price, opts.limit);
    fill(mode, order, chunk, price);
    if (order.filled < order.shares - 1e-9 && order.status !== 'rejected') {
      order.status = 'partially filled';
      save();
      emit('state', { mode });
      setTimeout(() => executeMarket(mode, id, { ...opts, noPartial: Math.random() < 0.6 }), rnd(2000, 6000));
    }
  } finally {
    delete order.fillLock;
  }
}

function fill(mode, order, shares, price) {
  const account = S[mode];
  const C = ctx[mode];
  const principal = r2(shares * price);
  const commission = order.filled === 0 ? (COMMISSION[order.type] || 0) : 0;
  const fees = regFees(order.side, principal, shares);
  const net = order.side === 'buy' ? principal + commission : principal - commission - fees;
  if (order.side === 'buy' && net > account.cash + 0.005) {
    order.status = order.filled > 0 ? 'filled' : 'rejected';
    order.events.push({ at: C.nowMs(), text: `Rejected: insufficient cash for remaining ${r4(shares)} shares.` });
    if (order.filled > 0) order.shares = order.filled;
    save();
    emit('state', { mode });
    return;
  }
  const position = account.positions[order.ticker] || (account.positions[order.ticker] = { shares: 0, cost: 0 });
  let realized = 0;
  if (order.side === 'buy') {
    position.shares = r4(position.shares + shares);
    position.cost += net;
    account.cash = r2(account.cash - net);
  } else {
    const avg = position.cost / position.shares;
    const basis = avg * shares;
    realized = net - basis;
    account.realized = r2(account.realized + realized);
    position.shares = r4(position.shares - shares);
    position.cost = position.shares > 1e-9 ? position.cost - basis : 0;
    account.cash = r2(account.cash + net);
    if (position.shares <= 1e-9) delete account.positions[order.ticker];
  }
  const prevFilled = order.filled;
  order.filled = r4(order.filled + shares);
  order.avgFill = ((order.avgFill || 0) * prevFilled + price * shares) / order.filled;
  const done = order.filled >= order.shares - 1e-9;
  order.status = done ? 'filled' : 'partially filled';
  const at = C.nowMs();
  account.fills.unshift({
    id: crypto.randomUUID(),
    orderNum: order.num,
    ticker: order.ticker,
    side: order.side,
    shares,
    price,
    principal,
    commission,
    fees,
    net: r2(net),
    realized: r2(realized),
    cashAfter: account.cash,
    at,
    partial: !done || prevFilled > 0,
    slippage: r2(price - order.refPrice),
    quoteAtEntry: order.refPrice,
  });
  order.events.push({ at, text: `${done ? 'Filled' : 'Partial fill'}: ${r4(shares)} @ ${fmt$(price)} (${order.filled}/${order.shares})` });
  const settle = M.nextTradingDate(M.parts(new Date(at)).date);
  account.emails.unshift({
    id: crypto.randomUUID(),
    at,
    read: false,
    from: 'Paper Brokerage Trade Confirmations <confirms@paper-brokerage.sim>',
    to: 'Kate Lynn <kate.lynn@example.com>',
    subject: `Trade Confirmation: You ${order.side === 'buy' ? 'bought' : 'sold'} ${r4(shares)} ${order.ticker} @ ${fmt$(price)}`,
    fields: {
      'Order number': order.num,
      'Account': mode === 'sim' ? 'Paper SIM ****0500' : 'Paper Individual ****0500',
      'Action': order.side === 'buy' ? 'Buy' : 'Sell',
      'Symbol': `${order.ticker} (${order.name || ''})`,
      'Order type': `${order.type[0].toUpperCase() + order.type.slice(1)}${order.limit ? ' @ ' + fmt$(order.limit) : ''}${order.stop ? ' stop ' + fmt$(order.stop) : ''} · ${order.tif.toUpperCase()}`,
      'Quantity filled': `${r4(shares)} (order total ${order.filled} of ${order.shares}${done ? ', complete' : ', partial'})`,
      'Execution price': fmt$(price),
      'Execution time': new Date(at).toLocaleString('en-US', { timeZone: M.TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' CT',
      'Principal': fmt$(principal),
      'Commission': fmt$(commission),
      'Reg. fees (SEC/TAF)': fmt$(fees),
      'Net amount': fmt$(net),
      'Trade date': M.parts(new Date(at)).date,
      'Settlement date': settle,
      'Capacity': 'Agent (simulated)',
    },
  });
  const title = `${mode === 'sim' ? '[SIM] ' : ''}Order ${done ? 'filled' : 'partially filled'}: ${order.ticker}`;
  const text = `${order.side === 'buy' ? 'Bought' : 'Sold'} ${r4(shares)} ${order.ticker} @ ${fmt$(price)}. Cash ${fmt$(account.cash)}.`;
  addMessage(mode, 'fill', title, text, false);
  save();
  emit('state', { mode });
}

function addMessage(mode, kind, title, body, _doPush = true, extra = {}) {
  const account = S[mode];
  const message = { id: crypto.randomUUID(), kind, title, body, at: ctx[mode].nowMs(), realAt: Date.now(), read: false, mode, ...extra };
  account.messages.unshift(message);
  if (account.messages.length > 300) account.messages.length = 300;
  save();
  emit('message', message);
  push({ title: message.title, body: message.body.split('\n').slice(0, 4).join('\n'), tag: message.id, kind, mode, url: '/?tab=alerts&mode=' + mode });
  return message;
}

let checking = { live: false, sim: false };
async function checkResting(mode) {
  if (checking[mode]) return;
  checking[mode] = true;
  try {
    const account = S[mode];
    const C = ctx[mode];
    const status = C.status();
    const parts = C.clock();
    for (const order of account.orders) {
      if (mode === 'live' && order.type === 'market' && ['pending', 'partially filled'].includes(order.status) && !order.executing && status.open) {
        const last = order.events.length ? order.events[order.events.length - 1].at : order.createdAt;
        if (C.nowMs() - last > 20000) {
          order.executing = true;
          setTimeout(() => { delete order.executing; executeMarket(mode, order.id); }, rnd(500, 1500));
        }
      }
      if (!['queued', 'working', 'partially filled'].includes(order.status) || order.executing) continue;
      if (order.tif === 'day' && (parts.date > order.sessionDate || (parts.date === order.sessionDate && parts.mins >= M.closeMins(parts.date)))) {
        if (!(order.status === 'queued' && parts.date <= order.sessionDate)) {
          order.status = order.filled > 0 ? 'filled' : 'expired';
          if (order.filled > 0) order.shares = order.filled;
          order.events.push({ at: C.nowMs(), text: 'Day order expired at market close.' });
          save();
          emit('state', { mode });
          continue;
        }
      }
      if (!status.open) continue;
      if (order.status === 'queued') {
        if (parts.date >= order.sessionDate) {
          order.status = 'working';
          order.events.push({ at: C.nowMs(), text: 'Market open: order released to exchange.' });
          save();
          emit('state', { mode });
          if (order.type === 'market') {
            order.executing = true;
            setTimeout(() => { delete order.executing; executeMarket(mode, order.id); }, rnd(1000, 3000));
            continue;
          }
        } else continue;
      }
      if (order.type === 'market') continue;
      let quote;
      try { quote = await C.quote(order.ticker); }
      catch { continue; }
      let hit = false;
      if (order.type === 'limit') hit = order.side === 'buy' ? quote.price <= order.limit : quote.price >= order.limit;
      if (order.type === 'stop') hit = order.side === 'sell' ? quote.price <= order.stop : quote.price >= order.stop;
      if (hit) {
        order.executing = true;
        order.events.push({ at: C.nowMs(), text: order.type === 'stop' ? `Stop triggered at ${fmt$(quote.price)}; now a market order.` : `Limit reached (last ${fmt$(quote.price)}).` });
        setTimeout(async () => { delete order.executing; await executeMarket(mode, order.id, { limit: order.type === 'limit' ? order.limit : null }); }, rnd(800, 2500));
      }
    }
  } finally {
    checking[mode] = false;
  }
}

async function tickerInfo(mode, ticker) {
  const C = ctx[mode];
  const quote = await C.quote(ticker);
  const history = await C.history(ticker);
  const closes = history.closes;
  const prior = closes[Math.max(0, closes.length - 6)];
  const sma20 = closes.slice(-20).reduce((sum, price) => sum + price, 0) / Math.min(20, closes.length);
  return {
    t: ticker,
    price: quote.price,
    prevClose: quote.prevClose,
    dayChg: (quote.price - quote.prevClose) / quote.prevClose,
    mom5: (quote.price - prior) / prior,
    vsSma20: (quote.price - sma20) / sma20,
    vol: history.dailyVol,
    move: history.dailyVol * quote.price,
    name: quote.name,
  };
}
async function dailyCheck(mode, manual = false) {
  const account = S[mode];
  const value = await valuation(mode);
  const lines = [];
  const infos = {};
  const tickers = [...new Set([...Object.keys(account.positions), ...WATCH])];
  for (const ticker of tickers) {
    try { infos[ticker] = await tickerInfo(mode, ticker); } catch { /* skip a name with no quote */ }
  }
  lines.push(`Account ${fmt$(value.total)} · total ${fmt$(value.totalPL)} (${pct(value.totalPct)}) · cash ${fmt$(value.cash)} (${(value.cash / value.total * 100).toFixed(0)}%)`);
  if (!value.positions.length) lines.push('Positions: none (all cash).');
  for (const position of value.positions) {
    const info = infos[position.ticker] || {};
    lines.push(`${position.ticker}: ${position.shares} sh @ ${fmt$(position.price)} · ${pct(position.unrealPct)} vs cost ${fmt$(position.avgCost)} · 5d ${pct(info.mom5 || 0)}`);
  }
  const open = account.orders.filter((order) => ['queued', 'working', 'partially filled', 'pending'].includes(order.status));
  if (open.length) lines.push('Open orders: ' + open.map((order) => `${order.side.toUpperCase()} ${order.shares - order.filled} ${order.ticker} ${order.type}${order.limit ? ' @ ' + fmt$(order.limit) : ''}${order.stop ? ' stop ' + fmt$(order.stop) : ''} (${order.status})`).join(' · '));
  const watchOnly = WATCH.filter((ticker) => !account.positions[ticker] && infos[ticker]);
  if (watchOnly.length) lines.push('Watchlist: ' + watchOnly.map((ticker) => `${ticker} ${fmt$(infos[ticker].price)} (5d ${pct(infos[ticker].mom5)})`).join(' · '));
  let action = 'HOLD';
  let why = 'Nothing has hit a rule. Do nothing today.';
  const winners = value.positions.filter((position) => position.unrealPct >= 0.08).sort((a, b) => b.unrealPct - a.unrealPct);
  const losers = value.positions.filter((position) => position.unrealPct <= -0.06).sort((a, b) => a.unrealPct - b.unrealPct);
  const cashPct = value.cash / value.total;
  if (losers.length) {
    action = `TRIM ${losers[0].ticker}`;
    why = `${losers[0].ticker} is ${pct(losers[0].unrealPct)} below cost, past the -6% risk line. Cut part of it or set a tight stop.`;
  } else if (winners.length) {
    action = `TRIM ${winners[0].ticker}`;
    why = `${winners[0].ticker} is ${pct(winners[0].unrealPct)} above cost. Take some profit at the open.`;
  } else if (cashPct > 0.4) {
    const candidate = Object.values(infos).filter((info) => info.mom5 > 0 && info.vsSma20 > -0.02 && info.price <= value.cash * 0.6).sort((a, b) => b.mom5 - a.mom5)[0];
    if (candidate) {
      action = `ADD ${candidate.t}`;
      why = `Cash is ${(cashPct * 100).toFixed(0)}% of the account and ${candidate.t} has positive 5-day momentum (${pct(candidate.mom5)}). Look for an entry near the limit in the 8:00 game plan.`;
    } else why = `Cash is ${(cashPct * 100).toFixed(0)}%, but no watchlist name has a clean setup. Stay in cash.`;
  }
  lines.push(`ACTION: ${action}. ${why}`);
  lines.push(DISCLAIMER);
  account.lastAction = { action, at: ctx[mode].nowMs() };
  const parts = ctx[mode].clock();
  return addMessage(mode, 'daily_check', `${mode === 'sim' ? '[SIM] ' : ''}7:00 Daily Check: ${action}`, lines.join('\n'), true, { manual, simDate: parts.date });
}
async function gamePlan(mode, manual = false) {
  const account = S[mode];
  const value = await valuation(mode);
  const tickers = [...new Set([...WATCH, ...Object.keys(account.positions)])];
  const lines = [];
  let go = false;
  const plans = [];
  const avail = value.cash - reserved(account).cash;
  for (const ticker of tickers) {
    let info;
    try { info = await tickerInfo(mode, ticker); }
    catch { continue; }
    const held = account.positions[ticker];
    if (held) {
      const avg = held.cost / held.shares;
      const trimAt = r2(Math.max(avg * 1.08, info.price + info.move));
      const stopAt = r2(Math.min(avg * 0.94, info.price - 1.5 * info.move));
      plans.push(`${ticker} (held ${r4(held.shares)}): last ${fmt$(info.price)} · trim limit SELL @ ${fmt$(trimAt)} · protective stop ${fmt$(stopAt)}`);
      if ((info.price - avg) / avg >= 0.08 || (info.price - avg) / avg <= -0.06) go = true;
    } else {
      const limit = r2(info.price - 0.5 * info.move);
      const shares = Math.floor((avail * 0.33) / limit);
      const setup = info.mom5 > 0 && info.vsSma20 > -0.02;
      if (setup && shares >= 1) go = true;
      const what = !setup ? 'watch only, no setup' : shares < 1 ? `setup, but 1 share at ${fmt$(limit)} is over the 1/3-of-cash size limit; skip` : `BUY limit @ ${fmt$(limit)} x ${shares} sh (~${fmt$(limit * shares)})`;
      plans.push(`${ticker}: last ${fmt$(info.price)} · ${what} · typical 1-day move ≈ ${fmt$(info.move)} · 5d ${pct(info.mom5)}`);
    }
  }
  const call = go ? 'GO' : 'NO-GO';
  lines.push(`Open at 8:30 CT. Call: ${call}. ${go ? 'Place the limit orders below before the bell, then leave them alone.' : 'No setup meets the rules. Do not trade today.'}`);
  lines.push(...plans);
  lines.push(`Buying power: ${fmt$(avail)}${avail < value.cash - 0.01 ? ' (after open orders)' : ''}.`);
  lines.push(DISCLAIMER);
  const parts = ctx[mode].clock();
  return addMessage(mode, 'game_plan', `${mode === 'sim' ? '[SIM] ' : ''}8:00 Game Plan: ${call}`, lines.join('\n'), true, { manual, simDate: parts.date, call });
}
async function closeSnapshot(mode, dateOverride) {
  const account = S[mode];
  const value = await valuation(mode);
  const parts = ctx[mode].clock();
  const date = dateOverride || parts.date;
  if (account.snapshots.find((snap) => snap.date === date)) return;
  const prior = [...account.snapshots].reverse().find((snap) => snap.date < date);
  const base = prior ? prior.value : account.startCash;
  const snap = {
    date,
    value: r2(value.total),
    cash: value.cash,
    marketValue: r2(value.marketValue),
    dayPL: r2(value.total - base),
    dayPct: (value.total - base) / base,
    cumPL: r2(value.total - account.startCash),
    cumPct: (value.total - account.startCash) / account.startCash,
    at: ctx[mode].nowMs(),
  };
  account.snapshots.push(snap);
  save();
  emit('state', { mode });
  const caughtUp = date !== parts.date;
  addMessage(
    mode,
    'close',
    `${mode === 'sim' ? '[SIM] ' : ''}Market close${caughtUp ? ' ' + date : ''}: ${fmt$(snap.dayPL)} (${pct(snap.dayPct)}) today`,
    `Closing value ${fmt$(snap.value)}. Since start ${fmt$(snap.cumPL)} (${pct(snap.cumPct)}).`,
    true
  );
}

let jobsChain = Promise.resolve();
function withJobsLock(fn) {
  const run = jobsChain.then(() => fn(), () => fn());
  jobsChain = run.then(() => {}, () => {});
  return run;
}
async function runDueLiveJobs() {
  const parts = M.parts(new Date());
  const ran = [];
  for (const job of dueLiveJobs(parts, M)) {
    const marker = `live:${job.date}:${job.key}`;
    const claimed = await db.claimJob(marker);
    if (!claimed) continue;
    S.jobs[`${job.date}:${job.key}`] = Date.now();
    try {
      if (job.key === 'close' && job.date !== parts.date) {
        const closeAt = ctToMs(job.date, M.closeMins(job.date));
        if (new Date(S.live.createdAt).getTime() > closeAt) {
          console.log('skip close catch-up', job.date);
          continue;
        }
      }
      if (job.key === 'daily_check') await dailyCheck('live');
      else if (job.key === 'game_plan') await gamePlan('live');
      else if (job.key === 'close') await closeSnapshot('live', job.date);
      ran.push(marker);
    } catch (err) {
      console.error('job failed', marker, err.message);
      delete S.jobs[`${job.date}:${job.key}`];
      try { await db.releaseJob(marker); } catch (releaseErr) { console.error('job release failed', releaseErr.message); }
    }
  }
  return ran;
}

function applyStarter(account, quotes) {
  const plan = starterPositions(quotes, WATCH, account.startCash);
  account.positions = {};
  for (const [ticker, position] of Object.entries(plan.positions)) {
    account.positions[ticker] = { shares: position.shares, cost: position.cost };
  }
  account.cash = plan.cash;
  const at = Date.now();
  let running = account.startCash;
  const fills = [];
  for (const ticker of WATCH) {
    const position = plan.positions[ticker];
    if (!position) continue;
    running = r2(running - position.cost);
    fills.push({
      id: crypto.randomUUID(),
      orderNum: 'SEED',
      ticker,
      side: 'buy',
      shares: position.shares,
      price: position.price,
      principal: position.cost,
      commission: 0,
      fees: 0,
      net: position.cost,
      realized: 0,
      cashAfter: running,
      at,
      partial: false,
      slippage: 0,
      quoteAtEntry: position.price,
      seed: true,
    });
  }
  account.fills = fills.reverse();
  const lines = WATCH.map((ticker) => {
    const position = plan.positions[ticker];
    return position ? `${ticker} ${position.shares} sh @ ${fmt$(position.price)}` : `${ticker} (no whole share fit in the remaining cash)`;
  });
  account.messages.unshift({
    id: crypto.randomUUID(),
    kind: 'system',
    title: 'Starter account ready',
    body: `Paper account opened with ${fmt$(account.startCash)}. Starter positions from the first Yahoo quotes: ${lines.join('; ')}. Cash left ${fmt$(account.cash)}. ${DISCLAIMER}`,
    at,
    realAt: at,
    read: false,
    mode: 'live',
  });
}
function slimQuotes(quotes) {
  return Object.fromEntries(Object.entries(quotes).map(([ticker, quote]) => [ticker, {
    price: quote.price,
    prevClose: quote.prevClose,
    quoteTime: quote.quoteTime,
    source: quote.source,
  }]));
}
async function ensureStarterSeed() {
  return db.withLock(async () => {
    const fresh = await db.loadState();
    if (fresh) {
      S.live = fresh.live;
      S.sim = fresh.sim;
      S.subs = fresh.subs;
      S.jobs = fresh.jobs || {};
      S.simEngine = fresh.simEngine;
      S.bootstrap = fresh.bootstrap;
      S.seed = fresh.seed;
      if (Array.isArray(fresh.watchlist) && fresh.watchlist.length) {
        WATCH = fresh.watchlist.map((ticker) => String(ticker).toUpperCase());
      }
    }
    if (S.bootstrap && S.bootstrap.status === 'complete') return false;
    if (Object.keys(S.live.positions).length) {
      S.bootstrap = { status: 'complete', at: new Date().toISOString(), note: 'positions already present' };
      save();
      await flushNow();
      return false;
    }
    const quotes = {};
    for (const ticker of WATCH) {
      try { quotes[ticker] = await Q.getQuote(ticker, 0); }
      catch (err) { console.error('starter quote failed', ticker, err.message); }
    }
    if (!Object.keys(quotes).length) {
      console.error('starter seed waiting for Yahoo quotes; cash account is open');
      return false;
    }
    applyStarter(S.live, quotes);
    S.seed = slimQuotes(quotes);
    S.bootstrap = { status: 'complete', at: new Date().toISOString(), tickers: Object.keys(quotes) };
    save();
    await flushNow();
    console.log('starter seed complete', Object.keys(S.live.positions).join(',') || 'cash only');
    return true;
  });
}
async function refreshSeedQuotes() {
  const quotes = {};
  for (const ticker of WATCH) {
    try { quotes[ticker] = await Q.getQuote(ticker, 0); }
    catch (err) { console.error('quote refresh failed', ticker, err.message); }
  }
  if (!Object.keys(quotes).length) return;
  S.seed = slimQuotes(quotes);
  save();
}

function gauss() {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
async function startSim(speed = 60, days = 10) {
  const tickers = [...WATCH];
  const base = {};
  for (const ticker of tickers) {
    const quote = await Q.getQuote(ticker, 60000);
    const history = await Q.getHistory(ticker);
    base[ticker] = { price: quote.price, vol: history.dailyVol, hist: history.closes.slice(-60) };
  }
  let date = M.nextTradingDate(M.parts(new Date()).date);
  const out = [];
  const last = Object.fromEntries(tickers.map((ticker) => [ticker, base[ticker].price]));
  for (let k = 0; k < days; k++) {
    const roll = Math.random();
    const kind = roll < 0.3 ? 'quiet' : roll < 0.85 ? 'normal' : 'eventful';
    const mult = kind === 'quiet' ? 0.45 : kind === 'normal' ? 1 : 1.8;
    const close = M.closeMins(date);
    const n = close - M.OPEN_MINS + 1;
    const paths = {};
    const market = Array.from({ length: n }, () => gauss());
    const marketGap = gauss();
    for (const ticker of tickers) {
      const sig = base[ticker].vol * mult;
      const step = sig / Math.sqrt(390);
      let price = last[ticker] * Math.exp(0.35 * sig * (0.5 * marketGap + 0.866 * gauss()));
      if (kind === 'eventful' && Math.random() < 0.4) price *= Math.exp((Math.random() < 0.5 ? -1 : 1) * rnd(1.2, 2.5) * base[ticker].vol);
      const series = [r2(price)];
      for (let i = 1; i < n; i++) {
        const z = 0.45 * market[i] + 0.893 * gauss();
        price = price * Math.exp(-0.5 * step * step + step * z);
        series.push(r2(price));
      }
      paths[ticker] = series;
      last[ticker] = series[series.length - 1];
    }
    out.push({ date, kind, paths, closeMins: close });
    date = M.nextTradingDate(date);
  }
  S.sim = newAccount('sim');
  S.simEngine = {
    running: true,
    speed,
    days: out,
    base,
    simMs: ctToMs(out[0].date, 6 * 60 + 55),
    jobs: {},
    startedAt: Date.now(),
    finished: false,
  };
  save();
  emit('state', { mode: 'sim' });
  addMessage('sim', 'system', '[SIM] Two-week simulation started', `${days} simulated trading days (${out[0].date} to ${out[out.length - 1].date}) built from each ticker's real 6-month volatility. Includes quiet days. Speed ${speed}x. Alerts arrive at simulated 7:00, 8:00 and 3:00 CT.`, false);
}
function simDayIdx(date) { return S.simEngine ? S.simEngine.days.findIndex((day) => day.date === date) : -1; }
function simQuote(ticker) {
  const engine = S.simEngine;
  if (!engine) throw new Error('sim not started');
  if (!engine.base[ticker]) throw new Error(`${ticker} is not in the simulation universe (MRK, CVX, MDLZ).`);
  const parts = M.parts(new Date(engine.simMs));
  let idx = engine.days.findIndex((day) => day.date >= parts.date);
  let price;
  let prevClose;
  const closeOf = (i) => (i < 0 ? engine.base[ticker].price : engine.days[i].paths[ticker][engine.days[i].paths[ticker].length - 1]);
  if (idx === -1) {
    idx = engine.days.length;
    price = closeOf(idx - 1);
    prevClose = closeOf(idx - 2);
  } else if (engine.days[idx].date > parts.date || parts.mins < M.OPEN_MINS) {
    price = closeOf(idx - 1);
    prevClose = closeOf(idx - 2);
  } else {
    const series = engine.days[idx].paths[ticker];
    const minute = Math.min(series.length - 1, parts.mins - M.OPEN_MINS);
    price = series[minute];
    prevClose = closeOf(idx - 1);
  }
  return { ticker, name: ticker, price, prevClose, quoteTime: new Date(engine.simMs).toISOString(), source: 'Simulated (GBM)' };
}
function simHistory(ticker) {
  const engine = S.simEngine;
  const parts = M.parts(new Date(engine.simMs));
  const closes = [...engine.base[ticker].hist];
  for (const day of engine.days) {
    const done = day.date < parts.date || (day.date === parts.date && parts.mins >= day.closeMins);
    if (done) closes.push(day.paths[ticker][day.paths[ticker].length - 1]);
  }
  return { closes, dailyVol: engine.base[ticker].vol };
}
let simBusy = false;
async function simTick() {
  const engine = S.simEngine;
  if (!engine || !engine.running || simBusy) return;
  simBusy = true;
  try {
    engine.simMs += engine.speed * 1000;
    let parts = M.parts(new Date(engine.simMs));
    const lastDay = engine.days[engine.days.length - 1];
    if (parts.date > lastDay.date || (parts.date === lastDay.date && parts.mins > lastDay.closeMins + 5)) {
      engine.running = false;
      engine.finished = true;
      engine.simMs = ctToMs(lastDay.date, lastDay.closeMins + 5);
      addMessage('sim', 'system', '[SIM] Simulation complete', `Finished ${engine.days.length} simulated trading days. Final value ${fmt$((await valuation('sim')).total)}.`, true);
    } else if (simDayIdx(parts.date) === -1 || parts.mins > engine.days[simDayIdx(parts.date)].closeMins + 5) {
      const next = engine.days.find((day) => day.date > parts.date);
      if (next) engine.simMs = ctToMs(next.date, 6 * 60 + 58);
    }
    parts = M.parts(new Date(engine.simMs));
    const day = engine.days[simDayIdx(parts.date)];
    if (day) {
      const run = async (key, fn) => {
        const marker = `${parts.date}:${key}`;
        if (engine.jobs[marker]) return;
        engine.jobs[marker] = 1;
        await fn();
      };
      if (parts.mins >= 420) await run('daily_check', () => dailyCheck('sim'));
      if (parts.mins >= 480) await run('game_plan', () => gamePlan('sim'));
      if (parts.mins >= M.OPEN_MINS) await run('open', async () => addMessage('sim', 'system', `[SIM] Opening bell, ${parts.date}`, `Market is open. Regular session until ${day.closeMins === 720 ? '12:00 PM' : '3:00 PM'} CT.`, false));
      if (parts.mins >= day.closeMins) await run('close', () => closeSnapshot('sim'));
    }
    await checkResting('sim');
    save();
    emit('simclock', { simMs: engine.simMs });
  } catch (err) {
    console.error('simTick', err.message);
  } finally {
    simBusy = false;
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());
app.use(async (req, res, next) => {
  if (req.path === '/healthz' || req.path === '/tick') return next();
  if (req.method === 'GET' && !req.path.startsWith('/api')) return next();
  try {
    await readyPromise;
    next();
  } catch {
    res.status(503).json({ ok: false, error: 'starting' });
  }
});

function token() {
  return crypto.createHmac('sha256', sessionSecret).update(PIN).digest('hex');
}
function authed(req) {
  if (!PIN) return true;
  return req.cookies.pt === token();
}
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true });
});
app.all('/tick', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.sendStatus(405);
  res.set('Cache-Control', 'no-store');
  try {
    await readyPromise;
    const ran = await withJobsLock(() => runDueLiveJobs());
    await checkResting('live');
    await flushNow();
    res.status(200).json({ ok: true, ran, time: new Date().toISOString() });
  } catch (err) {
    console.error('tick', err.message);
    res.status(500).json({ ok: false, error: 'tick failed' });
  }
});
app.post('/api/login', (req, res) => {
  if (!PIN) return res.json({ ok: true, pinRequired: false });
  if (String(req.body.pin || '') !== PIN) return res.status(401).json({ ok: false, error: 'Wrong PIN' });
  res.cookie('pt', token(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 1000 * 3600 * 24 * 365 });
  res.json({ ok: true });
});
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ ok: false, error: 'PIN required' })));
const modeOf = (req) => ((req.query.mode || (req.body && req.body.mode)) === 'sim' ? 'sim' : 'live');

app.get('/api/state', async (req, res) => {
  const mode = modeOf(req);
  const account = S[mode];
  const C = ctx[mode];
  try {
    const value = mode === 'sim' && !S.simEngine
      ? { positions: [], cash: account.cash, marketValue: 0, total: account.cash, dayPL: 0, dayPct: 0, totalPL: 0, totalPct: 0, realized: 0 }
      : await valuation(mode);
    const watch = [];
    if (!(mode === 'sim' && !S.simEngine)) {
      for (const ticker of WATCH) {
        try {
          const quote = await C.quote(ticker);
          watch.push({ ticker, price: quote.price, prevClose: quote.prevClose, time: quote.quoteTime, source: quote.source });
        } catch { /* leave the name off this refresh */ }
      }
    }
    const engine = S.simEngine;
    res.json({
      mode,
      now: C.nowMs(),
      realNow: Date.now(),
      market: C.status(),
      ...value,
      watch,
      orders: account.orders.slice(0, 100).map(({ executing, fillLock, ...order }) => order),
      fills: account.fills,
      snapshots: account.snapshots,
      messages: account.messages.slice(0, 100),
      emails: account.emails.slice(0, 100).map((email) => ({ ...email })),
      unread: account.messages.filter((message) => !message.read).length,
      unreadEmail: account.emails.filter((email) => !email.read).length,
      startCash: account.startCash,
      commission: COMMISSION,
      sim: engine ? {
        running: engine.running,
        speed: engine.speed,
        finished: engine.finished,
        simMs: engine.simMs,
        from: engine.days[0].date,
        to: engine.days[engine.days.length - 1].date,
        dayNum: Math.max(1, engine.days.filter((day) => day.date <= M.parts(new Date(engine.simMs)).date).length),
        days: engine.days.length,
      } : null,
      vapidKey: vapidReady ? vapidPublic : null,
      subs: S.subs.length,
      provider: Q.usingPolygon ? 'Polygon' : 'Yahoo Finance',
      seed: S.seed,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/quote/:t', async (req, res) => {
  try { res.json(await ctx[modeOf(req)].quote(req.params.t)); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
app.post('/api/preview', async (req, res) => res.json(await preview(modeOf(req), req.body)));
app.post('/api/order', async (req, res) => res.json(await placeOrder(modeOf(req), req.body)));
app.post('/api/order/:id/cancel', (req, res) => {
  const mode = modeOf(req);
  const order = S[mode].orders.find((item) => item.id === req.params.id);
  if (!order || !['queued', 'working', 'pending', 'partially filled'].includes(order.status)) return res.json({ ok: false, error: 'Order cannot be cancelled.' });
  if (order.executing) return res.json({ ok: false, error: 'Too late: order is executing.' });
  order.status = order.filled > 0 ? 'filled' : 'cancelled';
  if (order.filled > 0) order.shares = order.filled;
  order.events.push({ at: ctx[mode].nowMs(), text: 'Cancelled by you.' });
  save();
  emit('state', { mode });
  res.json({ ok: true });
});
app.post('/api/alerts/run', async (req, res) => {
  const mode = modeOf(req);
  if (mode === 'sim' && !S.simEngine) return res.json({ ok: false, error: 'Start the simulation first.' });
  try {
    const message = req.body.kind === 'game_plan' ? await gamePlan(mode, true) : await dailyCheck(mode, true);
    res.json({ ok: true, message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/read', (req, res) => {
  const account = S[modeOf(req)];
  if (req.body.email) {
    const email = account.emails.find((item) => item.id === req.body.email);
    if (email) email.read = true;
  }
  if (req.body.messages) account.messages.forEach((message) => { message.read = true; });
  save();
  res.json({ ok: true });
});
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false });
  if (!vapidReady) return res.status(503).json({ ok: false, error: 'Web push is not configured' });
  S.subs = S.subs.filter((item) => item.endpoint !== sub.endpoint);
  S.subs.push(sub);
  save();
  res.json({ ok: true, count: S.subs.length });
});
app.post('/api/push/test', async (req, res) => {
  if (!vapidReady) return res.json({ ok: false, subs: 0, error: 'Web push is not configured on this server yet.' });
  await push({ title: 'Test notification', body: 'Push is working. Your 7:00 and 8:00 CT alerts will look like this.', tag: 'test', url: '/' });
  res.json({ ok: true, subs: S.subs.length });
});
app.post('/api/sim/start', async (req, res) => {
  try {
    await startSim(Number(req.body.speed) || 60, Number(req.body.days) || 10);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/sim/control', (req, res) => {
  const engine = S.simEngine;
  if (!engine) return res.json({ ok: false, error: 'No simulation running.' });
  const action = req.body.action;
  if (action === 'pause') engine.running = false;
  if (action === 'resume' && !engine.finished) engine.running = true;
  if (action === 'speed') engine.speed = Math.max(1, Math.min(600, Number(req.body.speed) || 60));
  if (action === 'skip') {
    const parts = M.parts(new Date(engine.simMs));
    const marks = [419, 479, M.OPEN_MINS - 1];
    const day = engine.days.find((item) => item.date === parts.date);
    if (day) marks.push(day.closeMins - 1);
    const next = marks.sort((a, b) => a - b).find((mark) => mark > parts.mins);
    if (next != null) engine.simMs = ctToMs(parts.date, next) + 50e3;
    else {
      const nextDay = engine.days.find((item) => item.date > parts.date);
      if (nextDay) engine.simMs = ctToMs(nextDay.date, 418) + 50e3;
    }
  }
  save();
  emit('state', { mode: 'sim' });
  res.json({ ok: true });
});
app.post('/api/reset', async (req, res) => {
  const mode = modeOf(req);
  if (req.body.confirm !== 'RESET') return res.json({ ok: false, error: 'Type RESET to confirm.' });
  S[mode] = newAccount(mode);
  if (mode === 'sim') S.simEngine = null;
  if (mode === 'live') {
    S.jobs = {};
    try { await db.clearLiveJobs(); } catch (err) { console.error('clear jobs', err.message); }
  }
  save();
  await flushNow();
  emit('state', { mode });
  res.json({ ok: true });
});
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const keepalive = setInterval(() => res.write(': ka\n\n'), 20000);
  req.on('close', () => { clearInterval(keepalive); clients.delete(res); });
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => { if (filePath.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); },
}));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down', signal);
  try { await db.saveState(cloneForSave(S)); }
  catch (err) { console.error('flush on shutdown', err.message); }
  try { await db.end(); } catch { /* pool already closed */ }
  process.exit(0);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  configureVapid();
  await db.migrate();
  const loaded = await db.loadState();
  if (!loaded) {
    S = emptyWorld();
    await db.saveState(cloneForSave(S));
  } else {
    S = loaded;
    if (Array.isArray(S.watchlist) && S.watchlist.length) {
      WATCH = S.watchlist.map((ticker) => String(ticker).toUpperCase());
    }
  }
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  app.listen(PORT, HOST, () => {
    console.log(`paper-trader listening on ${HOST}:${PORT}`);
    withJobsLock(async () => {
      const seededNow = await ensureStarterSeed();
      if (!seededNow) await refreshSeedQuotes();
      await runDueLiveJobs();
    }).then(() => {
      releaseReady();
      checkResting('live').catch((err) => console.error('resting', err.message));
    }).catch((err) => {
      console.error('startup jobs', err.message);
      releaseReady();
    });
  });
  setInterval(() => {
    withJobsLock(() => runDueLiveJobs()).catch((err) => console.error('live jobs', err.message));
    checkResting('live').catch((err) => console.error('resting', err.message));
  }, 15000);
  setInterval(() => { simTick().catch((err) => console.error('simTick', err.message)); }, 1000);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, readyPromise };
