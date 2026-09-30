const CACHE = 'yuzhou-v2';
const PRE_CACHE = ['/', '/index.html'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRE_CACHE)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => {
        return Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    }));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    if (e.request.url.includes('/api/')) return;

    // HTML/页面导航：网络优先。保证前端更新即时生效，离线时才回退缓存
    // （此前对 HTML 也缓存优先，会导致用户永远拿到旧版本页面）
    const accept = e.request.headers.get('accept') || '';
    if (e.request.mode === 'navigate' || accept.includes('text/html')) {
        e.respondWith(
            fetch(e.request).then(response => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return response;
            }).catch(() =>
                caches.match(e.request).then(c => c || caches.match('/index.html'))
            )
        );
        return;
    }

    // 其余静态资源：缓存优先，后台静默更新
    e.respondWith(
        caches.match(e.request).then(cached => {
            const fetched = fetch(e.request).then(response => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return response;
            }).catch(() => cached);
            return cached || fetched;
        })
    );
});
