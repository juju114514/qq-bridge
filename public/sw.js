// QQ 桥接控制台 Service Worker（0.4.108）
//
// 只做两件事：
//   1) 让页面可"安装"（PWA 要求有 fetch 处理器）
//   2) **导航请求走网络优先**——控制台是活的，缓存旧页面只会让人以为"功能没了"
//
// 明确不做的事：不缓存任何 /api 响应（里面有令牌、聊天内容、群号）。
const CACHE = 'qqb-shell-v1';
const SHELL = ['/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  // 接口一律走网络，绝不缓存（令牌/隐私）
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/health/detail') return;
  // 页面：网络优先，失败再回缓存（离线也能开个壳）
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
