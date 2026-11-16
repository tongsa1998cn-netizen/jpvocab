// 离线缓存：本站文件和 Firebase 的脚本先走网络（保证拿到最新版），没网时用缓存。
// Firebase 的登录、数据库请求不缓存，直接走网络。
const CACHE = 'jpvocab-v1';
const CORE = ['./', 'index.html', 'sync.js', 'manifest.webmanifest', 'icons/icon-192.png',
  'books/basic.js', 'books/n2.js', 'books/n1.js', 'books/n2_red.js', 'books/pos.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && url.hostname !== 'www.gstatic.com') return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
