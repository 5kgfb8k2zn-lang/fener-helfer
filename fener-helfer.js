// Fener-Helfer – Cloudflare Worker
// Holt die Fenerbahçe-Spiele kostenlos von TheSportsDB und schickt Push-Nachrichten über ntfy.
// Die App holt sich den Stand über /state.
//
// Benötigt in Cloudflare:
//   Secret   NTFY_TOPIC  – geheimer Kanalname in der ntfy-App
//   D1       DB          – Datenbank-Bindung (Name der Variable: DB)
//   Cron     * * * * *   – jede Minute
// Optional: NTFY_SERVER (Standard https://ntfy.sh), APP_URL (Link beim Antippen der Nachricht)

const SEASON = 2026;
const VERSION = 8;
const FINISHED = ["FT", "AET", "PEN"];
const STOP = FINISHED.concat(["PST", "CANC", "ABD", "AWD", "WO"]);
const PLAYING = ["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT", "SUSP"];
const LEAGUE_NAMES = { 203: "Süper Lig", 2: "Champions League", 206: "Türkiye Kupası" };

// Welche Nachrichten verschickt werden (in der App unter Live → Hintergrund-Helfer einstellbar)
const DEFAULT_PREFS = { reminder: true, kickoff: true, goals: true, oppgoals: true, ht: true, ft: true, rivals: true, chance: true };
let PREFS = Object.assign({}, DEFAULT_PREFS);
function setPrefs(s) { PREFS = Object.assign({}, DEFAULT_PREFS, s.prefs || {}); }

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
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    if (req.method === "OPTIONS") return new Response(null, { headers });
    try {
      if (url.pathname === "/settings") {
        const s = await load(env);
        if (req.method === "POST") {
          let body = {};
          try { body = JSON.parse(await req.text()); } catch (e) { /* leer */ }
          const next = Object.assign({}, DEFAULT_PREFS, s.prefs || {});
          Object.keys(DEFAULT_PREFS).forEach((k) => { if (typeof body[k] === "boolean") next[k] = body[k]; });
          s.prefs = next;
          await save(env, s);
        }
        return new Response(JSON.stringify({ prefs: Object.assign({}, DEFAULT_PREFS, s.prefs || {}) }), { headers });
      }
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
  return { v: VERSION, teamId: null, fixtures: [], table: [], syncedAt: 0, syncFailAt: 0, live: null, lastLive: null, notified: {}, usage: { day: "", n: 0 }, lastPollAt: 0, error: "", testAt: 0, pushError: "", rivalIds: {}, rivalFx: [], rivalPollAt: 0, reminded: {} };
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
    v: VERSION, now: Date.now(), source: "tsdb", syncedAt: s.syncedAt, fixtures: s.fixtures, table: s.table,
    live: s.live, lastLive: s.lastLive, usage: s.usage, lastPollAt: s.lastPollAt,
    error: s.error, pushError: s.pushError || "", push: !!env.NTFY_TOPIC,
    prefs: Object.assign({}, DEFAULT_PREFS, s.prefs || {}),
    rivals: (s.rivalFx || []).map((r) => ({ id: r.id, date: r.date, h: r.h, a: r.a, st: r.st, gh: r.gh, ga: r.ga })),
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
    row(true, "Datenquelle TheSportsDB (kostenlos, kein Schlüssel nötig)"),
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
<section class="card"><div class="label">Status</div><ul>${checks}</ul><small>Nächstes Spiel: ${next} · heute ${s.usage && s.usage.day === utcDay() ? s.usage.n : 0} Abfragen bei TheSportsDB (kein Tageslimit)</small>${s.error ? `<small style="color:var(--no)">Problem: ${esc(s.error)}</small>` : ""}</section>
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
function nextFx(s, now) { return sorted(s).find((a) => STOP.indexOf(a.st) < 0 && kick(a) > now - 150 * 60000) || null; }


// Schickt eine Nachricht an ntfy. Gibt { ok, error } zurück.
// Optional: NTFY_TOKEN (Zugangs-Token eines kostenlosen ntfy-Kontos), falls ntfy Anfragen von Cloudflare drosselt.
async function push(env, msg) {
  if (msg.cat && PREFS[msg.cat] === false) return { ok: true, skipped: true };
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
// Prognose: Stärkewerte (wie in der App) und Poisson-Modell
// ---------------------------------------------------------------------------
const FB_RATING = 84;
const RATINGS = [["galatasaray", 84], ["besiktas", 80], ["trabzon", 79], ["basaksehir", 75], ["amed", 74], ["samsun", 73], ["alanya", 72], ["goztepe", 72], ["kocaeli", 71], ["rize", 71], ["kasimpasa", 70], ["konya", 70], ["gaziantep", 70], ["corum", 69], ["gencler", 68], ["erzurum", 68], ["eyup", 67],
  ["liverpool", 89], ["atletico", 86], ["astonvilla", 83], ["roma", 82], ["villarreal", 82], ["shakhtar", 77], ["slavia", 76], ["lask", 72], ["realmadrid", 91], ["bayern", 90], ["barcelona", 89], ["arsenal", 89], ["manchestercity", 89], ["mancity", 89], ["parissaint", 89], ["psg", 89], ["inter", 87], ["chelsea", 86], ["napoli", 85], ["leverkusen", 84], ["dortmund", 84], ["juventus", 84], ["benfica", 82], ["sporting", 82], ["porto", 81], ["psv", 81], ["marseille", 81], ["brugge", 79]];
const RIVALS = [["galatasaray", "Galatasaray"], ["besiktas", "Beşiktaş"], ["trabzon", "Trabzonspor"]];
function rating(name, league) {
  if (isFb(name)) return FB_RATING;
  const k = norm(name);
  const r = RATINGS.find((x) => k.indexOf(x[0]) >= 0);
  return r ? r[1] : league === 203 ? 70 : 78;
}
function pois(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
// Wahrscheinlichkeit für Sieg/Remis/Niederlage aus Fener-Sicht.
// cur = [Fener-Tore, Gegner-Tore] bisher, rest = Anteil der Spielzeit, der noch fehlt (0..1)
function outcome(fbR, opR, adv, cur, rest, fbReds, opReds) {
  const d = (fbR - opR + adv) / 22.5;
  let lf = 1.35 * Math.exp(d) * rest, lo = 1.35 * Math.exp(-d) * rest;
  lf *= Math.pow(0.8, fbReds || 0) * Math.pow(1.15, opReds || 0);
  lo *= Math.pow(0.8, opReds || 0) * Math.pow(1.15, fbReds || 0);
  let w = 0, dr = 0, l = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(i, lf) * pois(j, lo), f = cur[0] + i, o = cur[1] + j;
    if (f > o) w += p; else if (f === o) dr += p; else l += p;
  }
  const t = w + dr + l || 1;
  return { w: w / t, d: dr / t, l: l / t };
}
function pct(x) { return Math.round(x * 100) + " %"; }
function berlin(ts, opt) { return new Date(ts).toLocaleString("de-DE", Object.assign({ timeZone: "Europe/Berlin" }, opt)); }
function berlinDay(ts) { return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" }); }
function berlinHour(ts) { return +new Date(ts).toLocaleString("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }); }

// Live-Siegchance aus dem aktuellen Spielstand
function liveChance(f) {
  const fbHome = isFb(f.teams.home.name);
  const st = f.fixture.status.short, el = f.fixture.status.elapsed || 0;
  if (["ET", "BT", "P"].indexOf(st) >= 0 || FINISHED.indexOf(st) >= 0) return null;
  const rest = st === "HT" ? 0.5 : Math.max(0.02, (90 - Math.min(el, 90)) / 90);
  const opName = fbHome ? f.teams.away.name : f.teams.home.name;
  const gh = f.goals.home || 0, ga = f.goals.away || 0;
  let fbReds = 0, opReds = 0;
  (f.events || []).forEach((e) => { if (e.type === "Card" && /Red|Second/.test(e.detail)) { if (isFb(e.team.name)) fbReds++; else opReds++; } });
  const neutral = /final/i.test(f.league.round || "") && f.league.id !== 203;
  return outcome(FB_RATING, rating(opName, f.league.id), neutral ? 0 : fbHome ? 3 : -3, fbHome ? [gh, ga] : [ga, gh], rest, fbReds, opReds);
}
function chanceLine(f) {
  if (!PREFS.chance) return "";
  const c = liveChance(f);
  if (!c) return "";
  return "\nSiegchance jetzt " + pct(c.w) + " · Remis " + pct(c.d);
}


// ---------------------------------------------------------------------------
// Jede Minute
// ---------------------------------------------------------------------------
async function tick(env) {
  const s = await load(env);
  setPrefs(s);
  return tickTsdb(env, s, Date.now());
}

async function maybeRemind(env, s, now) {
  // Erinnerung am Spieltag (ab 9 Uhr deutscher Zeit, bei frühem Anpfiff 3 Std. vorher) – kostet keine Anfrage
  const todayFx = sorted(s).find((a) => STOP.indexOf(a.st) < 0 && berlinDay(kick(a)) === berlinDay(now) && kick(a) > now + 20 * 60000);
  if (todayFx && !(s.reminded || {})[todayFx.id] && (berlinHour(now) >= 9 || now >= kick(todayFx) - 3 * 3600 * 1000)) {
    s.reminded = { [todayFx.id]: true };
    const fbHome = isFb(todayFx.h), opp = fbHome ? todayFx.a : todayFx.h;
    const neutral = /final/i.test(todayFx.round || "") && todayFx.lg !== 203;
    const c = outcome(FB_RATING, rating(opp, todayFx.lg), neutral ? 0 : fbHome ? 3 : -3, [0, 0], 1, 0, 0);
    await push(env, {
      cat: "reminder", title: "Heute spielt Fener! " + berlin(kick(todayFx), { hour: "2-digit", minute: "2-digit" }) + " Uhr",
      message: todayFx.h + " – " + todayFx.a + " (" + (LEAGUE_NAMES[todayFx.lg] || "") + ")\nPrognose: Sieg " + pct(c.w) + " · Remis " + pct(c.d) + " · Niederlage " + pct(c.l) + "\nSchon getippt? Tippspiel in der Fener-App.",
      tags: ["calendar", "soccer"], priority: 3,
    });
    return true;
  }
  return false;

}

async function pushRival(env, s, r) {
  const isH = !!s.rivalIds[r.hid];
  const name = s.rivalIds[isH ? r.hid : r.aid];
  const opp = isH ? r.a : r.h;
  const my = isH ? r.gh : r.ga, their = isH ? r.ga : r.gh;
  const res = my > their ? "w" : my === their ? "d" : "l";
  const title = res === "l" ? "😄 " + name + " verliert!" : res === "d" ? name + " nur Remis" : name + " gewinnt";
  let msg = r.h + " " + r.gh + ":" + r.ga + " " + r.a;
  // Abstand zu Fener nach dieser Partie (aus dem letzten Tabellenstand)
  const row = (t) => s.table.find((x) => (t === "fb" ? isFb(x.n) : norm(x.n).indexOf(RIVALS.find((y) => y[1] === name)[0]) >= 0));
  const fbRow = row("fb"), rvRow = row("rv");
  if (fbRow && rvRow) {
    const already = s.syncedAt > kick(r) + 120 * 60000;
    const rvPts = rvRow.pts + (already ? 0 : res === "w" ? 3 : res === "d" ? 1 : 0);
    const gap = fbRow.pts - rvPts;
    msg += "\n" + (gap > 0 ? "Fener " + gap + (gap === 1 ? " Punkt" : " Punkte") + " vor " + name : gap < 0 ? "Fener " + -gap + (gap === -1 ? " Punkt" : " Punkte") + " hinter " + name : "Fener und " + name + " punktgleich") + " (Fener hat " + fbRow.p + ", " + name + " " + (rvRow.p + (already ? 0 : 1)) + " Spiele).";
  }
  await push(env, { cat: "rivals", title: title, message: msg, tags: res === "l" ? ["tada"] : res === "d" ? ["neutral_face"] : ["pensive"], priority: res === "w" ? 2 : 3 });
}





// ===========================================================================
// Datenquelle TheSportsDB (kostenlos, für private Projekte erlaubt)
// Kein Live-Ticker im Free-Plan: Spielstände kommen, sobald TheSportsDB sie einträgt.
// Abgefragt wird während eines Fener-Spiels jede Minute, danach alle 10 Minuten bis zum Endergebnis.
// ===========================================================================
const TSDB = "https://www.thesportsdb.com/api/v1/json/";
const TSDB_FENER = 133807;            // Fenerbahçe bei TheSportsDB (wird beim ersten Mal per Suche geprüft)
const TSDB_LEAGUES = { 4339: 203, 4480: 2 };
const TSDB_SEASON = "2026-2027";

async function tsdbGet(env, s, path) {
  if (s.usage.day !== utcDay()) s.usage = { day: utcDay(), n: 0 };
  s.usage.n++;
  const r = await fetch(TSDB + (env.TSDB_KEY || "123") + "/" + path);
  if (r.status === 429) throw new Error("TheSportsDB: kurz zu viele Anfragen, es geht in einer Minute weiter.");
  const t = await r.text();
  try { return JSON.parse(t) || {}; } catch (e) { throw new Error("TheSportsDB antwortet unerwartet (" + r.status + "): " + t.slice(0, 80)); }
}
function n0(x) { return x === null || x === undefined || x === "" ? null : +x; }
function tsLeague(e) {
  if (TSDB_LEAGUES[+e.idLeague]) return TSDB_LEAGUES[+e.idLeague];
  const l = norm(e.strLeague);
  if (l.indexOf("champions") >= 0) return 2;
  if (l.indexOf("cup") >= 0 || l.indexOf("kupa") >= 0) return 206;
  if (l.indexOf("superlig") >= 0 || l.indexOf("turkish") >= 0) return 203;
  return 0;
}
function tsDate(e) {
  if (e.strTimestamp) { const t = String(e.strTimestamp).replace(" ", "T"); return /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + "Z"; }
  const tm = String(e.strTime || "18:00:00").slice(0, 8);
  return (e.dateEvent || utcDay()) + "T" + tm + "Z";
}
function tsStatus(e, now) {
  const st = String(e.strStatus || "").trim().toLowerCase();
  const k = Date.parse(tsDate(e));
  const hasScore = e.intHomeScore !== null && e.intHomeScore !== undefined && e.intHomeScore !== "";
  if (/postpon|cancel|abandon|pst|canc/.test(st)) return "PST";
  if (/finish|^ft$|^aet$|^pen|after/.test(st)) return /pen/.test(st) ? "PEN" : /aet|extra/.test(st) ? "AET" : "FT";
  if (/^ht$|half ?time/.test(st)) return "HT";
  if (/^1h$|first half/.test(st)) return "1H";
  if (/^2h$|second half/.test(st)) return "2H";
  if (/live|in play|^et$/.test(st)) return "2H";
  if (hasScore && now > k + 110 * 60000) return "FT";
  if (hasScore && now >= k) return now < k + 50 * 60000 ? "1H" : "2H";
  return "NS";
}
function tsRound(e, lg) {
  const r = e.intRound ? String(e.intRound) : "";
  if (lg === 203 && r) return "Regular Season - " + r;
  if (lg === 2 && r && +r <= 8) return "League Stage - " + r;
  return e.strLeague || "";
}
function tsCompact(e, now) {
  const lg = tsLeague(e);
  return { id: +e.idEvent, date: tsDate(e), st: tsStatus(e, now), lg: lg, round: tsRound(e, lg), h: e.strHomeTeam, a: e.strAwayTeam, hid: +e.idHomeTeam, aid: +e.idAwayTeam, gh: n0(e.intHomeScore), ga: n0(e.intAwayScore), ph: null, pa: null };
}
function tsLive(c) {
  return { fixture: { id: c.id, date: c.date, status: { short: c.st, elapsed: null } }, league: { id: c.lg, name: LEAGUE_NAMES[c.lg] || "", round: c.round }, teams: { home: { name: c.h }, away: { name: c.a } }, goals: { home: c.gh, away: c.ga }, score: { penalty: { home: null, away: null } }, events: [], source: "tsdb" };
}
function upsert(list, c) {
  const i = list.findIndex((x) => x.id === c.id);
  if (i < 0) list.push(c); else list[i] = Object.assign(list[i], c);
}
async function tsdbTeamId(env, s, name, fallback) {
  try {
    const j = await tsdbGet(env, s, "searchteams.php?t=" + encodeURIComponent(name));
    const t = (j.teams || []).find((x) => /soccer/i.test(x.strSport || "soccer") && !/women|kadın/i.test(x.strTeam || ""));
    if (t) return +t.idTeam;
  } catch (e) { /* Rückfall unten */ }
  return fallback || null;
}

async function syncTsdb(env, s, now) {
  const T = s.tsdb || (s.tsdb = {});
  if (!T.teamId) T.teamId = TSDB_FENER;
  const nx = await tsdbGet(env, s, "eventsnext.php?id=" + T.teamId);
  const ls = await tsdbGet(env, s, "eventslast.php?id=" + T.teamId);
  (nx.events || []).concat(ls.results || []).forEach((e) => upsert(s.fixtures, tsCompact(e, now)));
  // Tabelle der Süper Lig
  try {
    const tb = await tsdbGet(env, s, "lookuptable.php?l=4339&s=" + TSDB_SEASON);
    const rows = tb.table || [];
    if (rows.length) s.table = rows.map((t) => ({ n: t.strTeam, p: +t.intPlayed, pts: +t.intPoints, gf: +t.intGoalsFor, ga: +t.intGoalsAgainst, id: +t.idTeam }));
    T.tableRows = rows.length;
  } catch (e) { T.tableErr = String(e.message || e); }
  // Rivalen: ihre nächsten Ligaspiele
  if (!T.rivals) {
    T.rivals = {};
    const search = { "Galatasaray": "Galatasaray", "Beşiktaş": "Besiktas", "Trabzonspor": "Trabzonspor" };
    for (const r of RIVALS) { const id = await tsdbTeamId(env, s, search[r[1]], null); if (id) T.rivals[id] = r[1]; }
  }
  s.rivalIds = T.rivals;
  for (const id of Object.keys(T.rivals)) {
    try {
      const j = await tsdbGet(env, s, "eventsnext.php?id=" + id);
      (j.events || []).forEach((e) => {
        const c = tsCompact(e, now);
        if (c.lg !== 203 || isFb(c.h) || isFb(c.a)) return;
        if (!s.rivalFx.some((x) => x.id === c.id)) s.rivalFx.push(Object.assign(c, { done: FINISHED.indexOf(c.st) >= 0 }));
      });
    } catch (e) { /* nächster Rivale */ }
  }
  T.fixtures = s.fixtures.length;
  s.syncedAt = now; s.syncFailAt = 0;
}

async function tickTsdb(env, s, now) {
  let dirty = false;
  if (s.source !== "tsdb") {
    // Alte Daten aus früheren Versionen verwerfen
    Object.assign(s, { source: "tsdb", fixtures: [], table: [], rivalFx: [], rivalIds: {}, notified: {}, live: null, lastLive: null, syncedAt: 0, syncFailAt: 0, error: "", tsdb: {}, chanceLog: null });
    dirty = true;
  }
  if (s.usage.day !== utcDay()) { s.usage = { day: utcDay(), n: 0 }; dirty = true; }
  const needs = !s.syncedAt || now - s.syncedAt > 6 * 3600 * 1000 || s.fixtures.some((a) => { const e = kick(a) + 115 * 60000; return e > s.syncedAt && e < now && FINISHED.indexOf(a.st) < 0; });
  if (needs && !(s.syncFailAt && now - s.syncFailAt < 20 * 60000) && !(s.syncedAt && now - s.syncedAt < 15 * 60000)) {
    try { await syncTsdb(env, s, now); s.error = ""; } catch (e) { s.error = String(e.message || e); s.syncFailAt = now; }
    dirty = true;
  }

  // Fener-Spiel: von Anpfiff bis Endergebnis beobachten
  const w = sorted(s).find((a) => STOP.indexOf(a.st) < 0 && now >= kick(a) - 5 * 60000 && now <= kick(a) + 8 * 3600 * 1000);
  if (w) {
    const iv = now < kick(w) + 130 * 60000 ? 60000 : 10 * 60000; // während des Spiels jede Minute, danach alle 10 Minuten
    if (now - (s.lastPollAt || 0) >= iv - 5000) {
      s.lastPollAt = now;
      try {
        const j = await tsdbGet(env, s, "lookupevent.php?id=" + w.id);
        const e = (j.events || [])[0];
        if (e) await handleTsdb(env, s, w, tsCompact(e, now));
        s.error = "";
      } catch (e) { s.error = String(e.message || e); }
      dirty = true;
    }
  }

  if (await maybeRemind(env, s, now)) dirty = true;

  // Rivalen: Endergebnis nachsehen (alle 20 Minuten nach Spielende, bis zu 12 Stunden)
  if (s.rivalFx && s.rivalFx.length && now - (s.rivalPollAt || 0) >= 20 * 60000) {
    const due = s.rivalFx.filter((r) => !r.done && now >= kick(r) + 110 * 60000 && now <= kick(r) + 12 * 3600 * 1000).slice(0, 3);
    if (due.length) {
      s.rivalPollAt = now;
      for (const r of due) {
        try {
          const j = await tsdbGet(env, s, "lookupevent.php?id=" + r.id);
          const e = (j.events || [])[0]; if (!e) continue;
          const c = tsCompact(e, now);
          Object.assign(r, { st: c.st, gh: c.gh, ga: c.ga });
          if (c.st === "PST") r.done = true;
          else if (FINISHED.indexOf(c.st) >= 0 && c.gh !== null) { r.done = true; await pushRival(env, s, r); }
        } catch (e) { /* später nochmal */ }
      }
      dirty = true;
    }
    const before = s.rivalFx.length;
    s.rivalFx = s.rivalFx.filter((r) => now - kick(r) < 36 * 3600 * 1000);
    if (s.rivalFx.length !== before) dirty = true;
  }
  if (dirty) await save(env, s);
}

// Neue Spielstände aus TheSportsDB melden
async function handleTsdb(env, s, w, c) {
  const id = c.id;
  if (!s.notified[id]) s.notified = { [id]: { ko: false, ht: false, ft: false, gh: 0, ga: 0 } };
  const N = s.notified[id];
  const comp = LEAGUE_NAMES[c.lg] || "";
  const gh = c.gh || 0, ga = c.ga || 0, fbHome = isFb(c.h);
  const line = c.h + " " + gh + ":" + ga + " " + c.a;
  const f = tsLive(c);
  const mins = (Date.now() - kick(c)) / 60000;
  f.fixture.status.elapsed = c.st === "HT" ? 45 : Math.max(0, Math.min(90, Math.round(mins > 60 ? mins - 15 : Math.min(45, mins))));
  if (!N.ko && PLAYING.indexOf(c.st) >= 0) { N.ko = true; await push(env, { cat: "kickoff", title: "Anpfiff · " + comp, message: c.h + " – " + c.a + " läuft! Spielstände kommen von TheSportsDB und können verzögert sein.", tags: ["stopwatch"], priority: 3 }); }
  if (FINISHED.indexOf(c.st) < 0 && gh + ga > N.gh + N.ga) {
    const fbScored = fbHome ? gh > N.gh : ga > N.ga;
    await push(env, { cat: fbScored ? "goals" : "oppgoals", title: fbScored ? "⚽ TOR für Fenerbahçe!" : "Gegentor", message: line + chanceLine(f) + "\n(Stand laut TheSportsDB, evtl. verzögert)", tags: ["soccer"], priority: fbScored ? 5 : 4 });
  }
  N.gh = gh; N.ga = ga;
  if (!N.ht && c.st === "HT") { N.ht = true; await push(env, { cat: "ht", title: "Halbzeit", message: line + chanceLine(f), tags: ["pause_button"], priority: 2 }); }
  if (!N.ft && FINISHED.indexOf(c.st) >= 0 && c.gh !== null) {
    N.ft = true;
    const fg = fbHome ? gh : ga, og = fbHome ? ga : gh;
    await push(env, { cat: "ft", title: "Endergebnis · " + comp, message: line + "\n" + (fg > og ? "Sieg! 💛💙" : fg < og ? "Niederlage." : "Unentschieden."), tags: ["checkered_flag"], priority: 4 });
    s.lastLive = f;
  }
  // Verlauf der Siegchance für die Grafik in der App
  if (!s.chanceLog || s.chanceLog.id !== id) {
    const opp = fbHome ? c.a : c.h;
    const pre = outcome(FB_RATING, rating(opp, c.lg), fbHome ? 3 : -3, [0, 0], 1, 0, 0);
    s.chanceLog = { id: id, pts: [{ m: 0, w: Math.round(pre.w * 100), d: Math.round(pre.d * 100) }] };
  }
  const lastPt = s.chanceLog.pts[s.chanceLog.pts.length - 1];
  if (FINISHED.indexOf(c.st) >= 0 && c.gh !== null) {
    const fg = fbHome ? gh : ga, og = fbHome ? ga : gh;
    if (!lastPt.end) s.chanceLog.pts.push({ m: Math.max(90, lastPt.m + 1), w: fg > og ? 100 : 0, d: fg === og ? 100 : 0, end: true });
  } else if (PLAYING.indexOf(c.st) >= 0) {
    const ch = liveChance(f), el = f.fixture.status.elapsed || 0;
    if (ch && el > lastPt.m) s.chanceLog.pts.push({ m: el, w: Math.round(ch.w * 100), d: Math.round(ch.d * 100) });
  }
  f.chance = s.chanceLog.pts;
  if (s.lastLive && s.lastLive.fixture.id === id) s.lastLive = f;
  upsert(s.fixtures, c);
  s.live = f;
}
