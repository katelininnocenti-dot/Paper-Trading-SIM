// Postgres persistence for the paper account. The process keeps the working
// copy in memory (fills and the sim clock mutate it constantly) and writes
// normalized rows on each save.
const pg = require('pg');

const { Pool } = pg;
pg.types.setTypeParser(1082, (value) => value); // date as YYYY-MM-DD
pg.types.setTypeParser(20, (value) => Number(value)); // int8 as number

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  start_cash NUMERIC NOT NULL,
  cash NUMERIC NOT NULL,
  realized NUMERIC NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  last_action JSONB
);
CREATE TABLE IF NOT EXISTS positions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  cost NUMERIC NOT NULL,
  PRIMARY KEY (account_id, ticker)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  num TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  filled NUMERIC NOT NULL DEFAULT 0,
  limit_price NUMERIC,
  stop_price NUMERIC,
  created_at BIGINT NOT NULL,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_num TEXT,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  cash_after NUMERIC,
  at BIGINT NOT NULL,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  value NUMERIC NOT NULL,
  cash NUMERIC NOT NULL,
  market_value NUMERIC NOT NULL,
  day_pl NUMERIC NOT NULL,
  day_pct NUMERIC NOT NULL,
  cum_pl NUMERIC NOT NULL,
  cum_pct NUMERIC NOT NULL,
  at BIGINT,
  PRIMARY KEY (account_id, date)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  at BIGINT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT,
  at BIGINT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_markers (
  job_key TEXT PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'done'
);
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
`;

let pool;

function poolConfig(connectionString) {
  const cfg = {
    connectionString,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'paper-trader',
  };
  // Internal Render URLs do not require TLS. External URLs do.
  if (/[?&]sslmode=require/i.test(connectionString) || /[?&]ssl=true/i.test(connectionString)) {
    cfg.ssl = { rejectUnauthorized: false };
  }
  return cfg;
}

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    pool = new Pool(poolConfig(connectionString));
    pool.on('error', (err) => console.error('pg pool error', err.message));
  }
  return pool;
}

function schemaStatements() {
  return SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
}

async function migrate() {
  const client = await getPool().connect();
  try {
    for (const statement of schemaStatements()) {
      await client.query(statement);
    }
  } finally {
    client.release();
  }
}

const num = (v) => (v == null || v === '' ? 0 : Number(v));
const dateStr = (v) => (v == null ? v : String(v).slice(0, 10));

function accountFromRows(id, accountRow, children) {
  const positions = {};
  for (const row of children.positions) {
    positions[row.ticker] = { shares: num(row.shares), cost: num(row.cost) };
  }
  return {
    id,
    startCash: num(accountRow.start_cash),
    cash: num(accountRow.cash),
    realized: num(accountRow.realized),
    seq: Number(accountRow.seq) || 1,
    createdAt: new Date(accountRow.created_at).toISOString(),
    lastAction: accountRow.last_action || null,
    positions,
    orders: children.orders.map((r) => r.payload),
    fills: children.fills.map((r) => r.payload),
    snapshots: children.snapshots.map((r) => ({
      date: dateStr(r.date),
      value: num(r.value),
      cash: num(r.cash),
      marketValue: num(r.market_value),
      dayPL: num(r.day_pl),
      dayPct: num(r.day_pct),
      cumPL: num(r.cum_pl),
      cumPct: num(r.cum_pct),
      at: r.at == null ? null : Number(r.at),
    })),
    messages: children.messages.map((r) => r.payload),
    emails: children.emails.map((r) => r.payload),
  };
}

async function loadChildren(client, accountId) {
  const positions = await client.query('SELECT ticker, shares, cost FROM positions WHERE account_id = $1', [accountId]);
  const orders = await client.query('SELECT payload FROM orders WHERE account_id = $1 ORDER BY created_at DESC', [accountId]);
  const fills = await client.query('SELECT payload FROM fills WHERE account_id = $1 ORDER BY at DESC', [accountId]);
  const snapshots = await client.query('SELECT date, value, cash, market_value, day_pl, day_pct, cum_pl, cum_pct, at FROM snapshots WHERE account_id = $1 ORDER BY date ASC', [accountId]);
  const messages = await client.query('SELECT payload FROM messages WHERE account_id = $1 ORDER BY at DESC', [accountId]);
  const emails = await client.query('SELECT payload FROM emails WHERE account_id = $1 ORDER BY at DESC', [accountId]);
  return {
    positions: positions.rows,
    orders: orders.rows,
    fills: fills.rows,
    snapshots: snapshots.rows,
    messages: messages.rows,
    emails: emails.rows,
  };
}

async function loadState() {
  const client = await getPool().connect();
  try {
    const accounts = await client.query('SELECT id, start_cash, cash, realized, seq, created_at, last_action FROM accounts');
    if (!accounts.rows.length) return null;
    const byId = Object.fromEntries(accounts.rows.map((r) => [r.id, r]));
    if (!byId.live || !byId.sim) return null;
    const liveKids = await loadChildren(client, 'live');
    const simKids = await loadChildren(client, 'sim');
    const subs = await client.query('SELECT subscription FROM push_subscriptions');
    const cfg = await client.query('SELECT key, value FROM app_config');
    const markers = await client.query("SELECT job_key, (EXTRACT(EPOCH FROM ran_at) * 1000)::bigint AS ms FROM job_markers WHERE job_key LIKE 'live:%'");
    const config = {};
    for (const row of cfg.rows) config[row.key] = row.value;
    const jobs = {};
    for (const row of markers.rows) jobs[row.job_key.replace(/^live:/, '')] = Number(row.ms);
    return {
      live: accountFromRows('live', byId.live, liveKids),
      sim: accountFromRows('sim', byId.sim, simKids),
      subs: subs.rows.map((r) => r.subscription),
      jobs,
      simEngine: config.sim_engine || null,
      seed: config.seed || null,
      watchlist: Array.isArray(config.watchlist) ? config.watchlist : null,
      bootstrap: config.bootstrap || { status: 'pending' },
    };
  } finally {
    client.release();
  }
}

async function upsertAccount(client, account) {
  await client.query(
    `INSERT INTO accounts (id, start_cash, cash, realized, seq, created_at, last_action)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       start_cash = EXCLUDED.start_cash,
       cash = EXCLUDED.cash,
       realized = EXCLUDED.realized,
       seq = EXCLUDED.seq,
       created_at = EXCLUDED.created_at,
       last_action = EXCLUDED.last_action`,
    [
      account.id,
      account.startCash,
      account.cash,
      account.realized || 0,
      account.seq || 1,
      account.createdAt,
      account.lastAction ? JSON.stringify(account.lastAction) : null,
    ]
  );
  await client.query('DELETE FROM positions WHERE account_id = $1', [account.id]);
  for (const [ticker, position] of Object.entries(account.positions || {})) {
    if (!position || !(position.shares > 1e-9)) continue;
    await client.query(
      'INSERT INTO positions (account_id, ticker, shares, cost) VALUES ($1, $2, $3, $4)',
      [account.id, ticker, position.shares, position.cost]
    );
  }
  await client.query('DELETE FROM orders WHERE account_id = $1', [account.id]);
  for (const order of account.orders || []) {
    await client.query(
      `INSERT INTO orders (id, account_id, num, ticker, side, type, status, shares, filled, limit_price, stop_price, created_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [
        order.id,
        account.id,
        order.num,
        order.ticker,
        order.side,
        order.type,
        order.status,
        order.shares,
        order.filled || 0,
        order.limit,
        order.stop,
        order.createdAt || 0,
        JSON.stringify(order),
      ]
    );
  }
  await client.query('DELETE FROM fills WHERE account_id = $1', [account.id]);
  for (const fill of account.fills || []) {
    await client.query(
      `INSERT INTO fills (id, account_id, order_num, ticker, side, shares, price, cash_after, at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        fill.id,
        account.id,
        fill.orderNum || null,
        fill.ticker,
        fill.side,
        fill.shares,
        fill.price,
        fill.cashAfter,
        fill.at || 0,
        JSON.stringify(fill),
      ]
    );
  }
  await client.query('DELETE FROM snapshots WHERE account_id = $1', [account.id]);
  for (const snap of account.snapshots || []) {
    await client.query(
      `INSERT INTO snapshots (account_id, date, value, cash, market_value, day_pl, day_pct, cum_pl, cum_pct, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [account.id, snap.date, snap.value, snap.cash, snap.marketValue, snap.dayPL, snap.dayPct, snap.cumPL, snap.cumPct, snap.at]
    );
  }
  await client.query('DELETE FROM messages WHERE account_id = $1', [account.id]);
  for (const message of account.messages || []) {
    await client.query(
      `INSERT INTO messages (id, account_id, kind, title, body, at, read, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        message.id,
        account.id,
        message.kind || null,
        message.title || '',
        message.body || '',
        message.at || 0,
        !!message.read,
        JSON.stringify(message),
      ]
    );
  }
  await client.query('DELETE FROM emails WHERE account_id = $1', [account.id]);
  for (const email of account.emails || []) {
    await client.query(
      `INSERT INTO emails (id, account_id, subject, at, read, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [email.id, account.id, email.subject || '', email.at || 0, !!email.read, JSON.stringify(email)]
    );
  }
}

async function setConfig(client, key, value) {
  await client.query(
    `INSERT INTO app_config (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

async function saveState(state) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await upsertAccount(client, state.live);
    await upsertAccount(client, state.sim);
    await client.query('DELETE FROM push_subscriptions');
    for (const sub of state.subs || []) {
      if (!sub || !sub.endpoint) continue;
      await client.query(
        'INSERT INTO push_subscriptions (endpoint, subscription) VALUES ($1, $2::jsonb)',
        [sub.endpoint, JSON.stringify(sub)]
      );
    }
    await setConfig(client, 'watchlist', state.watchlist || ['MRK', 'CVX', 'MDLZ']);
    await setConfig(client, 'seed', state.seed || null);
    await setConfig(client, 'bootstrap', state.bootstrap || { status: 'pending' });
    await setConfig(client, 'sim_engine', state.simEngine || null);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
    throw err;
  } finally {
    client.release();
  }
}

async function withLock(fn) {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [8675309]);
    return await fn();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [8675309]); } catch { /* connection already closed */ }
    client.release();
  }
}

async function claimJob(jobKey) {
  const result = await getPool().query(
    `INSERT INTO job_markers (job_key, status) VALUES ($1, 'done')
     ON CONFLICT (job_key) DO NOTHING
     RETURNING job_key`,
    [jobKey]
  );
  return result.rowCount > 0;
}

async function releaseJob(jobKey) {
  await getPool().query('DELETE FROM job_markers WHERE job_key = $1', [jobKey]);
}

async function clearLiveJobs() {
  await getPool().query("DELETE FROM job_markers WHERE job_key LIKE 'live:%'");
}

async function end() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

module.exports = {
  SCHEMA,
  schemaStatements,
  migrate,
  loadState,
  saveState,
  withLock,
  claimJob,
  releaseJob,
  clearLiveJobs,
  end,
};
