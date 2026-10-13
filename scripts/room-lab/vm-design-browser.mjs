// Real two-VM acceptance. Session and token-presence metadata are fixtures; business calls use the
// disposable Hub and its existing private credential. Never run against production.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, extname, sep, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { highSecAuthorization } from "../../packages/fleet-worker/src/tokenv1.mjs";
import { fleetHubHeaders } from "../../packages/fleet-tool/operator.mjs";

const sshConfig = process.env.FLEET_VM_SSH_CONFIG;
assert(sshConfig?.startsWith("/private/tmp/flab-") && sshConfig.endsWith("/linux-a/ssh.config"));
const seed = JSON.parse(
  execFileSync(
    "ssh",
    [
      "-F",
      sshConfig,
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "lima-linux-a",
      "sudo -u fleet-test cat /var/lib/fleet-lab/seed.json",
    ],
    { encoding: "utf8" },
  ),
);
const hub = "http://fleet-hub.test:8787",
  tunnel = "http://127.0.0.1:18787";
const fingerprint = randomUUID(),
  suffix = randomUUID().slice(0, 8);
const root = fileURLToPath(new URL("../../packages/fleet-worker/public/", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "fleet-design-vm-"));
const throughTunnel = (url, options = {}) => {
  assert(String(url).startsWith(hub + "/"));
  return fetch(tunnel + String(url).slice(hub.length), {
    ...options,
    headers: { ...options.headers, host: "fleet-hub.test:8787" },
  });
};
async function rpc(path, body) {
  assert(
    [
      "/v1/list_computers",
      "/v1/set_computer_alias",
      "/v1/room-agents",
      "/v1/room-control",
    ].includes(path),
  );
  const authorization = await highSecAuthorization(seed.token, hub, throughTunnel);
  return throughTunnel(hub + path, {
    method: body === undefined ? "GET" : "POST",
    headers: fleetHubHeaders({ authorization, fingerprint }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = resolve(
    root,
    "." +
      (path === "/rooms/"
        ? "/rooms/index.html"
        : ["/", "/plugins"].includes(path)
          ? "/index.html"
          : path),
  );
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return res.writeHead(403).end();
  try {
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
    res.end(await readFile(file));
  } catch {
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  serviceWorkers: "block",
});
await context.addInitScript(() => {
  localStorage.setItem("fleet-locale", "en");
  localStorage.setItem("fleet-theme", "dark");
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  calls = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  if (!url.pathname.startsWith("/v1/")) return route.continue();
  if (url.pathname === "/v1/me")
    return route.fulfill({
      json: { id: "vm-browser-owner", email: "vm@example.test", ops: false },
    });
  if (url.pathname === "/v1/hub_token") {
    assert.equal(route.request().method(), "GET");
    return route.fulfill({ json: { hasToken: true, prefix: "flt_1.lab" } });
  }
  const body = route.request().method() === "GET" ? undefined : route.request().postDataJSON();
  const response = await rpc(url.pathname, body);
  const text = await response.text();
  calls.push({ path: url.pathname, body, status: response.status, reply: JSON.parse(text) });
  return route.fulfill({ status: response.status, contentType: "application/json", body: text });
});
try {
  const response = await rpc("/v1/list_computers", {});
  assert.equal(response.status, 200, "Private lab Hub authentication failed");
  const { computers } = await response.json();
  const a = computers.find((c) => c.id === "11111111-1111-4111-8111-111111111111");
  const b = computers.find((c) => c.id === "22222222-2222-4222-8222-222222222222");
  assert(a?.online && b?.online, "Both disposable Linux machines must be online");
  await page.goto(origin + "/#machines");
  const alias = `UI Linux ${suffix}`;
  await page.locator(`[data-alias-device="${b.id}"]`).first().click();
  await page.locator("#alias-input").fill(alias);
  await page.locator("#alias-form button[type=submit]").click();
  await page.getByRole("button", { name: alias, exact: true }).waitFor();
  assert(
    (await (await rpc("/v1/list_computers", {})).json()).computers.some(
      (c) => c.id === b.id && c.alias === alias,
    ),
  );
  checks.push("browser alias update persisted on actual isolated Worker");
  await page.goto(origin + "/rooms/");
  await page.getByRole("button", { name: "New room", exact: true }).first().click();
  await page.getByLabel("New room name", { exact: true }).fill(`UI VM ${suffix}`);
  await page.getByLabel("Default execution device", { exact: true }).selectOption(a.id);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await page.getByRole("heading", { name: `UI VM ${suffix}`, exact: true }).waitFor();
  await page.getByRole("button", { name: /Members & settings/ }).click();
  await page.getByLabel("Invite agent", { exact: true }).selectOption("peer-b");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByRole("button", { name: /Remove / }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Tasks 0", exact: true }).click();
  for (const [i, target] of [a, b].entries()) {
    const marker = `LABMARK_UI_${suffix}_${i}`;
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Assignee", { exact: true }).selectOption("peer-b");
    await page.getByLabel("Target device", { exact: true }).selectOption(target.id);
    await page
      .getByLabel("Task objective", { exact: true })
      .fill(`Read hostname and emit ${marker}`);
    await page
      .getByLabel("Completion criteria", { exact: true })
      .fill("Return own marker and hostname");
    await page.getByRole("button", { name: "Delegate task", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const taskId = calls.filter((c) => c.body?.action === "tasks.delegate").at(-1).reply.task.id;
    const deadline = Date.now() + 60000;
    let done = false;
    while (Date.now() < deadline) {
      await page.getByRole("button", { name: "Refresh messages and tasks", exact: true }).click();
      await page
        .locator("li")
        .filter({ has: page.getByText(taskId, { exact: true }) })
        .getByRole("button", { name: "View details and result", exact: true })
        .click();
      const results = await page.locator("pre").allTextContents();
      done = results.some(
        (s) => s.includes(marker) && s.includes(i === 0 ? "lima-linux-a" : "lima-linux-b"),
      );
      if (done) break;
      await page.waitForTimeout(700);
    }
    assert(done, "Actual Room task did not complete on its selected VM");
    checks.push(
      `UI-delegated task ${i + 1} completed on ${i === 0 ? "VM A" : "VM B"} with matching marker`,
    );
  }
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill(`Saved UI note ${suffix}`);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText(`Saved UI note ${suffix}`, { exact: true }).waitFor();
  const delegation = calls.filter((c) => c.body?.action === "tasks.delegate");
  assert.equal(delegation.length, 2);
  assert.notEqual(delegation[0].body.input.requestId, delegation[1].body.input.requestId);
  const roomId = delegation[0].body.input.roomId;
  const saved = await (
    await rpc("/v1/room-control", { leaderId: "leader", action: "rooms.get", input: { roomId } })
  ).json();
  assert.equal(
    saved.room.defaultDeviceId,
    a.id,
    "Task-specific targeting must not change room default",
  );
  assert.deepEqual(errors, []);
  assert(
    calls.every((c) => c.status === 200),
    "Every real business request must succeed",
  );
  await page.screenshot({ path: join(output, "real-vm-room.png"), fullPage: true });
  await rpc("/v1/set_computer_alias", { device_id: b.id, alias: b.alias || "" });
  checks.push("message stored on leader, device targeting preserved, no duplicate delegation");
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
  console.error(
    JSON.stringify({ output, errors, body: (await page.locator("body").innerText()).slice(-4000) }),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
