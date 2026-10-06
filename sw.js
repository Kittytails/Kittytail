/* Direct Link 离线缓存（v2.0）
 * 放在和 直链.html 同一目录。作用：
 *  1) 页面本身：优先取最新；网络慢（>2.5 秒）或断网时用上次缓存的版本打开
 *  2) 看过的 jsDelivr / raw 缩略图：存起来，断网时资源库还能看
 *  3) 插件文件 plugins.js：优先取最新，断网时用缓存，离线也能用插件
 * 不碰 GitHub API 请求，Token 不会进入缓存。 */
const SHELL = 'dl-shell-2.0';
const IMG = 'dl-img';            // 图片缓存不跟版本走，升级后保留
const PLUG = 'dl-plugins';       // 插件缓存同样不跟版本走
const IMG_MAX = 400;             // 最多缓存多少张，超出时删最早的
const IMG_FRESH_MS = 10 * 60 * 1000;   // 非固定版本的图片：缓存超过这个时间，下次用到时在后台刷新
const SLOW_MS = 2500;            // 网络超过这个时间还没回来，就先用缓存
const IMG_HOSTS = /^(cdn\.jsdelivr\.net|raw\.githubusercontent\.com)$/;
const PLUG_PATH = /\/plugins\.js$/;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('dl-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (req.mode === 'navigate' && u.origin === self.location.origin) {
    e.respondWith(networkFirst(e, SHELL, u, {
      keepOnGone: true,   // 页面本身 404 时仍用缓存（可能只是部署中途）
      whenNoCache: net => net.catch(() => new Response('当前离线，且还没缓存过这个页面。联网打开一次后就能离线使用。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
    }));
    return;
  }
  if (u.origin === self.location.origin && PLUG_PATH.test(u.pathname)) {
    e.respondWith(networkFirst(e, PLUG, u, {
      keepOnGone: false,  // 插件文件被删了（404/410）就不要再用旧缓存
      whenNoCache: net => net.catch(() => Response.error())
    }));
    return;
  }
  if (req.destination === 'image' && u.protocol === 'https:' && IMG_HOSTS.test(u.hostname)) e.respondWith(image(e, req, u));
});

/* 带重定向标记的响应不能直接用作页面响应（浏览器会报错）：拷成一份干净的 */
async function unredirect(r) {
  if (!r.redirected) return r;
  return new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
}
const gone = r => r && (r.status === 404 || r.status === 410);

/* 网络优先：改了马上生效；断网、超时、服务器出错时用缓存。按路径存，忽略 ?_= 这类查询参数 */
async function networkFirst(e, cacheName, u, opt) {
  const key = u.origin + u.pathname;
  const cache = await caches.open(cacheName);
  const net = (async () => {
    let r = await fetch(key, { cache: 'no-cache' });
    const cacheable = r.ok && r.type === 'basic';
    if (r.redirected) r = await unredirect(r);
    if (cacheable) { try { await cache.put(key, r.clone()); } catch (_) { /* 存储满了也不能当成断网 */ } }
    else if (gone(r) && !opt.keepOnGone) { try { await cache.delete(key); } catch (_) {} }
    return r;
  })();
  e.waitUntil(net.catch(() => {}));
  const cached = await cache.match(key);
  if (!cached) return opt.whenNoCache(net);
  let timer;
  const quick = await Promise.race([net.catch(() => null), new Promise(res => { timer = setTimeout(() => res(null), SLOW_MS); })]);
  clearTimeout(timer);
  if (quick && (quick.ok || (gone(quick) && !opt.keepOnGone))) return quick;
  return cached;
}

/* 固定到某个提交（@40位sha / /40位sha/）的图片内容不会变，可以一直用缓存；
 * 跟着分支走的链接（@main 等）可能被「替换文件」改掉，用旧图的同时在后台刷新 */
function isPinned(u) {
  if (u.hostname === 'cdn.jsdelivr.net') return /^\/gh\/[^/]+\/[^/@]+@[0-9a-f]{40}\//i.test(u.pathname);
  return /^\/[^/]+\/[^/]+\/[0-9a-f]{40}\//i.test(u.pathname);
}
async function storeImage(cache, req, r) {
  if (!r || r.status !== 200 || r.type === 'opaque') return;   // 只缓存可读的（带 CORS 的）完整响应；opaque 会按固定大配额计算，不存
  try {
    await cache.put(req, r);
    const keys = await cache.keys();
    if (keys.length > IMG_MAX) for (const k of keys.slice(0, keys.length - IMG_MAX)) await cache.delete(k);
  } catch (_) {}
}
async function image(e, req, u) {
  const cache = await caches.open(IMG);
  const hit = await cache.match(req);
  if (hit) {
    if (!isPinned(u)) {
      const at = Date.parse(hit.headers.get('date') || '');
      if (!(Date.now() - at < IMG_FRESH_MS)) {
        e.waitUntil(fetch(req.url, { mode: 'cors', credentials: 'omit', cache: 'no-cache' })
          .then(r => storeImage(cache, req, r)).catch(() => {}));
      }
    }
    return hit;
  }
  try {
    const r = await fetch(req);
    e.waitUntil(storeImage(cache, req, r.clone()));
    return r;
  } catch (_) { return Response.error(); }
}
