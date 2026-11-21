// 昕悅早午餐 接單後台 Service Worker
// 目的：讓「安裝桌面 App」可用。刻意不做任何快取，確保網站更新後一定拿到最新版本。
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 空的事件處理器：完全交給網路處理，不攔截、不快取
self.addEventListener('fetch', () => {});
