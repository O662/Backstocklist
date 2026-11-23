// Service worker: receives push notifications and opens the app when tapped.
// (No offline caching on purpose, so phones always load the latest version.)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data?.text() };
  }
  // iOS stops delivering pushes if one ever arrives without a notification shown.
  e.waitUntil(
    self.registration.showNotification(d.title || "Backstock", {
      body: d.body || "",
      tag: d.tag,
      icon: "icons/icon-192.png",
      badge: "icons/badge-72.png",
      data: { url: d.url || "./#updates" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope)) {
          await w.focus();
          w.postMessage({ type: "open-updates" });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
