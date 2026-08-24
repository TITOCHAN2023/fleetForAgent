import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function text(path) {
  return readFileSync(join(root, path), "utf8");
}

test("website and Worker serve identical CLI installers", () => {
  assert.equal(text("public/install.sh"), text("packages/fleet-worker/public/install.sh"));
  assert.equal(text("public/install.ps1"), text("packages/fleet-worker/public/install.ps1"));
  const headers = text("packages/fleet-worker/public/_headers");
  assert.match(headers, /\/install\.sh[\s\S]*text\/x-shellscript/);
  assert.match(headers, /\/install\.ps1[\s\S]*text\/plain/);
});

test("POSIX installer parses and covers macOS, Linux, amd64, and arm64", () => {
  const path = join(root, "public/install.sh");
  execFileSync("sh", ["-n", path]);
  const sh = text("public/install.sh");
  assert.match(sh, /fleet-agent-linux-\$arch\.tar\.gz/);
  assert.match(sh, /FleetAgent-macos-\$arch\.zip/);
  assert.match(sh, /x86_64\|amd64/);
  assert.match(sh, /arm64\|aarch64/);
  assert.match(sh, /checksums\.txt/);
  assert.match(sh, /SHA-256 mismatch/);
  assert.match(sh, /"\$target" quit/);
  assert.match(sh, /running: no/);
  assert.match(sh, /exec "\$target" start --hub "\$hub" --token "\$token" --permit "\$permit"/);
  assert.match(sh, /Hub token omitted; Fleet was installed but not started/);
  assert.doesNotMatch(sh, /--token is required/);
  assert.doesNotMatch(sh, /token=.*https?:\/\//i);
});

test("POSIX installer downloads, verifies, replaces, and starts the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-installer-test-"));
  try {
    const home = join(dir, "home");
    const fakeBin = join(dir, "fake-bin");
    const payload = join(dir, "payload");
    const archive = join(dir, "fleet-agent-linux-amd64.tar.gz");
    const record = join(dir, "calls.txt");
    const installed = join(home, ".local", "bin", "fleet");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(payload, { recursive: true });
    mkdirSync(dirname(installed), { recursive: true });

    const fleet = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$INSTALL_RECORD"\nif [ "\${1:-}" = status ]; then printf '%s\\n' 'running: no'; fi\n`;
    writeFileSync(join(payload, "fleet"), fleet, { mode: 0o755 });
    writeFileSync(installed, fleet, { mode: 0o755 });
    execFileSync("tar", ["-C", payload, "-czf", archive, "fleet"]);
    const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");

    writeFileSync(
      join(fakeBin, "uname"),
      `#!/bin/sh\nif [ "\${1:-}" = -m ]; then echo x86_64; else echo Linux; fi\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, "curl"),
      `#!/bin/sh\nout=\nurl=\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out=$2; shift 2 ;;\n    -*) shift ;;\n    *) url=$1; shift ;;\n  esac\ndone\ncase "$url" in\n  */checksums.txt) printf '%s  %s\\n' "$FAKE_SUM" 'fleet-agent-linux-amd64.tar.gz' ;;\n  *) cp "$FAKE_ARCHIVE" "$out" ;;\nesac\n`,
      { mode: 0o755 },
    );
    chmodSync(join(fakeBin, "uname"), 0o755);
    chmodSync(join(fakeBin, "curl"), 0o755);

    execFileSync(
      "sh",
      [
        join(root, "public/install.sh"),
        "--hub",
        "https://hub.example",
        "--token",
        "flt_test",
        "--permit",
        "ask",
      ],
      {
        env: {
          ...process.env,
          FAKE_ARCHIVE: archive,
          FAKE_SUM: sum,
          HOME: home,
          INSTALL_RECORD: record,
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
      },
    );

    assert.equal(
      readFileSync(record, "utf8"),
      "quit\nstatus\nstart --hub https://hub.example --token flt_test --permit ask\n",
    );
    assert.equal(readFileSync(installed, "utf8"), fleet);

    writeFileSync(record, "");
    const tokenless = execFileSync(
      "sh",
      [join(root, "public/install.sh"), "--hub", "https://hub.example", "--permit", "ask"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_ARCHIVE: archive,
          FAKE_SUM: sum,
          HOME: home,
          INSTALL_RECORD: record,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          FLEET_TOKEN: "",
        },
      },
    );
    assert.match(tokenless, /installed but not started/);
    assert.equal(readFileSync(record, "utf8"), "quit\nstatus\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows installer verifies and starts the native amd64 or arm64 executable", () => {
  const ps = text("public/install.ps1");
  assert.match(ps, /^param\(/);
  assert.match(ps, /FleetAgent-windows-\$arch\.exe/);
  assert.match(ps, /"AMD64" \{ "amd64" \}/);
  assert.match(ps, /"ARM64" \{ "arm64" \}/);
  assert.match(ps, /Get-FileHash -Algorithm SHA256/);
  assert.match(ps, /\.local\\bin/);
  assert.match(ps, /& \$target quit/);
  assert.match(ps, /running:\\s\+no/);
  assert.match(ps, /& \$target start --hub \$Hub --token \$Token --permit \$Permit/);
  assert.match(ps, /Hub token omitted; Fleet was installed but not started/);
  assert.doesNotMatch(ps, /-Token is required/);
  assert.doesNotMatch(ps, /ExecutionPolicy|RunAs|Start-Process.*-Verb/i);
});
