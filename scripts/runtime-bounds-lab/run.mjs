// Disposable Linux integration lab. Requires Docker, Go, Node 22 and root npm deps.
// Three containers on an INTERNAL bridge; never mounts user home or real credentials.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, cp, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dockerEnvironment } from "./docker-env.mjs";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = path.join(root, "scripts/runtime-bounds-lab/.artifacts");
await mkdir(artifacts, { recursive: true });
const lab = await mkdtemp(path.join(artifacts, "run-"));
const name = `fleet-bounds-${process.pid}`;
const token = randomUUID();
const containers = [];
const image = process.env.FLEET_LAB_NODE_IMAGE || "node:22-bookworm-slim";
const env = dockerEnvironment();
const docker = async (...args) =>
  (await exec("docker", args, { env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { checks: [], memory: [], started: new Date().toISOString() };
let bridge;
let sequence = 0;
const pending = new Map();
async function rpc(route, body, operator = "operator-a") {
  if (bridge.exitCode !== null || bridge.signalCode !== null)
    throw new Error("lab RPC bridge exited");
  const id = ++sequence;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("lab rpc timeout"));
    }, 40000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject,
    });
  });
  bridge.stdin.write(JSON.stringify({ id, route, body, operator }) + "\n");
  const result = await response;
  assert.equal(result.status, 200, JSON.stringify(result));
  return result.data;
}
async function run(device, command, operator = "operator-a", request_id, wait_ms = 20000) {
  return rpc(
    "run",
    { device_id: device, command, wait_ms, ...(request_id ? { request_id } : {}) },
    operator,
  );
}
function completed(row) {
  assert.equal(row.status, "done", JSON.stringify(row));
  assert.equal(row.exit_code, 0, JSON.stringify(row));
}
async function waitDone(device, corr, operator, request_id) {
  for (let i = 0; i < 30; i++) {
    const row = await rpc(
      "get_result",
      { device_id: device, corr, request_id, wait_ms: 2000 },
      operator,
    );
    if (row.status === "done") return row;
    await pause(100);
  }
  throw new Error("task completion timeout");
}
function pass(check) {
  evidence.checks.push(check);
  console.log("PASS", check);
}
async function memory(round) {
  const samples = [];
  for (const side of ["a", "b", "hub"]) {
    const raw = await docker(
      "exec",
      `${name}-${side}`,
      "sh",
      "-c",
      side === "hub"
        ? "cat /proc/1/status"
        : 'for p in /proc/[0-9]*; do if [ "$(cat "$p/comm" 2>/dev/null)" = fleet-agent ]; then cat "$p/status"; fi; done',
    );
    samples.push({
      side,
      rssKiB: Number(raw.match(/^VmRSS:\s+(\d+)/m)?.[1]),
      highWaterKiB: Number(raw.match(/^VmHWM:\s+(\d+)/m)?.[1]),
    });
    assert(
      samples.at(-1).rssKiB > 0 && samples.at(-1).rssKiB < 384 * 1024,
      `${side} RSS exceeds 384 MiB safety budget`,
    );
    const state = JSON.parse(await docker("inspect", `${name}-${side}`))[0].State;
    assert.equal(state.Running, true);
    assert.equal(state.OOMKilled, false);
  }
  assert.equal((await rpc("list_computers", {})).computers.filter((x) => x.online).length, 2);
  evidence.memory.push({ round, samples });
  console.log("MEMORY", JSON.stringify(evidence.memory.at(-1)));
}
try {
  const arch = await docker("info", "--format", "{{.Architecture}}");
  const goarch = /aarch64|arm64/.test(arch) ? "arm64" : "amd64";
  await exec(
    "go",
    ["build", "-buildvcs=false", "-trimpath", "-o", path.join(lab, "fleet-agent"), "."],
    {
      cwd: path.join(root, "packages/fleet-agent"),
      env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goarch },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  await mkdir(path.join(lab, "app"), { recursive: true });
  for (const entry of ["packages", "src", "package.json"])
    await cp(path.join(root, entry), path.join(lab, "app", entry), {
      recursive: true,
      filter: (source) =>
        !path
          .relative(root, source)
          .split(path.sep)
          .some((part) => ["node_modules", ".git", ".artifacts", ".wrangler"].includes(part)),
    });
  await mkdir(path.join(lab, "app/node_modules"), { recursive: true });
  const require = createRequire(path.join(root, "package.json"));
  await cp(
    path.dirname(await realpath(require.resolve("ws/package.json"))),
    path.join(lab, "app/node_modules/ws"),
    { recursive: true },
  );
  await writeFile(
    path.join(lab, "entry.mjs"),
    `import {writeFile,mkdir} from 'node:fs/promises'; import {spawn} from 'node:child_process'; await mkdir('/data',{recursive:true}); await writeFile('/data/config.json',JSON.stringify({enabled:true,permit:'allow',hubInput:'http://hub:8787',hubToken:process.env.FLEET_TOKEN,deviceId:'',autoUpdate:false})); const child=spawn('/lab/fleet-agent',[],{stdio:'inherit',env:{...process.env,FLEET_HOME:'/data',FLEET_BACKEND_TYPE:'pty'}}); for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill(sig)); child.on('exit',code=>process.exit(code??1));`,
  );
  await docker("network", "create", "--internal", name);
  const limits = [
    "--cpus=1",
    "--memory=1g",
    "--memory-swap=1g",
    "--pids-limit=256",
    "--security-opt=no-new-privileges",
  ];
  const mounts = [
    "-v",
    `${lab}/app:/app:ro`,
    "-v",
    `${lab}:/lab:ro`,
    "-w",
    "/app",
    "--tmpfs",
    "/data:rw,nosuid,nodev,size=134217728",
  ];
  const common = [
    ...limits,
    ...mounts,
    "-e",
    "HTTP_PROXY=",
    "-e",
    "HTTPS_PROXY=",
    "-e",
    "http_proxy=",
    "-e",
    "https_proxy=",
    "-e",
    "NO_PROXY=*",
  ];
  async function start(side, args) {
    const id = `${name}-${side}`;
    containers.push(id);
    await docker("run", "-d", "--name", id, "--network", name, ...common, ...args);
    return id;
  }
  const hub = await start("hub", [
    "--network-alias",
    "hub",
    "-e",
    `SELF_HOST_TOKEN=${token}`,
    "-e",
    "HOST=0.0.0.0",
    "-e",
    "PORT=8787",
    image,
    "node",
    "packages/fleet-hub/index.mjs",
  ]);
  // Keep HTTP entirely inside the internal network; Docker exec pipes carry only probe JSON.
  bridge = spawn(
    "docker",
    [
      "exec",
      "-i",
      hub,
      "node",
      "--input-type=module",
      "-e",
      `import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line',async line=>{const q=JSON.parse(line);try{const r=await fetch('http://127.0.0.1:8787/v1/'+q.route,{method:'POST',headers:{authorization:'Bearer '+process.env.SELF_HOST_TOKEN,'content-type':'application/json','x-fleet-operator':q.operator},body:JSON.stringify(q.body),signal:AbortSignal.timeout(35000)});console.log(JSON.stringify({id:q.id,status:r.status,data:await r.json()}));}catch(e){console.log(JSON.stringify({id:q.id,error:e.message}));}});`,
    ],
    { env, stdio: ["pipe", "pipe", "inherit"] },
  );
  createInterface({ input: bridge.stdout }).on("line", (line) => {
    const result = JSON.parse(line);
    pending.get(result.id)?.resolve(result);
    pending.delete(result.id);
  });
  bridge.on("exit", (code) => {
    for (const request of pending.values())
      request.resolve({ error: `probe bridge exited ${code}` });
    pending.clear();
  });
  for (const side of ["a", "b"])
    await start(side, [
      "--hostname",
      `pod-${side}`,
      "-e",
      `FLEET_TOKEN=${token}`,
      "-e",
      `FLEET_NAME=pod-${side}`,
      "-e",
      "FLEET_URL=http://hub:8787",
      image,
      "node",
      "/lab/entry.mjs",
    ]);
  let devices;
  for (let i = 0; i < 120; i++) {
    try {
      const result = await rpc("list_computers", {});
      devices = result.computers.filter((x) => x.online);
      if (devices.length === 2) break;
    } catch {
      /* Hub and endpoints start asynchronously; bounded readiness retry. */
    }
    await pause(250);
  }
  assert.equal(devices?.length, 2, "two endpoints connected");
  const byName = Object.fromEntries(devices.map((x) => [x.name, x.id]));
  assert(byName["pod-a"] && byName["pod-b"]);
  for (const ctr of containers) {
    const config = JSON.parse(await docker("inspect", ctr))[0];
    assert.equal(config.HostConfig.Memory, 1073741824);
    assert.equal(config.HostConfig.NanoCpus, 1e9);
    assert.equal(config.State.OOMKilled, false);
  }
  pass("isolated internal network, two distinct endpoints and 1 CPU/1 GiB caps");
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const host = `pod-${i % 3 === 0 ? "b" : "a"}`;
        const op = `operator-${i}`;
        const marker = `${host}-${op}-round-${round}`;
        const row = await run(
          byName[host],
          `printf '%s:%s' "$HOSTNAME" '${marker}'`,
          op,
          randomUUID(),
        );
        completed(row);
        assert.equal(row.stdout.trim(), `${host}:${marker}`);
        const stolen = await rpc(
          "get_result",
          { device_id: byName[host], corr: row.corr },
          "outsider",
        );
        assert(!JSON.stringify(stolen).includes(marker));
        const screen = await rpc(
          "read_screen",
          { device_id: byName[host], corr: row.corr },
          "outsider",
        );
        assert.equal(screen.screen, null);
      }),
    );
  }
  pass("24 concurrent operator tasks on same/different endpoints; foreign output/screen denied");
  const device = byName["pod-a"];
  const request = randomUUID();
  const command = "printf x >> /data/once; sleep 3; printf running-survived";
  const first = await run(device, command, "replay-owner", request, 0);
  await Promise.all(
    Array.from({ length: 6 }, () => run(device, command, "replay-owner", request, 0)),
  );
  const running = await rpc(
    "get_result",
    { device_id: device, corr: first.corr, request_id: request },
    "replay-owner",
  );
  assert.notEqual(running.status, "done");
  const done = await waitDone(device, first.corr, "replay-owner", request);
  completed(done);
  assert(done.stdout.includes("running-survived"));
  await run(device, command, "replay-owner", request);
  const count = await run(device, "wc -c < /data/once");
  completed(count);
  assert.equal(count.stdout.trim(), "1");
  pass("duplicate delivery while running and after completion executes side effect exactly once");
  await memory("baseline");
  // Continuous no-newline output is generated only inside disposable capped Linux endpoints.
  // 16 MiB per task, 8 tasks per round; retention eviction is exercised separately below.
  for (let round = 0; round < 6; round++) {
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const host = i % 2 ? "pod-a" : "pod-b";
        const row = await run(
          byName[host],
          "head -c 16777216 /dev/zero | tr '\\000' x; printf END",
          `pressure-${i}`,
          randomUUID(),
          30000,
        );
        completed(row);
        assert(row.stdout.endsWith("END"));
        assert(Buffer.byteLength(row.stdout) < 1024 * 1024);
      }),
    );
    await memory(round);
  }
  pass(
    "48 no-newline 16 MiB tasks returned bounded output with final marker; endpoints remain online",
  );
  // Fill both 256-pane retention windows with full-size retained payloads before plateau checks.
  for (let batch = 0; batch < 33; batch++)
    await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const id = byName[i % 2 ? "pod-a" : "pod-b"];
        const row = await run(
          id,
          "head -c 131072 /dev/zero | tr '\\000' w; printf END",
          `warm-${i}`,
          randomUUID(),
        );
        completed(row);
        assert(row.stdout.endsWith("END"));
      }),
    );
  await memory("retention-full");
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const row = await run(
          byName[i % 2 ? "pod-a" : "pod-b"],
          "head -c 16777216 /dev/zero | tr '\\000' z; printf END",
          `steady-${i}`,
          randomUUID(),
          30000,
        );
        completed(row);
        assert(row.stdout.endsWith("END"));
        assert(Buffer.byteLength(row.stdout) < 1024 * 1024);
      }),
    );
    await memory(`steady-${round}`);
  }
  const steady = evidence.memory.slice(-3);
  for (const side of ["a", "b", "hub"]) {
    const readings = steady.map((x) => x.samples.find((s) => s.side === side).rssKiB);
    assert(
      Math.max(...readings) - Math.min(...readings) < 64 * 1024,
      `${side} RSS spread exceeds 64 MiB after warmup`,
    );
  }
  pass(
    "full retention plus three 256 MiB output rounds: RSS below 384 MiB, spread below 64 MiB, no OOM and two endpoints online",
  );
  await run(device, command, "replay-owner", request);
  const finalCount = await run(device, "wc -c < /data/once");
  completed(finalCount);
  assert.equal(finalCount.stdout.trim(), "1");
  pass("completed-output eviction preserves replay receipt and never repeats side effect");
  await memory("after-retention");
  evidence.finished = new Date().toISOString();
  console.log("EVIDENCE", lab);
} finally {
  bridge?.stdin.end();
  for (const ctr of containers) {
    try {
      const output = await exec("docker", ["logs", ctr], { env, maxBuffer: 16 * 1024 * 1024 });
      await writeFile(path.join(lab, `${ctr}.log`), output.stdout + output.stderr);
    } catch {
      /* A failed create may leave no container log. */
    }
    try {
      await docker("rm", "-f", ctr);
    } catch {
      /* Cleanup is scoped and idempotent after partial startup. */
    }
  }
  try {
    await docker("network", "rm", name);
  } catch {
    /* Network may not have been created. */
  }
  await writeFile(path.join(lab, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("Artifacts:", lab);
}
