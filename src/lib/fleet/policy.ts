/** Device-policy check mirrored from packages/fleet-agent/policy.go. */

const ALWAYS =
  /(?:^|[\s;|&])(?:del\s+\/f|format\s+c:|shutdown\b|reboot\b|mkfs\b|diskpart\b)/i;

export function devicePolicyBlocked(command: string): boolean {
  if (ALWAYS.test(command)) return true;
  return rmRfBlocked(command);
}

function rmRfBlocked(command: string): boolean {
  for (const seg of splitCommandSegments(command)) {
    let args = fieldsRespectingSimple(seg);
    args = stripSudoPrefix(args);
    if (args[0] !== "rm") continue;
    const parsed = parseRmRf(args);
    if (!parsed.rf) continue;
    if (rmRfPathsDangerous(parsed.paths)) return true;
  }
  return false;
}

function splitCommandSegments(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote = "";
  let esc = false;
  for (const r of s) {
    if (esc) {
      buf += r;
      esc = false;
      continue;
    }
    if (r === "\\" && quote !== "'") {
      buf += r;
      esc = true;
      continue;
    }
    if (quote) {
      if (r === quote) quote = "";
      buf += r;
      continue;
    }
    if (r === "'" || r === '"') {
      quote = r;
      buf += r;
      continue;
    }
    if (r === ";" || r === "\n" || r === "|" || r === "&") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += r;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function fieldsRespectingSimple(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote = "";
  for (const r of s) {
    if (quote) {
      if (r === quote) {
        quote = "";
        continue;
      }
      buf += r;
      continue;
    }
    if (r === "'" || r === '"') {
      quote = r;
      continue;
    }
    if (/\s/.test(r)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += r;
  }
  if (buf) out.push(buf);
  return out;
}

function stripSudoPrefix(args: string[]): string[] {
  if (args[0] !== "sudo" && args[0] !== "doas") return args;
  let i = 1;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "--") {
      i += 1;
      break;
    }
    i += 1;
  }
  return args.slice(i);
}

function parseRmRf(args: string[]): { rf: boolean; paths: string[] } {
  let recursive = false;
  let force = false;
  let dashdash = false;
  const paths: string[] = [];
  for (const a of args.slice(1)) {
    if (dashdash) {
      paths.push(a);
      continue;
    }
    if (a === "--") {
      dashdash = true;
      continue;
    }
    if (a === "--recursive") {
      recursive = true;
      continue;
    }
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a.startsWith("-") && !a.startsWith("--")) {
      if (/[rR]/.test(a)) recursive = true;
      if (a.includes("f")) force = true;
      continue;
    }
    paths.push(a);
  }
  return { rf: recursive && force, paths };
}

function rmRfPathsDangerous(paths: string[]): boolean {
  if (paths.length === 0) return true;
  return paths.some((p) => !safeCleanupPath(p));
}

function safeCleanupPath(p: string): boolean {
  const raw = p.trim();
  if (!raw || /[*?\[]/.test(raw)) return false;
  if (raw === "~" || raw.startsWith("~/") || raw === "$HOME" || raw.startsWith("$HOME/")) {
    return false;
  }
  if (raw.startsWith("/")) {
    const cleaned = raw.replace(/\/+/g, "/").replace(/\/\.$/, "").replace(/\/$/, "") || "/";
    if (cleaned === "/") return false;
    const rel = cleaned.slice(1);
    return rel !== "" && rel.includes("/");
  }
  return false;
}
