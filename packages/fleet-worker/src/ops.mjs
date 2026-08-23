/**
 * In-Worker ops console. Cookie session + ADMIN_EMAILS only — not HUB_TOKEN,
 * actor.super, or Fleet-OAEP. Empty ADMIN_EMAILS = nobody is an admin.
 * Non-admins get 404 (no teaser).
 */

export const BAN_COPY_ZH = "操作不了你的机子，只是用于异常账号识别";
export const BAN_COPY_EN =
  "Cannot operate your machines. This is only for identifying abnormal accounts.";

export const FRESHNESS_NOTE =
  "Last-seen freshness only — not packet loss, congestion, or traffic.";

const SENSITIVE_KEYS = new Set(["name", "hostname", "ip"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, x-device-id, x-device-name, x-device-os, x-fleet-proto, x-fleet-operator",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const RECENT_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function parseAdminEmails(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isOpsAdmin(actor, adminEmailsRaw) {
  if (!actor || actor.super || actor.banned) return false;
  const email = String(actor.email || "")
    .trim()
    .toLowerCase();
  if (!email) return false;
  return parseAdminEmails(adminEmailsRaw).includes(email);
}

export function banTargetError(actor, targetId, banned, adminEmailsRaw, users) {
  const id = String(targetId || "").trim();
  if (!id || typeof banned !== "boolean") return "id and banned required";
  if (id === String(actor?.id || "").trim()) return "cannot ban yourself";
  if (banned) {
    const emails = parseAdminEmails(adminEmailsRaw);
    const row = Array.isArray(users) ? users.find((u) => u && String(u.id) === id) : null;
    const email = String(row?.email || "")
      .trim()
      .toLowerCase();
    if (email && emails.includes(email)) return "cannot ban an admin";
  }
  return "";
}

export function opsNotFound(kind = "json") {
  if (kind === "html") {
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return json({ error: "not found" }, 404);
}

export function classifyOs(os) {
  const s = String(os || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.startsWith("darwin") || s.startsWith("mac")) return "mac";
  if (s.startsWith("win")) return "windows";
  if (s.startsWith("linux")) return "linux";
  return "unknown";
}

export function classifyArch(arch) {
  const s = String(arch || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s === "arm64" || s === "aarch64") return "arm64";
  if (s === "amd64" || s === "x86_64" || s === "x64" || s === "x86" || s === "386" || s === "i386" || s === "i686") {
    return "amd64";
  }
  return "unknown";
}

export function freshnessBucket(lastSeen, now = Date.now()) {
  const t = Number(lastSeen);
  if (!Number.isFinite(t) || t <= 0) return "unknown";
  const age = now - t;
  if (age <= RECENT_MS) return "recent";
  if (age <= HOUR_MS) return "hour";
  if (age <= DAY_MS) return "day";
  return "stale";
}

export function userHasToken(user) {
  if (!user || typeof user !== "object") return false;
  return Boolean(user.token || user.hasToken || user.tokenHash || user.kid);
}

export function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out;
  }
  return value;
}

export function deviceOpsPublic(row) {
  if (!row || typeof row !== "object" || !row.id) return null;
  return {
    id: String(row.id),
    os: row.os == null ? "" : String(row.os),
    arch: row.arch == null ? "" : String(row.arch),
    agentVer: row.agentVer == null ? "" : String(row.agentVer),
    online: Boolean(row.online),
    lastSeen: Number(row.lastSeen) || 0,
    userId: row.userId == null ? "" : String(row.userId),
  };
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

export function buildOverview(catalog = {}, now = Date.now()) {
  const users = Array.isArray(catalog.users) ? catalog.users.filter((u) => u && u.id && u.email) : [];
  const devices = Array.isArray(catalog.devices) ? catalog.devices : [];

  const os = { mac: 0, windows: 0, linux: 0, unknown: 0 };
  const arch = { arm64: 0, amd64: 0, unknown: 0 };
  const agentVer = {};
  const freshness = { recent: 0, hour: 0, day: 0, stale: 0, unknown: 0 };
  let online = 0;
  let offline = 0;
  const deviceRows = [];

  for (const raw of devices) {
    const d = deviceOpsPublic(raw);
    if (!d) continue;
    deviceRows.push({
      id: d.id,
      os: d.os,
      arch: d.arch,
      agentVer: d.agentVer,
      online: d.online,
      lastSeen: d.lastSeen,
    });
    if (d.online) online += 1;
    else offline += 1;
    bump(os, classifyOs(d.os));
    bump(arch, classifyArch(d.arch));
    bump(agentVer, d.agentVer.trim() ? d.agentVer.trim() : "unknown");
    bump(freshness, freshnessBucket(d.lastSeen, now));
  }

  const accounts = users.map((u) => {
    const mine = devices.map(deviceOpsPublic).filter((d) => d && d.userId === u.id);
    const breakdown = { os: {}, arch: {}, agentVer: {} };
    for (const d of mine) {
      bump(breakdown.os, classifyOs(d.os));
      bump(breakdown.arch, classifyArch(d.arch));
      bump(breakdown.agentVer, d.agentVer.trim() ? d.agentVer.trim() : "unknown");
    }
    return {
      id: String(u.id),
      email: String(u.email),
      banned: Boolean(u.banned),
      token: userHasToken(u),
      devices: mine.length,
      os: breakdown.os,
      arch: breakdown.arch,
      agentVer: breakdown.agentVer,
    };
  });

  return stripSensitive({
    users: users.length,
    tokens: users.filter(userHasToken).length,
    devices: { total: deviceRows.length, online, offline },
    os,
    arch,
    agentVer,
    freshness,
    freshnessNote: FRESHNESS_NOTE,
    accounts,
    deviceRows,
  });
}

export async function handleOpsRoute(input) {
  const path = String(input.path || "").replace(/\/+$/, "") || "/";
  const method = String(input.method || "GET").toUpperCase();
  const html = path === "/ops";
  if (!isOpsAdmin(input.actor, input.adminEmails)) return opsNotFound(html ? "html" : "json");

  if (path === "/ops" && method === "GET") {
    return new Response(opsPageHtml(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/v1/ops/overview" && method === "GET") {
    const body = buildOverview({ users: input.users, devices: input.devices });
    return json({ ...body, me: String(input.actor?.id || "") });
  }

  if (path === "/v1/ops/banned" && method === "POST") {
    const id = String(input.body?.id || "").trim();
    const banned = input.body?.banned;
    const deny = banTargetError(input.actor, id, banned, input.adminEmails, input.users);
    if (deny) return json({ error: deny }, 400);
    if (typeof input.setBanned !== "function") return json({ error: "not found" }, 404);
    const row = await input.setBanned(id, banned);
    if (!row) return json({ error: "not found" }, 404);
    return json({ ok: true, id: row.id, banned: Boolean(row.banned) });
  }

  return opsNotFound(html ? "html" : "json");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export function opsPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fleet</title>
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <script>
      (function () {
        try {
          var p = localStorage.getItem("fleet-theme") || "system";
          var d = window.matchMedia("(prefers-color-scheme: dark)").matches;
          var r = p === "system" ? (d ? "dark" : "light") : p;
          document.documentElement.setAttribute("data-theme", r);
          document.documentElement.setAttribute("data-theme-pref", p);
          document.documentElement.style.colorScheme = r;
        } catch (e) {}
      })();
    </script>
    <style>
      :root { --sans: Inter, ui-sans-serif, system-ui, sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      html[data-theme="light"] {
        color-scheme: light;
        --bg:#f7f7f8; --surface:#fff; --elevated:#ececec; --fg:#0d0d0d; --muted:#6e6e80; --subtle:#8e8ea0;
        --border:#e5e5e5; --accent:#0d0d0d; --accent-fg:#fff; --ok:#0f7b4c; --warn:#9a6700; --bad:#c7381a;
        --shadow:0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.04);
      }
      html[data-theme="dark"] {
        color-scheme: dark;
        --bg:#212121; --surface:#2f2f2f; --elevated:#3a3a3a; --fg:#ececec; --muted:#b4b4b4; --subtle:#8f8f8f;
        --border:rgba(255,255,255,.1); --accent:#ececec; --accent-fg:#212121; --ok:#3dd68c; --warn:#e2c08d; --bad:#ff8a80;
        --shadow:0 1px 2px rgba(0,0,0,.35);
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
      button, a { font: inherit; }
      a { color: inherit; text-decoration: none; }
      button { cursor: pointer; }
      .top { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
        border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 80%, transparent); backdrop-filter: blur(12px);
        padding: 12px 20px; }
      .brand { font-weight: 600; letter-spacing: -0.03em; display: inline-flex; align-items: center; gap: 8px; }
      .brand img { width: 28px; height: 28px; }
      .spacer { flex: 1; }
      .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 2px; gap: 0; }
      .seg button { height: 32px; padding: 0 10px; border: 0; background: transparent; color: var(--muted); border-radius: 999px; font-size: 12px; }
      .seg button.on { background: var(--fg); color: var(--bg); }
      .wrap { max-width: 960px; margin: 0 auto; padding: 64px 20px 96px; }
      .kicker { font-size: 13px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); }
      h1 { font-size: clamp(32px, 6vw, 48px); font-weight: 600; letter-spacing: -0.04em; line-height: 1.1; margin: 16px 0 0; }
      h2 { font-size: 22px; font-weight: 600; letter-spacing: -0.03em; margin: 0; }
      h3 { font-size: 16px; font-weight: 600; margin: 0; }
      .lead { margin-top: 20px; max-width: 42em; color: var(--muted); font-size: 16px; }
      .muted { color: var(--muted); font-size: 14px; }
      .subtle { color: var(--subtle); font-size: 12px; }
      .card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px; box-shadow: var(--shadow); }
      .grid { display: grid; gap: 12px; }
      .grid-4 { display: grid; gap: 12px; }
      @media (min-width: 700px) { .grid-4 { grid-template-columns: repeat(4, 1fr); } .grid-2 { grid-template-columns: 1fr 1fr; } }
      .grid-2 { display: grid; gap: 12px; }
      .stat { font-size: 28px; font-weight: 600; letter-spacing: -0.04em; margin-top: 8px; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
      .btn { height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--fg); }
      .btn:hover { background: var(--elevated); }
      .btn.warn { color: var(--warn); }
      .dot { width: 8px; height: 8px; border-radius: 99px; background: var(--subtle); display: inline-block; }
      .dot.on { background: var(--ok); }
      .err { color: var(--bad); font-size: 13px; min-height: 1.2em; }
      .stack { display: grid; gap: 10px; margin-top: 16px; }
      .machine { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--surface); }
      code { font-family: var(--mono); font-size: 12px; }
      .kv { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; padding: 4px 0; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script>
      const BAN_ZH = ${JSON.stringify(BAN_COPY_ZH)};
      const BAN_EN = ${JSON.stringify(BAN_COPY_EN)};
      const T = {
        zh: {
          kicker: "fleet.ginfo.cc",
          title: "用量与健康",
          lead: "只看账号用量和 last-seen 新鲜度。不是丢包、拥堵或流量。",
          users: "账号", tokens: "已签发 token", devices: "设备", online: "在线",
          os: "系统", arch: "架构", versions: "Agent 版本", freshness: "Last-seen 新鲜度",
          recent: "最近", hour: "一小时内", day: "一天内", stale: "较旧", unknown: "未知",
          accounts: "账号", deviceRows: "设备（无名称 / IP）",
          tokenYes: "有 token", tokenNo: "无 token",
          ban: "标记异常", unban: "取消标记",
          banned: "已标记",
          you: "当前账号",
          empty: "还没有数据。",
          themeL: "浅色", themeD: "深色", themeS: "系统",
        },
        en: {
          kicker: "fleet.ginfo.cc",
          title: "Usage and health",
          lead: "Account usage and last-seen freshness only. Not packet loss, congestion, or traffic.",
          users: "Accounts", tokens: "Minted tokens", devices: "Devices", online: "online",
          os: "OS", arch: "Arch", versions: "Agent versions", freshness: "Last-seen freshness",
          recent: "Recent", hour: "Within an hour", day: "Within a day", stale: "Stale", unknown: "Unknown",
          accounts: "Accounts", deviceRows: "Devices (no names / IPs)",
          tokenYes: "token", tokenNo: "no token",
          ban: "Ban", unban: "Unban",
          banned: "banned",
          you: "you",
          empty: "Nothing here yet.",
          themeL: "Light", themeD: "Dark", themeS: "System",
        },
      };
      const state = {
        locale: localStorage.getItem("fleet-locale") === "en" ? "en" : "zh",
        themePref: localStorage.getItem("fleet-theme") || "system",
        data: null,
        err: "",
      };
      const t = (k) => T[state.locale][k];
      function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
      function applyTheme(pref) {
        state.themePref = pref || state.themePref || "system";
        localStorage.setItem("fleet-theme", state.themePref);
        var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        var r = state.themePref === "system" ? (dark ? "dark" : "light") : state.themePref;
        document.documentElement.setAttribute("data-theme", r);
        document.documentElement.setAttribute("data-theme-pref", state.themePref);
        document.documentElement.style.colorScheme = r;
      }
      function themeBar() {
        const p = state.themePref;
        return '<div class="seg" role="group" aria-label="Theme">'
          + '<button type="button" data-theme-set="light" class="'+(p==="light"?"on":"")+'">'+t("themeL")+'</button>'
          + '<button type="button" data-theme-set="dark" class="'+(p==="dark"?"on":"")+'">'+t("themeD")+'</button>'
          + '<button type="button" data-theme-set="system" class="'+(p==="system"?"on":"")+'">'+t("themeS")+'</button>'
          + "</div>";
      }
      function langBar() {
        return '<div class="seg" role="group" aria-label="Language">'
          + '<button type="button" data-loc="en" class="'+(state.locale==="en"?"on":"")+'">EN</button>'
          + '<button type="button" data-loc="zh" class="'+(state.locale==="zh"?"on":"")+'">中文</button>'
          + "</div>";
      }
      function chrome() {
        return '<header class="top">'
          + '<a class="brand" href="/"><img src="/logo.png" width="28" height="28" alt="" />Fleet</a>'
          + '<span class="spacer"></span>'+themeBar()+langBar()
          + "</header>";
      }
      function pairs(obj) {
        return Object.entries(obj || {}).map(([k,v]) => '<div class="kv"><span class="muted">'+esc(k)+'</span><span>'+esc(v)+"</span></div>").join("");
      }
      function freshLabel(k) {
        return t(k) || k;
      }
      function accountView(a) {
        const mark = a.banned ? t("banned") : "";
        const action = a.banned ? t("unban") : t("ban");
        const self = state.data && String(a.id) === String(state.data.me);
        return '<div class="machine">'
          + '<div class="row"><div><strong>'+esc(a.email)+'</strong>'
          + '<div class="subtle" style="font-family:var(--mono)">'+esc(a.id)+' · '+esc(a.token ? t("tokenYes") : t("tokenNo"))
          + (mark ? " · "+esc(mark) : "")
          + (self ? " · "+esc(t("you")) : "")+'</div></div>'
          + (self ? "" : '<button class="btn'+(a.banned ? "" : " warn")+'" data-ban="'+esc(a.id)+'" data-next="'+(a.banned ? "0" : "1")+'">'+esc(action)+"</button>")
          + "</div>"
          + '<p class="subtle" style="margin:10px 0 0">'+esc((a.devices||0)+" · "+JSON.stringify(a.os||{})+" · "+JSON.stringify(a.arch||{})+" · "+JSON.stringify(a.agentVer||{}))+'</p>'
          + "</div>";
      }
      function deviceView(d) {
        return '<div class="machine row"><div>'
          + '<code>'+esc(d.id)+'</code>'
          + '<div class="subtle">'+esc([d.os, d.arch, d.agentVer].filter(Boolean).join(" · "))+'</div></div>'
          + '<span class="muted"><span class="dot'+(d.online ? " on" : "")+'"></span> '
          + esc(d.online ? t("online") : "")+' · '+esc(freshLabel(freshBucket(d.lastSeen)))+"</span></div>";
      }
      function freshBucket(lastSeen) {
        var t0 = Number(lastSeen), now = Date.now();
        if (!t0) return "unknown";
        var age = now - t0;
        if (age <= 120000) return "recent";
        if (age <= 3600000) return "hour";
        if (age <= 86400000) return "day";
        return "stale";
      }
      function render() {
        document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
        var root = document.getElementById("app");
        var d = state.data;
        if (!d) {
          root.innerHTML = chrome()+'<div class="wrap"><p class="kicker">'+t("kicker")+'</p><h1>'+t("title")+'</h1><p class="err">'+esc(state.err)+"</p></div>";
          bind();
          return;
        }
        var fresh = d.freshness || {};
        root.innerHTML = chrome()+'<div class="wrap">'
          + '<p class="kicker">'+t("kicker")+"</p>"
          + "<h1>"+t("title")+"</h1>"
          + '<p class="lead">'+t("lead")+"</p>"
          + '<p class="muted" style="margin-top:12px">'+(state.locale==="zh" ? BAN_ZH : BAN_EN)+"</p>"
          + '<p class="err">'+esc(state.err)+"</p>"
          + '<div class="grid-4" style="margin-top:36px">'
          + '<article class="card"><p class="subtle">'+t("users")+'</p><div class="stat">'+(d.users||0)+"</div></article>"
          + '<article class="card"><p class="subtle">'+t("tokens")+'</p><div class="stat">'+(d.tokens||0)+"</div></article>"
          + '<article class="card"><p class="subtle">'+t("devices")+'</p><div class="stat">'+((d.devices&&d.devices.total)||0)+"</div></article>"
          + '<article class="card"><p class="subtle">'+t("online")+'</p><div class="stat">'+((d.devices&&d.devices.online)||0)+" / "+((d.devices&&d.devices.offline)||0)+"</div></article>"
          + "</div>"
          + '<div class="grid-2" style="margin-top:36px">'
          + '<article class="card"><h3>'+t("os")+'</h3><div class="stack">'+pairs(d.os)+"</div></article>"
          + '<article class="card"><h3>'+t("arch")+'</h3><div class="stack">'+pairs(d.arch)+"</div></article>"
          + '<article class="card"><h3>'+t("versions")+'</h3><div class="stack">'+pairs(d.agentVer)+"</div></article>"
          + '<article class="card"><h3>'+t("freshness")+'</h3><p class="subtle" style="margin-top:8px">'+esc(d.freshnessNote||"")+"</p>"
          + '<div class="stack" style="margin-top:8px">'
          + [["recent","hour","day","stale","unknown"].map(function(k){return '<div class="kv"><span class="muted">'+esc(freshLabel(k))+'</span><span>'+esc(fresh[k]||0)+"</span></div>";}).join("")]
          + "</div></article></div>"
          + '<h2 style="margin-top:64px">'+t("accounts")+"</h2>"
          + '<div class="stack" style="margin-top:16px">'+(d.accounts&&d.accounts.length ? d.accounts.map(accountView).join("") : '<p class="muted">'+t("empty")+"</p>")+"</div>"
          + '<h2 style="margin-top:64px">'+t("deviceRows")+"</h2>"
          + '<div class="stack" style="margin-top:16px">'+(d.deviceRows&&d.deviceRows.length ? d.deviceRows.map(deviceView).join("") : '<p class="muted">'+t("empty")+"</p>")+"</div>"
          + "</div>";
        bind();
      }
      function bind() {
        document.querySelectorAll("[data-loc]").forEach(function (b) {
          b.onclick = function () { state.locale = b.dataset.loc; localStorage.setItem("fleet-locale", state.locale); render(); };
        });
        document.querySelectorAll("[data-theme-set]").forEach(function (b) {
          b.onclick = function () { applyTheme(b.dataset.themeSet); render(); };
        });
        document.querySelectorAll("[data-ban]").forEach(function (b) {
          b.onclick = async function () {
            state.err = "";
            try {
              const res = await fetch("/v1/ops/banned", {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: b.dataset.ban, banned: b.dataset.next === "1" }),
              });
              if (res.status === 404) { document.body.textContent = "Not Found"; return; }
              const data = await res.json().catch(function () { return {}; });
              if (!res.ok) throw new Error(data.error || res.statusText);
              await load();
            } catch (e) { state.err = e.message || String(e); render(); }
          };
        });
      }
      async function load() {
        applyTheme(state.themePref);
        try {
          const res = await fetch("/v1/ops/overview", { credentials: "include" });
          if (res.status === 404) { document.body.textContent = "Not Found"; return; }
          const ct = res.headers.get("content-type") || "";
          if (!ct.includes("json")) throw new Error("not json");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.statusText);
          state.data = data;
          state.err = "";
        } catch (e) {
          state.data = null;
          state.err = e.message || String(e);
        }
        render();
      }
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        if (state.themePref === "system") { applyTheme("system"); render(); }
      });
      load();
    </script>
  </body>
</html>`;
}
