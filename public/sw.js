self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Paper Trader', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: 'push', data: d }));
    await self.registration.showNotification(d.title || 'Paper Trader', {
      body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png',
      vibrate: [200, 100, 200, 100, 400], requireInteraction: d.kind === 'daily_check' || d.kind === 'game_plan',
      renotify: true, silent: false, data: { url: d.url || '/' }, timestamp: Date.now(),
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) { c.postMessage({ type: 'open', url }); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
