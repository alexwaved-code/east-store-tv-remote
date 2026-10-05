(function () {
  var BUILD = "20260928k";
  try {
    var url = new URL(location.href);
    var path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/parked.html" || path === "/privacy.html" || path === "/privacy") return;
    if (path.indexOf("/r/") === 0) {
      var code = path.split("/")[2] || "";
      url.pathname = "/remote.html";
      if (code) url.searchParams.set("c", code);
    } else if (path === "/wts" || path === "/dh" || path === "/tv.html") {
      var keep = url.search;
      url.pathname = "/";
      url.search = keep;
    }
    if (!url.searchParams.get("b")) url.searchParams.set("b", BUILD);
    if (url.href !== location.href) history.replaceState(null, "", url.toString());
  } catch (err) {
    /* ignore */
  }
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js?b=" + BUILD).then(function (reg) {
    return navigator.serviceWorker.ready.then(function () {
      if (reg.active) reg.active.postMessage({ type: "REAP" });
    });
  });
})();
