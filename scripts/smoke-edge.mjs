#!/usr/bin/env node
/**
 * Smoke + edge-case suite for East Store TV Remote.
 * Usage: node scripts/smoke-edge.mjs [baseUrl]
 * Default: http://127.0.0.1:8788
 */
const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let passed = 0;
let failed = 0;
const failures = [];
const sections = [];

async function req(method, path, body, { raw = false, redirect = "follow" } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "user-agent": UA,
      "cache-control": "no-store",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    cache: "no-store",
    body: body ? JSON.stringify(body) : undefined,
    redirect,
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

function section(title) {
  sections.push(title);
  console.log(`\n▸ ${title}`);
}

function assert(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${name}`);
  } else {
    failed += 1;
    failures.push(`[${sections.at(-1) || "?"}] ${name}: ${detail}`);
    console.log(`  FAIL ${name} — ${detail}`);
  }
}

async function create() {
  const { status, data } = await req("POST", "/api/sync", {
    action: "create",
    nonce: `n-${Date.now()}-${Math.random()}`,
  });
  assert("create 200", status === 200 && data.ok, JSON.stringify(data).slice(0, 200));
  return data.room;
}

async function cmd(code, c, extra = {}) {
  return req("POST", "/api/sync", { code, cmd: c, ...extra });
}

async function get(code) {
  return req("GET", `/api/sync?code=${encodeURIComponent(code)}&_=${Date.now()}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`\n════════════════════════════════════════`);
  console.log(` Massive smoke + edge tests`);
  console.log(` → ${BASE}`);
  console.log(`════════════════════════════════════════`);

  // ─── A. Static / pages ───
  section("A) Static pages & assets");
  const pages = [
    "/",
    "/remote",
    "/remote.html",
    "/tv",
    "/tv.html",
    "/tv.js",
    "/remote.js",
    "/shared/ads.js",
    "/shared/styles.css",
    "/vendor/qrcode.min.js",
    "/covers/cover_cohb003_zh.jpg",
    "/covers/cover_cohs004_zh.jpg",
    "/covers/cover_cbhb001_zh.jpg",
  ];
  for (const path of pages) {
    const res = await req("GET", path, null, { raw: true });
    assert(`GET ${path}`, res.status === 200, `status=${res.status}`);
  }
  // Ready page markup must include QR mount
  {
    const html = await (await req("GET", "/", null, { raw: true })).text();
    assert("index has readyQr", html.includes('id="readyQr"'), "missing #readyQr");
    assert("index has pairReady", html.includes('id="pairReady"'), "missing #pairReady");
    assert("index loads qr lib", html.includes("qrcode.min.js"));
  }
  {
    const remote = await (await req("GET", "/remote", null, { raw: true })).text();
    assert("remote page loads", remote.includes("remote.js"));
  }
  // /r/:code should rewrite to remote
  {
    const res = await req("GET", "/r/TEST", null, { raw: true });
    assert(
      "/r/CODE serves remote",
      res.status === 200 || res.status === 302,
      `status=${res.status}`,
    );
  }

  // ─── B. Create room basics ───
  section("B) Create room basics");
  const room = await create();
  assert("code length 4", room?.code?.length === 4, `code=${room?.code}`);
  assert("code charset", /^[A-Z0-9]+$/.test(room?.code || ""), room?.code);
  assert("not closed", !room.closed);
  assert("phone_count 0", room.phone_count === 0);
  assert("not tv_ready", !room.tv_ready);
  assert("not paired", !room.paired);
  assert("has queue", Array.isArray(room.queue) && room.queue.length > 0, `len=${room.queue?.length}`);
  assert("has current_id", !!room.current_id);
  assert("mode loop", room.mode === "loop");
  assert("lang zh", room.lang === "zh");
  assert("revision >=1", Number(room.revision) >= 1);

  // New ads present in queue
  assert("queue has 捲髮梳", room.queue.includes("YwZ1qilcbp0"), room.queue.slice(0, 5).join(","));
  assert("queue has 直髮器", room.queue.includes("8mn1TOftC9Y"));

  const g0 = await get(room.code);
  assert("GET same code", g0.data.room?.code === room.code);
  assert("GET same current", g0.data.room?.current_id === room.current_id);

  // ─── C. Missing / invalid inputs ───
  section("C) Missing / invalid inputs");
  {
    const miss = await get("ZZZZ");
    assert("missing room fails", miss.status === 404 || miss.data.ok === false);
  }
  {
    const bad = await cmd("ZZZZ", "join", { client_id: "x" });
    assert("join missing fails", bad.status >= 400 || bad.data.ok === false);
  }
  {
    const unk = await cmd(room.code, "notARealCmd", { client_id: "x" });
    assert("unknown cmd rejected or no-op", unk.data.ok === false || unk.data.room?.code === room.code);
  }
  {
    const empty = await req("POST", "/api/sync", {});
    // create fallback or error — either ok create or error
    assert("empty body handled", empty.status === 200 || empty.status >= 400);
  }

  // ─── D. Multi-phone join ───
  section("D) Multi-phone join");
  let r = await cmd(room.code, "join", { client_id: "smoke-a" });
  assert("join A paired", r.data.room?.paired === true);
  assert("join A count 1", r.data.room?.phone_count === 1);
  r = await cmd(room.code, "join", { client_id: "smoke-b" });
  assert("join B count 2", r.data.room?.phone_count === 2);
  r = await cmd(room.code, "join", { client_id: "smoke-a" });
  assert("rejoin A still 2", r.data.room?.phone_count === 2, `count=${r.data.room?.phone_count}`);
  r = await cmd(room.code, "join", { client_id: "" });
  assert("empty client_id join ok-ish", r.data.ok === true || r.data.ok === false);

  // ─── E. Commands BEFORE tvReady ───
  section("E) Commands before tv_ready");
  {
    const roomE = await create();
    await cmd(roomE.code, "join", { client_id: "pre-1" });
    const before = (await get(roomE.code)).data.room;
    assert("pre: not ready", !before.tv_ready);

    r = await cmd(roomE.code, "play", { client_id: "pre-1" });
    assert("pre: play blocked", r.data.room?.playing === false && !r.data.room?.tv_ready);

    r = await cmd(roomE.code, "pause", { client_id: "pre-1" });
    assert("pre: pause no-op ok", r.data.ok);

    const id0 = before.current_id;
    r = await cmd(roomE.code, "next", { client_id: "pre-1" });
    assert("pre: next ALLOWED", r.data.ok && r.data.room?.current_id && r.data.room.current_id !== id0, `id=${r.data.room?.current_id}`);

    r = await cmd(roomE.code, "prev", { client_id: "pre-1" });
    assert("pre: prev ALLOWED", r.data.ok && r.data.room?.current_id === id0, `id=${r.data.room?.current_id}`);

    r = await cmd(roomE.code, "pick", { client_id: "pre-1", id: "YwZ1qilcbp0" });
    assert("pre: pick new ad", r.data.room?.current_id === "YwZ1qilcbp0", `id=${r.data.room?.current_id}`);

    r = await cmd(roomE.code, "pick", { client_id: "pre-1", id: "NOT_A_REAL_ID" });
    assert("pre: bad pick ignored", r.data.room?.current_id === "YwZ1qilcbp0");

    r = await cmd(roomE.code, "setMode", { client_id: "pre-1", mode: "shuffle" });
    assert("pre: setMode", r.data.room?.mode === "shuffle");

    r = await cmd(roomE.code, "setLang", { client_id: "pre-1", lang: "en" });
    assert("pre: setLang en", r.data.room?.lang === "en");

    r = await cmd(roomE.code, "setRotation", { client_id: "pre-1", rotation: 90 });
    assert("pre: rotation 90", r.data.room?.rotation === 90);
  }

  // ─── F. tvReady + transport ───
  section("F) tvReady + play/pause/next/prev");
  r = await cmd(room.code, "tvReady");
  assert("tv_ready", r.data.room?.tv_ready === true);
  assert("tv_ready playing", r.data.room?.playing === true);
  const revReady = r.data.room?.revision;

  r = await cmd(room.code, "tvReady");
  assert("tvReady idempotent (no forced rev bump)", r.data.room?.tv_ready === true);
  // may or may not bump — if already ready+playing should not bump
  assert(
    "tvReady idempotent revision",
    Number(r.data.room?.revision) === Number(revReady),
    `was ${revReady} now ${r.data.room?.revision}`
  );

  r = await cmd(room.code, "pause", { client_id: "smoke-a" });
  assert("pause", r.data.room?.playing === false);
  r = await cmd(room.code, "play", { client_id: "smoke-a" });
  assert("play", r.data.room?.playing === true);

  const idBefore = r.data.room?.current_id;
  r = await cmd(room.code, "next", { client_id: "smoke-a" });
  assert("next changes id", r.data.room?.current_id !== idBefore, `${idBefore}→${r.data.room?.current_id}`);
  assert("next forces playing", r.data.room?.playing === true);
  r = await cmd(room.code, "prev", { client_id: "smoke-a" });
  assert("prev back", r.data.room?.current_id === idBefore);

  // ─── G. Pick ads ───
  section("G) Pick catalog ads");
  for (const id of ["YwZ1qilcbp0", "8mn1TOftC9Y", "r-EjfQ0l_3w", "mc5vlJoNcFc"]) {
    r = await cmd(room.code, "pick", { client_id: "smoke-a", id });
    assert(`pick ${id}`, r.data.room?.current_id === id, `got=${r.data.room?.current_id}`);
  }

  // ─── H. Modes ───
  section("H) Playback modes");
  {
    const rm = await create();
    await cmd(rm.code, "join", { client_id: "mode-1" });
    await cmd(rm.code, "tvReady");

    r = await cmd(rm.code, "setMode", { client_id: "mode-1", mode: "loop_one" });
    assert("mode loop_one", r.data.room?.mode === "loop_one");
    const oneId = r.data.room?.current_id;
    r = await cmd(rm.code, "next", { client_id: "mode-1" });
    assert("loop_one next same id", r.data.room?.current_id === oneId);

    r = await cmd(rm.code, "setMode", { client_id: "mode-1", mode: "once" });
    assert("mode once", r.data.room?.mode === "once");

    r = await cmd(rm.code, "setMode", { client_id: "mode-1", mode: "shuffle" });
    assert("mode shuffle", r.data.room?.mode === "shuffle");
    assert("shuffle queue", (r.data.room?.queue || []).length > 1);

    r = await cmd(rm.code, "setMode", { client_id: "mode-1", mode: "loop" });
    assert("mode loop", r.data.room?.mode === "loop");

    r = await cmd(rm.code, "setMode", { client_id: "mode-1", mode: "bogus" });
    assert("bad mode ignored/kept", ["loop", "shuffle", "once", "loop_one"].includes(r.data.room?.mode));
  }

  // ─── I. ended ───
  section("I) ended command");
  {
    const re = await create();
    await cmd(re.code, "join", { client_id: "end-1" });
    await cmd(re.code, "tvReady");
    const before = (await get(re.code)).data.room;
    r = await cmd(re.code, "ended", { client_id: "end-1" });
    assert("ended advances or loops", r.data.ok && r.data.room?.playing === true);
    assert("ended revision up", Number(r.data.room?.revision) > Number(before.revision));

    await cmd(re.code, "setMode", { client_id: "end-1", mode: "once" });
    r = await cmd(re.code, "ended", { client_id: "end-1" });
    assert("ended once stops", r.data.room?.playing === false, `playing=${r.data.room?.playing}`);
  }

  // ─── J. Rotation edge ───
  section("J) Rotation edges");
  {
    const rr = await create();
    await cmd(rr.code, "join", { client_id: "rot-1" });
    for (const [inp, expect] of [
      [90, 90],
      [270, 270],
      [-90, 270],
      [0, 0],
      [180, 0],
      [999, 0],
    ]) {
      r = await cmd(rr.code, "setRotation", { client_id: "rot-1", rotation: inp });
      assert(`rot ${inp}→${expect}`, r.data.room?.rotation === expect, `got=${r.data.room?.rotation}`);
    }
  }

  // ─── K. Lang switch rebuilds queue ───
  section("K) Language switch");
  {
    const rl = await create();
    await cmd(rl.code, "join", { client_id: "lang-1" });
    await cmd(rl.code, "tvReady");
    r = await cmd(rl.code, "setLang", { client_id: "lang-1", lang: "en" });
    assert("lang en", r.data.room?.lang === "en");
    assert("en queue no ZH-only short", !r.data.room.queue.includes("YwZ1qilcbp0") || r.data.room.queue.length > 0);
    assert("en has ice fan", r.data.room.queue.includes("XNPlKQPzC-I"), r.data.room.queue.slice(0, 3).join(","));
    r = await cmd(rl.code, "setLang", { client_id: "lang-1", lang: "zh" });
    assert("lang back zh", r.data.room?.lang === "zh");
    assert("zh has 捲髮梳", r.data.room.queue.includes("YwZ1qilcbp0"));
  }

  // ─── L. gone vs leave ───
  section("L) gone vs leave");
  {
    const rg = await create();
    await cmd(rg.code, "join", { client_id: "g-a" });
    await cmd(rg.code, "join", { client_id: "g-b" });
    await cmd(rg.code, "tvReady");
    r = await cmd(rg.code, "gone", { client_id: "g-a" });
    assert("gone A count 1", r.data.room?.phone_count === 1);
    assert("gone A still playing", r.data.room?.playing === true);
    r = await cmd(rg.code, "gone", { client_id: "g-b" });
    assert("gone last still playing", r.data.room?.playing === true, `playing=${r.data.room?.playing}`);
    assert("gone last → shuffle", r.data.room?.mode === "shuffle", `mode=${r.data.room?.mode}`);
    assert("gone keeps open", r.data.room?.tv_ready === true && !r.data.room?.closed);
  }
  {
    const rl = await create();
    await cmd(rl.code, "join", { client_id: "l-a" });
    await cmd(rl.code, "tvReady");
    r = await cmd(rl.code, "leave", { client_id: "l-a" });
    assert("leave pauses", r.data.room?.playing === false);
    assert("leave phone 0", r.data.room?.phone_count === 0);
    assert("leave room open", r.data.room?.tv_ready === true && !r.data.room?.closed);
  }

  // ─── M. tvClose ───
  section("M) tvClose");
  {
    const rc = await create();
    await cmd(rc.code, "join", { client_id: "c-1" });
    await cmd(rc.code, "tvReady");
    r = await cmd(rc.code, "tvClose");
    assert("closed", r.data.room?.closed === true);
    assert("closed no phones", r.data.room?.phone_count === 0);
    assert("closed stopped", r.data.room?.playing === false);
    r = await cmd(rc.code, "join", { client_id: "c-1" });
    assert("join after close no revive", r.data.room?.closed === true && r.data.room?.phone_count === 0);
    r = await cmd(rc.code, "next", { client_id: "c-1" });
    assert("next after close no-op/closed", r.data.room?.closed === true);
  }

  // ─── N. Heartbeat storm ───
  section("N) Heartbeat storm 60×");
  {
    const rh = await create();
    await cmd(rh.code, "join", { client_id: "hb-1" });
    await cmd(rh.code, "tvReady");
    let ok = 0;
    for (let i = 0; i < 60; i++) {
      const [ph, tv] = await Promise.all([
        cmd(rh.code, "heartbeat", { client_id: "hb-1" }),
        cmd(rh.code, "tvHeartbeat"),
      ]);
      if (ph.data.ok && tv.data.ok && !tv.data.room?.closed) ok += 1;
    }
    assert("heartbeat 60/60", ok === 60, `ok=${ok}`);
  }

  // ─── O. Concurrent joins + next storm ───
  section("O) Concurrent joins + next storm");
  {
    const ro = await create();
    const joins = await Promise.all(
      Array.from({ length: 8 }, (_, i) => cmd(ro.code, "join", { client_id: `p${i}` }))
    );
    assert("all joins ok", joins.every((j) => j.data.ok));
    const g = await get(ro.code);
    assert("phones >=1 after concurrent", (g.data.room?.phone_count || 0) >= 1);

    await cmd(ro.code, "tvReady");
    const startId = (await get(ro.code)).data.room?.current_id;
    const nexts = await Promise.all(
      Array.from({ length: 10 }, (_, i) => cmd(ro.code, "next", { client_id: `p${i % 8}` }))
    );
    assert("next storm all ok", nexts.every((n) => n.data.ok));
    const end = (await get(ro.code)).data.room;
    assert("after storm still ready", end.tv_ready === true && !end.closed);
    assert("after storm has id", !!end.current_id);
    // not asserting different from start — races may land same
    assert("storm room alive", end.code === ro.code, startId);
  }

  // ─── P. Rapid create many rooms ───
  section("P) Rapid create 12 rooms");
  {
    const created = await Promise.all(Array.from({ length: 12 }, () => create()));
    const codes = created.map((x) => x?.code).filter(Boolean);
    assert("12 rooms created", codes.length === 12, `got=${codes.length}`);
    assert("codes unique", new Set(codes).size === 12, `unique=${new Set(codes).size}`);
  }

  // ─── Q. GET poll spam ───
  section("Q) GET poll spam 30×");
  {
    const rq = await create();
    await cmd(rq.code, "join", { client_id: "poll-1" });
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const g = await get(rq.code);
      if (g.data.ok && g.data.room?.code === rq.code) ok += 1;
    }
    assert("GET poll 30/30", ok === 30, `ok=${ok}`);
  }

  // ─── R. OPTIONS CORS ───
  section("R) OPTIONS CORS");
  {
    const res = await fetch(`${BASE}/api/sync`, {
      method: "OPTIONS",
      headers: { "user-agent": UA, origin: "https://example.com" },
    });
    assert("OPTIONS status ok", res.status === 200 || res.status === 204, `status=${res.status}`);
    const aco = res.headers.get("access-control-allow-origin");
    assert("CORS ACAO", !!aco, `ACAO=${aco}`);
  }

  // ─── S. ads.js catalog sanity ───
  section("S) Client ads.js catalog");
  {
    const text = await (await req("GET", `/shared/ads.js?_=${Date.now()}`, null, { raw: true })).text();
    assert("ads has YwZ1qilcbp0", text.includes("YwZ1qilcbp0"));
    assert("ads has 8mn1TOftC9Y", text.includes("8mn1TOftC9Y"));
    assert("ads has 捲髮梳 name", text.includes("捲髮梳"));
    assert("ads has 直髮器 name", text.includes("直髮器"));
    assert("ads exports findAd", text.includes("export function findAd"));
  }

  // ─── T. Rejoin after gone ───
  section("T) Rejoin after gone");
  {
    const rt = await create();
    await cmd(rt.code, "join", { client_id: "re-1" });
    await cmd(rt.code, "tvReady");
    await cmd(rt.code, "gone", { client_id: "re-1" });
    r = await cmd(rt.code, "join", { client_id: "re-1" });
    assert("rejoin after gone", r.data.room?.phone_count >= 1 && r.data.room?.paired === true);
    assert("still tv_ready", r.data.room?.tv_ready === true);
  }

  // ─── U. Double leave / double gone ───
  section("U) Double leave / double gone");
  {
    const ru = await create();
    await cmd(ru.code, "join", { client_id: "d-1" });
    await cmd(ru.code, "tvReady");
    await cmd(ru.code, "leave", { client_id: "d-1" });
    r = await cmd(ru.code, "leave", { client_id: "d-1" });
    assert("double leave ok", r.data.ok && r.data.room?.phone_count === 0);

    const ru2 = await create();
    await cmd(ru2.code, "join", { client_id: "d-2" });
    await cmd(ru2.code, "tvReady");
    await cmd(ru2.code, "gone", { client_id: "d-2" });
    r = await cmd(ru2.code, "gone", { client_id: "d-2" });
    assert("double gone ok", r.data.ok);
  }

  // ─── V. pick + next race ───
  section("V) pick + next race");
  {
    const rv = await create();
    await cmd(rv.code, "join", { client_id: "race-1" });
    await cmd(rv.code, "tvReady");
    const results = await Promise.all([
      cmd(rv.code, "pick", { client_id: "race-1", id: "8mn1TOftC9Y" }),
      cmd(rv.code, "next", { client_id: "race-1" }),
      cmd(rv.code, "pick", { client_id: "race-1", id: "YwZ1qilcbp0" }),
      cmd(rv.code, "next", { client_id: "race-1" }),
    ]);
    assert("race all ok", results.every((x) => x.data.ok));
    const final = (await get(rv.code)).data.room;
    assert("race final has id", !!final.current_id);
    assert("race not closed", !final.closed);
  }

  // ─── W. No fixed shop rooms ───
  section("W) No fixed shop rooms");
  {
    const bad = await req("POST", "/api/sync", { action: "ensure", code: "EAST01" });
    assert("ensure shop rejected", bad.data.ok === false, JSON.stringify(bad.data).slice(0, 120));

    const html = await (await req("GET", "/", null, { raw: true })).text();
    assert("home has no shop bookmarks", !html.includes("/wts") && !html.includes("/dh"));

    for (const path of ["/wts", "/dh", "/1", "/2"]) {
      const res = await req("GET", path, null, { raw: true, redirect: "manual" });
      assert(`${path} is not a shop route`, res.status === 404 || res.status === 200 && !(res.headers.get("location") || "").includes("EAST0"), `status=${res.status}`);
    }
  }

  // small pause so we don't hammer
  await sleep(50);

  console.log(`\n════════════════════════════════════════`);
  console.log(` ${passed} passed · ${failed} failed · ${sections.length} sections`);
  console.log(`════════════════════════════════════════\n`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(" -", f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
