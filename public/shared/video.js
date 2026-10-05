/** Demo videos live under /videos/. Replace with your own host in production. */
export const VIDEO_BASE = "/videos";
export const VIDEO_REV = "demo1";

export function videoSrc(id) {
  if (!id) return "";
  const base = String(VIDEO_BASE || "").replace(/\/$/, "");
  return `${base}/${encodeURIComponent(id)}.mp4?v=${VIDEO_REV}`;
}
