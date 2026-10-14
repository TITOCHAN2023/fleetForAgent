// Linux-only regression gate, offline container with disposable source/vendor snapshot.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dockerEnvironment } from "./docker-env.mjs";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = path.join(root, "scripts/runtime-bounds-lab/.artifacts");
await mkdir(dir, { recursive: true });
const lab = await mkdtemp(path.join(dir, "go-"));
await cp(path.join(root, "packages/fleet-agent"), path.join(lab, "agent"), {
  recursive: true,
  filter: (p) => !p.split(path.sep).includes("vendor"),
});
await exec("go", ["mod", "vendor", "-o", path.join(lab, "agent/vendor")], {
  cwd: path.join(root, "packages/fleet-agent"),
  maxBuffer: 16 * 1024 * 1024,
});
const env = dockerEnvironment();
const name = `fleet-bounds-go-${process.pid}`;
const cmd = [
  "run",
  "--rm",
  "--name",
  name,
  "--network",
  name,
  "--cpus=1",
  "--memory=1g",
  "--memory-swap=1g",
  "--pids-limit=256",
  "--security-opt=no-new-privileges",
  "-v",
  `${lab}/agent:/app:ro`,
  "--tmpfs",
  "/tmp:rw,exec,nosuid,nodev,size=805306368",
  "-e",
  "GOCACHE=/tmp/gocache",
  "-e",
  "GOPATH=/tmp/gopath",
  "-e",
  "GOTOOLCHAIN=local",
  "-e",
  "GOFLAGS=-mod=vendor",
  "-e",
  "GOMAXPROCS=2",
  "-e",
  "FLEET_OPERATION_LAB=1",
  "-w",
  "/app",
  "golang:1.23-bookworm",
  "sh",
  "-c",
  'go test -p 1 -count=1 -timeout=8m ./... && go test -p 1 -race -count=3 -timeout=8m ./internal/pane && go test -p 1 -race -count=3 -timeout=8m -run "TestOperation|TestRunAdmission|TestDispatchAdmits" .',
];
console.log("Linux regression artifacts:", lab);
try {
  await exec("docker", ["network", "create", "--internal", name], { env });
  const result = await exec("docker", cmd, { env, maxBuffer: 32 * 1024 * 1024, timeout: 1800000 });
  await writeFile(path.join(lab, "tests.log"), result.stdout + result.stderr);
  console.log(result.stdout + result.stderr);
} catch (error) {
  await writeFile(
    path.join(lab, "tests.log"),
    String(error.stdout || "") + String(error.stderr || "") + "\n" + error.message,
  );
  throw error;
} finally {
  await exec("docker", ["rm", "-f", name], { env }).catch(() => {});
  await exec("docker", ["network", "rm", name], { env }).catch(() => {});
}
