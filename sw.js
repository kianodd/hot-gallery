// هات گالری — سرویس‌ورکر: پوسته‌ی اپ برای نصب و اجرای آفلاین؛ لیست گالری آخرین نسخه‌ی کش‌شده را آفلاین نشان می‌دهد
const CACHE = 'hg-v42';
/* hg-v15 (۳۰۵): کش اختصاصی بندانگشتی‌ها روی دستگاه — سقف ~۱۵۰MB با حذف قدیمی‌ترین‌ها (LRU تقریبی
   بر اساس ترتیب درج). فقط تصویرهای بندانگشتی/پیش‌نمایش اینجا می‌نشینند؛ پارت‌های فیلم هرگز کش نمی‌شوند. */
const THUMBS = 'hg-thumbs';
const THUMB_CAP = 150 * 1024 * 1024;
async function trimThumbs() {
  try {
    const c = await caches.open(THUMBS);
    const keys = await c.keys();
    let total = 0;
    const sizes = [];
    for (const k of keys) {
      const r = await c.match(k);
      let n = 0;
      if (r) {
        const cl = r.headers.get('content-length');
        if (cl) n = +cl || 0;
        else {
          const b = await r.clone().blob();
          n = b.size;
        }
      }
      sizes.push(n);
      total += n;
    }
    let i = 0;
    while (total > THUMB_CAP && i < keys.length) {
      await c.delete(keys[i]);
      total -= sizes[i];
      i++;
    }
  } catch (e) {}
}
function thumbCacheFirst(req) {
  return caches.open(THUMBS).then((tc) =>
    tc.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((r) => {
          if (r.ok) {
            const cl = r.clone();
            tc.put(req, cl).then(() => trimThumbs());
          }
          return r;
        })
    )
  );
}
const RAW = 'https://raw.githubusercontent.com/kianodd/hot-gallery-data/main/';
/* hg-v42: منبع گیت‌هاب کل اپ — از خود اپ با پیام می‌آید؛ پیش‌فرض آینه‌ی CDN است. */
let GH_MODE = 'auto';
self.addEventListener('message', function (e) { const d = e.data || {}; if (d.type === 'hg-ghsrc' && (d.mode === 'auto' || d.mode === 'cdn' || d.mode === 'gh')) GH_MODE = d.mode; });
function rawFor(repo){return GH_MODE==='gh'?('https://raw.githubusercontent.com/kianodd/'+(repo||'hot-gallery-data')+'/main/'):('https://cdn.jsdelivr.net/gh/kianodd/'+(repo||'hot-gallery-data')+'@main/');}

// استریم فیلم از روی پارت‌های گیت‌هاب: سرویس‌ورکر (بخشی از خود اپ، روی دستگاه کاربر) درخواست‌های
// Range پخش‌کننده را به پارت درست نگاشت می‌کند؛ پخش فوری شروع می‌شود و جلو/عقب‌بردن هم کار می‌کند.
const manCache = new Map();
async function getManifest(id, repo) {
  const ck = (repo || 'hot-gallery-data') + ':' + id;
  if (manCache.has(ck)) return manCache.get(ck);
  const r = await fetch(rawFor(repo) + 'media/' + id + '.json');
  if (!r.ok) throw new Error('manifest ' + r.status);
  const man = await r.json();
  let off = 0;
  man.parts = man.parts.map((p) => {
    const q = { path: p.path, size: p.size, start: off };
    off += p.size;
    return q;
  });
  manCache.set(ck, man);
  return man;
}

async function streamVideo(id, req, repo) {
  try {
    const man = await getManifest(id, repo);
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
              const res = await fetch(rawFor(repo) + seg.path, { headers: { Range: 'bytes=' + seg.from + '-' + seg.to } });
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
  // hg-v11: نسخه‌ی تازه خودکار فعال نمی‌شود؛ منتظر اعمال دستی کاربر از منوی «به‌روزرسانی اپ» می‌ماند
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== THUMBS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // استریم فیلم از پارت‌ها (آدرس مجازی داخل اسکوپ اپ)
  const sm = url.origin === self.location.origin && url.pathname.match(/\/hgstream\/([A-Za-z0-9-]+)\/([A-Za-z0-9]+)$/);
  if (sm) {
    e.respondWith(streamVideo(sm[2], req, sm[1]));
    return;
  }

  // API ورکر: لیست عکس‌ها شبکه‌اول با fallback به کش (نمایش آفلاین)؛ بقیه‌ی API فقط شبکه
  if (url.hostname === 'hot-gallery.kiandevteam.workers.dev' || url.hostname === 'gapi.kiandevteam.ir') {
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

  // hg-v15 (۳۰۵): بندانگشتی‌های weserv (نسخه‌ی WebP عکس‌ها) هم در کش بندانگشتی روی دستگاه می‌نشینند
  if (url.hostname === 'images.weserv.nl') {
    e.respondWith(thumbCacheFirst(req));
    return;
  }

  // مدیای خام گیت‌هاب: کش‌اول (عکس‌ها)؛ درخواست‌های Range فیلم دست نخورده از شبکه
  if (url.hostname === 'raw.githubusercontent.com' || url.hostname === 'cdn.jsdelivr.net') {
    if (req.headers.has('range')) return;
    // hg-v15 (۳۰۵): تصویرها (تامنیل فیلم، عکس، پیش‌نمایش GIF) → کش بندانگشتی اختصاصی؛ بقیه مثل قبل
    if (/\.(jpe?g|png|webp|gif)$/i.test(url.pathname)) {
      e.respondWith(thumbCacheFirst(req));
      return;
    }
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
