/**
 * Actual Go Sandbox UI + RoomRunner + leader SQLite browser acceptance.
 * No Room data or local HTTP responses are mocked. Requires Node 22+, Go and Linux.
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE / ROOM_SANDBOX_ARTIFACTS are optional.
 * Both Fleet homes, Go ports, leader database and follower tmpfs are isolated.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync, createWriteStream, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { createHub } from "../../packages/fleet-hub/index.mjs";
import { RoomConnection } from "../../packages/fleet-room/client.mjs";
import { RoomRunner } from "../../packages/fleet-room/runner.mjs";

assert(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+ required");
assert.equal(process.platform, "linux", "Follower state requires Linux tmpfs");
const root = fileURLToPath(new URL("../../", import.meta.url));
const output =
  process.env.ROOM_SANDBOX_ARTIFACTS || mkdtempSync(join(tmpdir(), "fleet-room-sandbox-browser-"));
mkdirSync(output, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "fleet-room-sandbox-data-"));
const cliStateDir = mkdtempSync("/dev/shm/fleet-room-sandbox-cli-");
const homes = { leader: join(data, "leader-home"), follower: join(data, "follower-home") };
const token = "sandbox-browser-lab-only";
const hub = createHub({ token });
const runners = [],
  processes = [],
  checks = [],
  apiCalls = [],
  pageErrors = [],
  browserResponses = [];
const longAgentId = "reviewer-" + "x".repeat(87);
let longReviewer,
  reviewer,
  browser,
  device,
  hubStopped = false,
  leaderStopped = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error("Sandbox browser condition timed out");
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
try {
  const binary = join(data, "fleet-agent");
  execFileSync("go", ["build", "-buildvcs=false", "-trimpath", "-o", binary, "."], {
    cwd: join(root, "packages/fleet-agent"),
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: "pipe",
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const hubUrl = `http://127.0.0.1:${hub.server.address().port}`;
  device = new WebSocket(hubUrl.replace("http:", "ws:") + "/v1/device", {
    headers: { authorization: `Bearer ${token}`, "x-device-id": "sandbox-device" },
  });
  await once(device, "open");
  for (const id of ["leader", "follower"]) {
    const runner = new RoomRunner({
      id: id === "follower" ? "Codex" : id,
      name: id === "follower" ? "Codex" : "Grok",
      leader: id === "leader",
      url: hubUrl,
      token,
      dataDir: join(data, `${id}-ledger`),
      fleetHome: homes[id],
      command: process.execPath,
      args: [join(root, "packages/fleet-room/tests/fixtures/runner-acp.mjs")],
      cwd: data,
      pollMs: 100,
      ...(id === "follower" ? { cliStateDir } : {}),
    });
    runners.push(runner);
    await runner.start();
  }
  reviewer = new RoomConnection({ id: "Reviewer", name: "Codex", url: hubUrl, token });
  await reviewer.connect();
  longReviewer = new RoomConnection({ id: longAgentId, name: "Codex", url: hubUrl, token });
  await longReviewer.connect();
  async function control(action, input) {
    const response = await fetch(hubUrl + "/v1/room-control", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ leaderId: "leader", action, input }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    return result;
  }
  for (const [id, name] of [
    ["room-a", "Sandbox 对话工作区"],
    ["room-b", "发布前检查"],
  ]) {
    await control("rooms.create", {
      id,
      name,
      leaderId: "leader",
      defaultDeviceId: "sandbox-device",
    });
    await control("rooms.invite", { roomId: id, agentId: "Codex" });
    await control("rooms.invite", { roomId: id, agentId: "Reviewer" });
    await control("rooms.invite", { roomId: id, agentId: longAgentId });
  }
  // Real authenticated agents write the demonstration into the leader SQLite.
  const demo = [
    "我们把机器端做成团队的对话工作区。左边找房间，中间看讨论，机器设置单独保留。\n\nCodex 先实现界面，Reviewer 检查权限和断线场景。",
    "已完成两栏布局，消息按真实顺序展示。设置入口、待审批提醒和只读模式都保留。\n```js\n  const messages = await readLocalRoom(roomId);\n  renderConversation(messages);\n```",
    "接手检查。重点看三件事：组员不能读取别的机器历史；Hub 断线后组长仍能查看；浏览器不保存消息正文。",
    "收到。保持只读，不添加没有后端支持的发送框。移动端也用同一套消息流，避免设置表单挤占阅读空间。",
    "实现摘要：中文换行与代码块使用安全的文本节点；长链接会自动换行。\n验证地址：https://example.invalid/review/" +
      "long-path-".repeat(22),
    "本轮检查通过：房间切换没有混入上一页消息，较早 / 较新翻页正常。\n下一步交给组长确认桌面、手机与深色模式的阅读效果。",
  ];
  for (let i = 1; i <= 35; i++) {
    const input = {
      roomId: "room-a",
      discussionId: "main",
      requestId: randomUUID(),
      expectedContextRev: i - 1,
      text: i === 35 ? "末条中文消息：分页读取成功" : demo[(i - 1) % demo.length],
    };
    const author = (i - 1) % 3;
    if (i === 32)
      await longReviewer.call("leader", "messages.send", input, { scopeRoomId: "room-a" });
    else if (i === 33)
      await control("messages.send", { ...input, text: "人工确认：继续检查移动端可读性。" });
    else if (author === 0) await runners[0].call("leader", "messages.send", input, "room-a");
    else if (author === 1) await runners[1].call("leader", "messages.send", input, "room-a");
    else await reviewer.call("leader", "messages.send", input, { scopeRoomId: "room-a" });
  }
  await runners[0].call(
    "leader",
    "messages.send",
    {
      roomId: "room-b",
      discussionId: "main",
      requestId: randomUUID(),
      expectedContextRev: 0,
      text: "第二房间独立消息",
    },
    "room-b",
  );
  const descriptorPath = join(homes.leader, "rooms/leader.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  assert.equal(statSync(descriptorPath).mode & 0o077, 0);
  assert.equal(statSync(join(homes.leader, "rooms")).mode & 0o077, 0);
  const readHeaders = { authorization: `Bearer ${descriptor.readCapability}` };
  for (const [path, options, status] of [
    ["/rooms", {}, 403],
    ["/rooms", { headers: { authorization: "Bearer wrong" } }, 403],
    ["/rooms", { headers: { ...readHeaders, origin: "https://foreign.invalid" } }, 403],
    ["/rooms", { method: "POST", headers: readHeaders }, 405],
    ["/tool", { method: "POST", headers: readHeaders, body: "{}" }, 403],
  ])
    assert.equal((await fetch(descriptor.url + path, options)).status, status);
  assert.equal((await fetch(descriptor.url + "/rooms", { headers: readHeaders })).status, 200);
  checks.push(
    "private descriptor; missing/wrong capability, foreign Origin and writes denied; read capability cannot call execution tools",
  );
  const origins = {};
  for (const id of ["leader", "follower"]) {
    mkdirSync(homes[id], { recursive: true, mode: 0o700 });
    await writeFile(
      join(homes[id], "config.json"),
      JSON.stringify({
        enabled: false,
        permit: "off",
        autoUpdate: false,
        hubInput: "",
        hubToken: "",
      }),
    );
    const port = await freePort();
    origins[id] = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("FLEET_") && !key.startsWith("_FLEET_"),
      ),
    );
    const child = spawn(binary, [], {
      cwd: data,
      env: {
        ...env,
        FLEET_HOME: homes[id],
        FLEET_SETTINGS_ADDR: `127.0.0.1:${port}`,
        FLEET_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    const log = createWriteStream(join(output, `${id}-sandbox.log`));
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`${id} Sandbox exited ${child.exitCode}`);
      try {
        return (await fetch(origins[id] + "/api/state")).ok;
      } catch {
        return false;
      }
    });
  }
  for (const [path, options, status] of [
    ["/api/rooms", { headers: { origin: "https://foreign.invalid" } }, 403],
    ["/api/rooms", { headers: { "sec-fetch-site": "cross-site" } }, 403],
    ["/api/rooms", { method: "POST" }, 405],
    ["/api/room-messages?leaderId=leader&roomId=room-a&url=http://foreign.invalid", {}, 400],
    ["/api/room-messages?leaderId=../secret&roomId=room-a", {}, 400],
    ["/api/room-messages?leaderId=leader&roomId=room-a&limit=101", {}, 400],
  ])
    assert.equal((await fetch(origins.leader + path, options)).status, status);
  checks.push("Go proxy enforces same-origin, GET-only and bounded whitelisted query parameters");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    serviceWorkers: "block",
  });
  await context.addInitScript(() => localStorage.setItem("fleet-locale", "zh"));
  await context.route("**/*", (route) =>
    Object.values(origins).includes(new URL(route.request().url()).origin)
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage(),
    memberPage = await context.newPage();
  for (const p of [page, memberPage]) {
    p.on("pageerror", (error) => pageErrors.push(String(error)));
    p.on("request", (request) => {
      assert(!JSON.stringify(request.headers()).includes(descriptor.readCapability));
      assert(!request.url().includes(descriptor.readCapability));
    });
    p.on("response", (response) => {
      if (!new URL(response.url()).pathname.startsWith("/api/room")) return;
      browserResponses.push(
        response.text().then((body) => {
          assert(!body.includes(descriptor.readCapability));
          assert(!body.includes('"readCapability"'));
          assert.equal(response.headers()["cache-control"], "no-store");
          apiCalls.push({
            path: new URL(response.url()).pathname + new URL(response.url()).search,
            status: response.status(),
          });
        }),
      );
    });
  }
  await page.goto(origins.leader);
  await page.getByText(demo[0], { exact: true }).first().waitFor();
  assert.equal(await page.locator("#room-messages article").count(), 30);
  assert.equal(await page.locator("#room-subtitle").textContent(), "Grok · 组长 · ID: leader");
  const machineRooms = await (await fetch(origins.leader + "/api/rooms")).json();
  assert(machineRooms.machineName);
  assert.equal(
    await page.locator("#machine-label").textContent(),
    "本机 · " + machineRooms.machineName,
  );
  const messageRows = page.locator("#room-messages article");
  assert.equal(await messageRows.nth(0).locator("strong").textContent(), "Grok");
  assert.equal(await messageRows.nth(0).locator(".leader-label").textContent(), "组长");
  for (const [index, id] of [
    [1, "Codex"],
    [2, "Reviewer"],
  ]) {
    assert.equal(await messageRows.nth(index).locator("strong").textContent(), "Codex");
    assert.equal(await messageRows.nth(index).locator(".message-id").textContent(), "ID: " + id);
    assert.equal(await messageRows.nth(index).locator(".leader-label").count(), 0);
  }
  checks.push(
    "registered agent names and stable IDs distinguish same-name agents; leader role and actual machine name remain separate",
  );
  assert((await page.locator(".message-bubble pre").first().textContent()).startsWith("  const"));
  await page.locator("#room-next").click();
  await page.getByText("末条中文消息：分页读取成功", { exact: true }).waitFor();
  assert.equal(await page.locator("#room-messages article").count(), 5);
  await page.locator("#room-prev").click();
  await page.getByText(demo[0], { exact: true }).first().waitFor();
  await page
    .locator("#room-list")
    .getByRole("button", { name: /发布前检查/ })
    .click();
  await page.getByText("第二房间独立消息", { exact: true }).waitFor();
  assert.equal(await page.getByText(demo[0], { exact: true }).count(), 0);
  checks.push(
    "actual Go UI reads Chinese leader SQLite messages, paginates 30+5 and switches rooms without mixing history",
  );
  await page
    .locator("#room-list")
    .getByRole("button", { name: /Sandbox 对话工作区/ })
    .click();
  await page.getByText(demo[0], { exact: true }).first().waitFor();
  await page.screenshot({ path: join(output, "leader-online.png") });
  console.log("Desktop screenshot: " + join(output, "leader-online.png"));
  await page.locator("#settings-open").click();
  for (const id of ["hub", "token", "connect", "enabled", "lv-off", "lv-ask", "lv-allow", "t-logs"])
    assert(await page.locator("#" + id).isVisible(), id + " settings reachable");
  await page.locator("#en").click();
  assert.equal(await page.locator("#room-heading").textContent(), "Machine settings");
  await until(async () => (await page.locator(".leader-label").first().textContent()) === "Leader");
  assert.equal(await page.locator("#room-page").textContent(), "Page 1");
  assert(!(await page.locator(".date-divider").first().textContent()).includes("年"));
  await page.locator("#zh").click();
  await until(async () => (await page.locator(".leader-label").first().textContent()) === "组长");
  assert.equal(await page.locator("#room-page").textContent(), "第 1 页");
  await page.locator("#settings-back").click();
  await page.locator("#th-dark").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: join(output, "leader-dark.png") });
  await page.locator("#th-light").click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator("#sidebar-toggle").isVisible());
  assert(await page.locator("#sidebar").evaluate((element) => element.inert));
  await page.locator("#room-next").click();
  await page.getByText("末条中文消息：分页读取成功", { exact: true }).waitFor();
  assert.equal(await page.getByText("ID: " + longAgentId, { exact: true }).count(), 1);
  assert.equal(await page.locator(".message-avatar.human").count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator("#room-prev").click();
  await page.getByText(demo[0], { exact: true }).first().waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, "leader-mobile.png") });
  await page.locator("#sidebar-toggle").click();
  await page.locator("#room-search").fill("发布");
  assert.equal(await page.locator("#room-list button").count(), 1);
  await page.locator("#room-search").fill("");
  await page
    .locator("#room-list")
    .getByRole("button", { name: /发布前检查/ })
    .click();
  assert.equal(await page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "false");
  await page.setViewportSize({ width: 1280, height: 1000 });
  checks.push(
    "desktop/mobile/dark conversation layouts; search, settings, permissions, theme and language remain accessible",
  );
  await memberPage.goto(origins.follower);
  await memberPage
    .getByText("本机没有组长房间账本；组员不保存房间消息。", { exact: true })
    .waitFor();
  assert.equal(await memberPage.locator("#room-select option").count(), 0);
  assert.equal(await memberPage.locator("#room-messages article").count(), 0);
  assert(!existsSync(join(homes.follower, "rooms")));
  assert(!existsSync(join(data, "follower-ledger")));
  checks.push("follower machine has no Room ledger or descriptor and shows an empty history state");
  await memberPage.screenshot({ path: join(output, "member-empty.png") });
  await hub.close();
  hubStopped = true;
  await page.locator("#room-refresh").click();
  await page.getByText("第二房间独立消息", { exact: true }).waitFor();
  await page
    .locator("#room-list")
    .getByRole("button", { name: /Sandbox 对话工作区/ })
    .click();
  await page.getByText(demo[0], { exact: true }).first().waitFor();
  await page.locator("#room-next").click();
  await page.getByText("末条中文消息：分页读取成功", { exact: true }).waitFor();
  checks.push(
    "Hub fully stopped: local leader page still refreshes, switches rooms and reads the next page",
  );
  await page.screenshot({ path: join(output, "hub-offline-readable.png") });
  for (const p of [page, memberPage]) {
    const storage = await p.evaluate(async () => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      caches: await caches.keys(),
      indexedDB: await indexedDB.databases(),
    }));
    assert(!JSON.stringify(storage).includes(descriptor.readCapability));
    assert(!JSON.stringify(storage).includes("中文消息"));
    assert(!JSON.stringify(storage).includes("独立消息"));
    assert.deepEqual(Object.keys(storage.local).sort(), ["fleet-locale", "fleet-theme"]);
    assert.deepEqual(storage.session, {});
    assert.equal(storage.caches.length, 0);
    assert.equal(storage.indexedDB.length, 0);
  }
  await Promise.all(browserResponses);
  assert.deepEqual(pageErrors, []);
  checks.push(
    "read capability absent from browser requests/responses/storage; Room responses no-store; no persistent browser history",
  );
  await runners[0].stop();
  leaderStopped = true;
  await page.locator("#room-refresh").click();
  await until(
    async () =>
      (await page.locator("#room-messages article").count()) === 0 &&
      (await page.locator("#room-select option").count()) === 0,
  );
  assert(!existsSync(descriptorPath));
  checks.push(
    "stopping the local leader removes its descriptor and clears displayed history on refresh",
  );
  const report = {
    ok: true,
    checks,
    pageErrors,
    apiCalls,
    boundary:
      "Go loopback UI trusts native local callers without Origin; read capability protects runner IPC and is never exposed to the browser. This is not an OS-user isolation guarantee.",
    screenshots: [
      "leader-online.png",
      "leader-mobile.png",
      "leader-dark.png",
      "member-empty.png",
      "hub-offline-readable.png",
    ],
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, artifacts: output, checks }, null, 2));
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack));
  console.error(`Sandbox browser failed; artifacts: ${output}`);
  throw error;
} finally {
  await browser?.close();
  reviewer?.close();
  longReviewer?.close();
  for (const runner of [...runners].reverse())
    if (!(leaderStopped && runner === runners[0])) await runner.stop();
  for (const child of processes) await stopProcess(child);
  device?.close();
  if (!hubStopped) await hub.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(cliStateDir, { recursive: true, force: true });
}
