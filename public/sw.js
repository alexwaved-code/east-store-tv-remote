const BUILD = "20260928k";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await reapClients();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "REAP") event.waitUntil(reapClients());
});

function nextUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== self.location.origin) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (
    path === "/sw.js" ||
    path === "/parked.html" ||
    path === "/privacy.html" ||
    path === "/privacy" ||
    path.startsWith("/vendor/") ||
    path.startsWith("/videos/") ||
    path.startsWith("/covers/") ||
    path.startsWith("/shared/")
  ) {
    return null;
  }
  if (path === "/wts" || path === "/dh" || path === "/tv.html" || path.startsWith("/api/")) {
    const dest = new URL("/", url.origin);
    dest.searchParams.set("b", BUILD);
    return dest.toString();
  }
  if (path.startsWith("/r/")) {
    const code = path.slice(3).split("/")[0] || "";
    const dest = new URL("/remote.html", url.origin);
    if (code) dest.searchParams.set("c", code);
    dest.searchParams.set("b", BUILD);
    return dest.toString();
  }
  const app = path === "/" || path === "/remote.html" || path === "/remote" || path === "/index.html";
  if (!app) return null;
  if (url.searchParams.has("b")) return null;
  url.searchParams.set("b", BUILD);
  return url.toString();
}

async function reapClients() {
  const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  await Promise.all(
    pages.map(async (client) => {
      const dest = nextUrl(client.url);
      if (!dest || dest === client.url) return;
      try {
        await client.navigate(dest);
      } catch {
        /* ignore */
      }
    })
  );
}
