// Live quotes: Polygon if POLYGON_API_KEY is set, else Yahoo Finance public chart endpoint.
const POLY = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || '';
const UA = { 'User-Agent': 'Mozilla/5.0 (paper-trader)' };
const cache = new Map(); // ticker -> {q, at}
const histCache = new Map();

const fetchOpts = (headers) => ({ headers, signal: AbortSignal.timeout(8000) });

async function yahoo(ticker) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`, fetchOpts(UA));
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${ticker}`);
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error(`Unknown ticker ${ticker}`);
  const m = res.meta;
  const closes = (res.indicators.quote[0].close || []).filter(x => x != null);
  // previous close = the close before the last regular session
  const prev = m.chartPreviousClose && closes.length < 2 ? m.chartPreviousClose : (closes.length >= 2 ? closes[closes.length - 2] : m.chartPreviousClose);
  return { ticker: m.symbol, name: m.longName || m.shortName || m.symbol, price: m.regularMarketPrice, prevClose: prev, dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, volume: m.regularMarketVolume, quoteTime: new Date(m.regularMarketTime * 1000).toISOString(), source: 'Yahoo Finance' };
}
async function polygon(ticker) {
  const r = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}?apiKey=${POLY}`, fetchOpts());
  if (!r.ok) throw new Error(`Polygon ${r.status}`);
  const j = await r.json(); const t = j.ticker;
  const price = (t.lastTrade && t.lastTrade.p) || t.day.c || t.prevDay.c;
  return { ticker, name: ticker, price, prevClose: t.prevDay.c, dayHigh: t.day.h, dayLow: t.day.l, volume: t.day.v, quoteTime: new Date((t.updated || Date.now() * 1e6) / 1e6).toISOString(), source: 'Polygon' };
}
async function getQuote(ticker, maxAgeMs = 10000) {
  ticker = String(ticker).toUpperCase().trim();
  const c = cache.get(ticker);
  if (c && Date.now() - c.at < maxAgeMs) return c.q;
  let q;
  try { q = POLY ? await polygon(ticker) : await yahoo(ticker); }
  catch (e) { if (POLY) q = await yahoo(ticker); else { if (c) return c.q; throw e; } }
  q.fetchedAt = new Date().toISOString();
  cache.set(ticker, { q, at: Date.now() });
  return q;
}
// ~6 months daily closes -> annualized/daily vol, recent closes
async function getHistory(ticker) {
  ticker = ticker.toUpperCase();
  const c = histCache.get(ticker);
  if (c && Date.now() - c.at < 6 * 3600e3) return c.h;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`, fetchOpts(UA));
  const j = await r.json(); const res = j.chart.result[0];
  const closes = res.indicators.quote[0].close.filter(x => x != null);
  const rets = []; for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const h = { closes, dailyVol: sd, last: closes[closes.length - 1] };
  histCache.set(ticker, { h, at: Date.now() });
  return h;
}
module.exports = { getQuote, getHistory, usingPolygon: !!POLY };
