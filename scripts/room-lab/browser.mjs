/**
 * Worker static bundle acceptance against a real local Hub + SQLite + ACP runners.
 * Builds /rooms assets, mocks only /v1/me, and forwards Room requests to the real Hub.
 * Run with Node 22+: node scripts/room-lab/browser.mjs
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE, ROOM_BROWSER_PORT, ROOM_BROWSER_ARTIFACTS.
 * Never uses production services. Follower CLI state is private Linux tmpfs.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { writeFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { createHub } from "../../packages/fleet-hub/index.mjs";
import { RoomRunner } from "../../packages/fleet-room/runner.mjs";

assert(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+ required");
assert.equal(process.platform, "linux", "Follower CLI state requires Linux tmpfs");
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(
  new URL("../../packages/fleet-room/tests/fixtures/runner-acp.mjs", import.meta.url),
);
const output =
  process.env.ROOM_BROWSER_ARTIFACTS || mkdtempSync(join(tmpdir(), "fleet-room-browser-"));
mkdirSync(output, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "fleet-room-browser-data-"));
const cliStateDir = mkdtempSync("/dev/shm/fleet-room-browser-");
const token = "fleet-room-browser-lab-only";
const followerId = "f".repeat(96);
const port = Number(process.env.ROOM_BROWSER_PORT || 4318);
assert(Number.isInteger(port) && port > 0 && port < 65536, "Invalid local port");
const origin = `http://127.0.0.1:${port}`;
const hub = createHub({ token });
const devices = [],
  runners = [],
  checks = [],
  requests = [],
  pageErrors = [];
let browser,
  page,
  staticServer,
  signedIn = false,
  leaderStopped = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await read()) return;
    await pause(200);
  }
  throw new Error("Timed out waiting for browser lab condition");
}
try {
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const hubUrl = `http://127.0.0.1:${hub.server.address().port}`;
  for (const [id, name] of [
    ["device-a", "Lab Linux"],
    ["device-b", "Lab Mac"],
  ]) {
    const ws = new WebSocket(`${hubUrl.replace("http:", "ws:")}/v1/device`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-device-id": id,
        "x-device-name": name,
        "x-device-os": "linux",
        "x-fleet-proto": "1",
      },
    });
    devices.push(ws);
    await once(ws, "open");
  }
  for (const [id, leader] of [
    ["leader", true],
    [followerId, false],
  ]) {
    const runner = new RoomRunner({
      id,
      name: leader ? "Lab leader" : "Long-ID worker",
      leader,
      url: hubUrl,
      token,
      dataDir: join(dataDir, id),
      fleetHome: join(dataDir, "fleet-home", id),
      command: process.execPath,
      args: [fixture],
      cwd: dataDir,
      pollMs: 100,
      leaseMs: 10000,
      renewMs: 1000,
      ...(leader ? {} : { cliStateDir }),
    });
    runners.push(runner);
    await runner.start();
  }
  const originalHome = await readFile(
    join(root, "packages/fleet-worker/public/index.html"),
    "utf8",
  );
  const buildLog = execFileSync(
    process.execPath,
    [join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.room.config.ts"],
    { cwd: root, encoding: "utf8" },
  );
  await writeFile(join(output, "build.log"), buildLog);
  const publicRoot = join(root, "packages/fleet-worker/public");
  staticServer = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, origin).pathname);
      if (pathname === "/rooms") {
        response.writeHead(302, { location: "/rooms/" });
        response.end();
        return;
      }
      let path = resolve(publicRoot, `.${pathname}`);
      if (path !== publicRoot && !path.startsWith(publicRoot + sep)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      const contentType =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".ico": "image/x-icon",
          ".woff2": "font/woff2",
        }[extname(path)] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": contentType });
      response.end(await readFile(path));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(port, "127.0.0.1", resolve);
  });
  const home = await (await fetch(origin)).text();
  assert.equal(home, originalHome, "Room build must preserve the Worker homepage");
  assert.match(home, /href="\/rooms\/">Rooms<\/a>/);
  const roomHtml = await (await fetch(origin + "/rooms/")).text();
  assert.match(roomHtml, /src="\/rooms\/assets\/[^"]+\.js"/);
  assert(!roomHtml.includes("main.tsx"));
  checks.push("Worker homepage links to generated /rooms/ HTML and static hashed assets");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: "block",
  });
  await context.addInitScript(() => localStorage.setItem("fleet-locale", "en"));
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/v1/me")
      return route.fulfill({
        status: signedIn ? 200 : 401,
        json: signedIn
          ? { id: "lab-owner", email: "lab@example.test", ops: false }
          : { error: "unauthorized" },
        headers: { "Cache-Control": "no-store" },
      });
    if (url.pathname.startsWith("/v1/")) {
      const body = request.postData();
      const response = await fetch(hubUrl + url.pathname + url.search, {
        method: request.method(),
        headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(30000),
      });
      const responseBody = await response.text();
      requests.push({
        path: url.pathname,
        ...(body ? { input: JSON.parse(body) } : {}),
        status: response.status,
      });
      return route.fulfill({
        status: response.status,
        body: responseBody,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
      });
    }
    return route.continue();
  });
  await page.goto(`${origin}/rooms/`);
  await page.getByRole("link", { name: "Sign in to Fleet", exact: true }).waitFor();
  assert.equal(requests.length, 0);
  signedIn = true;
  await page.reload();
  checks.push("Worker cookie-session gate blocks Room requests until /v1/me succeeds");
  await page.getByRole("heading", { name: "Fleet Room", exact: true }).waitFor();
  await page.getByText("Long-ID worker", { exact: true }).waitFor();
  const panelStyle = await page.locator("#agents-heading").evaluate((heading) => {
    const style = getComputedStyle(heading.parentElement);
    return { radius: parseFloat(style.borderRadius), padding: parseFloat(style.paddingTop) };
  });
  assert(
    panelStyle.radius >= 12 && panelStyle.padding >= 16,
    "Shared Room Tailwind utilities must be included in the standalone CSS",
  );
  checks.push("static bundle includes shared Room component layout and styling");
  await page.getByLabel("New room name", { exact: true }).fill("Real backend browser room");
  await page.getByLabel("Default execution device", { exact: true }).selectOption("device-a");
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page.getByRole("heading", { name: "Real backend browser room", exact: true }).waitFor();
  await page.getByLabel("Invite agent", { exact: true }).selectOption(followerId);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByRole("button", { name: "Remove Long-ID worker", exact: true }).waitFor();
  checks.push("browser creates room and invites real 96-character Agent ID");
  await page.getByLabel("Assignee", { exact: true }).selectOption(followerId);
  await page.getByLabel("Task objective", { exact: true }).fill("BROWSER_REAL_TASK");
  await page
    .getByLabel("Completion criteria", { exact: true })
    .fill("Return TASK_COMPLETE from ACP");
  await page.getByRole("button", { name: "Delegate task", exact: true }).click();
  await until(async () => {
    await page.getByRole("button", { name: "Refresh messages and tasks", exact: true }).click();
    return page.getByText("completed", { exact: true }).isVisible();
  });
  await page.getByRole("button", { name: "View details and result", exact: true }).click();
  await page.getByText("TASK_COMPLETE", { exact: true }).waitFor();
  const delegation = requests.find((request) => request.input?.action === "tasks.delegate");
  assert.equal(delegation.status, 200);
  assert.equal(delegation.input.input.assigneeId.length, 96);
  assert(delegation.input.input.sessionId.length <= 96);
  assert(
    requests
      .filter((request) => request.input?.action === "tasks.list")
      .every((request) => request.status === 200 && request.input.input.afterId !== ""),
  );
  checks.push(
    "real ACP task completes; long Agent ID and initial task cursor are accepted; full result displayed",
  );
  await page.getByLabel("Message", { exact: true }).fill("BROWSER_REAL_HISTORY");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("BROWSER_REAL_HISTORY", { exact: true }).waitFor();
  checks.push("browser message is persisted through the actual leader control path");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(output, "online.png"), fullPage: true });
  assert(existsSync(join(dataDir, "leader", "room.sqlite")));
  assert.equal(existsSync(join(dataDir, followerId)), false);
  assert.equal(runners[1].storage, undefined);
  checks.push("only leader has SQLite; follower has no durable Room directory");
  await runners[0].stop();
  leaderStopped = true;
  await page
    .getByText(
      "The leader is offline or the directory is unavailable. Room operations are blocked until the connection returns.",
      { exact: true },
    )
    .waitFor({ timeout: 12000 });
  assert.equal(await page.getByText("BROWSER_REAL_HISTORY", { exact: true }).count(), 0);
  assert.equal(await page.getByText("TASK_COMPLETE", { exact: true }).count(), 0);
  const controls = () => requests.filter((request) => request.path === "/v1/room-control").length;
  const before = controls();
  await pause(5200);
  assert.equal(controls(), before);
  checks.push("leader offline removes history/results and stops browser content requests");
  const storage = await page.evaluate(async () => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    caches: await caches.keys(),
    indexedDB: await indexedDB.databases(),
  }));
  assert(!JSON.stringify(storage).includes("BROWSER_REAL"));
  assert.equal(storage.caches.length, 0);
  assert.equal(storage.indexedDB.length, 0);
  checks.push("no Room body in browser persistent storage");
  await page.screenshot({ path: join(output, "offline.png"), fullPage: true });
  assert.deepEqual(pageErrors, []);
  assert(
    requests.every((request) => request.status < 400),
    JSON.stringify(requests.filter((request) => request.status >= 400)),
  );
  const report = {
    ok: true,
    checks,
    pageErrors,
    storage,
    requests,
    screenshots: ["online.png", "offline.png"],
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, artifacts: output, checks }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(
      join(output, "failure.txt"),
      `${error.stack}\n\n${await page
        .locator("body")
        .innerText()
        .catch(() => "")}\n\n${JSON.stringify({ requests, pageErrors }, null, 2)}`,
    );
  }
  console.error(`Browser lab failed; artifacts: ${output}`);
  throw error;
} finally {
  await browser?.close();
  for (const runner of [...runners].reverse())
    if (!(leaderStopped && runner === runners[0])) await runner.stop();
  for (const device of devices) device.close();
  await hub.close();
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cliStateDir, { recursive: true, force: true });
}
