// Requires local builds: FLEET_LAB_AGENT and FLEET_LAB_HERDR (tested 0.9.0).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
const exec = promisify(execFile);
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("Worker lab requires Node 22+");
const root = fileURLToPath(new URL("../../", import.meta.url));
const name = `fleet-worker-lab-${process.pid}`;
const evidence = await mkdtemp(path.join(os.tmpdir(), name + "-"));
const seedKey = randomBytes(24).toString("hex");
const agent = process.env.FLEET_LAB_AGENT,
  herdr = process.env.FLEET_LAB_HERDR;
if (!agent || !herdr) throw new Error("set FLEET_LAB_AGENT and FLEET_LAB_HERDR to local binaries");
const nodeImage = "node:22.22.0-bookworm-slim";
const containers = [];
const limits = [
  "--init",
  "--cpus=1",
  "--memory=1g",
  "--memory-swap=1g",
  "--pids-limit=256",
  "--security-opt=no-new-privileges",
];
const proxy = [
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
async function docker(...args) {
  console.log("[worker-lab]", args[0], args[0] === "run" ? args[3] : "");
  const result = await exec(
    "sudo",
    ["-n", "--preserve-env=HTTP_PROXY,HTTPS_PROXY", "docker", ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
}
async function start(label, args) {
  const id = name + "-" + label;
  containers.push(id);
  await docker("run", "-d", "--name", id, "--network", name, ...limits, ...proxy, ...args);
  return id;
}
try {
  await docker("network", "create", name);
  // Immutable external Herdr binary is mounted read-only, never installed on host.
  await writeFile(
    path.join(evidence, "Dockerfile"),
    'FROM alpine:3.20\nRUN https_proxy="$HTTPS_PROXY" http_proxy="$HTTP_PROXY" apk add --no-cache bash tmux ca-certificates\n',
  );
  await docker(
    "build",
    "--network=host",
    "--build-arg",
    "HTTP_PROXY",
    "--build-arg",
    "HTTPS_PROXY",
    "-t",
    name + "-agent",
    evidence,
  );
  await mkdir(path.join(root, "scripts/plugin-peer-vm/.wrangler"), { recursive: true });
  const hub = await start("hub", [
    "--network-alias",
    "hub",
    "-p",
    "127.0.0.1::8787",
    "-v",
    root + ":/workspace:ro",
    "--tmpfs",
    "/workspace/scripts/plugin-peer-vm/.wrangler:rw,nosuid,nodev,mode=1777",
    "-w",
    "/workspace",
    "-e",
    "WRANGLER_SEND_METRICS=false",
    nodeImage,
    "node",
    "packages/fleet-worker/node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    "scripts/plugin-peer-vm/wrangler.toml",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    "8787",
    "--var",
    "HUB_ORIGIN:http://hub:8787",
    "--var",
    "RTC_STUN_URLS:",
    "--var",
    "VM_SEED_KEY:" + seedKey,
    "--persist-to",
    "/tmp/worker-state",
    "--show-interactive-dev-session=false",
  ]);
  const port = JSON.parse(await docker("inspect", hub))[0].NetworkSettings.Ports["8787/tcp"][0]
    .HostPort;
  let seed;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__fleet_vm__/seed`, {
        method: "POST",
        headers: { "x-fleet-vm-key": seedKey },
      });
      if (r.ok) {
        seed = await r.json();
        break;
      }
    } catch {
      /* Readiness retries or cleanup of disposable resources. */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!seed?.token) throw new Error("real Worker failed to seed");
  await writeFile(path.join(evidence, "seed.json"), JSON.stringify(seed), { mode: 0o600 });
  for (const endpoint of ["pod-a", "pod-b"]) {
    await start(endpoint, [
      "--hostname",
      endpoint,
      "-v",
      agent + ":/usr/local/bin/fleet-agent:ro",
      "-v",
      herdr + ":/usr/local/bin/herdr:ro",
      "-v",
      path.join(root, "scripts/intranet-lab/entrypoint.sh") + ":/entrypoint.sh:ro",
      "-e",
      "FLEET_URL=http://hub:8787",
      "-e",
      "FLEET_TOKEN=" + seed.token,
      "-e",
      "FLEET_NAME=" + endpoint,
      "-e",
      "FLEET_HOME=/data",
      "-e",
      "FLEET_BACKEND_TYPE=pty",
      name + "-agent",
      "sh",
      "/entrypoint.sh",
    ]);
  }
  const tool = await start("tool", [
    "-v",
    root + ":/workspace:ro",
    "-v",
    evidence + ":/evidence:ro",
    "-w",
    "/workspace",
    nodeImage,
    "node",
    "scripts/intranet-lab/worker-probe.mjs",
  ]);
  const result = await docker("wait", tool);
  const log = await docker("logs", tool);
  console.log(log);
  if (result !== "0") throw new Error("Tool probe failed: " + result);
  for (const ctr of containers) {
    const cfg = JSON.parse(await docker("inspect", ctr))[0].HostConfig;
    if (cfg.Memory !== 1073741824 || cfg.NanoCpus !== 1e9)
      throw new Error("resource caps wrong: " + ctr);
  }
  console.log("Evidence: " + evidence);
} finally {
  for (const ctr of containers) {
    try {
      await writeFile(path.join(evidence, ctr + ".log"), await docker("logs", ctr));
    } catch {
      /* Readiness retries or cleanup of disposable resources. */
    }
    try {
      await docker("rm", "-f", ctr);
    } catch {
      /* Readiness retries or cleanup of disposable resources. */
    }
  }
  try {
    await docker("network", "rm", name);
  } catch {
    /* Readiness retries or cleanup of disposable resources. */
  }
  try {
    await docker("image", "rm", name + "-agent");
  } catch {
    /* Readiness retries or cleanup of disposable resources. */
  }
}
