/* Direct Link 离线缓存（v1.9）
 * 放在和 直链.html 同一目录。作用：
 *  1) 页面本身：优先取最新；网络慢（>2.5 秒）或断网时用上次缓存的版本打开
 *  2) 看过的 jsDelivr / raw 缩略图：存起来，断网时资源库还能看
 * 不碰 GitHub API 请求，Token 不会进入缓存。 */
const SHELL = 'dl-shell-1.9';
const IMG = 'dl-img';            // 图片缓存不跟版本走，升级后保留
const IMG_MAX = 400;             // 最多缓存多少张，超出时删最早的
const IMG_HOSTS = /^(cdn\.jsdelivr\.net|raw\.githubusercontent\.com)$/;

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
  if (req.mode === 'navigate' && u.origin === self.location.origin) { e.respondWith(shell(e, u)); return; }
  if (req.destination === 'image' && u.protocol === 'https:' && IMG_HOSTS.test(u.hostname)) e.respondWith(image(e, req));
});

async function shell(e, u) {
  const key = u.origin + u.pathname;                       // 忽略 ?_= 这类查询参数
  const cache = await caches.open(SHELL);
  const net = fetch(key, { cache: 'no-cache' }).then(async r => {
    if (r && r.ok && r.type === 'basic') await cache.put(key, r.clone());
    return r;
  });
  e.waitUntil(net.catch(() => {}));
  const cached = await cache.match(key);
  if (!cached) {
    try { return await net; }
    catch (_) { return new Response('当前离线，且还没缓存过这个页面。联网打开一次后就能离线使用。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  }
  const quick = await Promise.race([net.catch(() => null), new Promise(res => setTimeout(() => res(null), 2500))]);
  return (quick && quick.ok) ? quick : cached;
}

async function image(e, req) {
  const cache = await caches.open(IMG);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    // 只缓存可读的（带 CORS 的）响应；opaque 响应会按固定大配额计算，不存
    if (r && r.ok && r.type !== 'opaque') {
      e.waitUntil((async () => {
        await cache.put(req, r.clone());
        const keys = await cache.keys();
        if (keys.length > IMG_MAX) for (const k of keys.slice(0, keys.length - IMG_MAX)) await cache.delete(k);
      })());
    }
    return r;
  } catch (_) { return Response.error(); }
}
