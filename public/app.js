const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let MODE = localStorage.getItem('mode') || 'live';
let ST = null, TAB = 'home';
const ticket = { side: null, qtyMode: 'shares' };
const money = x => x == null || isNaN(x) ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgn$ = x => (x >= 0 ? '+' : '') + money(x);
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const cls = x => x > 0.00001 ? 'pos-c' : x < -0.00001 ? 'neg-c' : '';
const ct = (ms, opt = {}) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opt });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, body) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`/api/${path}${sep}mode=${MODE}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, mode: MODE }) } : {});
  if (r.status === 401) { showLogin(); throw new Error('PIN required'); }
  return r.json();
}
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
$('#pinBtn').onclick = async () => {
  unlockAudio();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('#pin').value }) });
  if (r.ok) { $('#login').classList.add('hidden'); boot(); } else $('#pinErr').textContent = 'Wrong PIN';
};
$('#pin').addEventListener('keydown', e => e.key === 'Enter' && $('#pinBtn').click());

// ---------- sound ----------
let AC = null;
function unlockAudio() { try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch { } }
document.addEventListener('touchstart', unlockAudio, { once: true }); document.addEventListener('click', unlockAudio, { once: true });
function chime(kind) {
  if (!AC) return;
  const notes = kind === 'game_plan' ? [784, 988, 1175] : kind === 'daily_check' ? [1047, 784, 1047] : kind === 'fill' ? [1319, 1568] : [660, 880];
  const t0 = AC.currentTime;
  notes.forEach((f, i) => { const o = AC.createOscillator(), g = AC.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0 + i * 0.16); g.gain.exponentialRampToValueAtTime(0.35, t0 + i * 0.16 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.45); o.connect(g).connect(AC.destination); o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 0.5); });
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
function toast(m) {
  const d = document.createElement('div'); d.className = 'toast';
  d.innerHTML = `<div class="app"><span>📈 Paper Trader${m.mode === 'sim' ? ' · SIM' : ''}</span><span>now</span></div><div class="t">${esc(m.title)}</div><div class="b">${esc(m.body)}</div>`;
  d.onclick = () => { setTab(m.kind === 'fill' ? 'orders' : 'alerts'); d.remove(); };
  $('#toastWrap').prepend(d); setTimeout(() => d.remove(), m.kind === 'fill' ? 6000 : 12000);
}
const seen = new Set();
function onAlert(m) {
  if (!m || seen.has(m.id || m.tag)) return; seen.add(m.id || m.tag);
  chime(m.kind); toast(m);
}

// ---------- tabs / mode ----------
function setTab(t) { TAB = t; $$('.tab').forEach(s => s.classList.toggle('hidden', s.dataset.tab !== t)); $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); if (t === 'alerts' && ST && ST.unread) api('read', { messages: true }).then(refresh); window.scrollTo(0, 0); }
$$('#nav button').forEach(b => b.onclick = () => setTab(b.dataset.t));
function setMode(m) { MODE = m; localStorage.setItem('mode', m); $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m)); $('#simBar').classList.toggle('hidden', m !== 'sim'); document.body.style.setProperty('--blue', m === 'sim' ? '#8b5cf6' : '#3b82f6'); clearReview(); refresh(); }
$$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

// ---------- render ----------
let refreshing = false, again = false;
async function refresh() {
  if (refreshing) { again = true; return; } refreshing = true;
  try { ST = await api('state'); render(); } catch (e) { console.warn(e); } finally { refreshing = false; if (again) { again = false; refresh(); } }
}
function render() {
  const s = ST;
  $('#mkt').textContent = s.market.label; $('#mkt').classList.toggle('open', !!s.market.open);
  $('#total').textContent = money(s.total);
  $('#dayPL').innerHTML = `<span class="${cls(s.dayPL)}">${sgn$(s.dayPL)} <small>(${pct(s.dayPct)})</small></span>`;
  $('#totPL').innerHTML = `<span class="${cls(s.totalPL)}">${sgn$(s.totalPL)} <small>(${pct(s.totalPct)})</small></span>`;
  $('#cash').textContent = money(s.cash); $('#mv').textContent = money(s.marketValue);
  $('#feed').textContent = MODE === 'sim' ? 'Prices: simulated' : `Quotes: ${s.provider}`;
  $('#posBody').innerHTML = s.positions.map(p => `<tr><td><b>${p.ticker}</b></td><td>${p.shares}</td><td>${money(p.avgCost)}</td><td>${money(p.price)}</td><td>${money(p.value)}</td><td class="${cls(p.unreal)}">${sgn$(p.unreal)}</td><td class="${cls(p.unreal)}">${pct(p.unrealPct)}</td></tr>`).join('') + (s.positions.length ? `<tr><td><b>Cash</b></td><td></td><td></td><td></td><td>${money(s.cash)}</td><td></td><td></td></tr><tr><td><b>Total</b></td><td></td><td></td><td></td><td><b>${money(s.total)}</b></td><td class="${cls(s.totalPL)}">${sgn$(s.totalPL)}</td><td class="${cls(s.totalPL)}">${pct(s.totalPct)}</td></tr>` : '');
  $('#noPos').classList.toggle('hidden', s.positions.length > 0);
  $('#watch').innerHTML = s.watch.length ? s.watch.map(w => { const c = w.price - w.prevClose; return `<div class="wl"><b>${w.ticker}</b><span>${money(w.price)} <span class="${cls(c)}">${sgn$(c)} (${pct(c / w.prevClose)})</span></span></div>`; }).join('') + `<div class="muted small" style="margin-top:6px">${MODE === 'live' ? `Last quote ${s.watch[0] ? ct(s.watch[0].time) + ' CT' : ''} · ${s.provider}` : 'Simulated prices'}</div>` : '<div class="muted small">Start the simulation to see prices.</div>';
  const snaps = [...s.snapshots].reverse();
  $('#snapBody').innerHTML = snaps.map(x => `<tr><td>${x.date}</td><td>${money(x.value)}</td><td class="${cls(x.dayPL)}">${sgn$(x.dayPL)}</td><td class="${cls(x.dayPL)}">${pct(x.dayPct)}</td><td class="${cls(x.cumPL)}">${sgn$(x.cumPL)} (${pct(x.cumPct)})</td></tr>`).join('');
  $('#noSnap').classList.toggle('hidden', snaps.length > 0);
  // badges
  $('#bAlerts').textContent = s.unread; $('#bAlerts').classList.toggle('hidden', !s.unread || TAB === 'alerts');
  $('#bInbox').textContent = s.unreadEmail; $('#bInbox').classList.toggle('hidden', !s.unreadEmail);
  // closed banner
  const cb = $('#closedBanner');
  if (!s.market.open) { cb.classList.remove('hidden'); cb.textContent = `Market is closed (${s.market.label}). Regular hours are 8:30 AM - 3:00 PM CT (9:30-4:00 ET). Market orders are blocked; limit and stop orders will queue for the next open.`; } else cb.classList.add('hidden');
  // messages
  $('#msgs').innerHTML = s.messages.length ? s.messages.map(m => `<div class="msg k-${m.kind} ${m.read ? '' : 'unread'}"><div class="row between"><span class="t">${esc(m.title)}</span></div><div class="w">${ct(m.at)} CT${m.mode === 'sim' ? ' (sim time)' : ''}${m.manual ? ' · on demand' : ''}</div><div class="b">${esc(m.body)}</div></div>`).join('') : '<div class="card muted small">No messages yet. Tap "Run 7:00 check now" to see one.</div>';
  // orders
  $('#orders').innerHTML = s.orders.length ? s.orders.map(o => { const stc = o.status.split(' ')[0]; const can = ['queued', 'working', 'pending', 'partially filled'].includes(o.status); return `<div class="ord"><div class="row between"><b>${o.side.toUpperCase()} ${o.shares} ${o.ticker}</b><span class="st st-${stc}">${o.status}</span></div><div class="small muted">#${o.num} · ${o.type.toUpperCase()}${o.limit ? ' ' + money(o.limit) : ''}${o.stop ? ' stop ' + money(o.stop) : ''} · ${o.tif.toUpperCase()} · ${ct(o.createdAt)} CT${o.filled ? ` · filled ${o.filled} @ avg ${money(o.avgFill)}` : ''}</div>${o.events.slice(-3).map(e => `<div class="ev">${ct(e.at, { month: undefined, day: undefined })} · ${esc(e.text)}</div>`).join('')}${can ? `<button class="btn" style="margin-top:6px" onclick="cancelOrder('${o.id}')">Cancel order</button>` : ''}</div>`; }).join('') : '<div class="muted small">No orders.</div>';
  $('#fillBody').innerHTML = s.fills.map(f => `<tr><td>${ct(f.at)}</td><td class="${f.side === 'buy' ? 'pos-c' : 'neg-c'}">${f.side.toUpperCase()}</td><td><b>${f.ticker}</b></td><td>${f.shares}${f.partial ? '*' : ''}</td><td>${money(f.price)}</td><td>${money(f.side === 'buy' ? -f.net : f.net)}</td><td>${money(f.cashAfter)}</td></tr>`).join('');
  $('#noFill').classList.toggle('hidden', s.fills.length > 0);
  $('#inbox').innerHTML = s.emails.length ? s.emails.map(e => `<div class="mail ${e.read ? '' : 'unread'}" onclick="openEmail('${e.id}')"><div class="small muted row between"><span>Paper Brokerage</span><span>${ct(e.at)} CT</span></div><div class="s">${esc(e.subject)}</div><div class="small muted">Order #${esc(e.fields['Order number'])}: tap to open</div></div>`).join('') : '<div class="muted small">No confirmations yet. One arrives after every fill.</div>';
  // sim
  if (s.sim) { $('#simDay').textContent = `Day ${s.sim.dayNum}/${s.sim.days} · ${ct(s.sim.simMs, { weekday: 'short' })} CT${s.sim.finished ? ' · finished' : s.sim.running ? '' : ' · paused'}`; $('#simPause').textContent = s.sim.running ? 'Pause' : 'Resume'; $('#simSpeed').value = String(s.sim.speed); }
  else $('#simDay').textContent = 'Not started';
  $('#simPause').disabled = $('#simSkip').disabled = !s.sim;
  $('#clock').textContent = (MODE === 'sim' && s.sim ? 'Sim time ' : '') + ct(s.now, { weekday: 'short' }) + ' CT';
  if (lastOrderId) renderLiveOrder();
  notifStatus();
}
window.cancelOrder = async id => { if (!confirm('Cancel this order?')) return; const r = await api(`order/${id}/cancel`, {}); if (!r.ok) alert(r.error); refresh(); };
window.openEmail = async id => {
  const e = ST.emails.find(x => x.id === id); if (!e) return;
  $('#modalBody').innerHTML = `<div class="em-h"><div><b>From:</b> ${esc(e.from)}</div><div><b>To:</b> ${esc(e.to)}</div><div><b>Date:</b> ${ct(e.at, { weekday: 'short', year: 'numeric', second: '2-digit' })} CT</div><div><b>Subject:</b> ${esc(e.subject)}</div></div><div class="em-brand">PAPER BROKERAGE · Trade Confirmation</div><p>Dear Kate Lynn,</p><p>Your order has been executed. Details are below.</p><table class="em-t">${Object.entries(e.fields).map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table><p style="font-size:11px;color:#64748b;margin-top:14px">This is a simulated confirmation for a paper-trading account. No real securities were bought or sold and no money moved. Fills are simulated from ${MODE === 'sim' ? 'generated' : 'delayed public'} quotes and include simulated slippage.</p>`;
  $('#modal').classList.remove('hidden');
  if (!e.read) { await api('read', { email: id }); refresh(); }
};
$('#modalX').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };

// ---------- order ticket ----------
function segInit(id, key, cb) { $$(`#${id} button`).forEach(b => b.onclick = () => { ticket[key] = b.dataset.v; $$(`#${id} button`).forEach(x => x.classList.toggle('on', x === b)); clearReview(); cb && cb(); }); }
segInit('tSide', 'side'); segInit('tQtyMode', 'qtyMode', () => { $('#tQty').placeholder = ticket.qtyMode === 'dollars' ? 'Dollar amount, e.g. 100' : 'Shares'; $('#tQty').value = ''; });
$('#tType').onchange = () => { const t = $('#tType').value; $('#limitRow').classList.toggle('hidden', t !== 'limit'); $('#stopRow').classList.toggle('hidden', t !== 'stop'); $('#tifRow').classList.toggle('hidden', !t || t === 'market'); clearReview(); };
['#tSym', '#tQty', '#tLimit', '#tStop', '#tTif'].forEach(s => $(s).addEventListener('input', clearReview));
function clearReview() { $('#review').classList.add('hidden'); $('#review').innerHTML = ''; }
$('#tQuote').onclick = async () => {
  const t = $('#tSym').value.trim().toUpperCase(); if (!t) return;
  const q = await api(`quote/${encodeURIComponent(t)}`);
  const box = $('#quoteBox'); box.classList.remove('hidden');
  if (q.error) { box.innerHTML = `<span class="neg-c">${esc(q.error)}</span>`; return; }
  const c = q.price - q.prevClose; const spr = q.price > 100 ? 0.02 : 0.01;
  box.innerHTML = `<div class="row between"><b>${esc(q.ticker)}</b><span class="muted small">${esc(q.name || '')}</span></div><div style="font-size:24px;font-weight:800">${money(q.price)} <span class="${cls(c)}" style="font-size:14px">${sgn$(c)} (${pct(c / q.prevClose)})</span></div><div class="small muted">Bid ~${money(q.price - spr)} · Ask ~${money(q.price + spr)} · as of ${ct(Date.parse(q.quoteTime))} CT · ${esc(q.source)}</div>`;
};
$('#tReview').onclick = async () => {
  const body = ticketBody(); const rv = $('#review'); rv.classList.remove('hidden'); rv.innerHTML = '<div class="muted">Checking order…</div>';
  const p = await api('preview', body);
  if (!p.ok) { rv.innerHTML = `<div class="banner">${(p.errors || ['Order rejected']).map(esc).join('<br>')}</div>`; return; }
  rv.innerHTML = `<div class="h">Review your order</div>
   <div class="kv"><span>Action</span><b class="${p.side === 'buy' ? 'pos-c' : 'neg-c'}">${p.side.toUpperCase()}</b></div>
   <div class="kv"><span>Symbol</span><b>${p.ticker}</b></div>
   <div class="kv"><span>Quantity</span><b>${p.shares} shares${p.qtyMode === 'dollars' ? ' (est., fractional)' : ''}</b></div>
   <div class="kv"><span>Order type</span><b>${p.type.toUpperCase()}${p.limit ? ' @ ' + money(p.limit) : ''}${p.stop ? ' stop ' + money(p.stop) : ''}</b></div>
   <div class="kv"><span>Timing</span><b>${p.tif === 'gtc' ? 'GTC' : 'Day'}</b></div>
   <div class="kv"><span>Last price</span><b>${money(p.quote.price)} <span class="muted small">${ct(Date.parse(p.quote.time))} CT</span></b></div>
   <div class="kv"><span>Est. price</span><b>${money(p.estPrice)}</b></div>
   <div class="kv"><span>Est. principal</span><b>${money(p.principal)}</b></div>
   <div class="kv"><span>Commission</span><b>${money(p.commission)}</b></div>
   <div class="kv"><span>Est. regulatory fees</span><b>${money(p.fees)}</b></div>
   <div class="kv tot"><span>Est. ${p.side === 'buy' ? 'total cost' : 'proceeds'}</span><span>${money(p.estTotal)}</span></div>
   <div class="kv"><span>Est. cash after fill</span><b>${money(p.cashAfter)}</b></div>
   ${p.queueNote ? `<div class="banner" style="margin-top:8px;background:#2b2210;color:#fde68a;border-color:#78350f">${esc(p.queueNote)}</div>` : ''}
   ${p.warnings.map(w => `<div class="small muted">⚠ ${esc(w)}</div>`).join('')}
   <label class="check"><input type="checkbox" id="ack"><span>I have reviewed this order and understand the price may differ from the estimate.</span></label>
   <div class="row gap"><button class="btn" onclick="clearReview()">Edit</button><button class="btn ${p.side === 'buy' ? 'green' : 'danger'} wide" style="margin-top:0" id="placeBtn" disabled>Place ${p.side} order</button></div>`;
  $('#ack').onchange = e => $('#placeBtn').disabled = !e.target.checked;
  $('#placeBtn').onclick = async () => {
    $('#placeBtn').disabled = true; $('#placeBtn').textContent = 'Sending…';
    const r = await api('order', body);
    if (!r.ok) { rv.innerHTML = `<div class="banner">${(r.errors || [r.error]).map(esc).join('<br>')}</div>`; return; }
    lastOrderId = r.order.id; clearReview(); resetTicket(); await refresh(); renderLiveOrder();
  };
};
function ticketBody() { return { ticker: $('#tSym').value, side: ticket.side, qtyMode: ticket.qtyMode, shares: ticket.qtyMode === 'shares' ? $('#tQty').value : null, dollars: ticket.qtyMode === 'dollars' ? $('#tQty').value : null, type: $('#tType').value, limit: $('#tLimit').value || null, stop: $('#tStop').value || null, tif: $('#tTif').value }; }
function resetTicket() { $('#tQty').value = ''; $('#tLimit').value = ''; $('#tStop').value = ''; $('#tType').value = ''; $('#tType').onchange(); ticket.side = null; $$('#tSide button').forEach(b => b.classList.remove('on')); }
let lastOrderId = null;
function renderLiveOrder() {
  const o = ST && ST.orders.find(x => x.id === lastOrderId); const el = $('#liveOrder');
  if (!o) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const stc = o.status.split(' ')[0];
  el.innerHTML = `<div class="row between"><b>Order #${o.num}</b><span class="st st-${stc}">${o.status}</span></div><div style="margin-top:6px">${o.side.toUpperCase()} ${o.shares} ${o.ticker} · ${o.type.toUpperCase()}${o.limit ? ' ' + money(o.limit) : ''}${o.stop ? ' stop ' + money(o.stop) : ''}</div>${o.filled ? `<div class="mid">${o.filled} filled @ ${money(o.avgFill)}</div>` : ''}${o.events.map(e => `<div class="ev">${ct(e.at, { month: undefined, day: undefined, second: '2-digit' })} · ${esc(e.text)}</div>`).join('')}`;
}

// ---------- alerts / push ----------
function b64ToU8(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); }
let SWR = null;
async function notifStatus() {
  const el = $('#notifStatus');
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.innerHTML = ios && !standalone ? '<span class="neg-c">On iPhone: tap Share → "Add to Home Screen", then open Paper Trader from the home-screen icon to enable push alerts.</span>' : '<span class="neg-c">This browser does not support push. In-app alerts with sound still work while the page is open.</span>';
    return;
  }
  let sub = null; try { sub = SWR && await SWR.pushManager.getSubscription(); } catch { }
  el.innerHTML = Notification.permission === 'granted' && sub ? '<span class="pos-c">● Push notifications are on for this device.</span>' : Notification.permission === 'denied' ? '<span class="neg-c">Notifications are blocked. Allow them in your phone or browser settings for this site.</span>' : '<span class="muted">Notifications are off. Tap Enable to get alerts when the app is closed.</span>';
  $('#enableNotif').textContent = sub ? 'Re-register this device' : 'Enable notifications';
}
$('#enableNotif').onclick = async () => {
  unlockAudio();
  if (!ST || !ST.vapidKey) { alert('Web push is not configured on this server yet. In-app alerts still work while this page is open.'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notifications were not allowed.'); return notifStatus(); }
    SWR = SWR || await navigator.serviceWorker.ready;
    let sub = await SWR.pushManager.getSubscription();
    if (!sub) sub = await SWR.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(ST.vapidKey) });
    await api('push/subscribe', { subscription: sub.toJSON() });
    chime('fill'); notifStatus();
  } catch (e) { alert('Could not enable push: ' + e.message); }
};
$('#testPush').onclick = async () => { unlockAudio(); const r = await api('push/test', {}); if (r.error) return alert(r.error); if (!r.subs) toast({ title: 'No device registered', body: 'Tap "Enable notifications" first. In-app alerts still work.', kind: 'system' }); };
$('#run7').onclick = async () => { unlockAudio(); const r = await api('alerts/run', { kind: 'daily_check' }); if (!r.ok) alert(r.error); };
$('#run8').onclick = async () => { unlockAudio(); const r = await api('alerts/run', { kind: 'game_plan' }); if (!r.ok) alert(r.error); };
$('#resetBtn').onclick = async () => { const r = await api('reset', { confirm: $('#resetTxt').value.trim() }); if (!r.ok) alert(r.error); else { $('#resetTxt').value = ''; refresh(); } };

// ---------- sim controls ----------
$('#simStart').onclick = async () => { if (ST.sim && !confirm('Start over? This wipes the current simulation account.')) return; $('#simStart').disabled = true; const r = await api('sim/start', { speed: $('#simSpeed').value }); $('#simStart').disabled = false; if (!r.ok) alert(r.error); refresh(); };
$('#simPause').onclick = async () => { await api('sim/control', { action: ST.sim && ST.sim.running ? 'pause' : 'resume' }); refresh(); };
$('#simSkip').onclick = async () => { await api('sim/control', { action: 'skip' }); refresh(); };
$('#simSpeed').onchange = async () => { if (ST.sim) await api('sim/control', { action: 'speed', speed: $('#simSpeed').value }); };

// ---------- live updates ----------
function stream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', e => { const d = JSON.parse(e.data); if (d.mode === MODE) refresh(); });
  es.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.mode === MODE || m.kind !== 'fill') onAlert(m); refresh(); });
  let lastSim = 0; es.addEventListener('simclock', () => { if (MODE === 'sim' && Date.now() - lastSim > 2500) { lastSim = Date.now(); refresh(); } });
}
async function boot() {
  $('#app').classList.remove('hidden');
  if ('serviceWorker' in navigator) {
    try { SWR = await navigator.serviceWorker.register('/sw.js'); } catch (e) { console.warn(e); }
    navigator.serviceWorker.addEventListener('message', ev => { if (ev.data.type === 'push') onAlert({ ...ev.data.data, id: ev.data.data.tag }); if (ev.data.type === 'open') { const u = new URL(ev.data.url, location.href); if (u.searchParams.get('mode')) setMode(u.searchParams.get('mode')); setTab(u.searchParams.get('tab') || 'alerts'); } });
  }
  const u = new URLSearchParams(location.search);
  if (u.get('mode')) MODE = u.get('mode');
  setMode(MODE); if (u.get('tab')) setTab(u.get('tab'));
  stream(); setInterval(() => { if (!document.hidden) refresh(); }, 20000);
}
(async () => { const r = await fetch('/api/state?mode=live'); if (r.status === 401) showLogin(); else boot(); })();
