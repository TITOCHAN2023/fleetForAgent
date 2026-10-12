#!/usr/bin/env node
// Real Worker + two Go Agents + real Tool on a disposable, internal-only LAN.
// No production credential, host port, Docker socket, or personal home mount.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "http://fleet-hub.test:8787";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
async function put(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}
async function until(fn, ms = 30_000) {
  const deadline = Date.now() + ms;
  let error;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await delay(200);
  }
  throw error || new Error(`condition timed out after ${ms}ms`);
}
function command(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: ROOT, ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${exe} ${args.slice(0, 3).join(" ")} exited ${code}\n${stderr}\n${stdout}`)));
  });
}

async function seed() {
  const key = await readFile("/shared/seed-key", "utf8");
  const response = await until(async () => {
    const health = await fetch(`${HUB}/v1/challenge?kid=invalid`);
    return health.status < 500;
  }, 60_000);
  assert(response);
  const res = await fetch(`${HUB}/__fleet_vm__/seed`, {
    method: "POST", headers: { "x-fleet-vm-key": key },
  });
  assert.equal(res.status, 200, await res.clone().text());
  await put("/shared/seed.json", await res.json());
  console.log("Local account and flt_1 credential issued (secret not printed).");
}

async function inside() {
  const { token } = await json("/shared/seed.json");
  const key = await readFile("/shared/seed-key", "utf8");
  const { createOperator, officialPlugin, fleetHubHeaders, wrapTransportRpc, resultTransport, isDeviceTransportPath, isFinishedResult } = await import("../packages/fleet-tool/operator.mjs");
  const { highSecAuthorization, verifyTokenV1, verifyFleetStatement } = await import("../packages/fleet-worker/src/tokenv1.mjs");
  const { createRtcManager } = await import("../packages/fleet-tool/rtc.mjs");
  const { openRecovery } = await import("../packages/fleet-tool/recovery.mjs");
  const clients = [];
  async function client(name, rtcEnabled = false) {
    const recovery = openRecovery(`/shared/${name}.json`, { url: HUB, token });
    async function hubPost(endpoint, body, { signal } = {}) {
      const authorization = await highSecAuthorization(token, HUB, (url, init) => fetch(url, { ...init, signal }));
      const res = await fetch(HUB + endpoint, {
        method: "POST", signal, headers: fleetHubHeaders({ authorization, fingerprint: recovery.fingerprint }), body: JSON.stringify(body),
      });
      const value = await res.json();
      if (!res.ok) { const error = new Error(`${endpoint}: HTTP ${res.status}: ${JSON.stringify(value)}`); error.status = res.status; throw error; }
      return value;
    }
    const rtc = createRtcManager({ hubPost, token, operatorId: recovery.fingerprint, verifyTokenV1, verifyFleetStatement, officialPlugin });
    const operator = createOperator({ fingerprint: recovery.fingerprint, state: recovery.state, saveState: recovery.save,
      rpc: async (endpoint, body, options) => {
        if (rtcEnabled) {
          const direct = await rtc.tryRpc(endpoint, body, options);
          if (direct.handled) return wrapTransportRpc(direct.value, isDeviceTransportPath(endpoint) ? direct.transport : null);
        }
        return wrapTransportRpc(await hubPost(endpoint, body, options), isDeviceTransportPath(endpoint) ? "ws" : null);
      },
    });
    const value = { operator, rtc, recovery, hubPost, close: async () => { await rtc.shutdown(); recovery.close(); } };
    clients.push(value);
    return value;
  }
  let serial = 0;
  async function control(action, args = {}) {
    const id = ++serial;
    await put("/shared/control.json", { id, action, ...args });
    const response = await until(async () => { const row = await json("/shared/control-result.json"); return row.id === id ? row : null; }, 60_000);
    if (response.error) throw new Error(response.error);
    return response.value;
  }
  async function fault(device_id, action, extra = {}) {
    const res = await fetch(`${HUB}/__fleet_vm__/recovery`, {
      method: "POST", headers: { "content-type": "application/json", "x-fleet-vm-key": key },
      body: JSON.stringify({ device_id, action, ...extra }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  }
  async function test(name, fn) {
    const start = Date.now();
    try {
      const detail = await fn();
      const row = { test: name, passed: true, ms: Date.now() - start, ...detail };
      await appendFile("/shared/evidence.ndjson", JSON.stringify(row) + "\n", { mode: 0o600 });
      console.log(JSON.stringify(row));
    } catch (error) {
      await appendFile("/shared/evidence.ndjson", JSON.stringify({ test: name, passed: false, error: error.message }) + "\n", { mode: 0o600 });
      throw error;
    }
  }
  async function finished(c, device = A, ms = 30_000) {
    return until(async () => {
      const row = await c.operator.callTool("get_result", { device_id: device });
      return isFinishedResult(row) ? row : null;
    }, ms);
  }
  async function online(c, device = A) {
    return until(async () => (await c.operator.callTool("heartbeat", { device_id: device })).online);
  }
  async function counter(file, expected = 1, device = A) {
    assert.equal(await control("read", { device, file }), "x\n".repeat(expected));
  }
  function mcp(session) {
    const child = spawn(process.execPath, ["/workspace/packages/fleet-tool/index.mjs"], {
      env: { ...process.env, FLEET_URL: HUB, FLEET_TOKEN: token, FLEET_SESSION_PATH: `/shared/${session}.json` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let seq = 0, errors = "";
    const pending = new Map();
    child.stderr.on("data", data => { errors += data; });
    createInterface({ input: child.stdout }).on("line", line => {
      const row = JSON.parse(line); const waiter = pending.get(row.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(row.id); row.error ? waiter.reject(new Error(JSON.stringify(row.error))) : waiter.resolve(row.result); }
    });
    child.on("exit", code => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited ${code}: ${errors}`)); } pending.clear(); });
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${errors}`)); }, 45_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const tool = (name, args) => call("tools/call", { name, arguments: args });
    const close = async () => {
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.stdin.end();
      await Promise.race([exit, delay(5000).then(() => { if (child.exitCode === null) { child.kill(); throw new Error("MCP did not release session on EOF"); } })]);
    };
    return { call, tool, close };
  }
  const one = await client("operator-a"), two = await client("operator-b");
  try {
    await test("two real agents online; isolated network and invalid auth", async () => {
      const catalog = await until(async () => {
        const row = await one.operator.callTool("list_computers", {});
        const devices = Array.isArray(row) ? row : row.computers || row.devices;
        return devices?.length === 2 && devices.every(d => d.online) ? devices : null;
      });
      assert.deepEqual(catalog.map(d => d.id).sort(), [A, B]);
      for (const d of catalog) { assert(!("ip" in d)); assert(d.caps.includes("operation_recovery_v1")); }
      const invalid = await fetch(`${HUB}/v1/list_computers`, { method: "POST", headers: { authorization: "Bearer flt_1.invalid", "content-type": "application/json" }, body: "{}" });
      assert.equal(invalid.status, 401);
      const isolation = await control("isolation");
      assert.equal(isolation.internal, true); assert.equal(isolation.publishedPorts, 0);
      return { devices: catalog.map(d => ({ id: d.id, version: d.agentVer })), ...isolation };
    });
    await test("concurrent operators on one machine do not share output", async () => {
      await Promise.all([
        one.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/one; sleep 1; printf 'OPERATOR_ONE\\n'", wait_ms: 0 }),
        two.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/two; sleep 1; printf 'OPERATOR_TWO\\n'", wait_ms: 0 }),
      ]);
      const [first, second] = await Promise.all([finished(one), finished(two)]);
      assert(first.stdout.includes("OPERATOR_ONE") && !first.stdout.includes("OPERATOR_TWO"));
      assert(second.stdout.includes("OPERATOR_TWO") && !second.stdout.includes("OPERATOR_ONE"));
      assert.notEqual(first.corr, second.corr);
      const stolen = await two.hubPost("/v1/get_result", { device_id: A, corr: first.corr });
      assert(!stolen.stdout && stolen.status === "pending");
      await counter("one"); await counter("two");
      const b = await one.operator.callTool("run", { device_id: B, command: "printf 'SECOND_MACHINE\\n'", wait_ms: 2000 });
      assert(b.stdout.includes("SECOND_MACHINE"));
      assert.equal(await control("exists", { device: B, file: "one" }), false);
      return { first: first.corr, second: second.corr, transport: resultTransport(first) };
    });
    await test("duplicate request executes once; changed input conflicts", async () => {
      const request_id = randomUUID(), command = "printf 'x\\n' >> /data/duplicate; sleep 1; printf 'ONCE\\n'";
      await Promise.all([1, 2].map(() => one.operator.callTool("run", { device_id: A, command, request_id, wait_ms: 0 })));
      const row = await finished(one);
      assert.equal(row.exit_code, 0); await counter("duplicate");
      const mismatch = await one.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/mismatch", request_id, wait_ms: 2000 });
      assert(mismatch.isError || mismatch.status === "conflict" || mismatch.ok === false);
      assert.equal(await control("exists", { device: A, file: "mismatch" }), false);
      return { corr: row.corr };
    });
    await test("lost hub cache recovers device receipt without replay", async () => {
      const row = await one.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/cache; printf 'DEVICE_RECEIPT\\n'", wait_ms: 2000 });
      assert.equal(row.exit_code, 0);
      await fault(A, "clear_cache");
      const recovered = await finished(one);
      assert.equal(recovered.exit_code, 0); assert(recovered.stdout.includes("DEVICE_RECEIPT")); await counter("cache");
      return { corr: recovered.corr };
    });
    await test("lost result delivery is recovered by device query", async () => {
      await fault(A, "drop_results", { drop: true });
      await one.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/lost; printf 'LOST_REPLY\\n'", wait_ms: 0 });
      await until(async () => await control("exists", { device: A, file: "lost" }));
      await delay(500);
      const injection = await fault(A, "drop_results", { drop: false });
      assert(injection.dropped > 0, "fixture must actually drop a completed result");
      const recovered = await finished(one); assert(recovered.stdout.includes("LOST_REPLY")); await counter("lost");
      return { corr: recovered.corr, dropped: injection.dropped };
    });
    await test("network partition does not kill or replay running command", async () => {
      await one.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/partition; sleep 3; printf 'FINISHED_OFFLINE\\n'; touch /data/offline-done", wait_ms: 0 });
      await until(async () => await control("exists", { device: A, file: "partition" }));
      await control("disconnect", { device: A });
      await until(async () => await control("exists", { device: A, file: "offline-done" }));
      await control("connect", { device: A }); await online(one);
      const recovered = await finished(one); assert.equal(recovered.exit_code, 0); assert(recovered.stdout.includes("FINISHED_OFFLINE")); await counter("partition");
      return { corr: recovered.corr };
    });
    await test("completed receipt survives real agent process restart", async () => {
      const before = await one.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/restart-done; printf 'VOLATILE_OUTPUT\\n'", wait_ms: 2000 });
      assert.equal(before.exit_code, 0);
      await control("restart", { device: A }); await online(one); await fault(A, "clear_cache");
      const after = await finished(one); assert.equal(after.exit_code, 0); assert.equal(after.output_unavailable, true); assert(!after.stdout); await counter("restart-done");
      return { corr: after.corr, output_unavailable: after.output_unavailable };
    });
    await test("interrupted process is unknown, never automatically rerun", async () => {
      await one.operator.callTool("run", { device_id: A, command: "printf 'x\\n' >> /data/restart-running; sleep 60; touch /data/should-not-exist", wait_ms: 0 });
      await until(async () => await control("exists", { device: A, file: "restart-running" }));
      await control("restart", { device: A }); await online(one); await fault(A, "clear_cache");
      const after = await finished(one); assert.equal(after.status, "unknown"); assert.notEqual(after.exit_code, 0); await counter("restart-running");
      assert.equal(await control("exists", { device: A, file: "should-not-exist" }), false);
      return { corr: after.corr, status: after.status };
    });
    await test("actual MCP stdio restart restores identity and only reads", async () => {
      let process = mcp("stdio");
      const init = () => process.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "isolated-recovery-test", version: "1" } });
      try {
        await init();
        const reply = await process.tool("run", { device_id: B, command: "printf 'x\\n' >> /data/stdio; printf 'STDIO_RECEIPT\\n'", wait_ms: 3000 });
        assert(reply.content[0].text.includes("STDIO_RECEIPT"), JSON.stringify(reply));
        const before = await json("/shared/stdio.json"); await process.close();
        process = mcp("stdio"); await init();
        // Recovery is a read-only snapshot. Its first device query can still
        // be pending: poll reads, never dispatch the original command again.
        const { value, recovered } = await until(async () => {
          const recovered = await process.tool("recover_session", { device_id: B });
          const value = JSON.parse(recovered.content[0].text);
          return isFinishedResult(value.result) ? { value, recovered } : null;
        });
        assert.equal(value.replayed, false); assert.equal(value.result.exit_code, 0);
        assert.equal((await json("/shared/stdio.json")).fingerprint, before.fingerprint);
        await counter("stdio", 1, B);
        return { corr: value.corr, replayed: value.replayed, transport: recovered._meta?.fleet_transport };
      } finally { await process.close(); }
    });
    await test("real RTC execution; lost direct path falls back to WS", async () => {
      const direct = await client("rtc", true);
      const start = await direct.operator.callTool("run", { device_id: B, command: "printf 'x\\n' >> /data/rtc; sleep 2; printf 'RTC_TO_WS\\n'", wait_ms: 0 });
      assert.equal(resultTransport(start), "rtc", "must establish a real DataChannel, not silently skip RTC");
      await direct.rtc.shutdown();
      const after = await finished(direct, B);
      assert.equal(resultTransport(after), "ws"); assert.equal(after.exit_code, 0); assert(after.stdout.includes("RTC_TO_WS")); await counter("rtc", 1, B);
      assert.equal(start.corr, after.corr);
      return { corr: after.corr, initial: "rtc", recovered: "ws" };
    });
    await test("device permit and dangerous command checks remain authoritative", async () => {
      await control("permit", { device: A, permit: "off" });
      try {
        const denied = await one.operator.callTool("run", { device_id: A, command: "touch /data/not-permitted", wait_ms: 2000 });
        assert.equal(denied.exit_code, 126); assert.equal(await control("exists", { device: A, file: "not-permitted" }), false);
      } finally { await control("permit", { device: A, permit: "allow" }); }
      const blocked = await one.operator.callTool("run", { device_id: A, command: "rm -rf /", wait_ms: 2000 });
      assert.equal(blocked.exit_code, 126);
      return { permit_off: 126, destructive_command: 126 };
    });
    await test("checkpoints and receipts exclude secrets; session lock rejects sharing", async () => {
      assert.throws(() => openRecovery("/shared/operator-a.json", { url: HUB, token }), /locked/);
      const checkpoint = await readFile("/shared/operator-a.json", "utf8");
      assert(!checkpoint.includes(token)); assert(!checkpoint.includes("VOLATILE_OUTPUT")); assert(!checkpoint.includes("rm -rf"));
      const allowed = ["lastUsed", "lastCwd", "corrByDevice", "cwdByDevice", "requestByDevice"];
      assert.deepEqual(Object.keys(JSON.parse(checkpoint).state).sort(), allowed.sort());
      assert.equal((await stat("/shared/operator-a.json")).mode & 0o077, 0);
      const receipts = await control("receipts", { device: A });
      assert(receipts.length >= 8);
      for (const receipt of receipts) {
        assert(!receipt.text.includes(token)); assert(!receipt.text.includes("VOLATILE_OUTPUT")); assert(!receipt.text.includes("rm -rf"));
        assert.equal(receipt.mode & 0o077, 0);
        const keys = Object.keys(JSON.parse(receipt.text));
        assert(keys.every(k => ["version", "input", "status", "exit_code", "created_at", "finished_at"].includes(k)));
      }
      return { private_receipts: receipts.length, locked_session_rejected: true };
    });
  } finally {
    for (const c of clients) { try { await c.close(); } catch { /* preserve original failure */ } }
  }
}

async function host() {
  const docker = (...args) => command("docker", args);
  const serverArch = await docker("info", "--format", "{{.Architecture}}");
  assert(["aarch64", "arm64", "x86_64", "amd64"].includes(serverArch), `unsupported Docker architecture: ${serverArch}`);
  const arch = ["aarch64", "arm64"].includes(serverArch) ? "arm64" : "amd64";
  const runs = path.join(ROOT, "scripts/plugin-peer-vm/.runs");
  await mkdir(runs, { recursive: true });
  const run = await mkdtemp(path.join(runs, "recovery-network."));
  const tag = `fleet-recovery-${randomBytes(5).toString("hex")}`;
  const network = tag, image = `${tag}:local`, containers = [];
  const names = { hub: `${tag}-hub`, stun: `${tag}-stun`, tool: `${tag}-tool`, [A]: `${tag}-a`, [B]: `${tag}-b` };
  let networkCreated = false, imageCreated = false;
  const go = process.env.FLEET_TEST_GO || "go";
  const env = { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch };
  await mkdir(path.join(run, "bin"));
  await writeFile(path.join(run, "seed-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  console.log(`Private evidence: ${run}`);
  await command(go, ["build", "-o", path.join(run, "bin/agent"), "."], { cwd: path.join(ROOT, "packages/fleet-agent"), env });
  await command(go, ["build", "-o", path.join(run, "bin/stun"), path.join(ROOT, "scripts/plugin-peer-vm/recovery-stun.go")], { cwd: path.join(ROOT, "packages/fleet-agent"), env });
  const mount = (source, target, readonly = false) => ["--mount", `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`];
  async function start(name, extra, args) {
    await docker("run", "-d", "--name", name, "--network", network, "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", ...extra, ...args);
    containers.push(name);
  }
  try {
    console.log("Building Linux-only lab runtime; runtime network will have no external gateway.");
    await docker("build", "-t", image, "-f", "scripts/plugin-peer-vm/recovery.Dockerfile", "."); imageCreated = true;
    await docker("network", "create", "--internal", network); networkCreated = true;
    const hubState = path.join(run, "hub"); await mkdir(hubState);
    const bindings = { DEVICE: "DeviceDO", FLEET: "FleetDO", MCP: "McpDO", PEER_SESSION: "PeerSessionDO", REVOCATION: "RevocationDO" };
    await put(path.join(hubState, "wrangler.json"), {
      name: "fleet-recovery-lab", main: "/workspace/scripts/plugin-peer-vm/recovery-worker.ts", compatibility_date: "2026-04-07", workers_dev: false,
      vars: { HUB_ORIGIN: HUB, RTC_STUN_URLS: "stun:stun:3478" },
      durable_objects: { bindings: Object.entries(bindings).map(([name, class_name]) => ({ name, class_name })) },
      migrations: [{ tag: "v1", new_sqlite_classes: Object.values(bindings) }],
    });
    await writeFile(path.join(hubState, ".dev.vars"), `VM_SEED_KEY=${await readFile(path.join(run, "seed-key"), "utf8")}\n`, { mode: 0o600 });
    await start(names.hub, ["--network-alias", "fleet-hub.test", ...mount(ROOT, "/workspace", true), ...mount(hubState, "/data")],
      [image, "/runtime/node_modules/.bin/wrangler", "dev", "--local", "--config", "/data/wrangler.json", "--ip", "0.0.0.0", "--port", "8787", "--persist-to", "/data/state", "--inspector-port", "0"]);
    await start(names.stun, ["--network-alias", "stun", ...mount(path.join(run, "bin/stun"), "/stun", true)], [image, "/stun"]);
    await start(names.tool, [...mount(ROOT, "/workspace", true), ...mount(run, "/shared")], [image]);
    console.log(await docker("exec", names.tool, "node", "/workspace/scripts/test-recovery-network.mjs", "--seed"));
    const { token } = await json(path.join(run, "seed.json"));
    for (const [device, label] of [[A, "agent-a"], [B, "agent-b"]]) {
      const state = path.join(run, label, "state"), data = path.join(run, label, "data");
      await mkdir(state, { recursive: true, mode: 0o700 }); await mkdir(data, { recursive: true, mode: 0o700 });
      await put(path.join(state, "config.json"), { enabled: true, permit: "allow", hubInput: HUB, hubToken: token, deviceId: device, autoUpdate: false });
      await start(names[device], ["-e", "FLEET_HOME=/state", "-e", "FLEET_SETTINGS_ADDR=127.0.0.1:17890", "-e", `FLEET_NAME=${label}`, ...mount(state, "/state"), ...mount(data, "/data"), ...mount(path.join(run, "bin/agent"), "/agent", true)], [image, "/agent"]);
    }
    const child = spawn("docker", ["exec", names.tool, "node", "/workspace/scripts/test-recovery-network.mjs", "--inside"], { stdio: ["ignore", "pipe", "pipe"] });
    let exited = false, last = 0, transcript = "";
    child.stdout.on("data", data => { transcript += data; process.stdout.write(data); });
    child.stderr.on("data", data => { transcript += data; process.stderr.write(data); });
    const completion = new Promise(resolve => child.once("exit", code => { exited = true; resolve(code); }));
    const deadline = Date.now() + 8 * 60_000;
    while (!exited && Date.now() < deadline) {
      const request = await json(path.join(run, "control.json")).catch(() => null);
      if (request && request.id > last) {
        last = request.id;
        let value, error;
        try {
          const name = names[request.device];
          if (request.action === "isolation") {
            const internal = (await docker("network", "inspect", network, "--format", "{{.Internal}}")) === "true";
            const rows = JSON.parse(await docker("inspect", ...containers));
            assert(rows.every(c => c.HostConfig.NanoCpus === 1_000_000_000 && c.HostConfig.Memory === 1024 ** 3), "runtime containers must be limited to 1 CPU / 1 GiB");
            value = { internal, publishedPorts: rows.reduce((n, c) => n + Object.keys(c.HostConfig.PortBindings || {}).length, 0), cpu_per_container: 1, memory_gib_per_container: 1 };
          } else {
            assert([A, B].includes(request.device), "invalid fixture target");
            if (request.action === "disconnect") value = await docker("network", "disconnect", network, name);
            else if (request.action === "connect") value = await docker("network", "connect", network, name);
            else if (request.action === "restart") value = await docker("restart", "--time", "0", name);
            else if (request.action === "permit") { assert(["off", "allow"].includes(request.permit)); value = await docker("exec", name, "/agent", "permit", request.permit); }
            else if (request.action === "receipts") {
              const receipts = path.join(run, request.device === A ? "agent-a" : "agent-b", "state/operations");
              value = await Promise.all((await readdir(receipts)).map(async file => {
                assert(/^[a-f0-9]{64}\.json$/.test(file));
                const target = path.join(receipts, file);
                return { text: await readFile(target, "utf8"), mode: (await stat(target)).mode };
              }));
            }
            else {
              assert(/^[a-z0-9-]+$/.test(request.file), "invalid fixture file");
              const data = path.join(run, request.device === A ? "agent-a" : "agent-b", "data", request.file);
              if (request.action === "read") value = await readFile(data, "utf8");
              else if (request.action === "exists") value = await readFile(data).then(() => true, () => false);
              else throw new Error("unknown fixture action");
            }
          }
        } catch (e) { error = e.message; }
        await put(path.join(run, "control-result.json"), { id: request.id, value, error });
      }
      await delay(100);
    }
    if (!exited) { child.kill(); throw new Error("integration suite exceeded 8-minute limit"); }
    const code = await completion;
    await writeFile(path.join(run, "driver.log"), transcript, { mode: 0o600 });
    assert.equal(code, 0, `container suite failed; inspect ${run}`);
    console.log("All isolated-network integration cases passed.");
  } finally {
    for (const name of containers) {
      await writeFile(path.join(run, `${name}.log`), await docker("logs", name).catch(e => e.message), { mode: 0o600 });
      await docker("rm", "-f", name).catch(e => console.error(e.message));
    }
    if (networkCreated) await docker("network", "rm", network).catch(e => console.error(e.message));
    if (imageCreated) await docker("image", "rm", image).catch(e => console.error(e.message));
    console.log(`Disposable containers/network removed. Evidence retained at ${run}`);
  }
}

try {
  if (process.argv.includes("--seed")) await seed();
  else if (process.argv.includes("--inside")) await inside();
  else await host();
} catch (error) { console.error(error.stack); process.exitCode = 1; }
