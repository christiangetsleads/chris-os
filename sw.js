const CACHE = 'chris-os-v3';
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

  // Firebase OAuth redirect handler — served at our own domain so the redirect
  // chain stays on chris-os.com and iOS keeps it in the PWA shell rather than
  // opening Mobile Safari. Scripts are loaded from Firebase's CDN.
  if (url.origin === self.location.origin && url.pathname === '/__/auth/handler') {
    e.respondWith(new Response(
      `<!DOCTYPE html><html><head>
<meta name=viewport content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Type" content="text/html;charset=utf-8">
<script src="https://chris-os-web.firebaseapp.com/__/auth/experiments.js"></script>
<script src="https://chris-os-web.firebaseapp.com/__/auth/handler.js"></script>
<script nonce="firebase-auth-helper">var POST_BODY='';fireauth.oauthhelper.widget.initialize();</script>
</head><body></body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    ));
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
