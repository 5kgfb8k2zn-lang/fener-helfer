// Fener-Helfer – Cloudflare Worker
// Fragt API-Football nur rund um Fenerbahçe-Spiele ab und schickt Push-Nachrichten über ntfy.
// Die App holt sich den Stand über /state und verbraucht selbst keine Anfragen mehr.
//
// Benötigt in Cloudflare:
//   Secret   API_KEY     – Schlüssel von api-football.com
//   Secret   NTFY_TOPIC  – geheimer Kanalname in der ntfy-App
//   D1       DB          – Datenbank-Bindung (Name der Variable: DB)
//   Cron     * * * * *   – jede Minute
// Optional: NTFY_SERVER (Standard https://ntfy.sh), APP_URL (Link beim Antippen der Nachricht)

const API = "https://v3.football.api-sports.io";
const SEASON = 2026;
const VERSION = 2;
const DAILY_LIMIT = 100;
const CAP = 95; // 5 Anfragen bleiben als Reserve
const FINISHED = ["FT", "AET", "PEN"];
const STOP = FINISHED.concat(["PST", "CANC", "ABD", "AWD", "WO"]);
const PLAYING = ["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT", "SUSP"];
const LEAGUE_NAMES = { 203: "Süper Lig", 2: "Champions League", 206: "Türkiye Kupası" };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).catch((e) => console.log("Fehler im Durchlauf:", (e && e.stack) || e)));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers });
    try {
      if (url.pathname === "/state") {
        const s = await load(env);
        return new Response(JSON.stringify(publicState(s, env)), { headers });
      }
      if (url.pathname === "/test") {
        const s = await load(env);
        if (Date.now() - (s.testAt || 0) < 60 * 1000) {
          return new Response(JSON.stringify({ ok: false, error: "Bitte eine Minute warten, bevor du noch eine Test-Nachricht schickst." }), { headers });
        }
        s.testAt = Date.now();
        await save(env, s);
        if (!env.NTFY_TOPIC) return new Response(JSON.stringify({ ok: false, error: "NTFY_TOPIC fehlt in den Einstellungen des Workers." }), { headers });
        const r = await push(env, { title: "Fener-Helfer", message: "Test erfolgreich! Ab jetzt bekommst du hier die Tore von Fenerbahçe.", tags: ["white_check_mark"], priority: 3 });
        s.pushError = r.ok ? "" : r.error; await save(env, s);
        const topic = env.NTFY_TOPIC.trim();
        return new Response(JSON.stringify(r.ok ? { ok: true, topic: topic } : { ok: false, topic: topic, error: r.error + " (Kanal: " + topic + ")" }), { headers });
      }
      if (url.pathname === "/" || url.pathname === "") {
        const s = await load(env);
        return new Response(setupPage(s, env, url.origin), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("Nicht gefunden.", { status: 404, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers });
    }
  },
};

// ---------------------------------------------------------------------------
// Speicher (D1: eine Tabelle mit einem JSON-Eintrag)
// ---------------------------------------------------------------------------
let tableReady = false;
async function ensureTable(env) {
  if (!env.DB) throw new Error("Datenbank-Bindung DB fehlt.");
  if (tableReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT)").run();
  tableReady = true;
}
function emptyState() {
  return { v: VERSION, teamId: null, fixtures: [], table: [], syncedAt: 0, syncFailAt: 0, live: null, lastLive: null, lineups: {}, lineupTry: {}, notified: {}, usage: { day: "", n: 0 }, lastPollAt: 0, error: "", testAt: 0, pushError: "" };
}
async function load(env) {
  await ensureTable(env);
  const row = await env.DB.prepare("SELECT v FROM store WHERE k = ?").bind("state").first();
  if (!row) return emptyState();
  try { return Object.assign(emptyState(), JSON.parse(row.v)); } catch (e) { return emptyState(); }
}
async function save(env, s) {
  await ensureTable(env);
  await env.DB.prepare("INSERT OR REPLACE INTO store (k, v) VALUES (?, ?)").bind("state", JSON.stringify(s)).run();
}
function publicState(s, env) {
  return {
    v: VERSION, now: Date.now(), syncedAt: s.syncedAt, fixtures: s.fixtures, table: s.table,
    live: s.live, lastLive: s.lastLive, lineups: s.lineups, usage: s.usage, lastPollAt: s.lastPollAt,
    error: s.error, pushError: s.pushError || "", push: !!env.NTFY_TOPIC, apiKey: !!env.API_KEY,
  };
}

// ---------------------------------------------------------------------------
// Einrichtungs-Seite (für das iPhone): Status, Adresse kopieren, Test-Nachricht
// ---------------------------------------------------------------------------
function esc(x) { return String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function setupPage(s, env, origin) {
  const now = Date.now();
  const n = s.fixtures.length ? nextFx(s, now) : null;
  const row = (ok, label, hint) => `<li class="${ok ? "ok" : "no"}"><b>${ok ? "✓" : "✗"}</b><span>${label}${hint ? `<small>${hint}</small>` : ""}</span></li>`;
  const checks = [
    row(!!env.API_KEY, "API-Schlüssel eingetragen", env.API_KEY ? "" : "In Cloudflare unter Settings → Variables and Secrets: API_KEY"),
    row(!!env.NTFY_TOPIC, "Push-Kanal eingetragen", env.NTFY_TOPIC ? "" : "In Cloudflare unter Settings → Variables and Secrets: NTFY_TOPIC"),
    row(!!env.DB, "Datenbank verbunden"),
    row(!!s.syncedAt, "Spielplan geladen", s.syncedAt ? "Stand " + new Date(s.syncedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "Passiert innerhalb einer Minute nach dem Einrichten. Seite dann neu laden."),
  ].join("");
  const next = n ? `${esc(n.h)} – ${esc(n.a)}, ${new Date(n.date).toLocaleString("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "–";
  const topic = env.NTFY_TOPIC ? `<a class="btn" href="ntfy://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}">In ntfy abonnieren</a>` : "";
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fener-Helfer</title>
<style>
:root{--bg:#0b1838;--card:#12224a;--line:#2a3f74;--fg:#eef1fa;--muted:#9aa7c7;--y:#ffd31a;--ok:#3ddc84;--no:#ff6b6b;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px 40px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:26px}h1 span{color:var(--y)}p{margin:0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
.label{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}li{display:flex;gap:10px}
li b{width:22px;flex:none}li.ok b{color:var(--ok)}li.no b{color:var(--no)}small{display:block;color:var(--muted);font-size:13px}
code{display:block;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:14px;color:var(--y)}
.btn,button{display:block;text-align:center;background:var(--y);color:var(--bg);border:0;border-radius:12px;padding:13px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.btn.ghost,button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}#msg{min-height:1.4em}
</style></head><body><main>
<h1>Fener-<span>Helfer</span></h1>
<p>Läuft jede Minute bei Cloudflare und meldet dir die Fener-Spiele per Push, auch wenn die App zu ist.</p>
<section class="card"><div class="label">Status</div><ul>${checks}</ul><small>Nächstes Spiel: ${next} · heute ${s.usage && s.usage.day === utcDay() ? s.usage.n : 0} von ${DAILY_LIMIT} Anfragen</small>${s.error ? `<small style="color:var(--no)">Problem: ${esc(s.error)}</small>` : ""}</section>
<section class="card"><div class="label">1 · Push-Nachrichten</div><p>ntfy aus dem App Store installieren, dann hier tippen:</p>${topic}${env.NTFY_TOPIC ? `<small>Kanal: <b>${esc(env.NTFY_TOPIC.trim())}</b> – genau dieser Name muss in der ntfy-App stehen.</small>` : ""}${s.pushError ? `<small style="color:var(--no)">Letzter Fehler beim Senden: ${esc(s.pushError)}</small>` : ""}<button class="ghost" id="test">Test-Nachricht senden</button><p id="msg"></p></section>
<section class="card"><div class="label">2 · Mit der Fener-App verbinden</div><p>Adresse kopieren und in der Fener-App unter Live → Hintergrund-Helfer einfügen.</p><code id="u">${esc(origin)}</code><button id="copy">Adresse kopieren</button></section>
<script>
document.getElementById("copy").onclick=function(){var t=document.getElementById("u").textContent,b=this;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent="Kopiert ✓"},function(){var r=document.createRange();r.selectNode(document.getElementById("u"));getSelection().removeAllRanges();getSelection().addRange(r);b.textContent="Markiert – jetzt Kopieren antippen"})};
document.getElementById("test").onclick=function(){var m=document.getElementById("msg");m.textContent="Sende …";fetch("/test").then(function(r){return r.json()}).then(function(j){m.textContent=j.ok?"Gesendet an Kanal „"+j.topic+"“. Schau in die ntfy-App.":(j.error||"Hat nicht geklappt.")},function(){m.textContent="Hat nicht geklappt."})};
</script></main></body></html>`;
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
function utcDay() { return new Date().toISOString().slice(0, 10); }
function norm(x) { return String(x || "").replace(/ı/g, "i").replace(/İ/g, "I").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, ""); }
function isFb(name) { return norm(name).indexOf("fenerbahce") >= 0; }
function kick(a) { return Date.parse(a.date); }
function sorted(s) { return s.fixtures.slice().sort((x, y) => kick(x) - kick(y)); }
function windowFx(s, now) {
  return sorted(s).find((a) => STOP.indexOf(a.st) < 0 && now >= kick(a) - 5 * 60000 && now <= kick(a) + 150 * 60000) || null;
}
function nextFx(s, now) { return sorted(s).find((a) => STOP.indexOf(a.st) < 0 && kick(a) > now - 150 * 60000) || null; }

async function api(env, s, path) {
  if (s.usage.day !== utcDay()) s.usage = { day: utcDay(), n: 0 };
  if (s.usage.n >= CAP) throw new Error("Tageslimit erreicht (" + s.usage.n + " von " + DAILY_LIMIT + ").");
  s.usage.n++;
  const r = await fetch(API + path, { headers: { "x-apisports-key": env.API_KEY } });
  const rem = r.headers.get("x-ratelimit-requests-remaining");
  if (rem !== null && !isNaN(+rem)) s.usage.n = Math.max(s.usage.n, DAILY_LIMIT - +rem);
  const j = await r.json();
  const e = j && j.errors;
  if (e && (Array.isArray(e) ? e.length : Object.keys(e).length)) {
    throw new Error("API: " + (Array.isArray(e) ? e.join(" ") : Object.values(e).join(" ")));
  }
  return j.response || [];
}

// Schickt eine Nachricht an ntfy. Gibt { ok, error } zurück.
// Optional: NTFY_TOKEN (Zugangs-Token eines kostenlosen ntfy-Kontos), falls ntfy Anfragen von Cloudflare drosselt.
async function push(env, msg) {
  if (!env.NTFY_TOPIC) return { ok: false, error: "NTFY_TOPIC fehlt" };
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const auth = env.NTFY_TOKEN ? { Authorization: "Bearer " + env.NTFY_TOKEN } : {};
  const body = { topic: env.NTFY_TOPIC.trim(), title: msg.title, message: msg.message, tags: msg.tags || [], priority: msg.priority || 3 };
  if (env.APP_URL) body.click = env.APP_URL;
  let first = "";
  try {
    const r = await fetch(server + "/", { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) });
    if (r.ok) return { ok: true };
    first = r.status + " " + (await r.text()).slice(0, 200);
  } catch (e) { first = String((e && e.message) || e); }
  // Zweiter Weg: einfache Nachricht an /<kanal>, Titel als Parameter
  try {
    const q = new URLSearchParams({ title: msg.title, tags: (msg.tags || []).join(","), priority: String(msg.priority || 3) });
    if (env.APP_URL) q.set("click", env.APP_URL);
    const r2 = await fetch(server + "/" + encodeURIComponent(env.NTFY_TOPIC.trim()) + "?" + q.toString(), { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8", ...auth }, body: msg.message });
    if (r2.ok) return { ok: true };
    const second = r2.status + " " + (await r2.text()).slice(0, 200);
    console.log("Push fehlgeschlagen:", first, "|", second);
    return { ok: false, error: "ntfy antwortet: " + second };
  } catch (e) {
    console.log("Push fehlgeschlagen:", first, e);
    return { ok: false, error: "ntfy nicht erreichbar: " + String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Abgleich: Spielplan + Tabelle (2 Anfragen, beim ersten Mal 3)
// ---------------------------------------------------------------------------
function needSync(s, now) {
  if (s.syncFailAt && now - s.syncFailAt < 30 * 60000) return false; // nach Fehler 30 Min. warten
  if (!s.syncedAt || !s.fixtures.length) return true;
  if (now - s.syncedAt > 24 * 3600 * 1000) return true;
  return s.fixtures.some((a) => { const end = kick(a) + 120 * 60000; return end > s.syncedAt && end < now; });
}
async function sync(env, s) {
  if (!s.teamId) {
    const res = await api(env, s, "/teams?search=Fenerbahce");
    const t = res.find((x) => x.team && isFb(x.team.name) && !/W$|U\d+/.test(x.team.name));
    if (!t) throw new Error("Fenerbahçe wurde bei API-Football nicht gefunden.");
    s.teamId = t.team.id;
  }
  const fx = await api(env, s, "/fixtures?team=" + s.teamId + "&season=" + SEASON);
  const st = await api(env, s, "/standings?league=203&season=" + SEASON);
  if (!fx.length) throw new Error("Keine Spiele für die Saison " + SEASON + " gefunden. Der Free-Plan enthält die Saison eventuell nicht.");
  s.fixtures = fx.map((f) => ({
    id: f.fixture.id, date: f.fixture.date, st: f.fixture.status.short, lg: f.league.id, round: f.league.round,
    h: f.teams.home.name, a: f.teams.away.name, gh: f.goals.home, ga: f.goals.away,
    ph: f.score && f.score.penalty ? f.score.penalty.home : null, pa: f.score && f.score.penalty ? f.score.penalty.away : null,
  }));
  const rows = (st[0] && st[0].league && st[0].league.standings && st[0].league.standings[0]) || [];
  s.table = rows.map((t) => ({ n: t.team.name, p: t.all.played, pts: t.points, gf: t.all.goals.for, ga: t.all.goals.against }));
  s.syncedAt = Date.now();
  s.syncFailAt = 0;
}

// ---------------------------------------------------------------------------
// Jede Minute
// ---------------------------------------------------------------------------
async function tick(env) {
  const s = await load(env);
  const now = Date.now();
  let dirty = false;
  if (s.usage.day !== utcDay()) { s.usage = { day: utcDay(), n: 0 }; dirty = true; }
  if (!env.API_KEY) {
    if (s.error !== "API_KEY fehlt") { s.error = "API_KEY fehlt"; await save(env, s); }
    return;
  }

  if (needSync(s, now)) {
    try { await sync(env, s); s.error = ""; } catch (e) { s.error = String(e.message || e); s.syncFailAt = now; }
    dirty = true;
  }

  const w = windowFx(s, now);
  if (w) {
    const live = s.live && s.live.fixture.id === w.id ? s.live : null;
    const iv = pollInterval(s, w, live, now);
    if (iv && now - s.lastPollAt >= iv * 1000 - 5000) {
      try {
        const res = await api(env, s, "/fixtures?id=" + w.id);
        s.lastPollAt = now;
        if (res[0]) await handleUpdate(env, s, w, res[0]);
        s.error = "";
      } catch (e) { s.error = String(e.message || e); }
      dirty = true;
    }
  }

  // Aufstellung (kommt ca. 60 Minuten vor Anpfiff)
  const n = w || nextFx(s, now);
  if (n && now >= kick(n) - 60 * 60000 && !s.lineups[n.id]) {
    const t = s.lineupTry[n.id] || { n: 0, at: 0 };
    if (t.n < 4 && now - t.at >= 14 * 60000) {
      s.lineupTry = { [n.id]: { n: t.n + 1, at: now } };
      try {
        const res = await api(env, s, "/fixtures/lineups?fixture=" + n.id);
        const mine = res.find((x) => isFb(x.team.name));
        if (mine && mine.startXI && mine.startXI.length) {
          s.lineups = { [n.id]: { team: { name: mine.team.name }, formation: mine.formation, coach: mine.coach ? { name: mine.coach.name } : null, startXI: mine.startXI.map((x) => ({ player: { name: x.player.name, number: x.player.number, pos: x.player.pos } })) } };
          await push(env, { title: "Aufstellung Fenerbahçe", message: (mine.formation ? mine.formation + ": " : "") + mine.startXI.map((x) => x.player.name).join(", "), tags: ["clipboard"], priority: 2 });
        }
      } catch (e) { s.error = String(e.message || e); }
      dirty = true;
    }
  }

  if (dirty) await save(env, s);
}

// Das Tagesbudget gleichmäßig auf die restliche Spielzeit verteilen (ca. alle 60–80 Sekunden)
function pollInterval(s, w, live, now) {
  const st = live ? live.fixture.status.short : "NS";
  const extra = ["ET", "BT", "P"].indexOf(st) >= 0;
  const end = kick(w) + (extra ? 170 : 125) * 60000;
  let secsLeft = Math.max(300, (end - now) / 1000);
  if (!extra && st !== "2H") secsLeft -= 15 * 60;
  if (s.usage.day !== utcDay()) s.usage = { day: utcDay(), n: 0 };
  const left = CAP - s.usage.n - 3;
  if (left <= 0) return null;
  let iv = Math.max(55, Math.ceil(secsLeft / left));
  if (st === "HT") iv = Math.max(iv, 7 * 60);
  if (now < kick(w)) iv = Math.max(55, Math.min(iv, (kick(w) - now) / 1000 + 30));
  return iv;
}

// ---------------------------------------------------------------------------
// Neue Ereignisse erkennen und melden
// ---------------------------------------------------------------------------
function slim(f) {
  return {
    fixture: { id: f.fixture.id, date: f.fixture.date, status: { short: f.fixture.status.short, elapsed: f.fixture.status.elapsed, extra: f.fixture.status.extra || null } },
    league: { id: f.league.id, name: f.league.name, round: f.league.round },
    teams: { home: { name: f.teams.home.name }, away: { name: f.teams.away.name } },
    goals: { home: f.goals.home, away: f.goals.away },
    score: { penalty: f.score && f.score.penalty ? { home: f.score.penalty.home, away: f.score.penalty.away } : { home: null, away: null } },
    events: (f.events || []).map((e) => ({
      time: { elapsed: e.time.elapsed, extra: e.time.extra }, team: { name: e.team ? e.team.name : "" },
      player: { name: e.player ? e.player.name : "" }, assist: { name: e.assist ? e.assist.name : null },
      type: e.type, detail: e.detail,
    })),
  };
}
function evKey(e) { return [e.time.elapsed, e.time.extra || 0, e.type, e.detail, e.team && e.team.name, e.player && e.player.name].join("|"); }
function minute(e) { return e.time.elapsed + (e.time.extra ? "+" + e.time.extra : "") + "'"; }

async function handleUpdate(env, s, w, raw) {
  const f = slim(raw);
  const id = f.fixture.id;
  if (!s.notified[id]) s.notified = { [id]: { ev: [], ko: false, ht: false, ft: false, gh: 0, ga: 0, init: false } };
  const N = s.notified[id];
  const st = f.fixture.status.short;
  const h = f.teams.home.name, a = f.teams.away.name;
  const gh = f.goals.home || 0, ga = f.goals.away || 0;
  const line = h + " " + gh + ":" + ga + " " + a;
  const comp = LEAGUE_NAMES[f.league.id] || f.league.name || "";
  const fbHome = isFb(h);

  // Der Helfer wurde erst während des Spiels gestartet: alte Ereignisse nicht nachmelden
  if (!N.init) {
    N.init = true;
    if (PLAYING.indexOf(st) >= 0 && (f.events.length || (f.fixture.status.elapsed || 0) > 3)) {
      N.ko = true; N.ev = f.events.map(evKey); N.gh = gh; N.ga = ga; if (st === "HT") N.ht = true;
      await push(env, { title: "Fener live · " + comp, message: "Der Helfer ist dabei: " + line + " (" + (f.fixture.status.elapsed || 0) + "')", tags: ["soccer"], priority: 3 });
    }
  }

  if (!N.ko && PLAYING.indexOf(st) >= 0) {
    N.ko = true;
    await push(env, { title: "Anpfiff · " + comp, message: h + " – " + a + " läuft!", tags: ["stopwatch"], priority: 3 });
  }

  let goalPushed = false;
  for (const e of f.events) {
    const k = evKey(e);
    if (N.ev.indexOf(k) >= 0) continue;
    N.ev.push(k);
    const fb = isFb(e.team.name);
    if (e.type === "Goal" && e.detail !== "Missed Penalty") {
      goalPushed = true;
      const how = e.detail === "Penalty" ? " (Elfmeter)" : e.detail === "Own Goal" ? " (Eigentor)" : "";
      const as = e.assist && e.assist.name ? ", Vorlage " + e.assist.name : "";
      await push(env, fb
        ? { title: "⚽ TOR für Fenerbahçe!", message: e.player.name + how + " " + minute(e) + as + "\n" + line, tags: ["soccer", "yellow_heart", "blue_heart"], priority: 5 }
        : { title: "Gegentor · " + e.team.name, message: e.player.name + how + " " + minute(e) + "\n" + line, tags: ["soccer"], priority: 4 });
    } else if (e.type === "Goal" && e.detail === "Missed Penalty") {
      await push(env, { title: "Elfmeter verschossen", message: e.player.name + " (" + e.team.name + ") " + minute(e) + "\n" + line, tags: ["x"], priority: 3 });
    } else if (e.type === "Card" && /Red|Second/.test(e.detail)) {
      await push(env, { title: "🟥 Rote Karte" + (fb ? " für Fener" : ""), message: e.player.name + " (" + e.team.name + ") " + minute(e) + "\n" + line, tags: ["red_circle"], priority: 4 });
    } else if (e.type === "Var" && /cancel|disallow/i.test(e.detail || "")) {
      await push(env, { title: "Videobeweis: Tor zurückgenommen", message: (e.player.name ? e.player.name + " " : "") + minute(e) + "\n" + line, tags: ["tv"], priority: 4 });
    }
  }
  // Falls ein Tor ohne Ereignis-Daten auftaucht
  if (!goalPushed && gh + ga > N.gh + N.ga) {
    const fbScored = (fbHome ? gh > N.gh : ga > N.ga);
    await push(env, { title: fbScored ? "⚽ TOR für Fenerbahçe!" : "Gegentor", message: line, tags: ["soccer"], priority: fbScored ? 5 : 4 });
  }
  N.gh = gh; N.ga = ga;

  if (!N.ht && st === "HT") {
    N.ht = true;
    await push(env, { title: "Halbzeit", message: line, tags: ["pause_button"], priority: 2 });
  }
  if (!N.ft && FINISHED.indexOf(st) >= 0) {
    N.ft = true;
    const fg = fbHome ? gh : ga, og = fbHome ? ga : gh;
    let verdict = fg > og ? "Sieg! 💛💙" : fg < og ? "Niederlage." : "Unentschieden.";
    const ph = f.score.penalty.home, pa = f.score.penalty.away;
    if (ph !== null && pa !== null) verdict = ((fbHome ? ph > pa : pa > ph) ? "Weiter im Elfmeterschießen! " : "Raus im Elfmeterschießen. ") + ph + ":" + pa + " i.E.";
    await push(env, { title: "Abpfiff · " + comp, message: line + "\n" + verdict, tags: ["checkered_flag"], priority: 4 });
    s.lastLive = f;
  }

  // Spielplan mit dem Live-Stand aktuell halten
  const fx = s.fixtures.find((x) => x.id === id);
  if (fx) { fx.st = st; fx.gh = f.goals.home; fx.ga = f.goals.away; fx.ph = f.score.penalty.home; fx.pa = f.score.penalty.away; }
  s.live = f;
}
