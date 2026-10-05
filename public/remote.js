import "/shared/reap.js?v=20260928k";
import { BRAND_CHIPS, findAd, adsFor } from "/shared/ads.js?v=20260927d";
import { shopByCode, shopLabel, normalizeShopCode } from "/shared/shops.js?v=20260927z";

const app = document.getElementById("app");

function codeFromLocation() {
  const path = location.pathname.replace(/\/+$/, "");
  const m = path.match(/\/r\/([A-Za-z0-9]+)$/i);
  if (m) return normalizeShopCode(m[1]);
  const q = new URLSearchParams(location.search).get("c") || new URLSearchParams(location.search).get("code");
  return normalizeShopCode(q || "");
}

function roomTitle(code = roomCode) {
  return shopLabel(code) || `房號 ${code || "····"}`;
}

function getClientId() {
  const key = "east-tv-phone-id";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID?.() || `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    // Private mode fallback — still stable for this tab
    if (!window.__eastTvPhoneId) {
      window.__eastTvPhoneId =
        crypto.randomUUID?.() || `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return window.__eastTvPhoneId;
  }
}

let roomCode = codeFromLocation();
const clientId = getClientId();
const tabId = crypto.randomUUID?.() || `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const LOCK_KEY = "east-tv-hb-lock";
let brandFilter = "";
let lastRevision = -1;
let waitSince = -1;
let room = null;
let joined = false;
let phoneConfirmed = false;
let heartbeatTimer = 0;
let pollTimer = 0;
let emptyInstantStreak = 0;
let leaveConfirmOpen = false;
let presenceStopped = false;
let lastRenderKey = "";
let moreOpen = false;
let remoteIdle = false;
let lastInputAt = Date.now();
let idleWatchTimer = 0;
let hiddenGoneTimer = 0;

function refreshPhoneConfirmed() {
  phoneConfirmed = sessionStorage.getItem(`tv-ready-ok:${roomCode}`) === "1";
}

async function readApiJson(res) {
  const text = await res.text();
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.startsWith("<")) throw new Error("quota");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("quota");
  }
}

async function apiGet(code) {
  const q = new URLSearchParams({
    code,
    role: "phone",
    client_id: clientId,
    since: String(Number.isFinite(waitSince) ? waitSince : -1),
    wait: "1",
    _: String(Date.now()),
  });
  const res = await fetch(`/api/sync?${q}`, {
    cache: "no-store",
  });
  const data = await readApiJson(res);
  if (!data.ok) throw new Error(data.error || "not found");
  waitSince = data.room.revision;
  return data.room;
}

async function apiCmd(cmd, extra = {}, { silent = false } = {}) {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    cache: "no-store",
    body: JSON.stringify({ code: roomCode, cmd, client_id: clientId, ...extra }),
  });
  const data = await readApiJson(res);
  if (!data.ok) throw new Error(data.error || "cmd failed");
  room = data.room;
  lastRevision = room.revision;
  waitSince = room.revision;
  if (!silent) render();
  return room;
}

/** Fire-and-forget cmd with immediate optimistic UI for next/prev/pick/play/pause. */
function apiCmdSnappy(cmd, extra = {}) {
  // Optimistic: flip local now-playing so taps feel instant while POST is in flight
  if (room && (cmd === "next" || cmd === "prev" || cmd === "pick" || cmd === "play" || cmd === "pause")) {
    if (cmd === "pick" && extra.id) {
      room = { ...room, current_id: extra.id, playing: true, revision: (room.revision || 0) + 1 };
    } else if (cmd === "next" || cmd === "prev") {
      const q = room.queue || [];
      if (q.length) {
        const n = q.length;
        const delta = cmd === "next" ? 1 : -1;
        const idx = (((room.index || 0) + delta) % n + n) % n;
        room = {
          ...room,
          index: idx,
          current_id: q[idx],
          playing: true,
          revision: (room.revision || 0) + 1,
        };
      }
    } else if (cmd === "play") {
      room = { ...room, playing: true, revision: (room.revision || 0) + 1 };
    } else if (cmd === "pause") {
      room = { ...room, playing: false, revision: (room.revision || 0) + 1 };
    }
    lastRevision = room.revision;
    patchNowPlaying();
  }
  return apiCmd(cmd, extra, { silent: true }).then(() => {
    patchNowPlaying();
  }).catch((e) => {
    alertErr(e);
    // Resync from server on failure
    return apiGet(roomCode).then((r) => {
      room = r;
      lastRevision = r.revision;
      waitSince = r.revision;
      render();
    });
  });
}

function claimHeartbeatLock() {
  // Only one tab per phone/browser should heartbeat — prevents「1 機顯示 2 部」
  const now = Date.now();
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const lock = raw ? JSON.parse(raw) : null;
    if (lock?.tabId && lock.tabId !== tabId && now - Number(lock.at || 0) < 20000) {
      return false;
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ tabId, clientId, at: now }));
    return true;
  } catch {
    return true;
  }
}

function releaseHeartbeatLock() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const lock = raw ? JSON.parse(raw) : null;
    if (lock?.tabId === tabId) localStorage.removeItem(LOCK_KEY);
  } catch {
    /* ignore */
  }
}

function sendGoneBeacon() {
  if (!roomCode || !joined) return;
  const body = JSON.stringify({ code: roomCode, cmd: "gone", client_id: clientId });
  try {
    navigator.sendBeacon?.("/api/sync", new Blob([body], { type: "application/json" }));
  } catch {
    /* ignore */
  }
  fetch("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function stopPresence({ notifyGone = false } = {}) {
  presenceStopped = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  releaseHeartbeatLock();
  if (notifyGone) sendGoneBeacon();
}

function onPageHide(e) {
  // bfcache: stop timers only (don't mark gone — tab may come back)
  if (e.persisted) {
    stopPresence({ notifyGone: false });
    return;
  }
  // Real hide/close: stop heartbeats FIRST so we don't re-register after gone
  stopPresence({ notifyGone: true });
  joined = false;
}

function bumpRemoteIdle() {
  lastInputAt = Date.now();
  if (remoteIdle && roomCode) {
    remoteIdle = false;
    resumeRemote();
  }
}

function resumeRemote() {
  if (!roomCode) return;
  presenceStopped = false;
  joined = true;
  apiCmd("join", {}, { silent: true }).catch(() => {});
  startPresenceTimers();
}

function startIdleWatch() {
  if (idleWatchTimer) return;
  idleWatchTimer = setInterval(() => {
    if (!joined || presenceStopped || remoteIdle || document.hidden) return;
    if (Date.now() - lastInputAt < 4 * 60 * 1000) return;
    remoteIdle = true;
    stopPresence({ notifyGone: true });
    joined = false;
  }, 15000);
}

function startPresenceTimers() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    clearInterval(pollTimer);
  }
  presenceStopped = false;
  startIdleWatch();
  const tick = () => {
    if (presenceStopped || !joined) return;
    const started = Date.now();
    const sinceSent = waitSince;
    poll().finally(() => {
      if (presenceStopped || !joined) return;
      const elapsed = Date.now() - started;
      const moved = waitSince !== sinceSent;
      let wait = 200;
      if (elapsed < 400 && !moved) {
        emptyInstantStreak += 1;
        wait = emptyInstantStreak >= 2 ? 3000 : 200;
      } else {
        emptyInstantStreak = 0;
        wait = 200;
      }
      pollTimer = setTimeout(tick, wait);
    });
  };
  tick();
}

function openLeaveConfirm() {
  leaveConfirmOpen = true;
  let modal = document.getElementById("leaveModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "leaveModal";
    modal.className = "remote__modal";
    modal.innerHTML = `
      <div class="remote__modal-card" role="dialog" aria-modal="true" aria-labelledby="leaveTitle">
        <h2 id="leaveTitle">確定要離開房間？</h2>
        <p>離開後電視會暫停；可用同一房號重新進入。</p>
        <div class="remote__modal-actions">
          <button type="button" class="btn" id="leaveCancel">取消</button>
          <button type="button" class="btn btn--danger" id="leaveOk">確定離開</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeLeaveConfirm();
    });
    modal.querySelector("#leaveCancel")?.addEventListener("click", closeLeaveConfirm);
    modal.querySelector("#leaveOk")?.addEventListener("click", () => {
      confirmLeaveRoom().catch(alertErr);
    });
  }
  modal.hidden = false;
}

function closeLeaveConfirm() {
  leaveConfirmOpen = false;
  const modal = document.getElementById("leaveModal");
  if (modal) modal.hidden = true;
}

async function confirmLeaveRoom() {
  closeLeaveConfirm();
  stopPresence({ notifyGone: false });
  try {
    if (joined && roomCode) {
      await apiCmd("leave", {}, { silent: true });
    }
  } catch {
    /* ignore */
  }
  joined = false;
  phoneConfirmed = false;
  sessionStorage.removeItem(`tv-ready-ok:${roomCode}`);
  roomCode = "";
  room = null;
  history.replaceState({}, "", "/");
  renderEnterRoom();
}

function bindLeaveButtons(root = app) {
  root.querySelectorAll("[data-leave]").forEach((btn) => {
    btn.addEventListener("click", openLeaveConfirm);
  });
}

function showError(msg) {
  setRemoteShell("gate");
  lastRenderKey = "";
  app.innerHTML = `
    <main class="remote__error">
      <h1>無法連線</h1>
      <p>${msg}</p>
      <p style="margin-top:1.5rem"><a class="btn btn--primary" href="/">返回</a></p>
    </main>`;
}

function showConnecting() {
  setRemoteShell("gate");
  lastRenderKey = "";
  app.innerHTML = `
    <div class="remote remote--gate">
      <div class="remote__gate">
        <p class="remote__gate-code">${roomTitle(roomCode)}</p>
        <h1>連線中…</h1>
        <p class="remote__gate-pulse">正在進入房間</p>
      </div>
    </div>`;
}

function howtoBox(stepsHtml) {
  return `<ol class="howto howto--compact">${stepsHtml}</ol>`;
}

function renderEnterRoom() {
  document.documentElement.classList.remove("is-remote-landscape");
  setRemoteShell("gate");
  lastRenderKey = "";
  app.innerHTML = `
    <div class="remote remote--gate">
      <div class="remote__gate">
        <p class="remote__gate-brand">EAST STORE TV</p>
        <h1>進入房間</h1>
        <p>睇電視上嘅房號（通常 4 個字），打入下面。</p>
        <form class="landing__join" id="enterForm">
          <input id="enterCode" maxlength="8" placeholder="房號" autocomplete="off" inputmode="text" required />
          <button class="btn btn--primary" type="submit">進入房間</button>
        </form>
        <p class="remote__gate-note">掃電視 QR 更快；或者打房號入去。</p>
      </div>
    </div>`;
  document.getElementById("enterForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = (document.getElementById("enterCode").value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!code) return;
    location.href = "/r/" + encodeURIComponent(code);
  });
}

function alertErr(e) {
  console.error(e);
}

function renderWaitingTv() {
  const tvSeen = Number(room?.tv_seen_at) || 0;
  const tvAlive = tvSeen > 0 && Date.now() - tvSeen < 25000;
  const title = tvAlive ? "已入房 · 等電視開播" : "已入房 · 等電視回應";
  const callout = tvAlive
    ? "電視偵測到你喇。若未開播，去電視撳一下解鎖（只需一次），之後呢頁會變遙控。"
    : "已掃碼成功。電視見到「手機已入房」後會開播放器；到電視撳一下解鎖即可遙控。";
  app.innerHTML = `
    <div class="remote remote--gate">
      <div class="remote__gate">
        <p class="remote__gate-code">${roomTitle(roomCode)}</p>
        <h1>${title}</h1>
        <p class="howto-callout">${callout}</p>
        ${howtoBox(`
          <li><strong>OK</strong><span>掃碼／入房已成功（${roomTitle(roomCode)}）。</span></li>
          <li><strong>下一步</strong><span>電視撳一下解鎖後，自動變遙控面板。</span></li>
        `)}
        <p class="remote__gate-pulse">手機 ${Number(room?.phone_count) || 0} 部 · ${tvAlive ? "電視在線…" : "等電視…"}</p>
        <p style="margin-top:1.25rem">
          <button type="button" class="btn" data-leave>離開房間</button>
        </p>
      </div>
    </div>`;
  bindLeaveButtons();
}

function renderDisbanded() {
  setRemoteShell("gate");
  lastRenderKey = "";
  app.innerHTML = `
    <div class="remote remote--gate">
      <div class="remote__gate">
        <h1>房間已解散</h1>
        <p>請重新掃電視 QR 或輸入新房號。</p>
        <form class="landing__join" id="enterForm" style="margin-top:1rem">
          <input id="enterCode" maxlength="8" placeholder="房號" autocomplete="off" inputmode="text" required />
          <button class="btn btn--primary" type="submit">進入房間</button>
        </form>
        <p style="margin-top:1rem"><a class="btn btn--primary" href="/">回首頁</a></p>
      </div>
    </div>`;
  document.getElementById("enterForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = (document.getElementById("enterCode").value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!code) return;
    location.href = "/r/" + encodeURIComponent(code);
  });
}

function renderTvClosed() {
  stopPresence({ notifyGone: false });
  joined = false;
  phoneConfirmed = false;
  sessionStorage.removeItem(`tv-ready-ok:${roomCode}`);
  setRemoteShell("gate");
  lastRenderKey = "";
  app.innerHTML = `
    <div class="remote remote--gate">
      <div class="remote__gate">
        <h1>電視已關閉</h1>
        <p>房間 ${roomCode || ""} 已結束。請在電視重新開啟播放器，再掃碼或輸入新房號。</p>
        <p style="margin-top:1.25rem"><a class="btn btn--primary" href="/">回首頁</a></p>
      </div>
    </div>`;
  roomCode = "";
  room = null;
}

function setRemoteShell(mode) {
  // mode: "app" | "gate" | ""
  document.body.classList.toggle("is-remote-app", mode === "app");
  document.body.classList.toggle("is-remote-gate", mode === "gate");
}

function visualRenderKey(r) {
  return [
    r?.current_id,
    r?.playing,
    r?.tv_ready,
    r?.mode,
    r?.lang,
    r?.rotation,
    r?.phone_count,
    brandFilter,
    moreOpen ? 1 : 0,
  ].join("|");
}

function patchNowPlaying() {
  if (!room || !app.querySelector(".remote__transport")) {
    lastRenderKey = "";
    if (room) render();
    return;
  }
  const ad = findAd(room.lang, room.current_id);
  const coverSrc = ad?.cover ? `/${ad.cover}` : "";
  const img = app.querySelector("img.remote__cover");
  if (img && coverSrc && img.getAttribute("src") !== coverSrc) img.src = coverSrc;
  const brandEl = app.querySelector(".remote__meta-brand");
  const titleEl = app.querySelector(".remote__meta-title");
  const codeEl = app.querySelector(".remote__meta-code");
  if (brandEl) brandEl.textContent = ad?.line || "EAST STORE";
  if (titleEl) titleEl.textContent = ad?.name || "產品廣告";
  const tvReady = !!room.tv_ready;
  if (codeEl) {
    codeEl.textContent = `${roomTitle(room.code)} · ${Number(room.phone_count) || 0} 機${
      tvReady ? "" : " · 等開播"
    }`;
  }
  const mainBtn = app.querySelector(".remote__tbtn--main");
  if (mainBtn) {
    mainBtn.dataset.cmd = room.playing ? "pause" : "play";
    mainBtn.disabled = !tvReady;
    mainBtn.textContent = tvReady ? (room.playing ? "暫停" : "播放") : "待機";
  }
  app.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.classList.toggle("is-current", btn.dataset.pick === room.current_id);
  });
  lastRenderKey = visualRenderKey(room);
}

function render() {
  document.documentElement.classList.remove("is-remote-landscape");
  if (!roomCode) {
    renderEnterRoom();
    return;
  }
  if (!room) return;

  if (room.closed) {
    renderTvClosed();
    return;
  }

  // Legacy hard-reset (room wiped) — keep room open when phones temporarily leave
  if (joined && !room.paired && !room.tv_ready && room.phone_count === 0 && !room.current_id) {
    joined = false;
    phoneConfirmed = false;
    sessionStorage.removeItem(`tv-ready-ok:${roomCode}`);
    renderDisbanded();
    return;
  }

  const renderKey = visualRenderKey(room);
  if (renderKey === lastRenderKey && app.querySelector(".remote__transport")) return;
  lastRenderKey = renderKey;

  setRemoteShell("app");

  // Keep list scroll where it was — full re-render used to jump back to top
  const prevBody = app.querySelector(".remote__body");
  const savedScroll = prevBody ? prevBody.scrollTop : 0;

  // Show remote as soon as joined — don't wait for TV unlock (first taps used to be dropped)
  const tvReady = !!room.tv_ready;
  const ad = findAd(room.lang, room.current_id);
  const list = adsFor(room.lang).filter((a) => !brandFilter || a.line === brandFilter);
  const rot = Number(room.rotation) || 0;
  const coverSrc = ad?.cover ? `/${ad.cover}` : "";
  const title = ad?.name || "產品廣告";
  const brand = ad?.line || "EAST STORE";
  const gateBanner = tvReady
    ? ""
    : `<p class="remote__prestart">可先選片；電視撳「開始播放」後出聲</p>`;

  app.innerHTML = `
    <div class="remote">
      <header class="remote__top">
        ${gateBanner}
        <div class="remote__now">
          ${
            coverSrc
              ? `<img class="remote__cover" src="${coverSrc}" alt="" />`
              : `<div class="remote__cover remote__cover--empty" aria-hidden="true"></div>`
          }
          <div class="remote__now-text">
            <p class="remote__meta-brand">${brand}</p>
            <p class="remote__meta-title">${title}</p>
            <p class="remote__meta-code">${roomTitle(room.code)} · ${Number(room.phone_count) || 0} 機${tvReady ? "" : " · 等開播"}</p>
          </div>
        </div>
        <div class="remote__transport">
          <button type="button" class="remote__tbtn" data-cmd="prev" aria-label="上一首">‹</button>
          <button type="button" class="remote__tbtn remote__tbtn--main" data-cmd="${room.playing ? "pause" : "play"}" ${tvReady ? "" : "disabled"}>
            ${tvReady ? (room.playing ? "暫停" : "播放") : "待機"}
          </button>
          <button type="button" class="remote__tbtn" data-cmd="next" aria-label="下一首">›</button>
        </div>
        <details class="remote__more"${moreOpen ? " open" : ""}>
          <summary>
            <span class="remote__more-label">${moreOpen ? "收起控制" : "更多控制"}</span>
            <span class="remote__more-chev" aria-hidden="true">${moreOpen ? "▴" : "▾"}</span>
          </summary>
          <div class="remote__more-body">
            <div class="remote__modes remote__modes--4">
              <button type="button" class="mode-btn${room.mode === "loop" ? " is-on" : ""}" data-mode="loop">全部循環</button>
              <button type="button" class="mode-btn${room.mode === "loop_one" ? " is-on" : ""}" data-mode="loop_one">單支循環</button>
              <button type="button" class="mode-btn${room.mode === "shuffle" ? " is-on" : ""}" data-mode="shuffle">隨機</button>
              <button type="button" class="mode-btn${room.mode === "once" ? " is-on" : ""}" data-mode="once">播完即停</button>
            </div>
            <div class="remote__lang">
              <button type="button" class="lang-btn${room.lang === "zh" ? " is-on" : ""}" data-lang="zh">中文</button>
              <button type="button" class="lang-btn${room.lang === "en" ? " is-on" : ""}" data-lang="en">EN</button>
            </div>
            <div class="remote__rot-row">
              <button type="button" class="btn remote__tv-rotate${rot === 270 ? " is-on" : ""}" data-rot="270">左轉</button>
              <button type="button" class="btn remote__tv-rotate${rot === 0 ? " is-on" : ""}" data-rot="0">正常</button>
              <button type="button" class="btn remote__tv-rotate${rot === 90 ? " is-on" : ""}" data-rot="90">右轉</button>
            </div>
            <div class="remote__leave-row">
              <button type="button" class="btn btn--ghost remote__leave" data-leave>離開房間</button>
            </div>
          </div>
        </details>
      </header>
      <div class="remote__body">
        <div class="chips" id="chips"></div>
        <div class="grid" id="grid"></div>
      </div>
    </div>`;

  const chips = app.querySelector("#chips");
  const chipItems = [{ id: "", label: "全部" }, ...BRAND_CHIPS.map((b) => ({ id: b, label: b }))];
  chips.innerHTML = chipItems
    .map(
      (c) =>
        `<button type="button" class="chip${brandFilter === c.id ? " is-on" : ""}" data-brand="${c.id}">${c.label}</button>`
    )
    .join("");

  const grid = app.querySelector("#grid");
  grid.innerHTML = list
    .map(
      (a) => `
      <button type="button" class="card${a.id === room.current_id ? " is-current" : ""}" data-pick="${a.id}">
        <img class="card__img" src="/${a.cover}" alt="" loading="lazy" />
        <p class="card__name">${a.name || "—"}</p>
        ${a.info ? `<p class="card__info">${a.info}</p>` : ""}
      </button>`
    )
    .join("");

  app.querySelector(".remote__more")?.addEventListener("toggle", (e) => {
    moreOpen = !!e.currentTarget.open;
  });

  app.querySelectorAll("[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.currentTarget.blur();
      const cmd = btn.dataset.cmd;
      if (cmd === "next" || cmd === "prev" || cmd === "play" || cmd === "pause") apiCmdSnappy(cmd);
      else apiCmd(cmd).catch(alertErr);
    });
  });
  app.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.currentTarget.blur();
      apiCmd("setMode", { mode: btn.dataset.mode }).catch(alertErr);
    });
  });
  app.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.currentTarget.blur();
      apiCmd("setLang", { lang: btn.dataset.lang }).catch(alertErr);
    });
  });
  app.querySelectorAll("[data-brand]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.currentTarget.blur();
      brandFilter = btn.dataset.brand || "";
      // Filter change: jump to top of the new list intentionally
      const body = app.querySelector(".remote__body");
      if (body) body.scrollTop = 0;
      lastRenderKey = "";
      render();
    });
  });
  app.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // Avoid mobile focus scroll-into-view jumping the list
      e.currentTarget.blur();
      apiCmdSnappy("pick", { id: btn.dataset.pick });
    });
  });
  app.querySelectorAll("[data-rot]").forEach((btn) => {
    btn.addEventListener("click", () => {
      apiCmd("setRotation", { rotation: Number(btn.dataset.rot) || 0 }).catch(alertErr);
    });
  });
  bindLeaveButtons();

  const newBody = app.querySelector(".remote__body");
  if (newBody) newBody.scrollTop = savedScroll;
}

async function poll() {
  if (!roomCode || !joined || leaveConfirmOpen || document.hidden) return;
  const epoch = (poll.epoch = (poll.epoch || 0) + 1);
  const myEpoch = epoch;
  try {
    const next = await apiGet(roomCode);
    if (myEpoch !== poll.epoch) return;
    if (next.closed) {
      room = next;
      renderTvClosed();
      return;
    }
    // Don't clobber optimistic next/prev/pick with a slower GET
    if (Number(next.revision) < Number(lastRevision)) return;
    const readyChanged = !!room?.tv_ready !== !!next.tv_ready;
    const rotChanged = Number(room?.rotation) !== Number(next.rotation);
    const phoneChanged = Number(room?.phone_count) !== Number(next.phone_count);
    const pairChanged = !!room?.paired !== !!next.paired;
    const playChanged = !!room?.playing !== !!next.playing;
    const idChanged = room?.current_id !== next.current_id;
    const modeChanged = room?.mode !== next.mode || room?.lang !== next.lang;
    if (
      next.revision !== lastRevision ||
      readyChanged ||
      rotChanged ||
      phoneChanged ||
      pairChanged ||
      playChanged ||
      idChanged ||
      modeChanged
    ) {
      room = next;
      lastRevision = next.revision;
      if (readyChanged || rotChanged || pairChanged || modeChanged || !app.querySelector(".remote__transport")) {
        render();
      } else {
        patchNowPlaying();
      }
    } else {
      room = next;
    }
  } catch (e) {
    if (myEpoch === poll.epoch && String(e?.message || e).includes("not found")) {
      renderTvClosed();
    }
  }
}

async function boot() {
  if (!roomCode) {
    renderEnterRoom();
    return;
  }
  showConnecting();
  refreshPhoneConfirmed();
  try {
    room = await apiGet(roomCode);
    if (room.closed) {
      renderTvClosed();
      return;
    }
    lastRevision = room.revision;
    waitSince = room.revision;
    await apiCmd("join");
    joined = true;
    lastInputAt = Date.now();
    startPresenceTimers();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        stopPresence({ notifyGone: false });
        if (hiddenGoneTimer) clearTimeout(hiddenGoneTimer);
        hiddenGoneTimer = setTimeout(() => {
          sendGoneBeacon();
          joined = false;
        }, 20000);
        return;
      }
      if (hiddenGoneTimer) {
        clearTimeout(hiddenGoneTimer);
        hiddenGoneTimer = 0;
      }
      lastInputAt = Date.now();
      remoteIdle = false;
      if (roomCode) resumeRemote();
    });
    window.addEventListener("pointerdown", bumpRemoteIdle);
    window.addEventListener("keydown", bumpRemoteIdle);
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted || !roomCode) return;
      // Restored from bfcache — rejoin and resume timers
      joined = true;
      presenceStopped = false;
      apiCmd("join", {}, { silent: true }).catch(() => {});
      startPresenceTimers();
    });
  } catch (e) {
    showError(
      e.message === "quota"
        ? "連線額滿，電視仍可按遙控播片。手機稍後再掃。"
        : e.message === "not found"
          ? "房號不存在或已過期，請在 TV 重新開房。"
          : String(e.message || e),
    );
  }
}

boot();
