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

// Where the app picks up a deep link that survived a cold launch — see
// stashPendingNav() below and consumePendingNav() in public/app.js.
const PENDING_CACHE = "tierdrop-pending-nav";
const PENDING_KEY = "/__pending_nav__";

// Stash the tap's destination so a freshly-launched app can recover it. This is
// the belt-and-suspenders for iOS: when the PWA was fully killed, iOS often
// opens the start_url and DROPS our query string, so the URL alone isn't enough
// to know which comment to show. The page reads this on boot (and clears it).
async function stashPendingNav(url) {
  try {
    const cache = await caches.open(PENDING_CACHE);
    const body = JSON.stringify({ url, ts: Date.now() });
    await cache.put(PENDING_KEY, new Response(body, { headers: { "content-type": "application/json" } }));
  } catch {
    /* cache unavailable — fall back to the URL/openWindow path */
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Keep this RELATIVE (e.g. "./" or "./?comment=…"); resolving it against the
  // SW scope keeps the tap inside the installed PWA. An absolute https:// URL
  // would pop iOS out into Safari (the "broken Safari page").
  const target = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // The app is already running (foreground or backgrounded): focus it and let
      // the page navigate itself via postMessage. We deliberately do NOT call
      // WindowClient.navigate() — on an installed iOS PWA that kicks the user out
      // to Safari instead of routing in-app.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          client.postMessage({ type: "notification-nav", url: target });
          return;
        }
      }
      // No running window (the common case for a tapped notification): stash the
      // destination, then open the app. The fresh page recovers `target` from the
      // stash even if iOS launched the bare start_url.
      await stashPendingNav(target);
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});
