import "/shared/reap.js?v=20260928k";
import { findAd, idsFor, shuffleIds } from "/shared/ads.js?v=20260928a";
import { shopByCode, shopLabel, normalizeShopCode } from "/shared/shops.js?v=20260928a";
import { videoSrc } from "/shared/video.js?v=20260927x";

const overlay = document.getElementById("overlay");
const qrBig = document.getElementById("qrBig");
const roomCodeEl = document.getElementById("roomCode");
const pairHint = document.getElementById("pairHint");
const statusEl = document.getElementById("status");
const frame = document.getElementById("frame");
const veil = document.getElementById("veil");
const holdEl = document.getElementById("hold");
const loadingEl = document.getElementById("loading");
const shield = document.getElementById("shield");
const remoteHint = document.getElementById("remoteHint");
const pairHub = document.getElementById("pairHub");
const pairReady = document.getElementById("pairReady");
const pairCta = document.getElementById("pairCta");
const shopNameEl = document.getElementById("shopName");
const readyHint = document.getElementById("readyHint");
const readyPhones = document.getElementById("readyPhones");
const railBrand = document.getElementById("railBrand");
const railName = document.getElementById("railName");
const railPrice = document.getElementById("railPrice");
const railInfo = document.getElementById("railInfo");
const railBrandRight = document.getElementById("railBrandRight");
const railNameRight = document.getElementById("railNameRight");
const railPriceLeft = document.getElementById("railPriceLeft");
const railInfoLeft = document.getElementById("railInfoLeft");
const reconnectChip = document.getElementById("reconnectChip");
const reconnectCode = document.getElementById("reconnectCode");

function isStoreTvClient() {
  const q = new URLSearchParams(location.search);
  if (q.get("app") === "1") return true;
  const ua = navigator.userAgent || "";
  return (
    /Android/i.test(ua) &&
    /(TV|BRAVIA|AFT\w|GoogleTV|Chromecast|CrKey|SMART-TV|SmartTV)/i.test(ua)
  );
}

const TV_LANDSCAPE_MQ =
  "(orientation: landscape) and (min-width: 960px) and (min-height: 520px)";

function isTvLandscapeScreen() {
  return window.matchMedia(TV_LANDSCAPE_MQ).matches;
}

function applyStoreTvMode() {
  const tv = isStoreTvClient() || isTvLandscapeScreen();
  document.body.classList.toggle("is-tv-app", tv);
  const join = document.querySelector(".tv__start-join");
  if (join) join.hidden = tv;
  const input = document.getElementById("codeInput");
  if (input) input.tabIndex = tv ? -1 : 0;
  const enterHint = document.getElementById("enterHint");
  if (enterHint) enterHint.hidden = tv;
}

applyStoreTvMode();
window.addEventListener("resize", applyStoreTvMode);
window.matchMedia(TV_LANDSCAPE_MQ).addEventListener("change", applyStoreTvMode);

let roomCode = "";
let lastRevision = -1;
let ytPlayer = null;
let appliedVideoId = null;
let appliedPlaying = null;
let endingSent = false;
let audioUnlocked = false;
let paired = false;
let wasPaired = false;
let veilTimer = 0;
let wantPlaying = true;
let latestRoom = null;
let playerReady = false;
let pollInFlight = false;
let pollEpoch = 0;
let emptyInstantStreak = 0;
let soloMode = false;
let apiFailStreak = 0;
let soloWatchTimer = 0;
let soloRecoverTimer = 0;
let recoverInFlight = false;
let liveQrCodePainted = "";
let listenMode = "live";
let lastPhoneAt = Date.now();
let quietSolo = false;
let quietWatchTimer = 0;
let morningTimer = 0;
let lastPlayNudgeAt = 0;
/** First tap on connection page — even before the file player is ready. */
let gestureArmed = false;
/** Bumps on every loadAndPlay so stale play kicks / retries are ignored. */
let loadGen = 0;
/** Cancels in-flight preparePlayer so cueVideoById cannot overwrite a newer load. */
let prepareGen = 0;
let tvReadySent = false;
let lastForceLoadAt = 0;
/** Overlay gone, waiting for PLAYING before we show the video. */
let unlocking = false;
/** Once picture is running, later play kicks must not mute it again. */
let soundLatched = false;
/** Browser rejected sound and paused; keep the picture moving muted. */
let soundBlocked = false;
let unmuteAttemptAt = 0;
/** True for ~1s after a TV remote/click — unmuted play is allowed. */
let gestureFresh = false;
let stuckWatch = 0;

function livePlayerVideoId() {
  try {
    return String(ytPlayer?.getVideoData?.()?.video_id || "");
  } catch {
    return "";
  }
}

function ytStates() {
  return { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
}

function ensureHtml5Player() {
  const el = document.getElementById("player");
  if (!el) return;
  if (window.YT?.PlayerState == null) window.YT = { PlayerState: ytStates() };
  if (ytPlayer) return;
  ytPlayer = bindHtml5Player(el);
}

function bindHtml5Player(el) {
  let boundId = "";
  const emit = (data) => onYtStateChange({ data, target: api });

  el.addEventListener("playing", () => {
    clearHold();
    hideLoading();
    emit(1);
  });
  el.addEventListener("pause", () => {
    if (el.ended) return;
    emit(2);
  });
  el.addEventListener("waiting", () => {
    if (!audioUnlocked && !unlocking) showLoading();
    emit(3);
  });
  el.addEventListener("ended", () => emit(0));
  el.addEventListener("loadedmetadata", () => {
    applyCoverFromElement(el);
  });
  el.addEventListener("canplay", () => {
    playerReady = true;
    applyCoverFromElement(el);
    if (el.paused) emit(5);
  });
  el.addEventListener("error", () => {
    console.warn("video error", boundId, el.error);
    setStatus("影片載入失敗，跳下一支…");
    if (audioUnlocked) handleVideoEnded();
  });

  const setSrc = (id, play) => {
    const src = videoSrc(id);
    if (!src) return;
    boundId = String(id || "");
    if (el.getAttribute("data-id") !== boundId) {
      if (audioUnlocked) holdCurrentFrame();
      el.crossOrigin = "anonymous";
      el.setAttribute("data-id", boundId);
      el.src = src;
      el.load();
    }
    if (play) playElement(el);
    else el.pause();
  };

  const api = {
    mute() {
      el.muted = true;
    },
    unMute() {
      el.muted = false;
    },
    setVolume(n) {
      el.volume = Math.max(0, Math.min(1, Number(n) / 100));
    },
    playVideo() {
      playElement(el);
    },
    pauseVideo() {
      el.pause();
    },
    loadVideoById(a) {
      const id = typeof a === "string" ? a : a?.videoId;
      setSrc(id, true);
    },
    cueVideoById(a) {
      const id = typeof a === "string" ? a : a?.videoId;
      setSrc(id, false);
    },
    getPlayerState() {
      if (el.ended) return 0;
      if (el.readyState < 3 && !el.paused) return 3;
      if (!el.paused && !el.ended) return 1;
      if (el.paused && el.currentTime > 0) return 2;
      if (el.src && el.readyState >= 1) return 5;
      return -1;
    },
    getVideoData() {
      return { video_id: boundId || el.getAttribute("data-id") || "" };
    },
    getIframe() {
      return null;
    },
    setPlaybackQuality() {},
    setPlaybackQualityRange() {},
    unloadModule() {},
    setOption() {},
  };
  return api;
}

function remoteUrl(code) {
  const shop = shopByCode(code);
  const token = shop ? shop.path : String(code || "").toUpperCase();
  return `${location.origin}/remote.html?c=${encodeURIComponent(token)}`;
}

async function readApiJson(res) {
  const text = await res.text();
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.startsWith("<")) {
    const err = new Error("quota");
    err.quota = true;
    throw err;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const err = new Error("quota");
    err.quota = true;
    throw err;
  }
}

function makeSoloRoom() {
  const keepId = livePlayerVideoId() || latestRoom?.current_id || null;
  let queue = latestRoom?.queue?.length
    ? latestRoom.queue.map(String)
    : shuffleIds(idsFor("zh"));
  if (keepId && !queue.includes(keepId)) queue = [keepId, ...queue];
  const index = keepId && queue.includes(keepId) ? queue.indexOf(keepId) : 0;
  const rot = Number(latestRoom?.rotation);
  return {
    code: "店內",
    lang: "zh",
    mode: latestRoom?.mode === "loop_one" ? "loop_one" : "shuffle",
    queue,
    index,
    playing: !!audioUnlocked,
    current_id: keepId || queue[index] || null,
    paired: true,
    tv_ready: !!audioUnlocked,
    rotation: rot === 270 ? 270 : 90,
    phones_json: "{}",
    phone_count: 0,
    closed: false,
    revision: (Number(latestRoom?.revision) || 0) + 1,
  };
}

function startSoloWatch() {
  if (soloWatchTimer) return;
  soloWatchTimer = setInterval(() => {
    if (!soloMode || !audioUnlocked || !wantPlaying) return;
    const el = document.getElementById("player");
    if (!el || el.ended) return;
    if (el.paused && el.readyState >= 2) playUnmuted(ytPlayer, { force: true });
  }, 2500);
}

function advanceSoloQueue() {
  const room = latestRoom;
  if (!room?.queue?.length) return;
  if (room.mode === "loop_one") {
    loadAndPlay(room.current_id || room.queue[0]);
    return;
  }
  const n = room.queue.length;
  const idx = ((room.index || 0) + 1) % n;
  room.index = idx;
  room.current_id = room.queue[idx];
  latestRoom = room;
  loadAndPlay(room.current_id);
}

function hideLiveQr() {
  const box = document.getElementById("liveQr");
  if (box) box.hidden = true;
  liveQrCodePainted = "";
}

function showPlayingQr(code) {
  const box = document.getElementById("liveQr");
  const pad = document.getElementById("qrLive");
  const label = document.getElementById("liveQrCode");
  if (!box || !pad || !code) return;
  box.hidden = false;
  if (label) label.textContent = code;
  if (liveQrCodePainted !== code) {
    renderQr(pad, remoteUrl(code));
    liveQrCodePainted = code;
  }
}

function syncLiveQr(room) {
  if (soloMode || !audioUnlocked || room?.closed || !roomCode || roomCode === "店內") {
    hideLiveQr();
    return;
  }
  if (Number(room?.phone_count || 0) > 0) {
    hideLiveQr();
    return;
  }
  showPlayingQr(roomCode);
}

function stopSoloRecover() {
  if (soloRecoverTimer) {
    clearTimeout(soloRecoverTimer);
    soloRecoverTimer = 0;
  }
}

async function apiIsLive() {
  try {
    const res = await withTimeout(
      fetch(`/api/sync?code=____&_=${Date.now()}`, { cache: "no-store" }),
      4000
    );
    const text = await res.text();
    const body = String(text || "").trim();
    if (!body || body.startsWith("<")) return false;
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

async function recoverLiveRoom() {
  if (!soloMode || recoverInFlight) return false;
  recoverInFlight = true;
  try {
    if (!(await apiIsLive())) return false;
    const keepId = appliedVideoId || latestRoom?.current_id || "";
    const keepRot = latestRoom?.rotation === 270 ? 270 : 90;
    const room = await withTimeout(apiCreate(), 4000);
    if (!room?.code) return false;
    stopSoloRecover();
    soloMode = false;
    quietSolo = false;
    listenMode = "live";
    lastPhoneAt = Date.now();
    apiFailStreak = 0;
    tvReadySent = false;
    roomCode = room.code;
    lastRevision = room.revision;
    latestRoom = room;
    paired = !!room.paired;
    paintShopName(room.code);
    if (roomCodeEl) roomCodeEl.textContent = room.code;
    renderQr(qrBig, remoteUrl(room.code));
    if (keepId) {
      try {
        const picked = await apiCmd(room.code, "pick", { id: keepId });
        latestRoom = picked;
        lastRevision = picked.revision;
        if (keepRot) {
          const rotated = await apiCmd(room.code, "setRotation", { rotation: keepRot });
          latestRoom = rotated;
          lastRevision = rotated.revision;
        }
        if (audioUnlocked) {
          const playing = await apiCmd(room.code, "play");
          latestRoom = playing;
          lastRevision = playing.revision;
        }
      } catch {
        /* QR still shown */
      }
    }
    if (audioUnlocked) {
      hideOverlay();
      showPlayingQr(room.code);
      syncReconnectChip({ ...latestRoom, tv_ready: true, phone_count: 0, closed: false });
      startPollLoop();
      markTvReady();
      return true;
    }
    hideLiveQr();
    await bootRoom(latestRoom);
    return true;
  } catch {
    return false;
  } finally {
    recoverInFlight = false;
  }
}

function hktHour() {
  try {
    const raw = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date());
    return Number(String(raw).replace(/\D/g, "")) % 24;
  } catch {
    return new Date().getHours();
  }
}

function isHktNight() {
  const hour = hktHour();
  return hour >= 21 || hour < 9;
}

function startMorningWake() {
  if (morningTimer) return;
  morningTimer = setInterval(() => {
    if (!quietSolo || !soloMode) return;
    if (isHktNight()) return;
    quietSolo = false;
    listenMode = "live";
    startSoloRecover();
  }, 60000);
}

function startQuietWatch() {
  if (quietWatchTimer) return;
  startMorningWake();
  quietWatchTimer = setInterval(() => {
    if (soloMode) return;
    const phones = Number(latestRoom?.phone_count || 0);
    if (phones > 0) {
      lastPhoneAt = Date.now();
      if (listenMode !== "live") listenMode = "live";
      return;
    }
    const idle = Date.now() - lastPhoneAt;
    if (audioUnlocked && isHktNight() && idle > 20 * 60 * 1000) {
      listenMode = "off";
      pollEpoch += 1;
      enterSoloMode({ recover: false });
      quietSolo = true;
      return;
    }
    if (idle > 15 * 60 * 1000) listenMode = "slow";
  }, 30000);
}

function startSoloRecover() {
  if (!soloMode || soloRecoverTimer || quietSolo) return;
  const tick = async () => {
    soloRecoverTimer = 0;
    if (!soloMode) return;
    await recoverLiveRoom();
    if (soloMode) soloRecoverTimer = setTimeout(tick, 20000);
  };
  soloRecoverTimer = setTimeout(tick, 8000);
}

function enterSoloMode({ recover = true } = {}) {
  if (soloMode) {
    startSoloWatch();
    if (recover && !quietSolo) startSoloRecover();
    else stopSoloRecover();
    return latestRoom;
  }
  soloMode = true;
  pollEpoch += 1;
  pollInFlight = false;
  apiFailStreak = 0;
  const room = makeSoloRoom();
  latestRoom = room;
  lastRevision = room.revision;
  roomCode = room.code;
  paired = true;
  hideLiveQr();
  startSoloWatch();
  if (recover && !quietSolo) startSoloRecover();
  else stopSoloRecover();
  if (audioUnlocked) {
    wantPlaying = true;
    appliedPlaying = true;
    hideOverlay();
    syncRotation(room.rotation);
    if (room.current_id) syncLayout(room.current_id);
    if (reconnectChip) reconnectChip.hidden = true;
    setStatus("單機播放");
    return room;
  }
  return room;
}

function paintShopName(code) {
  const label = shopLabel(code);
  if (!shopNameEl) return;
  if (!label) {
    shopNameEl.hidden = true;
    shopNameEl.textContent = "";
    return;
  }
  shopNameEl.hidden = false;
  shopNameEl.textContent = label;
}

function setStatus(text, live = false) {
  if (audioUnlocked) {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle("is-live", live);
}

function isFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement
  );
}

function enterFullscreenSync() {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) el.requestFullscreen({ navigationUI: "hide" });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.msRequestFullscreen) el.msRequestFullscreen();
  } catch {
    /* ignore */
  }
}

function setPlayingChrome(on) {
  document.body.classList.toggle("is-playing", on);
  document.body.classList.toggle("is-pairing", !on);
  if (on) statusEl.hidden = true;
}

function showLoading() {
  if (!loadingEl) return;
  loadingEl.hidden = false;
}

function hideLoading() {
  if (!loadingEl) return;
  loadingEl.hidden = true;
}

function holdCurrentFrame() {
  const el = document.getElementById("player");
  if (!el || !holdEl || !el.videoWidth || el.readyState < 2) return false;
  try {
    holdEl.width = el.videoWidth;
    holdEl.height = el.videoHeight;
    holdEl.getContext("2d").drawImage(el, 0, 0);
    holdEl.hidden = false;
    hideLoading();
    return true;
  } catch {
    holdEl.hidden = true;
    return false;
  }
}

function clearHold() {
  if (holdEl) holdEl.hidden = true;
}

function showVeil() {
  // Only used before TV unlock / pairing — avoid black fades between videos
  if (audioUnlocked) return;
  clearTimeout(veilTimer);
  veil.classList.remove("is-clear");
}

function clearVeilNow() {
  clearTimeout(veilTimer);
  veil.classList.add("is-clear");
  hideLoading();
}

function applyCoverFromElement(el) {
  if (!frame || !el?.videoWidth || !el.videoHeight) return;
  const wide = el.videoWidth / el.videoHeight > 1.2;
  frame.classList.toggle("is-cover-916", wide);
}

function clearRailCopy() {
  for (const el of [
    railBrand,
    railName,
    railBrandRight,
    railNameRight,
    railPrice,
    railInfo,
    railPriceLeft,
    railInfoLeft,
  ]) {
    if (el) el.textContent = "";
  }
}

function syncLayout(videoId) {
  const lang = latestRoom?.lang || "zh";
  const ad = findAd(lang, videoId) || findAd("zh", videoId) || findAd("en", videoId);
  // All creatives play as 9:16 center; side rails hold copy
  frame.classList.remove("is-wide");
  if (!audioUnlocked && document.body.classList.contains("is-ready")) {
    clearRailCopy();
  } else {
    if (railBrand) railBrand.textContent = ad?.line || "";
    if (railName) railName.textContent = ad?.name || "";
    if (railBrandRight) railBrandRight.textContent = ad?.line || "";
    if (railNameRight) railNameRight.textContent = ad?.name || "";
    const price = (ad?.price || "").trim();
    const info = (ad?.info || "").trim();
    if (railPrice) railPrice.textContent = price;
    if (railInfo) railInfo.textContent = info;
    if (railPriceLeft) railPriceLeft.textContent = price;
    if (railInfoLeft) railInfoLeft.textContent = info;
  }

  // Prefer the real file. 16:9 shorts (vertical shot on a wide canvas) get cropped in.
  const el = document.getElementById("player");
  if (el?.videoWidth && el.videoHeight) {
    applyCoverFromElement(el);
  } else {
    frame.classList.toggle("is-cover-916", !!ad?.letterbox);
  }
}

function syncRotation(rotation) {
  const r = Number(rotation) || 0;
  document.body.classList.toggle("is-rot90", r === 90);
  document.body.classList.toggle("is-rot270", r === 270 || r === -90);
  // Inline fallback for stubborn TV WebViews that skip stylesheet transforms
  if (frame) {
    if (r === 90 || r === 270 || r === -90) {
      const deg = r === 90 ? 90 : -90;
      frame.style.position = "absolute";
      frame.style.top = "50%";
      frame.style.left = "50%";
      frame.style.width = "100dvh";
      frame.style.height = "100dvw";
      frame.style.maxWidth = "none";
      frame.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
      frame.style.webkitTransform = `translate(-50%, -50%) rotate(${deg}deg)`;
      frame.style.transformOrigin = "center center";
    } else {
      frame.style.position = "";
      frame.style.top = "";
      frame.style.left = "";
      frame.style.width = "";
      frame.style.height = "";
      frame.style.maxWidth = "";
      frame.style.transform = "";
      frame.style.webkitTransform = "";
      frame.style.transformOrigin = "";
    }
  }
}

function markGestureFresh() {
  gestureFresh = true;
  soundBlocked = false;
  setTimeout(() => {
    gestureFresh = false;
  }, 1200);
}

function playElement(el) {
  if (!el) return;
  const withSound = audioUnlocked || gestureFresh || (soundLatched && !soundBlocked);
  el.muted = !withSound;
  if (withSound) el.volume = 1;
  const pending = el.play();
  if (!pending || !pending.catch) return;
  pending.catch(() => {
    if (el.muted) return;
    el.muted = true;
    soundBlocked = true;
    soundLatched = false;
    el.play().catch(() => {});
  });
}

function applySoundIfPlaying(player = ytPlayer) {
  if (soundBlocked && !gestureFresh) return;
  try {
    if (gestureFresh) soundBlocked = false;
    player?.unMute?.();
    player?.setVolume?.(100);
    unmuteAttemptAt = Date.now();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    const el = document.getElementById("player");
    if (!el || !wantPlaying) return;
    if (!el.paused && !el.muted) {
      soundLatched = true;
      soundBlocked = false;
      return;
    }
    if (el.paused && !gestureFresh) {
      soundBlocked = true;
      soundLatched = false;
      el.muted = true;
      el.play().catch(() => {});
    }
  }, 150);
}

function playUnmuted(player = ytPlayer, { force = false } = {}) {
  if (!player) return false;
  if (!force) {
    if (!wantPlaying) return false;
    if (audioUnlocked && latestRoom?.playing === false) return false;
  }
  try {
    playElement(document.getElementById("player"));
    return true;
  } catch {
    return false;
  }
}

function pausePlayback() {
  wantPlaying = false;
  appliedPlaying = false;
  // Cancel scheduled play kicks from the last loadAndPlay / unlock
  loadGen += 1;
  showVeil();
  try {
    const el = document.getElementById("player");
    if (el && audioUnlocked) {
      el.muted = false;
      el.volume = 1;
    }
    ytPlayer?.unMute?.();
    ytPlayer?.pauseVideo?.();
  } catch {
    /* ignore */
  }
}

/** Cue a video without starting playback (paused remote state). */
function cueOnly(videoId) {
  ensureHtml5Player();
  if (!videoId || !ytPlayer) return false;
  prepareGen += 1;
  loadGen += 1;
  endingSent = false;
  appliedVideoId = videoId;
  appliedPlaying = false;
  wantPlaying = false;
  syncLayout(videoId);
  try {
    ytPlayer.cueVideoById?.(videoId, 0, "highres");
    return true;
  } catch {
    return false;
  }
}

/** Switch to a video and play it (use after audio is unlocked). */
function loadAndPlay(videoId) {
  ensureHtml5Player();
  if (!videoId || !ytPlayer) return false;
  // Cancel any pending preparePlayer cue — it was overwriting remote next/prev
  prepareGen += 1;
  const gen = ++loadGen;
  endingSent = false;
  appliedVideoId = videoId;
  appliedPlaying = true;
  wantPlaying = true;
  syncLayout(videoId);
  try {
    // Prefer string form — more reliable on TV WebViews than the object form
    if (typeof ytPlayer.loadVideoById === "function") {
      try {
        ytPlayer.loadVideoById(videoId, 0, "highres");
      } catch {
        ytPlayer.loadVideoById({ videoId, startSeconds: 0, suggestedQuality: "highres" });
      }
    } else {
      ytPlayer.cueVideoById?.(videoId, 0, "highres");
    }
    const kick = () => {
      if (gen !== loadGen) return;
      if (!wantPlaying) return;
      if (audioUnlocked && latestRoom?.playing === false) return;
      playUnmuted({ force: true });
    };
    kick();
    setTimeout(kick, 80);
    setTimeout(kick, 250);
    setTimeout(kick, 600);
    const retry = (ms) => {
      setTimeout(() => {
        if (gen !== loadGen || !ytPlayer) return;
        if (!wantPlaying) return;
        if (audioUnlocked && latestRoom?.playing === false) return;
        const liveId = livePlayerVideoId();
        if (liveId && liveId !== videoId) {
          try {
            ytPlayer.loadVideoById(videoId, 0, "highres");
          } catch {
            ytPlayer.loadVideoById?.({ videoId, startSeconds: 0, suggestedQuality: "highres" });
          }
          kick();
        } else {
          kick();
        }
      }, ms);
    };
    retry(400);
    retry(1200);
    retry(2500);
    return true;
  } catch {
    return false;
  }
}

function nextIdFromRoom(room) {
  if (!room?.queue?.length) return room?.current_id || null;
  return room.current_id || room.queue[room.index] || null;
}

async function handleVideoEnded() {
  if (soloMode) {
    advanceSoloQueue();
    return;
  }
  try {
    const room = await apiCmd(roomCode, "ended");
    latestRoom = room;
    lastRevision = room.revision;
    paired = !!room.paired;

    if (room.mode === "once" || !room.playing) {
      wantPlaying = false;
      appliedPlaying = false;
      return;
    }

    const nextId = nextIdFromRoom(room);
    if (nextId) loadAndPlay(nextId);
  } catch {
    enterSoloMode();
    advanceSoloQueue();
  }
}

function onYtStateChange(ev) {
  const S = window.YT.PlayerState;
  const state = ev.data;
  if (state === S.PLAYING) {
    endingSent = false;
    playerReady = true;
    clearTimeout(stuckWatch);
    finishUnlockChrome();
    if (wantPlaying) clearVeilNow();
    hideLoading();
    applySoundIfPlaying(ev.target || ytPlayer);
  } else if (state === S.BUFFERING) {
    if (audioUnlocked || unlocking) showLoading();
  } else if (state === S.CUED) {
    playerReady = true;
    // If we already want playback (e.g. after remote next), kick play
    if (audioUnlocked && wantPlaying && latestRoom?.playing !== false) {
      setTimeout(() => {
        if (wantPlaying && latestRoom?.playing !== false) playUnmuted();
      }, 50);
    }
    tryFinishArmedStart();
  } else if (state === S.PAUSED) {
    const el = document.getElementById("player");
    const intentionalPause = !wantPlaying || (audioUnlocked && latestRoom?.playing === false);
    if (intentionalPause) {
      if (el && audioUnlocked) {
        el.muted = false;
        el.volume = 1;
      }
      showVeil();
      return;
    }
    const unmutePaused =
      unmuteAttemptAt && Date.now() - unmuteAttemptAt < 700 && !gestureFresh;
    if (unmutePaused) {
      soundBlocked = true;
      soundLatched = false;
      if (el) el.muted = true;
    }
    if (wantPlaying && !(audioUnlocked && latestRoom?.playing === false)) {
      setTimeout(() => {
        if (!wantPlaying) return;
        if (audioUnlocked && latestRoom?.playing === false) return;
        const node = document.getElementById("player");
        if (!node || !node.paused) return;
        if (soundBlocked && !gestureFresh) node.muted = true;
        node.play().catch(() => {});
      }, 40);
    } else {
      showVeil();
    }
  } else if (state === S.ENDED && !endingSent) {
    endingSent = true;
    handleVideoEnded();
  }
}

/** Prepare / cue player before the OK press (no autoplay yet). */
async function preparePlayer(videoId) {
  if (!videoId) return;
  // After unlock / during start, only loadAndPlay may touch the player
  if (audioUnlocked || unlocking) return;
  const gen = ++prepareGen;
  if (!document.body.classList.contains("is-ready")) showVeil();
  syncLayout(videoId);
  ensureHtml5Player();
  if (gen !== prepareGen || audioUnlocked || !ytPlayer) return;
  if (appliedVideoId !== videoId) {
    ytPlayer.cueVideoById(videoId);
    if (gen === prepareGen && !audioUnlocked) appliedVideoId = videoId;
  }
  playerReady = true;
  tryFinishArmedStart();
}

async function apiCreate() {
  const res = await fetch(`/api/sync?_=${Date.now()}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    cache: "no-store",
    body: JSON.stringify({ action: "create", nonce: crypto.randomUUID?.() || String(Date.now()) }),
  });
  const data = await readApiJson(res);
  if (!data.ok) throw new Error(data.error || "create failed");
  return data.room;
}

function getTvId() {
  const key = "east-tv-device-id";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID?.() || `tv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `tv-${Date.now()}`;
  }
}

async function apiEnsure(code, { force = false } = {}) {
  const res = await fetch(`/api/sync?_=${Date.now()}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    cache: "no-store",
    body: JSON.stringify({
      action: "ensure",
      code,
      tv_id: getTvId(),
      force: !!force,
    }),
  });
  const data = await readApiJson(res).catch((e) => {
    if (e?.quota) throw e;
    return {};
  });
  if (!data.ok) {
    const err = new Error(data.error || "ensure failed");
    err.error = data.error;
    err.shop_name_zh = data.shop_name_zh;
    err.shop_name_en = data.shop_name_en;
    throw err;
  }
  return data.room;
}

async function apiGet(code, { wait = true } = {}) {
  const q = new URLSearchParams({
    code,
    role: "tv",
    since: String(Number.isFinite(lastRevision) ? lastRevision : -1),
    wait: wait ? "1" : "0",
    _: String(Date.now()),
  });
  const res = await fetch(`/api/sync?${q}`, {
    cache: "no-store",
  });
  const data = await readApiJson(res);
  if (!data.ok) throw new Error(data.error || "get failed");
  return data.room;
}

function codeFromQuery() {
  const q = new URLSearchParams(location.search).get("code") || "";
  return normalizeShopCode(q);
}

async function apiCmd(code, cmd, extra = {}) {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    cache: "no-store",
    body: JSON.stringify({ code, cmd, ...extra }),
  });
  const data = await readApiJson(res);
  if (!data.ok) throw new Error(data.error || "cmd failed");
  return data.room;
}

function isPhoneScreen() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function fitTvQr(el) {
  if (!el) return;
  if (isPhoneScreen()) {
    el.style.width = "";
    el.style.height = "";
    return;
  }
  const screen = el.closest(".tv__start-screen, .tv__ready");
  const boundsEl = overlay;
  if (!screen || !boundsEl) return;

  const shown = (node) => node && !node.hidden && getComputedStyle(node).display !== "none";
  const padY = (node) => {
    const cs = getComputedStyle(node);
    return (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  };
  const gapY = (node) => {
    const cs = getComputedStyle(node);
    return parseFloat(cs.rowGap || cs.gap) || 0;
  };

  const screenKids = [...screen.children].filter(shown);
  let outside = padY(screen) + gapY(screen) * Math.max(0, screenKids.length - 1);
  for (const child of screenKids) {
    if (child.contains(el)) continue;
    outside += child.getBoundingClientRect().height;
  }

  const body = el.closest(".tv__start-body");
  let inside = 0;
  if (body && screen.contains(body)) inside += padY(body);

  const col = el.closest(".tv__start-qr");
  const screenCs = getComputedStyle(screen);
  let maxW =
    screen.clientWidth -
    (parseFloat(screenCs.paddingLeft) || 0) -
    (parseFloat(screenCs.paddingRight) || 0) -
    8;
  if (col) {
    const colKids = [...col.children].filter(shown);
    inside += padY(col) + gapY(col) * Math.max(0, colKids.length - 1);
    for (const child of colKids) {
      if (child === el || child.contains(el)) continue;
      inside += child.getBoundingClientRect().height;
    }
    const colCs = getComputedStyle(col);
    const padX = (parseFloat(colCs.paddingLeft) || 0) + (parseFloat(colCs.paddingRight) || 0);
    const join = screen.querySelector(".tv__start-join");
    const joinShown = join && shown(join);
    if (joinShown) maxW = col.clientWidth - padX - 4;
    else maxW -= padX;
  }

  const boundsCs = getComputedStyle(boundsEl);
  const boundsPad =
    (parseFloat(boundsCs.paddingTop) || 0) + (parseFloat(boundsCs.paddingBottom) || 0);
  const maxH = boundsEl.clientHeight - boundsPad - outside - inside - 12;
  const size = Math.floor(Math.min(maxW, maxH));
  if (!Number.isFinite(size) || size < 72) return;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
}

function applyQrFit() {
  if (!document.body.classList.contains("is-pairing")) return;
  if (qrBig && pairHub && !pairHub.hidden) fitTvQr(qrBig);
}

window.addEventListener("resize", applyQrFit);
document.fonts?.ready?.then(() => applyQrFit()).catch(() => {});
if (overlay && typeof ResizeObserver === "function") {
  new ResizeObserver(() => applyQrFit()).observe(overlay);
}

function renderQr(el, url) {
  fitTvQr(el);
  el.innerHTML = "";
  const size = Math.max(96, Math.round(el.clientWidth || el.clientHeight || 240));
  // Local qrcode-generator (global `qrcode`) — no CDN wait
  if (typeof qrcode === "function") {
    try {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      const cell = Math.max(4, Math.floor(size / (qr.getModuleCount() + 2)));
      el.innerHTML = qr.createSvgTag(cell, 1);
      const svg = el.querySelector("svg");
      if (svg) {
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.style.display = "block";
      }
      return;
    } catch {
      /* fall through */
    }
  }
  // Offline fallback: big room code only (never block on remote QR API)
  const tip = document.createElement("p");
  tip.className = "tv__qr-fallback";
  tip.textContent = "請用房號進入";
  el.appendChild(tip);
}

function showHubPage() {
  if (pairHub) pairHub.hidden = false;
  if (pairReady) pairReady.hidden = true;
  document.body.classList.add("is-pairing");
  document.body.classList.remove("is-ready");
}

function showReadyPage(room = latestRoom) {
  overlay.classList.remove("is-hidden");
  if (pairHub) pairHub.hidden = true;
  if (pairReady) pairReady.hidden = false;
  document.body.classList.add("is-playing", "is-ready");
  document.body.classList.remove("is-pairing");
  const code = roomCode || room?.code || "";
  const videoId = room?.current_id || latestRoom?.current_id;
  paintShopName(code);
  if (readyPhones) {
    readyPhones.textContent = soloMode ? "手機遙控暫時不能用" : "手機已入房";
  }
  if (readyHint) {
    readyHint.textContent = soloMode
      ? "按遙控一次，片照播"
      : "畫面與聲音一起播放";
  }
  const kicker = document.querySelector(".tv__ready-kicker");
  if (kicker) kicker.textContent = soloMode ? "連線額滿" : "手機已入房";
  clearRailCopy();
  if (videoId) syncLayout(videoId);
  if (pairReady) {
    pairReady.tabIndex = 0;
    try {
      pairReady.focus({ preventScroll: true });
    } catch {
      pairReady.focus?.();
    }
  }
  clearVeilNow();
  setStatus(`房號 ${roomCode} — 按遙控一次播放`);
  preparePlayer(videoId).catch(() => {});
}

function showPairOnly() {
  setPlayingChrome(false);
  overlay.classList.remove("is-hidden");
  showHubPage();
  const phones = Number(latestRoom?.phone_count || 0);
  pairHint.textContent = "店內廣告播放 · 掃碼後按遙控一次";
  qrBig.style.display = "";
  roomCodeEl.style.display = "";
  applyStoreTvMode();
  const enterHint = document.getElementById("enterHint");
  if (enterHint) enterHint.hidden = document.body.classList.contains("is-tv-app");
  if (pairCta) pairCta.hidden = false;
  if (remoteHint) {
    remoteHint.hidden = false;
    remoteHint.textContent =
      phones > 0 ? "手機已入房 — 按遙控一次播放" : "掃碼後按遙控一次，畫面與聲音一起播放";
  }
  showVeil();
  applyQrFit();
}

function syncReconnectChip(room) {
  if (!reconnectChip || !reconnectCode) return;
  const need =
    audioUnlocked &&
    !!room?.tv_ready &&
    !room?.closed &&
    Number(room?.phone_count || 0) === 0;
  reconnectCode.textContent = roomCode || room?.code || "····";
  reconnectChip.hidden = !need;
  if (need && reconnectChip.querySelector("span")) {
    reconnectChip.querySelector("span").textContent = "斷線";
  }
}

function resetSessionToStart() {
  audioUnlocked = false;
  gestureArmed = false;
  unlocking = false;
  soundLatched = false;
  soundBlocked = false;
  unmuteAttemptAt = 0;
  wasPaired = false;
  paired = false;
  wantPlaying = false;
  appliedPlaying = false;
  endingSent = false;
  if (reconnectChip) reconnectChip.hidden = true;
  try {
    ytPlayer?.pauseVideo?.();
  } catch {
    /* ignore */
  }
  syncRotation(0);
  showVeil();
  showPairOnly();
  setStatus(`房號 ${roomCode} — 開始播放`);
}

function isTypingTarget(el = document.activeElement) {
  if (!el || el === document.body) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return !!el.closest?.("input, textarea, select, [contenteditable='true'], #joinForm, .tv__start-join");
}

function hideOverlay() {
  overlay.classList.add("is-hidden");
  if (remoteHint) remoteHint.hidden = true;
  if (pairReady) pairReady.hidden = true;
  if (pairHub) pairHub.hidden = true;
  document.body.classList.remove("is-ready");
  setPlayingChrome(true);
}

function markTvReady() {
  if (latestRoom) latestRoom = { ...latestRoom, tv_ready: true, playing: true };
  if (soloMode) {
    tvReadySent = true;
    return;
  }
  if (tvReadySent) return;
  tvReadySent = true;
  apiCmd(roomCode, "tvReady")
    .then((room) => {
      // Never roll back past a newer remote next/prev
      if (Number(room.revision) >= Number(lastRevision)) {
        latestRoom = room;
        lastRevision = room.revision;
        applyRoom(room);
      } else if (latestRoom) {
        latestRoom = { ...latestRoom, tv_ready: true, playing: true };
      }
      syncReconnectChip(latestRoom || room);
    })
    .catch(() => {
      tvReadySent = false;
      enterSoloMode();
    });
}

function finishUnlockChrome() {
  if (audioUnlocked) {
    hideOverlay();
    if (wantPlaying) clearVeilNow();
    return;
  }
  if (!gestureArmed && !unlocking) return;
  audioUnlocked = true;
  unlocking = false;
  wantPlaying = true;
  appliedPlaying = true;
  hideOverlay();
  enterFullscreenSync();
  clearVeilNow();
  setStatus(`房號 ${roomCode} — 播放中 · 可掃碼遙控`);
}

function startStuckWatch(videoId) {
  clearTimeout(stuckWatch);
  let n = 0;
  const tick = () => {
    let st = null;
    try {
      st = ytPlayer?.getPlayerState?.();
    } catch {
      st = null;
    }
    if (st === 1) return;
    playUnmuted({ force: true });
    n += 1;
    if (n < 24) stuckWatch = setTimeout(tick, 400);
  };
  stuckWatch = setTimeout(tick, 200);
  if (videoId) void videoId;
}

function tryFinishArmedStart() {
  if (audioUnlocked || !gestureArmed) return false;
  const id = latestRoom?.current_id || appliedVideoId;
  if (!id || !playerReady || !ytPlayer) return false;

  unlocking = true;
  wantPlaying = true;
  appliedPlaying = true;
  markTvReady();
  showLoading();
  hideOverlay();
  if (appliedVideoId !== id) {
    loadAndPlay(id);
  } else {
    playUnmuted({ force: true });
    setTimeout(() => playUnmuted({ force: true }), 200);
    setTimeout(() => playUnmuted({ force: true }), 600);
  }
  startStuckWatch(id);
  try {
    if (ytPlayer.getPlayerState?.() === 1) finishUnlockChrome();
  } catch {
    /* wait for PLAYING */
  }
  return true;
}

/**
 * ONE tap on the connection/QR page arms unlock.
 * If player is ready → start now. If not → auto-start when ready (no second tap).
 */
function startUnmutedFromGesture() {
  if (audioUnlocked) {
    markGestureFresh();
    playUnmuted({ force: true });
    applySoundIfPlaying();
    return;
  }
  // Room not ready yet (e.g. shop lock screen) — ignore dead start button
  if (!latestRoom?.current_id && !roomCode) {
    setStatus("房間未就緒，請稍等或強制接管");
    return;
  }

  gestureArmed = true;
  unlocking = true;
  markGestureFresh();
  // Play first. requestFullscreen consumes the TV user gesture and leaves
  // YouTube on the red play button.
  const id = latestRoom?.current_id || appliedVideoId;
  if (id && ytPlayer) playUnmuted({ force: true });
  showLoading();
  hideOverlay();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      ctx.resume?.();
    }
  } catch {
    /* ignore */
  }
  if (id && playerReady && ytPlayer) {
    tryFinishArmedStart();
    return;
  }

  const who = shopLabel(roomCode) || `房號 ${roomCode}`;
  setStatus(`${who} — 啟動播放中…`);
  if (paired || (pairReady && !pairReady.hidden)) showReadyPage(latestRoom);
  else showPairOnly();

  const vid = latestRoom?.current_id || appliedVideoId;
  ensureHtml5Player();
  preparePlayer(vid)
    .then(() => {
      tryFinishArmedStart();
    })
    .catch((e) => {
      setStatus(`播放器載入失敗，再撳一次（${e?.message || e}）`);
      gestureArmed = false;
    });
}

function updatePairPhoneHint(room) {
  const phones = Number(room?.phone_count || 0);
  if (!pairHint || audioUnlocked) return;
  if (gestureArmed) {
    pairHint.textContent =
      phones > 0
        ? `已準備 · 手機 ${phones} 部已入房`
        : "已準備 · 等手機掃碼／入房";
  } else if (phones > 0) {
    pairHint.textContent = `手機已入房（${phones}）· 按遙控一次`;
    if (remoteHint) {
      remoteHint.hidden = false;
      remoteHint.textContent = "手機已入房 — 按遙控一次播放";
    }
  }
}

function applyRoom(room) {
  if (!room) return;
  // Ignore stale poll responses (can race with faster tvReady / ended POSTs)
  if (latestRoom && Number(room.revision) < Number(lastRevision) && audioUnlocked) {
    return;
  }
  latestRoom = room;
  paired = !!room.paired;
  if (Number(room.phone_count || 0) > 0) {
    lastPhoneAt = Date.now();
    if (listenMode !== "live") listenMode = "live";
  }
  syncRotation(room.rotation);
  syncReconnectChip(room);
  syncLiveQr(room);

  if (!audioUnlocked && !unlocking) {
    if (!paired) {
      showPairOnly();
    } else if (!wasPaired || pairReady?.hidden) {
      showReadyPage(room);
    }
    wasPaired = paired;
  } else if (unlocking && !audioUnlocked) {
    wasPaired = paired;
    if (room.current_id && room.current_id !== appliedVideoId && ytPlayer) {
      loadAndPlay(room.current_id);
    }
    if (gestureArmed) tryFinishArmedStart();
  } else {
    hideOverlay();
    wasPaired = paired;
    if (!room.tv_ready) markTvReady();
  }

  const revChanged = room.revision !== lastRevision;
  if (revChanged) lastRevision = room.revision;

  if (room.current_id) syncLayout(room.current_id);

  if (!audioUnlocked) {
    if (
      !unlocking &&
      paired &&
      room.current_id &&
      (revChanged || room.current_id !== appliedVideoId)
    ) {
      preparePlayer(room.current_id).catch(() => {});
    }
    return;
  }

  if (!room.tv_ready) {
    wantPlaying = true;
    markTvReady();
  } else {
    wantPlaying = !!room.playing;
  }
  if (!wantPlaying) showVeil();
  else clearVeilNow();

  const liveId = livePlayerVideoId();
  // Trust live YouTube id — appliedVideoId alone got stuck when load was ignored
  const outOfSync = !!(room.current_id && liveId && liveId !== room.current_id);
  const needLoad =
    !!room.current_id && (room.current_id !== appliedVideoId || outOfSync);
  const playChanged = !!room.playing !== !!appliedPlaying;

  if (needLoad) {
    const now = Date.now();
    // Throttle forced resync storms, but always allow revision-driven switches
    if (!revChanged && outOfSync && now - lastForceLoadAt < 400) {
      /* wait */
    } else {
      lastForceLoadAt = now;
      endingSent = false;
      if (wantPlaying) {
        loadAndPlay(room.current_id);
      } else {
        cueOnly(room.current_id);
      }
    }
    return;
  }

  if (playChanged && ytPlayer) {
    appliedPlaying = !!room.playing;
    try {
      if (room.playing) {
        wantPlaying = true;
        playUnmuted();
        setTimeout(() => {
          if (wantPlaying && latestRoom?.playing) playUnmuted();
        }, 120);
      } else {
        pausePlayback();
      }
    } catch {
      /* ignore */
    }
  }
}

function nextPollDelay(ok, elapsed, moved) {
  if (!ok) {
    emptyInstantStreak = 0;
    return 8000;
  }
  if (moved || elapsed >= 400) {
    emptyInstantStreak = 0;
    return 200;
  }
  emptyInstantStreak += 1;
  return emptyInstantStreak >= 2 ? 3000 : 200;
}

async function poll() {
  if (!roomCode || pollInFlight) return { ok: true, delay: 400 };
  const epoch = ++pollEpoch;
  pollInFlight = true;
  const sinceSent = Number.isFinite(lastRevision) ? lastRevision : -1;
  const started = Date.now();
  try {
    const room = await apiGet(roomCode, { wait: listenMode === "live" });
    const elapsed = Date.now() - started;
    if (epoch !== pollEpoch) return { ok: true, delay: 200 };
    if (room.closed) {
      setStatus("房間已關閉，請重新整理 TV 頁");
      syncReconnectChip(room);
      return { ok: false, delay: 8000 };
    }
    apiFailStreak = 0;
    applyRoom(room);
    if (!audioUnlocked) {
      if (gestureArmed) tryFinishArmedStart();
      if (unlocking) {
        nudgePlaybackIfStuck(room);
        setStatus(`房號 ${room.code} — 載入中`);
      } else {
        setStatus(
          room.paired
            ? `房號 ${room.code} — 手機已入房`
            : `房號 ${room.code} — 載入中`,
          room.paired
        );
      }
    } else if (!room.tv_ready) {
      setStatus(`房號 ${room.code} — 播放中 · 可掃碼`);
    } else {
      nudgePlaybackIfStuck(room);
    }
    return {
      ok: true,
      delay: nextPollDelay(true, elapsed, room.revision !== sinceSent),
    };
  } catch {
    apiFailStreak += 1;
    if (apiFailStreak >= 2) {
      const playing = audioUnlocked;
      enterSoloMode();
      if (playing) return { ok: true, delay: 8000 };
    }
    if (epoch === pollEpoch) setStatus("連線異常，重試中…");
    return { ok: false, delay: 8000 };
  } finally {
    if (epoch === pollEpoch) pollInFlight = false;
  }
}

function startPollLoop() {
  if (soloMode || listenMode === "off") return;
  const tick = () => {
    if (soloMode || listenMode === "off") return;
    poll().then((result) => {
      if (soloMode || listenMode === "off") return;
      let delay = Number(result?.delay);
      if (!Number.isFinite(delay)) delay = 8000;
      if (listenMode === "slow") delay = Math.max(delay, 90000);
      setTimeout(tick, delay);
    });
  };
  tick();
}

function nudgePlaybackIfStuck(room) {
  if ((!audioUnlocked && !unlocking) || !ytPlayer || !playerReady) return;
  const now = Date.now();
  const liveId = livePlayerVideoId();
  if (room?.current_id && liveId && liveId !== room.current_id) {
    if (now - lastForceLoadAt < 500) return;
    lastForceLoadAt = now;
    loadAndPlay(room.current_id);
    return;
  }
  if (!room?.playing) return;
  if (now - lastPlayNudgeAt < 1000) return;
  try {
    const st = ytPlayer.getPlayerState?.();
    // -1 unstarted, 0 ended, 2 paused, 5 cued — TV often sticks on the red play button
    if (st === -1 || st === 0 || st === 2 || st === 5) {
      lastPlayNudgeAt = now;
      playUnmuted({ force: true });
    }
  } catch {
    /* ignore */
  }
}

overlay?.addEventListener("click", (e) => {
  if (audioUnlocked) return;
  if (!paired) return;
  if (e.target?.closest?.("#joinForm, #codeInput, .tv__shop-temp")) return;
  if (isTypingTarget(e.target)) return;
  e.preventDefault();
  startUnmutedFromGesture();
});

function isConfirmKey(e) {
  const k = e.key;
  const c = e.keyCode || e.which;
  return (
    k === "Enter" ||
    k === " " ||
    k === "Spacebar" ||
    k === "MediaPlayPause" ||
    k === "MediaPlay" ||
    c === 13 ||
    c === 32 ||
    c === 179 ||
    c === 415 ||
    c === 23 ||
    c === 66
  );
}

document.addEventListener(
  "keydown",
  (e) => {
    if (isTypingTarget(e.target)) return;
    if (audioUnlocked || unlocking) {
      if (!isConfirmKey(e)) return;
      e.preventDefault();
      markGestureFresh();
      playUnmuted({ force: true });
      applySoundIfPlaying();
      return;
    }
    // Don't hijack keys while typing the room code
    const readyVisible = pairReady && !pairReady.hidden;
    if (!readyVisible) return;
    if (!isConfirmKey(e)) return;
    e.preventDefault();
    startUnmutedFromGesture();
  },
  true
);

shield?.addEventListener("click", () => {
  if (audioUnlocked || unlocking) {
    markGestureFresh();
    playUnmuted({ force: true });
    applySoundIfPlaying();
  }
  if (audioUnlocked && !isFullscreen()) enterFullscreenSync();
});

// Phone enter-room box on the same connection page
document.getElementById("joinForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const input = document.getElementById("codeInput");
  const code = String(input?.value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (!code) return;
  location.href = "/remote.html?c=" + encodeURIComponent(code);
});

const codeInputEl = document.getElementById("codeInput");

codeInputEl?.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
});
codeInputEl?.addEventListener("click", (e) => {
  e.stopPropagation();
  // Ensure keyboard can open even if something else held focus
  try {
    codeInputEl.focus({ preventScroll: false });
  } catch {
    codeInputEl.focus?.();
  }
});

codeInputEl?.addEventListener("input", (e) => {
  const input = e.target;
  const raw = String(input.value || "");
  const next = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (next === raw) return;
  const start = input.selectionStart;
  input.value = next;
  // Avoid selection hacks on mobile IME — can dismiss the keyboard
  if (window.matchMedia("(pointer: coarse)").matches) return;
  try {
    input.setSelectionRange(start, start);
  } catch {
    /* ignore */
  }
});

async function bootRoom(room) {
  roomCode = room.code;
  paintShopName(roomCode);
  const label = shopLabel(roomCode);
  roomCodeEl.textContent = label || roomCode;
  latestRoom = room;
  lastRevision = room.revision;
  unlocking = false;
  wantPlaying = false;
  if (pairCta) pairCta.hidden = false;
  renderQr(qrBig, remoteUrl(roomCode));
  applyRoom(room);
  const who = label || `房號 ${roomCode}`;
  if (room.paired && !audioUnlocked) {
    showReadyPage(room);
  } else {
    showPairOnly();
    setStatus(`${who} — 掃碼後按遙控一次`);
  }
  lastPhoneAt = Date.now();
  listenMode = "live";
  startQuietWatch();
  startPollLoop();
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    tvCloseBeacon();
  });
  window.addEventListener("beforeunload", tvCloseBeacon);
  ensureHtml5Player();
  preparePlayer(room.current_id).catch(() => {});
}

function paintKnownShopChrome(code) {
  const shop = shopByCode(code);
  if (!shop) return false;
  roomCode = shop.code;
  paintShopName(shop.code);
  const label = shopLabel(shop.code);
  if (roomCodeEl) roomCodeEl.textContent = label || shop.code;
  renderQr(qrBig, remoteUrl(shop.code));
  setStatus(`${label || shop.code} — 連線中…`);
  ensureHtml5Player();
  return true;
}

function showShopInUse(err, code) {
  const name = err.shop_name_zh || shopByCode(code)?.nameZh || "呢間舖";
  paintShopName(code);
  setStatus(`${name} 而家已有另一部電視用緊`);
  roomCodeEl.textContent = name;
  if (pairHint) {
    pairHint.textContent = "兩間舖唔好共用頻道。若確認係本書電視，撳下面強制接管。";
  }
  if (pairCta) pairCta.hidden = true;
  if (remoteHint) {
    remoteHint.hidden = false;
    remoteHint.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--primary";
    btn.textContent = "強制接管（會踢走另一部 TV）";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const room = await apiEnsure(code, { force: true });
        if (pairCta) pairCta.hidden = false;
        await bootRoom(room);
      } catch (e) {
        setStatus("接管失敗：" + (e.message || e));
        btn.disabled = false;
      }
    });
    remoteHint.appendChild(btn);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const err = new Error("quota");
      err.quota = true;
      setTimeout(() => reject(err), ms);
    }),
  ]);
}

async function boot() {
  document.body.classList.add("is-pairing");
  audioUnlocked = false;
  gestureArmed = false;
  unlocking = false;
  soundLatched = false;
  soundBlocked = false;
  unmuteAttemptAt = 0;
  wasPaired = false;
  paired = false;
  appliedVideoId = null;
  playerReady = false;
  tvReadySent = false;
  loadGen = 0;
  prepareGen = 0;
  showVeil();
  setStatus("開房中…");
  try {
    const reuse = codeFromQuery();
    // Fixed shop: QR URL is known instantly — paint before waiting on API
    if (reuse && shopByCode(reuse)) {
      paintKnownShopChrome(reuse);
    }

    let room;
    if (reuse && shopByCode(reuse)) {
      try {
        room = await withTimeout(apiEnsure(reuse), 4000);
      } catch (e) {
        if (e.error === "shop_in_use" || e.message === "shop_in_use") {
          showShopInUse(e, reuse);
          return;
        }
        throw e;
      }
    } else if (reuse) {
      room = await withTimeout(apiGet(reuse), 4000);
      if (room.closed) throw new Error("房間已關閉，請重新整理再開");
    } else {
      // Bare homepage = temporary room only (avoids two shops sharing a fixed channel)
      room = await withTimeout(apiCreate(), 4000);
    }
    await bootRoom(room);
  } catch {
    const room = enterSoloMode();
    await bootRoom(room);
  }
}
function tvCloseBeacon() {
  if (!roomCode || soloMode) return;
  const body = JSON.stringify({ code: roomCode, cmd: "tvClose" });
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

// Always new room on real load / reload (avoid bfcache sticking old room)
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

boot();
