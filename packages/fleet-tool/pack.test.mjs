import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const workerToken = join(root, "packages/fleet-worker/src/tokenv1.mjs");
const vendoredToken = join(here, "tokenv1.mjs");
const committedTgz = join(root, "packages/fleet-worker/public/fleet-tool.tgz");
const packScript = join(root, "scripts/pack-fleet-tool.mjs");

const IMPORT_FROM = /(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g;

function importSpecifiers(source) {
  return [...source.matchAll(IMPORT_FROM)].map((m) => m[1]);
}

function assertSelfContained(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".mjs") || name.endsWith(".js"));
  assert.ok(files.includes("index.mjs"));
  assert.ok(files.includes("tokenv1.mjs"));
  assert.ok(files.includes("operator.mjs"));
  for (const name of files) {
    const src = readFileSync(join(dir, name), "utf8");
    for (const spec of importSpecifiers(src)) {
      assert.equal(spec.includes("fleet-worker"), false, `${name} imports ${spec}`);
      assert.equal(spec.startsWith("../"), false, `${name} escapes package via ${spec}`);
    }
  }
}

function extractPackage(tgz) {
  const stage = mkdtempSync(join(tmpdir(), "fleet-tool-extract-"));
  execFileSync("tar", ["-xzf", tgz, "-C", stage]);
  return { stage, pkgDir: join(stage, "package") };
}

function initializeMcp(command, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MCP initialize timed out: stdout=${out} stderr=${err}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(out);
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pack-test", version: "0" },
        },
      }) + "\n",
    );
  });
}

test("fleet-tool source is self-contained (vendored tokenv1)", () => {
  assert.equal(readFileSync(vendoredToken, "utf8"), readFileSync(workerToken, "utf8"));
  const index = readFileSync(join(here, "index.mjs"), "utf8");
  assert.match(index, /from "\.\/tokenv1\.mjs"/);
  assert.doesNotMatch(index, /fleet-worker\/src\/tokenv1/);
  assertSelfContained(here);
});

test("packed tarball has a name + bin and no escaping imports", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-tool-pack-"));
  const packed = join(tmp, "fleet-tool.tgz");
  try {
    execFileSync(process.execPath, [packScript, packed], { cwd: root, encoding: "utf8" });
    assert.ok(existsSync(packed));
    const magic = readFileSync(packed).subarray(0, 2);
    assert.equal(magic[0], 0x1f);
    assert.equal(magic[1], 0x8b);

    const fresh = extractPackage(packed);
    try {
      const pkg = JSON.parse(readFileSync(join(fresh.pkgDir, "package.json"), "utf8"));
      assert.equal(pkg.name, "fleet-tool");
      assert.equal(pkg.bin["fleet-tool"], "./index.mjs");
      assert.equal(pkg.private, undefined);
      assertSelfContained(fresh.pkgDir);

      assert.ok(existsSync(committedTgz), "commit packages/fleet-worker/public/fleet-tool.tgz");
      const committed = extractPackage(committedTgz);
      try {
        for (const name of ["package.json", "index.mjs", "operator.mjs", "tokenv1.mjs"]) {
          assert.equal(
            readFileSync(join(committed.pkgDir, name), "utf8"),
            readFileSync(join(fresh.pkgDir, name), "utf8"),
            `${name} in public/fleet-tool.tgz is stale — run npm run pack:tool`,
          );
        }
      } finally {
        rmSync(committed.stage, { recursive: true, force: true });
      }
    } finally {
      rmSync(fresh.stage, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("packed index.mjs with no args starts MCP stdio", async () => {
  const extracted = extractPackage(committedTgz);
  try {
    const out = await initializeMcp(process.execPath, [join(extracted.pkgDir, "index.mjs")]);
    const msg = JSON.parse(out.trim().split("\n")[0]);
    assert.equal(msg.result.serverInfo.name, "fleet");
    assert.equal(msg.result.protocolVersion, "2024-11-05");
  } finally {
    rmSync(extracted.stage, { recursive: true, force: true });
  }
});

test("npx -y <origin>/fleet-tool.tgz starts MCP stdio", async () => {
  const body = readFileSync(committedTgz);
  const server = createServer((req, res) => {
    if (req.url === "/fleet-tool.tgz") {
      res.writeHead(200, { "content-type": "application/gzip", "content-length": body.length });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const out = await initializeMcp("npx", ["-y", `http://127.0.0.1:${port}/fleet-tool.tgz`], 30000);
    const msg = JSON.parse(out.trim().split("\n")[0]);
    assert.equal(msg.result.serverInfo.name, "fleet");
    assert.equal(msg.result.protocolVersion, "2024-11-05");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
