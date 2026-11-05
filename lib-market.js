// Market calendar + time helpers (all in America/Chicago)
const TZ = 'America/Chicago';
const HOLIDAYS = new Set([
  // NYSE full-day closures
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
]);
// Early closes (1:00 PM ET = 12:00 PM CT)
const EARLY = new Set(['2026-11-27','2026-12-24','2027-11-26']);

function parts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  const hour = Number(o.hour) % 24;
  return { date: `${o.year}-${o.month}-${o.day}`, hour, minute: Number(o.minute), second: Number(o.second), weekday: o.weekday, mins: hour * 60 + Number(o.minute) };
}
function isTradingDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(dateStr);
}
function closeMins(dateStr) { return EARLY.has(dateStr) ? 12 * 60 : 15 * 60; }
const OPEN_MINS = 8 * 60 + 30;
// status given a date string and minutes-of-day (CT)
function statusAt(dateStr, mins) {
  if (!isTradingDate(dateStr)) return { open: false, label: HOLIDAYS.has(dateStr) ? 'Closed (holiday)' : 'Closed (weekend)' };
  if (mins < OPEN_MINS) return { open: false, label: mins >= 7 * 60 ? 'Pre-market' : 'Closed' };
  if (mins >= closeMins(dateStr)) return { open: false, label: 'After hours' };
  return { open: true, label: EARLY.has(dateStr) ? 'Open (early close 12:00 CT)' : 'Open' };
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function nextTradingDate(dateStr, includeSelf = false) {
  let d = includeSelf ? dateStr : addDays(dateStr, 1);
  while (!isTradingDate(d)) d = addDays(d, 1);
  return d;
}
function prevTradingDate(dateStr) { let d = addDays(dateStr, -1); while (!isTradingDate(d)) d = addDays(d, -1); return d; }
module.exports = { TZ, parts, isTradingDate, statusAt, closeMins, OPEN_MINS, nextTradingDate, prevTradingDate, addDays, HOLIDAYS, EARLY };
