// Which live jobs are due at a Chicago-time clock reading.
// Jobs stay due after their clock time so a free-tier wake can catch up once.
// The caller records a job_markers row and skips keys that already ran.
function dueLiveJobs(clock, market) {
  const due = [];
  const trading = market.isTradingDate(clock.date);
  if (trading) {
    if (clock.mins >= 7 * 60) due.push({ date: clock.date, key: 'daily_check' });
    if (clock.mins >= 8 * 60) due.push({ date: clock.date, key: 'game_plan' });
    if (clock.mins >= market.closeMins(clock.date)) due.push({ date: clock.date, key: 'close' });
  }
  // Before the next regular open, Yahoo's regular-session price is still the
  // previous session's close, so a missed snapshot can be recorded once.
  const beforeOpen = !trading || clock.mins < market.OPEN_MINS;
  if (beforeOpen) due.push({ date: market.prevTradingDate(clock.date), key: 'close' });
  return due;
}

module.exports = { dueLiveJobs };
