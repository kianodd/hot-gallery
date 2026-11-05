// هات گالری — سرویس‌ورکر: پوسته‌ی اپ برای نصب و اجرای آفلاین؛ لیست گالری آخرین نسخه‌ی کش‌شده را آفلاین نشان می‌دهد
const CACHE = 'hg-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API ورکر: لیست عکس‌ها شبکه‌اول با fallback به کش (نمایش آفلاین)؛ بقیه‌ی API فقط شبکه
  if (url.hostname === 'hot-gallery.kiandevteam.workers.dev') {
    if (url.pathname === '/api/photos') {
      e.respondWith(
        fetch(req)
          .then((r) => {
            const cl = r.clone();
            caches.open(CACHE).then((c) => c.put(req, cl));
            return r;
          })
          .catch(() => caches.match(req))
      );
    }
    return;
  }

  // مدیای خام گیت‌هاب: کش‌اول (عکس‌ها)؛ درخواست‌های Range فیلم دست نخورده از شبکه
  if (url.hostname === 'raw.githubusercontent.com') {
    if (req.headers.has('range')) return;
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((r) => {
            if (r.ok) {
              const cl = r.clone();
              caches.open(CACHE).then((c) => c.put(req, cl));
            }
            return r;
          })
      )
    );
    return;
  }

  // ناوبری و فایل‌های خود اپ: شبکه‌اول، آفلاین از کش
  if (req.mode === 'navigate' || url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const cl = r.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', cl));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
  }
});
