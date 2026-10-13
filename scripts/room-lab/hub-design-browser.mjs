// UI fixtures only. The VM acceptance is separate; no production credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, extname, sep, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../packages/fleet-worker/public/", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "fleet-design-browser-"));
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = resolve(
    root,
    "." +
      (path === "/rooms/"
        ? "/rooms/index.html"
        : ["/", "/plugins", "/help", "/docs"].includes(path)
          ? "/index.html"
          : path),
  );
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".ttf": "font/ttf",
        }[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  serviceWorkers: "block",
});
await context.addInitScript(() => {
  localStorage.setItem("fleet-locale", "en");
  localStorage.setItem("fleet-theme", "dark");
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [],
  calls = [],
  checks = [];
let signedIn = true,
  listError = false,
  directory = "ready",
  online = true,
  loseReply = false,
  paginated = false;
const computers = [
  {
    id: "machine-a",
    name: "linux-a",
    alias: "SG <test>",
    os: "linux",
    agentVer: "0.6.7",
    online: true,
  },
  {
    id: "machine-b",
    name: "linux-b",
    alias: "Builder",
    os: "linux",
    agentVer: "0.6.6",
    online: false,
  },
];
const agents = [
  {
    id: "leader",
    name: "Lab leader",
    online: true,
    leader: true,
    callable: true,
    mode: "runtime",
    running: 0,
    capacity: 2,
  },
  {
    id: "follower",
    name: "Lab follower",
    online: true,
    leader: false,
    callable: true,
    mode: "runtime",
    running: 0,
    capacity: 2,
  },
];
const room = {
  id: "room-a",
  name: "Design acceptance",
  leaderId: "leader",
  memberIds: ["leader", "follower"],
  defaultDeviceId: "machine-a",
  configVersion: 1,
  membershipVersion: 1,
  paused: false,
};
const messages = [
  {
    id: "message-a",
    authorKind: "agent",
    authorId: "leader",
    seq: 1,
    text: "Real UI fixture — never a production task.",
    createdAt: Date.now(),
  },
];
const tasks = [
  {
    id: "task-a",
    assigneeId: "follower",
    kind: "task",
    description: "Investigate uncertain result",
    status: "unknown",
    resolvedDeviceId: "machine-a",
  },
];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const req = route.request(),
    url = new URL(req.url());
  if (url.origin !== origin) return route.abort();
  if (!url.pathname.startsWith("/v1/")) return route.continue();
  const body = req.postDataJSON() || {};
  calls.push({ path: url.pathname, body, method: req.method() });
  const reply = (json, status = 200) => route.fulfill({ json, status });
  if (url.pathname === "/v1/me")
    return reply(
      signedIn
        ? { id: "fixture-owner", email: "fixture@example.test", ops: false }
        : { error: "unauthorized" },
      signedIn ? 200 : 401,
    );
  if (url.pathname === "/v1/hub_token") {
    assert.equal(req.method(), "GET", "UI test must never reset token");
    return reply({ hasToken: true, prefix: "flt_1.fixture" });
  }
  if (url.pathname === "/v1/logout") return route.abort("failed");
  if (url.pathname === "/v1/list_computers")
    return listError ? reply({ error: "fixture list unavailable" }, 503) : reply({ computers });
  if (url.pathname === "/v1/set_computer_alias") {
    computers.find((c) => c.id === body.device_id).alias = body.alias;
    return reply({ alias: body.alias });
  }
  if (url.pathname === "/v1/room-agents")
    return directory === "error"
      ? reply({ error: "fixture directory unavailable" }, 503)
      : reply({
          agents:
            directory === "empty"
              ? []
              : agents.map((a) => ({ ...a, online: a.leader ? online : true })),
        });
  if (url.pathname !== "/v1/room-control") return reply({ error: "unexpected fixture route" }, 404);
  const { action, input } = body;
  if (action === "rooms.list") return reply({ rooms: [room] });
  if (action === "messages.read")
    return reply({
      messages,
      contextRev: messages.length,
      hasMore: paginated && !input.afterSeq,
      nextCursor: paginated && !input.afterSeq ? 1 : null,
    });
  if (action === "tasks.list") return reply({ tasks, hasMore: false, nextCursor: null });
  if (action === "tasks.get") return reply({ task: tasks[0], events: [] });
  if (action === "messages.send") {
    if (loseReply) return reply({ error: "fixture ambiguous response" }, 503);
    messages.push({
      id: `message-${messages.length}`,
      seq: messages.length + 1,
      authorKind: "user",
      authorId: "fixture-owner",
      text: input.text,
    });
    return reply({ ok: true });
  }
  if (action === "tasks.delegate") return reply({ task: { ...tasks[0], id: "delegated" } });
  if (action === "rooms.pause" || action === "rooms.resume") room.paused = action === "rooms.pause";
  return reply({ room });
});
async function visible(text) {
  await page.getByText(text, { exact: true }).first().waitFor();
}
async function fit(name, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    `${name}: horizontal overflow`,
  );
  const font = await page.evaluate(() => ({
    root: getComputedStyle(document.documentElement).fontSize,
    loaded: document.fonts.check("15px Inter"),
  }));
  assert.equal(font.root, "15px");
  assert(font.loaded);
  const controls = await page
    .locator(
      ".fleet-top .fleet-brand, .fleet-top nav a, .fleet-top summary, .fleet-top .seg, .fleet-top .glass-seg",
    )
    .evaluateAll((elements) =>
      elements.map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { label: el.textContent, x, y, width, height };
      }),
    );
  for (const [i, a] of controls.entries())
    for (const b of controls.slice(i + 1)) {
      assert(
        !(
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1
        ),
        `${name}: header controls overlap: ${a.label} / ${b.label}`,
      );
    }
  await page.screenshot({ path: join(output, `${name}-${width}.png`), fullPage: true });
}
try {
  await page.goto(origin + "/#machines");
  await visible("SG <test>");
  await fit("machines", 1280);
  await fit("machines", 390);
  await fit("machines", 320);
  await page.getByLabel("Search machines", { exact: true }).fill("Builder");
  assert.equal(await page.locator(".fleet-machine").count(), 1);
  await page.getByLabel("Search machines", { exact: true }).fill("");
  await page.getByRole("button", { name: "SG <test>", exact: true }).click();
  await page.locator("#alias-input").fill("New alias");
  await page.locator("#alias-form button[type=submit]").click();
  await visible("New alias");
  checks.push("machine search, escaped names, live alias contract, versions and responsive layout");
  await page.goto(origin + "/#settings/mcp");
  await visible("Streamable HTTP");
  assert.equal(await page.locator(".setup-copy pre").count(), 1);
  assert((await page.locator(".setup-copy pre").innerText()).includes('"type": "http"'));
  await page.getByRole("button", { name: "SSE", exact: true }).click();
  assert((await page.locator(".setup-copy pre").innerText()).includes('"type": "sse"'));
  await page.getByRole("button", { name: "stdio · npx", exact: true }).click();
  assert(!(await page.locator(".setup-copy pre").innerText()).includes("FLEET_TOKEN"));
  await page.getByRole("link", { name: "Install Agent", exact: true }).click();
  await page.getByRole("button", { name: "Windows PowerShell", exact: true }).click();
  assert((await page.locator(".setup-copy pre").innerText()).includes("install.ps1"));
  assert(!(await page.locator(".setup-copy pre").innerText()).includes("-Token"));
  await fit("setup", 390);
  await fit("setup", 1280);
  await page.goBack();
  await visible("Streamable HTTP");
  await page.goto(origin + "/#downloads");
  await page.locator('a[href$="/checksums.txt"]').waitFor();
  checks.push(
    "HTTP/SSE/stdio and Windows/Unix options; no-token configs; old links and back navigation",
  );
  await page.goto(origin + "/plugins");
  await page.locator(".plugin-card").first().waitFor();
  await fit("plugins", 390);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await visible("为你的机器，添一点能力。");
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await fit("plugins-zh-light", 390);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  listError = true;
  await page.goto(origin + "/#machines");
  await page.getByRole("alert").waitFor();
  assert(!(await page.locator("#machine-rows").innerText()).includes("No machines"));
  listError = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await visible("New alias");
  checks.push("list error is distinct from empty; retry works; plugin registry still loads");
  await page.goto(origin + "/rooms/");
  await page.getByRole("heading", { name: room.name, exact: true }).waitFor();
  await fit("room", 390);
  await fit("room", 320);
  await fit("room", 1280);
  await page.getByRole("button", { name: /Members & settings/ }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert(
    await page
      .getByRole("button", { name: /Members & settings/ })
      .evaluate((el) => el === document.activeElement),
  );
  await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
  await page.getByRole("button", { name: "Tasks 1", exact: true }).click();
  await visible("Investigate uncertain result");
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  assert.equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Keep this draft");
  loseReply = true;
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Tasks 1", exact: true }).click();
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  loseReply = false;
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await visible("Keep this draft");
  const sends = calls.filter((c) => c.body.action === "messages.send");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].body, sends[1].body);
  checks.push(
    "tab changes preserve drafts and exact requestId/envelope after an ambiguous response",
  );
  online = false;
  await page.getByText(/Writes are blocked/).waitFor();
  assert(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled());
  const count = calls.filter((c) => c.path === "/v1/room-control").length;
  await page.waitForTimeout(5500);
  assert.equal(calls.filter((c) => c.path === "/v1/room-control").length, count);
  checks.push("leader offline blocks writes and content requests without replay");
  online = true;
  paginated = true;
  await page.reload();
  await page.getByLabel("Message", { exact: true }).fill("Must read first");
  await page
    .getByRole("button", { name: "Load newer messages to enable sending", exact: true })
    .waitFor();
  assert(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled());
  await page
    .getByRole("button", { name: "Load newer messages to enable sending", exact: true })
    .click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Send message" && !b.disabled,
    ),
  );
  checks.push("unread pagination continues to block sending");
  await page.getByLabel("Account", { exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await visible("Sign out failed. Please try again.");
  assert(await page.getByRole("button", { name: "Sign out", exact: true }).isEnabled());
  checks.push("failed sign-out stays visible and retryable without clearing account state");
  directory = "empty";
  await page.reload();
  await visible("A place for your agents to work together.");
  assert.equal(await page.getByLabel("New room name", { exact: true }).isVisible(), false);
  await fit("room-empty", 390);
  directory = "error";
  await page.reload();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByText("A place for your agents to work together.", { exact: true }).count(),
    0,
  );
  signedIn = false;
  await page.reload();
  await page.getByRole("link", { name: "Sign in to Fleet", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  checks.push("empty directory, failed directory and login expiry remain distinct");
  checks.push("Chinese/light theme and native dialog keyboard focus restoration");
  console.log(JSON.stringify({ passed: true, checks, screenshots: output }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
  console.error(
    JSON.stringify({
      screenshots: output,
      errors,
      body: (await page.locator("body").innerText()).slice(-6000),
    }),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
