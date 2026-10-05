/** Serve remote UI for /r/:code — keep code in URL path; also pass ?c= backup. */
import { shopByCode } from "../_shared/shops.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const raw = (parts[1] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const shop = shopByCode(raw);
  const code = shop ? shop.code : raw;

  if (env.ASSETS) {
    const assetUrl = new URL("/remote.html", url.origin);
    if (code) assetUrl.searchParams.set("c", code);
    const assetRes = await env.ASSETS.fetch(assetUrl);
    return new Response(assetRes.body, {
      status: assetRes.status,
      headers: assetRes.headers,
    });
  }

  return Response.redirect(new URL(`/remote.html?c=${encodeURIComponent(code)}`, url.origin), 302);
}
