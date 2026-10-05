export const BUILD = "20260928k";

function registerReaper() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(`/sw.js?b=${BUILD}`).catch(() => {});
}

function reapSiblings() {
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel("east-tv-reap");
  const born = Date.now();
  const isTv = document.body?.classList.contains("tv");
  let parked = false;
  channel.onmessage = (event) => {
    const data = event.data || {};
    if (data.build && data.build > BUILD) {
      location.reload();
      return;
    }
    if (!isTv || data.kind !== "tv" || data.build !== BUILD || parked) return;
    if (Number(data.born) <= born) return;
    window.setTimeout(() => {
      if (parked) return;
      parked = true;
      location.replace("/parked.html");
    }, 2000);
  };
  channel.postMessage({ kind: isTv ? "tv" : "remote", build: BUILD, born });
}

registerReaper();
reapSiblings();
