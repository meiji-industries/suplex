// Suplex service worker: shows Web Push notifications and opens their task. It does not cache.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === "string" && data.title ? data.title : "Suplex";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    data: { url: typeof data.url === "string" ? data.url : "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = new URL("/", self.location.origin);
  try {
    const candidate = new URL(event.notification.data?.url ?? "/", self.location.origin);
    if (candidate.origin === self.location.origin) target = candidate;
  } catch { /* Keep the root URL. */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      try {
        await existing.focus();
        await existing.navigate(target.href);
        return;
      } catch { /* An uncontrolled window cannot navigate; open a new one. */ }
    }
    await self.clients.openWindow(target.href);
  })());
});
