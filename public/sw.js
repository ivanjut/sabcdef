// TierDrop service worker.
//
// Two jobs:
//   1. Make the app installable (a registered SW with a fetch handler is part of
//      the PWA install criteria). We don't cache aggressively — the app is tiny
//      and always wants fresh comments — so the fetch handler is a pass-through.
//   2. Receive Web Push messages and show notifications, and focus/open the app
//      when one is tapped. The push payload is sent by the send-push Edge
//      Function (supabase/functions/send-push) as JSON: { title, body, url, tag }.

self.addEventListener("install", () => {
  // Activate this version immediately rather than waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler. Its presence (not its behavior) is what makes the
// app installable; we deliberately don't add a cache to avoid serving stale
// comments or an outdated daily category.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "TierDrop";
  const options = {
    body: payload.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: payload.tag || "tierdrop",
    // With a tag set, renotify makes a repeat notification buzz instead of
    // silently replacing the previous one.
    renotify: Boolean(payload.tag),
    data: { url: payload.url || "./" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing tab if one is open; otherwise open a new one.
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) client.navigate(target).catch(() => {});
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});
