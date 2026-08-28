/**
 * Build an npm-installable tarball of packages/fleet-tool for
 *   npx -y https://fleet.ginfo.cc/fleet-tool.tgz
 *
 * fleet-tool imports ../fleet-worker/src/tokenv1.mjs. npm pack of that
 * folder alone is not runnable, so this stages a self-contained package.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_DIR = join(ROOT, "packages/fleet-tool");
const TOKEN_SRC = join(ROOT, "packages/fleet-worker/src/tokenv1.mjs");
export const DEFAULT_OUT = join(ROOT, "packages/fleet-worker/public/fleet-tool.tgz");

const WORKER_IMPORT = 'from "../fleet-worker/src/tokenv1.mjs"';
const PACKED_IMPORT = 'from "./tokenv1.mjs"';

export function fleetToolVersion(operatorSrc = readFileSync(join(TOOL_DIR, "operator.mjs"), "utf8")) {
  const m = operatorSrc.match(/export const FLEET_VERSION = "([^"]+)"/);
  if (!m) throw new Error("FLEET_VERSION missing from packages/fleet-tool/operator.mjs");
  return m[1];
}

export function rewriteToolIndex(src) {
  if (!src.includes(WORKER_IMPORT)) {
    throw new Error(`packages/fleet-tool/index.mjs must import tokenv1 via ${WORKER_IMPORT}`);
  }
  return src.replaceAll(WORKER_IMPORT, PACKED_IMPORT);
}

export function packFleetTool({ outFile = DEFAULT_OUT } = {}) {
  const stage = join(tmpdir(), `fleet-tool-pack-${process.pid}-${Date.now()}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    writeFileSync(join(stage, "index.mjs"), rewriteToolIndex(readFileSync(join(TOOL_DIR, "index.mjs"), "utf8")));
    cpSync(join(TOOL_DIR, "operator.mjs"), join(stage, "operator.mjs"));
    cpSync(join(TOOL_DIR, "rtc.mjs"), join(stage, "rtc.mjs"));
    cpSync(join(TOOL_DIR, "file-transfer.mjs"), join(stage, "file-transfer.mjs"));
    cpSync(join(TOOL_DIR, "file-transfer-rtc.mjs"), join(stage, "file-transfer-rtc.mjs"));
    cpSync(join(TOOL_DIR, "official-plugins.generated.mjs"), join(stage, "official-plugins.generated.mjs"));
    cpSync(TOKEN_SRC, join(stage, "tokenv1.mjs"));
    cpSync(join(TOOL_DIR, "README.md"), join(stage, "README.md"));
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify(
        {
          name: "fleet-tool",
          version: fleetToolVersion(),
          license: "MIT",
          type: "module",
          bin: { "fleet-tool": "./index.mjs" },
          dependencies: { werift: "0.24.4" },
          files: ["index.mjs", "operator.mjs", "rtc.mjs", "file-transfer.mjs", "file-transfer-rtc.mjs", "official-plugins.generated.mjs", "tokenv1.mjs", "README.md"],
        },
        null,
        2,
      )}\n`,
    );
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json"], { cwd: stage, encoding: "utf8" }));
    const filename = packed[0]?.filename;
    if (!filename) throw new Error("npm pack did not return a filename");
    mkdirSync(dirname(outFile), { recursive: true });
    cpSync(join(stage, filename), outFile);
    return outFile;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = packFleetTool();
  console.log(out);
}
