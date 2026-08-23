#!/usr/bin/env node
/**
 * Pack a self-contained fleet-tool tarball for `npx -y <hub>/fleet-tool.tgz`.
 * Vendors tokenv1.mjs (no ../fleet-worker import) and writes the Worker asset.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolDir = join(root, "packages/fleet-tool");
const workerToken = join(root, "packages/fleet-worker/src/tokenv1.mjs");
const vendoredToken = join(toolDir, "tokenv1.mjs");
const publicDir = join(root, "packages/fleet-worker/public");
const dest = process.argv[2] ? resolve(process.argv[2]) : join(publicDir, "fleet-tool.tgz");

const files = ["index.mjs", "operator.mjs"];

copyFileSync(workerToken, vendoredToken);

const pkg = JSON.parse(readFileSync(join(toolDir, "package.json"), "utf8"));
const staged = mkdtempSync(join(tmpdir(), "fleet-tool-pack-"));
try {
  for (const name of [...files, "tokenv1.mjs"]) {
    copyFileSync(join(toolDir, name), join(staged, name));
  }
  writeFileSync(
    join(staged, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        type: pkg.type,
        bin: pkg.bin,
        files: pkg.files,
      },
      null,
      2,
    ) + "\n",
  );
  const printed = execFileSync("npm", ["pack", "--pack-destination", staged], {
    cwd: staged,
    encoding: "utf8",
  }).trim();
  const packedName = printed.split(/\r?\n/).pop();
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(staged, packedName), dest);
  console.log(`wrote ${dest} (${packedName})`);
} finally {
  rmSync(staged, { recursive: true, force: true });
}
