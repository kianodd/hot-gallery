// هات گالری — سرویس‌ورکر: پوسته‌ی اپ برای نصب و اجرای آفلاین؛ لیست گالری آخرین نسخه‌ی کش‌شده را آفلاین نشان می‌دهد
const CACHE = 'hg-v9';
const RAW = 'https://raw.githubusercontent.com/kianodd/hot-gallery-data/main/';

// استریم فیلم از روی پارت‌های گیت‌هاب: سرویس‌ورکر (بخشی از خود اپ، روی دستگاه کاربر) درخواست‌های
// Range پخش‌کننده را به پارت درست نگاشت می‌کند؛ پخش فوری شروع می‌شود و جلو/عقب‌بردن هم کار می‌کند.
const manCache = new Map();
async function getManifest(id) {
  if (manCache.has(id)) return manCache.get(id);
  const r = await fetch(RAW + 'media/' + id + '.json');
  if (!r.ok) throw new Error('manifest ' + r.status);
  const man = await r.json();
  let off = 0;
  man.parts = man.parts.map((p) => {
    const q = { path: p.path, size: p.size, start: off };
    off += p.size;
    return q;
  });
  manCache.set(id, man);
  return man;
}

async function streamVideo(id, req) {
  try {
    const man = await getManifest(id);
    const total = man.size;
    let start = 0,
      end = total - 1,
      status = 200;
    const range = req.headers.get('range');
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range);
      if (mm) {
        if (mm[1] === '' && mm[2] !== '') start = Math.max(0, total - +mm[2]);
        else {
          start = +mm[1] || 0;
          if (mm[2] !== '') end = Math.min(+mm[2], total - 1);
        }
        if (start > end || start >= total)
          return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total, 'Accept-Ranges': 'bytes' } });
        status = 206;
      }
    }
    const headers = {
      'Content-Type': man.mime || 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    };
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
    if (req.method === 'HEAD') return new Response(null, { status, headers });

    const segs = [];
    for (const p of man.parts) {
      const ps = p.start,
        pe = p.start + p.size - 1;
      if (pe < start || ps > end) continue;
      segs.push({ path: p.path, partSize: p.size, from: Math.max(start, ps) - ps, to: Math.min(end, pe) - ps });
    }
    let si = 0,
      reader = null;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          for (;;) {
            if (!reader) {
              if (si >= segs.length) {
                controller.close();
                return;
              }
              const seg = segs[si];
              const res = await fetch(RAW + seg.path, { headers: { Range: 'bytes=' + seg.from + '-' + seg.to } });
              if (res.status === 200 && (seg.from > 0 || seg.to < seg.partSize - 1)) {
                const ab = await res.arrayBuffer();
                const slice = new Uint8Array(ab).subarray(seg.from, seg.to + 1);
                si++;
                if (slice.length) controller.enqueue(slice);
                continue;
              }
              if (!res.ok && res.status !== 206) throw new Error('part ' + res.status);
              reader = res.body.getReader();
            }
            const { done, value } = await reader.read();
            if (done) {
              reader = null;
              si++;
              continue;
            }
            controller.enqueue(value);
            return;
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        if (reader) reader.cancel().catch(() => {});
      },
    });
    return new Response(body, { status, headers });
  } catch (err) {
    return new Response('stream error', { status: 502 });
  }
}
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

  // استریم فیلم از پارت‌ها (آدرس مجازی داخل اسکوپ اپ)
  const sm = url.origin === self.location.origin && url.pathname.match(/\/hgstream\/([A-Za-z0-9]+)$/);
  if (sm) {
    e.respondWith(streamVideo(sm[1], req));
    return;
  }

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
            // فقط فایل‌های کوچک (عکس‌ها و مانیفست) کش می‌شوند؛ پارت‌های فیلم کش نمی‌شوند تا حافظه‌ی دستگاه پر نشود
            const ln = +(r.headers.get('content-length') || 0);
            if (r.ok && (!ln || ln <= 8 * 1024 * 1024)) {
              const cl = r.clone();
              caches.open(CACHE).then((c) => c.put(req, cl));
            }
            return r;
          })
      )
    );
    return;
  }

  // ناوبری: شبکه‌اول با دور زدن کش HTTP (CDN پیجز تا ۱۰ دقیقه HTML قدیمی می‌دهد)؛ آفلاین از کش
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req.url, { cache: 'no-store' })
        .then((r) => {
          const cl = r.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', cl));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // فایل‌های ثابت خود اپ (مانیفست، آیکون‌ها): کش‌اول با کلید خودشان
  if (url.origin === self.location.origin) {
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
  }
});
