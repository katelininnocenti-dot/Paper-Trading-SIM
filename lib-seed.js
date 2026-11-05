// Opening holdings bought from the $500 cash grant at the first-boot quotes.
// Whole shares only. Each name is sized near one third of the grant, then
// reduced so the running cash balance is never negative.
function starterPositions(quotes, tickers, startCash = 500) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const budget = startCash / tickers.length;
  const positions = {};
  let cash = startCash;
  for (const ticker of tickers) {
    const quote = quotes && quotes[ticker];
    const price = quote ? Number(quote.price) : NaN;
    if (!(price > 0) || cash + 1e-9 < price) continue;
    let shares = Math.floor(budget / price);
    if (shares < 1) shares = 1;
    while (shares > 0 && r2(shares * price) > cash + 1e-9) shares -= 1;
    if (shares < 1) continue;
    const cost = r2(shares * price);
    positions[ticker] = { shares, cost, price };
    cash = r2(cash - cost);
  }
  return { positions, cash, startCash };
}

module.exports = { starterPositions };
