const criticalRefreshCache = "wise-wolf-critical-refresh";
const criticalRefreshMarker = "/.well-known/profile-privacy-20260824";

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const markerCache = await caches.open(criticalRefreshCache);
    const markerRequest = new Request(criticalRefreshMarker);
    if (!(await markerCache.match(markerRequest))) {
      await markerCache.put(markerRequest, new Response("done"));
    }
    await self.clients.claim();
  })());
});
