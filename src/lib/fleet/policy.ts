/** Local lab-agent mirror. Production enforcement lives only in the device Agent. */

export function devicePolicyBlocked(command: string): boolean {
  return blocked(command, 0);
}

function blocked(command: string, depth: number): boolean {
  if (depth > 3) return true;
  for (const seg of splitCommandSegments(command)) {
    const args = normalizeCommand(fieldsRespectingSimple(seg));
    if (args.length === 0) continue;
    const nested = nestedShellBody(args);
    if (nested != null) {
      if (blocked(nested, depth + 1)) return true;
      continue;
    }
    if (destructiveVerbBlocked(args)) return true;
    if (commandBase(args[0]) !== "rm") continue;
    const parsed = parseRmRf(args);
    if (parsed.rf && rmRfPathsDangerous(parsed.paths)) return true;
  }
  return false;
}

function nestedShellBody(args: string[]): string | null {
  if (args.length < 3) return null;
  const base = commandBase(args[0]);
  if (["sh", "bash", "dash", "zsh", "ksh"].includes(base)) {
    for (let i = 1; i < args.length - 1; i += 1) {
      const arg = args[i].toLowerCase();
      if (
        arg === "-c" ||
        (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("c"))
      ) {
        return args.slice(i + 1).join(" ");
      }
      if (!arg.startsWith("-")) break;
      if (["-o", "--rcfile", "--init-file"].includes(arg)) i += 1;
    }
  }
  if (base === "cmd") {
    const at = args.findIndex((arg, i) => i > 0 && ["/c", "/k"].includes(arg.toLowerCase()));
    if (at > 0 && at < args.length - 1) return args.slice(at + 1).join(" ");
  }
  if (["powershell", "pwsh"].includes(base)) {
    const at = args.findIndex((arg, i) => i > 0 && ["-command", "-c"].includes(arg.toLowerCase()));
    if (at > 0 && at < args.length - 1) return args.slice(at + 1).join(" ");
  }
  return null;
}

function destructiveVerbBlocked(args: string[]): boolean {
  const base = commandBase(args[0]);
  if (
    ["powershell", "pwsh"].includes(base) &&
    args.slice(1).some((arg) => ["-encodedcommand", "-enc"].includes(arg.toLowerCase()))
  )
    return true;
  if (["shutdown", "reboot", "halt", "poweroff", "diskpart"].includes(base)) return true;
  if (base === "mkfs" || base.startsWith("mkfs.")) return true;
  if (base === "format") return Boolean(args[1]?.trim().toLowerCase().endsWith(":"));
  if (base === "del") return args.slice(1).some((arg) => arg.toLowerCase().includes("/f"));
  if (["rd", "rmdir", "remove-item"].includes(base)) {
    const parsed = destructiveRemoveArgs(args.slice(1));
    return parsed.recursive && parsed.force && rmRfPathsDangerous(parsed.paths);
  }
  return false;
}

function destructiveRemoveArgs(args: string[]): {
  recursive: boolean;
  force: boolean;
  paths: string[];
} {
  let recursive = false;
  let force = false;
  const paths: string[] = [];
  for (const arg of args) {
    switch (arg.toLowerCase()) {
      case "/s":
      case "-r":
      case "-recurse":
      case "-recursive":
        recursive = true;
        break;
      case "/q":
      case "-f":
      case "-force":
        force = true;
        break;
      default:
        if ((!arg.startsWith("-") && !arg.startsWith("/")) || isAbsPath(arg)) paths.push(arg);
    }
  }
  return { recursive, force, paths };
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
  if (!["sudo", "doas"].includes(commandBase(args[0]))) return args;
  let i = 1;
  while (i < args.length) {
    const option = args[i];
    if (option === "--") {
      i += 1;
      break;
    }
    if (!option.startsWith("-")) break;
    i += 1;
    if (sudoOptionTakesValue(option) && i < args.length) i += 1;
  }
  return args.slice(i);
}

function sudoOptionTakesValue(option: string): boolean {
  if (option.includes("=") || (option.length > 2 && !option.startsWith("--"))) return false;
  return [
    "-u",
    "-g",
    "-h",
    "-p",
    "-C",
    "-D",
    "-R",
    "-T",
    "--user",
    "--group",
    "--host",
    "--prompt",
    "--chdir",
    "--close-from",
  ].includes(option);
}

function commandBase(value = ""): string {
  const base = value.trim().replaceAll("\\", "/").split("/").pop()?.toLowerCase() || "";
  return base.replace(/\.(?:exe|com)$/, "");
}

function normalizeCommand(input: string[]): string[] {
  let args = stripSudoPrefix(input);
  while (args.length) {
    const cmd = commandBase(args[0]);
    if (cmd === "command") {
      args = args.slice(1);
      while (args.length && args[0].startsWith("-")) args = args.slice(1);
      continue;
    }
    if (cmd === "busybox") {
      args = args.slice(1);
      while (args.length && args[0].startsWith("-")) args = args.slice(1);
      continue;
    }
    if (cmd === "env") {
      args = stripEnvPrefix(args);
      continue;
    }
    break;
  }
  return args;
}

function stripEnvPrefix(input: string[]): string[] {
  let args = input.slice(1);
  while (args.length) {
    const arg = args[0];
    if (arg === "--") return args.slice(1);
    if (arg.includes("=") && !arg.startsWith("-")) {
      args = args.slice(1);
      continue;
    }
    if (!arg.startsWith("-")) return args;
    args = args.slice(1);
    if (
      ["-u", "--unset", "-c", "--chdir", "-s", "--split-string"].includes(arg.toLowerCase()) &&
      !arg.includes("=") &&
      args.length
    ) {
      args = args.slice(1);
    }
  }
  return args;
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
    if (a === "--recursive" || ["-recurse", "-recursive"].includes(a.toLowerCase())) {
      recursive = true;
      continue;
    }
    if (a === "--force" || a.toLowerCase() === "-force") {
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
  if (!raw || raw.includes("*") || raw.includes("?") || raw.includes("[")) return false;
  if (raw === "~" || raw.startsWith("~/") || raw === "$HOME" || raw.startsWith("$HOME/")) {
    return false;
  }
  if (raw.startsWith("/")) {
    const cleaned = cleanSlashAbsolute(raw);
    if (cleaned === "/") return false;
    const rel = cleaned.slice(1);
    return rel !== "" && rel.includes("/");
  }
  if (winAbsPath(raw)) {
    const cleaned = cleanSlashAbsolute(raw.slice(2).replaceAll("\\", "/"));
    if (cleaned === "/") return false;
    const rel = cleaned.slice(1);
    return rel !== "" && rel.includes("/");
  }
  return false;
}

function isAbsPath(value: string): boolean {
  return value.startsWith("/") || winAbsPath(value);
}

function winAbsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value);
}

function cleanSlashAbsolute(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
