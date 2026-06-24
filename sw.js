const CACHE = 'chris-os-v4';
const ASSETS = [
  '/', '/routine/', '/planner/', '/playbook/',
  '/cloud.js', '/manifest.json', '/icon.svg', '/icon-180.png', '/icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Proxy /__/auth/* to Firebase Hosting so the real, version-matched auth
  // handler runs at our domain. This keeps iOS PWA in the WKWebView shell
  // (redirect returns to chris-os.com, not firebaseapp.com) while letting
  // Firebase's actual handler.js exchange the OAuth code correctly.
  if (url.origin === self.location.origin && url.pathname.startsWith('/__/auth/')) {
    const upstream = new URL(e.request.url);
    upstream.hostname = 'chris-os-web.firebaseapp.com';
    e.respondWith(
      fetch(upstream.toString())
        .catch(() => new Response('Auth handler unavailable', { status: 503 }))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/'));
    })
  );
});
