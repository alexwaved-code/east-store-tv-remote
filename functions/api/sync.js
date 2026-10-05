import { idsFor, shuffleIds } from "../_shared/ads.js";
import { FIXED_SHOPS, isFixedShopCode, shopByCode } from "../_shared/shops.js";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** Closed temp rooms are deleted after this */
const CLOSED_ROOM_TTL_MS = 10 * 60 * 1000;
/** No TV heartbeat / pairing never started — leftover rooms */
const DEAD_ROOM_MS = 60 * 60 * 1000;
const PHONE_TTL_MS = 28000;
const TV_TTL_MS = 35000;
/** Another TV counts as "still online" within this window */
const TV_OWNER_LOCK_MS = 25000;
const MODES = new Set(["loop", "shuffle", "once", "loop_one"]);
/** In-memory prune throttle — avoids D1 write on every TV poll */
const lastPruneAt = new Map();
let lastCleanupAt = 0;
const CLEANUP_EVERY_MS = 30000;
const WAIT_MS = 15000;
const WAIT_TICK_MS = 400;
const lastWaitReturnAt = new Map();
const MIN_WAIT_GAP_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFixedShop(code) {
  return isFixedShopCode(code) || !!shopByCode(code);
}

function resolveCode(raw) {
  const shop = shopByCode(raw);
  if (shop) return shop.code;
  return normalizeCode(raw);
}

function shopMeta(code) {
  const shop = FIXED_SHOPS[resolveCode(code)] || shopByCode(code);
  if (!shop) return null;
  return {
    shop_code: shop.code,
    shop_name_zh: shop.nameZh,
    shop_name_en: shop.nameEn,
    shop_path: shop.path,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function normalizeCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function makeCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return out;
}

function parseQueue(raw) {
  try {
    const q = JSON.parse(raw || "[]");
    return Array.isArray(q) ? q.map(String) : [];
  } catch {
    return [];
  }
}

function parsePhones(raw) {
  try {
    const o = JSON.parse(raw || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function rowToState(row) {
  if (!row) return null;
  const queue = parseQueue(row.queue);
  const idx = Math.max(0, Number(row.idx) || 0);
  let rot = Number(row.rotation) || 0;
  if (rot === -90) rot = 270;
  if (rot !== 90 && rot !== 270) rot = 0;
  const phones = parsePhones(row.phones_json);
  const now = Date.now();
  let live = 0;
  for (const ts of Object.values(phones)) {
    if (now - Number(ts) <= PHONE_TTL_MS) live += 1;
  }
  return {
    code: row.code,
    lang: row.lang === "en" ? "en" : "zh",
    mode: MODES.has(row.mode) ? row.mode : "loop",
    queue,
    index: idx,
    playing: !!row.playing,
    current_id: row.current_id || queue[idx] || null,
    // Live phones only — so reconnect after reopen can re-trigger TV ready page
    paired: live > 0,
    tv_ready: !!row.tv_ready,
    rotation: rot,
    phones_json: JSON.stringify(phones),
    phone_count: live,
    closed: !!row.closed,
    // Keep 0 as 0 — means "no TV player yet" (do not fall back to updated_at)
    tv_seen_at: row.tv_seen_at == null || row.tv_seen_at === "" ? 0 : Number(row.tv_seen_at),
    tv_owner: String(row.tv_owner || ""),
    revision: Number(row.revision) || 0,
    updated_at: Number(row.updated_at) || 0,
    ...shopMeta(row.code),
  };
}

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        lang TEXT NOT NULL DEFAULT 'zh',
        mode TEXT NOT NULL DEFAULT 'loop',
        queue TEXT NOT NULL DEFAULT '[]',
        idx INTEGER NOT NULL DEFAULT 0,
        playing INTEGER NOT NULL DEFAULT 0,
        current_id TEXT,
        paired INTEGER NOT NULL DEFAULT 0,
        tv_ready INTEGER NOT NULL DEFAULT 0,
        rotation INTEGER NOT NULL DEFAULT 0,
        phones_json TEXT NOT NULL DEFAULT '{}',
        closed INTEGER NOT NULL DEFAULT 0,
        tv_seen_at INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0
      )`
    )
    .run();
  for (const sql of [
    "ALTER TABLE rooms ADD COLUMN tv_ready INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE rooms ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE rooms ADD COLUMN phones_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE rooms ADD COLUMN closed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE rooms ADD COLUMN tv_seen_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE rooms ADD COLUMN tv_owner TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  schemaReady = true;
}

function closeTv(state) {
  state.playing = false;
  state.tv_ready = false;
  state.paired = false;
  state.phones_json = "{}";
  state.phone_count = 0;
  state.tv_seen_at = 0;
  state.tv_owner = "";
  state.revision += 1;
  state.closed = true;
  return state;
}

function touchTv(state) {
  state.tv_seen_at = Date.now();
  return state;
}

function pruneTv(state) {
  if (state.closed) return state;
  const seen = Number(state.tv_seen_at) || 0;
  if (seen && Date.now() - seen > TV_TTL_MS) {
    return closeTv(state);
  }
  return state;
}

function pauseForNoPhones(state) {
  // Only used after explicit「離開房間」when no phones remain
  if (state.playing) {
    state.playing = false;
    state.revision += 1;
  }
  return state;
}

function shuffleOnDisconnect(state) {
  // Last phone dropped (tab close / timeout) — keep playing in shuffle
  if (state.closed || !state.tv_ready) return state;
  const current = state.current_id;
  state.mode = "shuffle";
  state.queue = buildQueue(state.lang, "shuffle", current);
  if (current && state.queue.includes(current)) {
    state.index = state.queue.indexOf(current);
  } else {
    state.index = 0;
  }
  syncCurrent(state);
  state.playing = true;
  state.revision += 1;
  return state;
}

function prunePhones(state) {
  const phones = parsePhones(state.phones_json);
  const now = Date.now();
  let removed = false;
  for (const [id, ts] of Object.entries(phones)) {
    if (now - Number(ts) > PHONE_TTL_MS) {
      delete phones[id];
      removed = true;
    }
  }
  state.phones_json = JSON.stringify(phones);
  state.phone_count = Object.keys(phones).length;
  if (!removed) return state;
  state.revision += 1;
  if (state.phone_count === 0) return shuffleOnDisconnect(state);
  return state;
}

function touchPhone(state, clientId) {
  const id = String(clientId || "").slice(0, 80);
  if (!id) return state;
  const phones = parsePhones(state.phones_json);
  const now = Date.now();
  for (const [pid, ts] of Object.entries(phones)) {
    if (now - Number(ts) > PHONE_TTL_MS) delete phones[pid];
  }
  phones[id] = now;
  state.phones_json = JSON.stringify(phones);
  state.phone_count = Object.keys(phones).length;
  return state;
}

function dropPhone(state, clientId, { pauseIfEmpty = false } = {}) {
  const id = String(clientId || "").slice(0, 80);
  if (!id) return state;
  const phones = parsePhones(state.phones_json);
  if (!(id in phones)) return state;
  delete phones[id];
  state.phones_json = JSON.stringify(phones);
  state.phone_count = Object.keys(phones).length;
  state.revision += 1;
  if (state.phone_count > 0) return state;
  // Last phone: leave → pause; disconnect/gone → shuffle + keep playing
  if (pauseIfEmpty) return pauseForNoPhones(state);
  return shuffleOnDisconnect(state);
}

async function getRoom(db, code) {
  await ensureSchema(db);
  const row = await db.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first();
  return rowToState(row);
}

async function saveRoom(db, state) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO rooms (code, updated_at, lang, mode, queue, idx, playing, current_id, paired, tv_ready, rotation, phones_json, closed, tv_seen_at, tv_owner, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         updated_at = excluded.updated_at,
         lang = excluded.lang,
         mode = excluded.mode,
         queue = excluded.queue,
         idx = excluded.idx,
         playing = excluded.playing,
         current_id = excluded.current_id,
         paired = excluded.paired,
         tv_ready = excluded.tv_ready,
         rotation = excluded.rotation,
         phones_json = excluded.phones_json,
         closed = excluded.closed,
         tv_seen_at = excluded.tv_seen_at,
         tv_owner = excluded.tv_owner,
         revision = excluded.revision`
    )
    .bind(
      state.code,
      now,
      state.lang,
      state.mode,
      JSON.stringify(state.queue || []),
      state.index || 0,
      state.playing ? 1 : 0,
      state.current_id || null,
      state.paired ? 1 : 0,
      state.tv_ready ? 1 : 0,
      state.rotation === 90 || state.rotation === 270 ? state.rotation : 0,
      state.phones_json || "{}",
      state.closed ? 1 : 0,
      // Preserve 0 (= no TV yet). Do NOT coerce 0 → Date.now().
      Number(state.tv_seen_at) || 0,
      String(state.tv_owner || ""),
      state.revision || 0
    )
    .run();
  state.updated_at = now;
  return state;
}

function buildQueue(lang, mode, currentId) {
  if (mode === "loop_one") {
    const id = currentId || idsFor(lang)[0];
    return id ? [id] : [];
  }
  const ids = idsFor(lang);
  return mode === "shuffle" ? shuffleIds(ids) : ids;
}

function syncCurrent(state) {
  if (!state.queue.length) {
    state.queue = buildQueue(state.lang, state.mode, state.current_id);
    state.index = 0;
  }
  if (state.index < 0) state.index = 0;
  if (state.index >= state.queue.length) state.index = state.index % state.queue.length;
  state.current_id = state.queue[state.index] || null;
  return state;
}

function advance(state, delta) {
  if (state.mode === "loop_one") return syncCurrent(state);
  const n = state.queue.length;
  if (!n) return syncCurrent(state);
  state.index = (state.index + delta + n * 100) % n;
  return syncCurrent(state);
}

function blankRoomState(code) {
  const queue = buildQueue("zh", "loop");
  return {
    code,
    lang: "zh",
    mode: "loop",
    queue,
    index: 0,
    playing: false,
    current_id: queue[0] || null,
    paired: false,
    tv_ready: false,
    rotation: 0,
    phones_json: "{}",
    phone_count: 0,
    closed: false,
    // 0 = waiting for a real TV player; do not prune until TV heartbeats
    tv_seen_at: 0,
    tv_owner: "",
    revision: 1,
    ...shopMeta(code),
  };
}

async function createRoom(db) {
  await ensureSchema(db);
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = makeCode();
    if (isFixedShop(code)) continue;
    const existing = await getRoom(db, code);
    if (existing) continue;
    const state = blankRoomState(code);
    await saveRoom(db, state);
    return state;
  }
  throw new Error("could not allocate room code");
}

/**
 * Create or revive a permanent shop room.
 * Optional tvId lock: another live TV on the same shop is rejected unless force.
 */
async function ensureFixedRoom(db, code, { tvId = "", force = false } = {}) {
  const shop = shopByCode(code);
  if (!shop) throw new Error("not a fixed shop code");
  const normalized = shop.code;
  await ensureSchema(db);
  let state = await getRoom(db, normalized);
  if (!state) {
    state = blankRoomState(normalized);
    if (tvId) {
      state.tv_owner = tvId;
      state.tv_seen_at = Date.now();
    }
    await saveRoom(db, state);
    return state;
  }
  if (state.closed) {
    state.closed = false;
    state.playing = false;
    state.tv_ready = false;
    state.paired = false;
    state.phones_json = "{}";
    state.phone_count = 0;
    state.tv_seen_at = 0;
    state.tv_owner = "";
    state.revision += 1;
  }

  const owner = String(state.tv_owner || "");
  const seen = Number(state.tv_seen_at) || 0;
  const liveOther =
    tvId &&
    owner &&
    owner !== tvId &&
    seen > 0 &&
    Date.now() - seen < TV_OWNER_LOCK_MS;

  if (liveOther && !force) {
    const err = new Error("shop_in_use");
    err.error = "shop_in_use";
    err.shop_name_zh = shop.nameZh;
    err.shop_name_en = shop.nameEn;
    err.room = state;
    throw err;
  }

  if (tvId) {
    state.tv_owner = tvId;
    state.tv_seen_at = Date.now();
    state.revision += 1;
  }
  await saveRoom(db, state);
  return state;
}

async function deleteRoom(db, code) {
  const id = normalizeCode(code);
  if (!id || isFixedShop(id)) return;
  await db.prepare("DELETE FROM rooms WHERE code = ?").bind(id).run();
}

async function cleanupOld(db) {
  const now = Date.now();
  const closedCutoff = now - CLOSED_ROOM_TTL_MS;
  const deadCutoff = now - DEAD_ROOM_MS;
  try {
    await db
      .prepare(
        `DELETE FROM rooms
         WHERE closed = 1
           AND updated_at < ?`
      )
      .bind(closedCutoff)
      .run();
    await db
      .prepare(
        `DELETE FROM rooms
         WHERE (tv_seen_at = 0 AND updated_at < ?)
            OR (tv_seen_at > 0 AND tv_seen_at < ?)`
      )
      .bind(deadCutoff, deadCutoff)
      .run();
  } catch {
    try {
      await db.prepare(`DELETE FROM rooms WHERE updated_at < ?`).bind(deadCutoff).run();
    } catch {
      /* ignore */
    }
  }
}

async function maybeCleanupOld(db) {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_EVERY_MS) return;
  lastCleanupAt = now;
  await cleanupOld(db);
}

function applyCmd(state, body) {
  const cmd = String(body?.cmd || "").slice(0, 32);
  const clientId = body?.client_id;

  if (cmd === "tvClose") {
    return closeTv(state);
  }

  if (cmd === "tvHeartbeat") {
    if (state.closed) return state;
    touchTv(state);
    return state;
  }

  if (state.closed) {
    return state;
  }

  if (cmd === "join") {
    touchPhone(state, clientId);
    state.paired = true;
    state.revision += 1;
    return state;
  }

  if (cmd === "heartbeat") {
    touchPhone(state, clientId);
    return state;
  }

  if (cmd === "leave") {
    // Explicit「離開房間」— pause TV if last phone
    return dropPhone(state, clientId, { pauseIfEmpty: true });
  }

  if (cmd === "gone") {
    // Tab closed / network drop — remove presence, keep playing
    return dropPhone(state, clientId, { pauseIfEmpty: false });
  }

  if (cmd === "tvReady") {
    touchTv(state);
    // Idempotent — do not bump revision on every poll retry (breaks TV sync)
    if (state.tv_ready && state.playing) {
      return syncCurrent(state);
    }
    state.tv_ready = true;
    state.playing = true;
    state.revision += 1;
    return syncCurrent(state);
  }

  // Before TV unlock: allow queue/selection so first remote taps aren't dropped.
  // Only block play/pause/ended (needs unmuted player).
  if (!state.tv_ready && ["play", "pause", "ended"].includes(cmd)) {
    return state;
  }

  if (clientId && ["play", "pause", "next", "prev", "pick", "setMode", "setLang", "setRotation"].includes(cmd)) {
    touchPhone(state, clientId);
  }

  if (cmd === "play") {
    state.playing = true;
    state.revision += 1;
    return syncCurrent(state);
  }

  if (cmd === "pause") {
    state.playing = false;
    state.revision += 1;
    return state;
  }

  if (cmd === "next") {
    if (state.mode === "loop_one") {
      state.playing = true;
      state.revision += 1;
      return syncCurrent(state);
    }
    advance(state, 1);
    state.playing = true;
    state.revision += 1;
    return state;
  }

  if (cmd === "prev") {
    if (state.mode === "loop_one") {
      state.playing = true;
      state.revision += 1;
      return syncCurrent(state);
    }
    advance(state, -1);
    state.playing = true;
    state.revision += 1;
    return state;
  }

  if (cmd === "ended") {
    if (state.mode === "once") {
      state.playing = false;
      state.revision += 1;
      return state;
    }
    if (state.mode === "loop_one") {
      state.playing = true;
      state.revision += 1;
      return syncCurrent(state);
    }
    if (state.mode === "shuffle" && state.index >= state.queue.length - 1) {
      state.queue = shuffleIds(idsFor(state.lang));
      state.index = 0;
      syncCurrent(state);
    } else {
      advance(state, 1);
    }
    state.playing = true;
    state.revision += 1;
    return state;
  }

  if (cmd === "pick") {
    const id = String(body?.id || "").slice(0, 64);
    const ids = idsFor(state.lang);
    if (!ids.includes(id)) return state;
    if (state.mode === "loop_one") {
      state.queue = [id];
      state.index = 0;
    } else if (state.mode === "shuffle") {
      const at = state.queue.indexOf(id);
      if (at >= 0) state.index = at;
      else state.queue.splice(state.index, 0, id);
    } else {
      state.queue = ids;
      state.index = Math.max(0, ids.indexOf(id));
    }
    syncCurrent(state);
    state.playing = true;
    state.revision += 1;
    return state;
  }

  if (cmd === "setRotation") {
    let rotation = Number(body?.rotation) || 0;
    if (rotation === -90) rotation = 270;
    if (rotation !== 0 && rotation !== 90 && rotation !== 270) rotation = 0;
    if (rotation === state.rotation) return state;
    state.rotation = rotation;
    state.revision += 1;
    return state;
  }

  if (cmd === "setMode") {
    const mode = String(body?.mode || "").slice(0, 16);
    if (!MODES.has(mode)) return state;
    const current = state.current_id;
    state.mode = mode;
    state.queue = buildQueue(state.lang, mode, current);
    if (mode === "loop_one") state.index = 0;
    else if (current && state.queue.includes(current)) state.index = state.queue.indexOf(current);
    else state.index = 0;
    syncCurrent(state);
    state.revision += 1;
    return state;
  }

  if (cmd === "setLang") {
    const lang = body?.lang === "en" ? "en" : "zh";
    if (lang === state.lang) return state;
    state.lang = lang;
    const keep = state.mode === "loop_one" ? state.current_id : null;
    state.queue = buildQueue(lang, state.mode, keep);
    state.index = 0;
    syncCurrent(state);
    state.playing = true;
    state.revision += 1;
    return state;
  }

  return null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: "no db" }, 500);

  const url = new URL(request.url);
  const code = resolveCode(url.searchParams.get("code"));
  if (!code) return json({ ok: false, error: "missing code" }, 400);

  let state = await getRoom(env.DB, code);
  if (!state && isFixedShop(code)) {
    try {
      state = await ensureFixedRoom(env.DB, code);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }
  if (!state) return json({ ok: false, error: "not found" }, 404);

  await maybeCleanupOld(env.DB);
  if (state.closed) {
    if (!isFixedShop(code) && Date.now() - (Number(state.updated_at) || 0) >= CLOSED_ROOM_TTL_MS) {
      await deleteRoom(env.DB, code);
      return json({ ok: false, error: "not found" }, 404);
    }
    return json({ ok: true, room: state });
  }

  // Client poll refreshes presence. Prune at most every 2.5s.
  const now = Date.now();
  const role = url.searchParams.get("role");
  const clientId = url.searchParams.get("client_id");
  let dirty = false;
  if (role === "tv") {
    const prevSeen = Number(state.tv_seen_at) || 0;
    touchTv(state);
    if (now - prevSeen > 8000) dirty = true;
  } else if (role === "phone" && clientId) {
    const beforePhones = state.phones_json;
    touchPhone(state, clientId);
    if (state.phones_json !== beforePhones) dirty = true;
  }
  const prevPrune = lastPruneAt.get(code) || 0;
  if (now - prevPrune > 2500) {
    lastPruneAt.set(code, now);
    const before = state.revision;
    state = prunePhones(state);
    state = pruneTv(state);
    if (state.revision !== before) dirty = true;
  }
  if (dirty) await saveRoom(env.DB, state);

  let wait = url.searchParams.get("wait") === "1";
  const floodKey = `${code}:${role || "any"}`;
  const prevGet = lastWaitReturnAt.get(`g:${floodKey}`) || 0;
  if (wait && Date.now() - prevGet < 1500) wait = false;
  lastWaitReturnAt.set(`g:${floodKey}`, Date.now());
  const since = Number(url.searchParams.get("since"));
  if (
    wait &&
    Number.isFinite(since) &&
    since >= 0 &&
    state.revision === since &&
    !state.closed
  ) {
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      await sleep(WAIT_TICK_MS);
      const next = await getRoom(env.DB, code);
      if (!next) break;
      state = next;
      if (state.revision !== since || state.closed) break;
    }
    if (role === "tv") {
      const latest = await getRoom(env.DB, code);
      if (latest && !latest.closed) {
        state = latest;
        const prevSeen = Number(latest.tv_seen_at) || 0;
        if (Date.now() - prevSeen > 8000) {
          touchTv(latest);
          await saveRoom(env.DB, latest);
          state = latest;
        }
      }
    }
  }

  if (wait) {
    const changed = !state || state.revision !== since || state.closed;
    if (!changed) {
      const key = `${code}:${role || "any"}`;
      const prevWait = lastWaitReturnAt.get(key) || 0;
      const gap = Date.now() - prevWait;
      if (gap < MIN_WAIT_GAP_MS) await sleep(MIN_WAIT_GAP_MS - gap);
      lastWaitReturnAt.set(key, Date.now());
    }
  }

  return json({ ok: true, room: state });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return json({ ok: false, error: "no db" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  const action = String(body?.action || body?.cmd || "").slice(0, 32);

  if (action === "ensure") {
    const code = resolveCode(body?.code);
    if (!code) return json({ ok: false, error: "missing code" }, 400);
    if (!isFixedShop(code)) return json({ ok: false, error: "not a fixed shop code" }, 400);
    const tvId = String(body?.tv_id || "").slice(0, 80);
    const force = !!body?.force;
    try {
      const room = await ensureFixedRoom(env.DB, code, { tvId, force });
      return json({ ok: true, room });
    } catch (e) {
      if (e?.error === "shop_in_use" || e?.message === "shop_in_use") {
        return json(
          {
            ok: false,
            error: "shop_in_use",
            shop_name_zh: e.shop_name_zh,
            shop_name_en: e.shop_name_en,
            room: e.room || null,
          },
          409
        );
      }
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  if (action === "create" || (!body?.code && !body?.cmd)) {
    await maybeCleanupOld(env.DB);
    try {
      const room = await createRoom(env.DB);
      return json({ ok: true, room });
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  const code = resolveCode(body?.code);
  if (!code) return json({ ok: false, error: "missing code" }, 400);

  let state = await getRoom(env.DB, code);
  if (!state && isFixedShop(code)) {
    try {
      state = await ensureFixedRoom(env.DB, code);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }
  if (!state) return json({ ok: false, error: "not found" }, 404);
  if (state.closed && isFixedShop(code)) {
    state = await ensureFixedRoom(env.DB, code);
  }
  await maybeCleanupOld(env.DB);
  if (state.closed && !isFixedShop(code)) {
    if (Date.now() - (Number(state.updated_at) || 0) >= CLOSED_ROOM_TTL_MS) {
      await deleteRoom(env.DB, code);
      return json({ ok: false, error: "not found" }, 404);
    }
    return json({ ok: true, room: state });
  }

  state = prunePhones(state);
  state = pruneTv(state);

  const next = applyCmd(state, { ...body, cmd: body.cmd || action });
  if (!next) return json({ ok: false, error: "unknown cmd" }, 400);

  await saveRoom(env.DB, next);
  return json({ ok: true, room: next });
}
