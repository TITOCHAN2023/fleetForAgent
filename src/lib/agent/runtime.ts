import { makeEnvelope, type Envelope } from "../fleet/protocol";
import { runSimulated, type ShellDevice, type ShellResult } from "../fleet/shell";

export type Permit = "off" | "ask" | "allow";
export type ConnState = "offline" | "connecting" | "online" | "error";
export type LogLevel = "info" | "warn" | "error";

export type LogLine = {
  id: string;
  t: number;
  level: LogLevel;
  msg: string;
};

export type PendingRun = {
  corr: string;
  command: string;
  requestedAt: number;
};

export type RunOutcome = {
  corr: string;
  status: "ok" | "error" | "refused" | "pending";
  exitCode: number;
  stdout: string;
  stderr: string;
  events: Envelope[];
};

export type NormalizedHub =
  | { ok: true; host: string; wss: string; http: string }
  | { ok: false; error: string };

const DESTRUCTIVE = /rm\s+-rf|del\s+\/f|format\s+c:|shutdown|reboot|mkfs|diskpart/i;

export function normalizeHub(raw: string): NormalizedHub {
  const input = raw.trim();
  if (!input) return { ok: false, error: "Enter the hub address" };
  let url: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
      url = new URL(input);
    } else {
      url = new URL(`https://${input}`);
    }
  } catch {
    return { ok: false, error: "域名无法解析" };
  }
  if (!url.hostname) return { ok: false, error: "缺少主机名" };
  const tls = url.protocol === "https:" || url.protocol === "wss:";
  const insecure = url.protocol === "http:" || url.protocol === "ws:";
  if (!tls && !insecure) return { ok: false, error: "只接受 http(s) / ws(s)" };
  const wsProto = tls || url.protocol === "https:" ? "wss:" : "ws:";
  const httpProto = tls || url.protocol === "wss:" ? "https:" : "http:";
  const path = url.pathname && url.pathname !== "/" ? url.pathname : "/v1/device";
  const port = url.port ? `:${url.port}` : "";
  return {
    ok: true,
    host: url.hostname,
    wss: `${wsProto}//${url.hostname}${port}${path}`,
    http: `${httpProto}//${url.hostname}${port}`,
  };
}

export function localShellDevice(): ShellDevice {
  return {
    name: "本机 Agent",
    slug: "local-agent",
    os: "linux",
    arch: "x86_64",
    locationTag: "home",
  };
}

export type AgentSnapshot = {
  enabled: boolean;
  permit: Permit;
  hubInput: string;
  hub: NormalizedHub | null;
  conn: ConnState;
  error: string;
  logs: LogLine[];
  pending: PendingRun | null;
  lastOutcome: RunOutcome | null;
};

export class AgentRuntime {
  enabled = false;
  permit: Permit = "ask";
  hubInput = "";
  hub: NormalizedHub | null = null;
  conn: ConnState = "offline";
  error = "";
  logs: LogLine[] = [];
  pending: PendingRun | null = null;
  lastOutcome: RunOutcome | null = null;
  device: ShellDevice;
  execute: (cmd: string) => ShellResult;
  now: () => number;
  askTimeoutMs: number;
  private seq = 0;

  constructor(opts?: {
    device?: ShellDevice;
    execute?: (cmd: string) => ShellResult;
    now?: () => number;
    askTimeoutMs?: number;
  }) {
    this.device = opts?.device ?? localShellDevice();
    this.execute = opts?.execute ?? ((cmd) => runSimulated(this.device, cmd));
    this.now = opts?.now ?? (() => Date.now());
    this.askTimeoutMs = opts?.askTimeoutMs ?? 60_000;
  }

  snapshot(): AgentSnapshot {
    return {
      enabled: this.enabled,
      permit: this.permit,
      hubInput: this.hubInput,
      hub: this.hub,
      conn: this.conn,
      error: this.error,
      logs: this.logs.slice(),
      pending: this.pending,
      lastOutcome: this.lastOutcome,
    };
  }

  log(level: LogLevel, msg: string) {
    this.seq += 1;
    this.logs.unshift({
      id: `l${this.seq}`,
      t: this.now(),
      level,
      msg,
    });
    if (this.logs.length > 200) this.logs.length = 200;
  }

  setPermit(permit: Permit) {
    this.permit = permit;
    this.log("info", `permit → ${permit}`);
    if (permit === "off" && this.pending) {
      this.refusePending("permit_off");
    }
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.disconnect("本机开关已关闭");
    }
    this.log("info", enabled ? "agent enabled" : "agent disabled");
  }

  async connect(hubInput: string, transport?: { connect: (wss: string) => Promise<void> }) {
    this.hubInput = hubInput;
    const hub = normalizeHub(hubInput);
    this.hub = hub;
    if (!hub.ok) {
      this.conn = "error";
      this.error = hub.error;
      this.log("error", hub.error);
      return this.snapshot();
    }
    if (!this.enabled) {
      this.conn = "error";
      this.error = "Turn on this computer first";
      this.log("warn", this.error);
      return this.snapshot();
    }
    this.conn = "connecting";
    this.error = "";
    this.log("info", `connecting ${hub.wss}`);
    try {
      if (transport?.connect) await transport.connect(hub.wss);
      this.conn = "online";
      this.log("info", `online ${hub.host}`);
      this.hello();
    } catch (e) {
      this.conn = "error";
      this.error = e instanceof Error ? e.message : "连接失败";
      this.log("error", this.error);
    }
    return this.snapshot();
  }

  disconnect(reason = "disconnected") {
    if (this.pending) this.refusePending("disconnected");
    this.conn = "offline";
    this.log("warn", reason);
  }

  hello(): Envelope {
    const env = makeEnvelope("hello", {
      os: this.device.os,
      arch: this.device.arch,
      hostname: this.device.slug,
      pod: "pod-local",
      egress: "internet",
      intranet_ip: null,
      caps: ["shell"],
      agent_ver: "0.2.0",
      permit: this.permit,
    });
    this.log("info", "hello sent");
    return env;
  }

  incomingRun(command: string, corr = crypto.randomUUID()): RunOutcome {
    const runEnv = makeEnvelope("run", { command }, corr);
    if (!this.enabled || this.conn !== "online") {
      return this.finish(corr, "refused", 1, "", "agent offline or disabled", [runEnv]);
    }
    if (this.permit === "off") {
      this.log("warn", `refused (off): ${command}`);
      return this.finish(corr, "refused", 126, "", "fleet: permit=off — 本机不允许执行", [runEnv]);
    }
    if (DESTRUCTIVE.test(command)) {
      this.log("error", `blocked destructive: ${command}`);
      return this.finish(corr, "refused", 126, "", "fleet: refused by device policy", [runEnv]);
    }
    if (this.permit === "ask") {
      if (this.pending) {
        return this.finish(corr, "refused", 1, "", "fleet: another command is waiting for consent", [runEnv]);
      }
      this.pending = { corr, command, requestedAt: this.now() };
      this.log("warn", `waiting consent: ${command}`);
      return {
        corr,
        status: "pending",
        exitCode: 0,
        stdout: "",
        stderr: "waiting for local consent",
        events: [runEnv],
      };
    }
    return this.exec(corr, command, [runEnv]);
  }

  approve(corr?: string): RunOutcome {
    const p = this.pending;
    if (!p) {
      return this.finish(corr ?? "", "refused", 1, "", "no pending command", []);
    }
    if (corr && corr !== p.corr) {
      return this.finish(corr, "refused", 1, "", "corr mismatch", []);
    }
    if (this.now() - p.requestedAt > this.askTimeoutMs) {
      this.pending = null;
      this.log("warn", "consent timed out");
      return this.finish(p.corr, "refused", 1, "", "fleet: consent timed out", []);
    }
    this.pending = null;
    this.log("info", `approved: ${p.command}`);
    return this.exec(p.corr, p.command, []);
  }

  deny(corr?: string): RunOutcome {
    const p = this.pending;
    if (!p || (corr && corr !== p.corr)) {
      return this.finish(corr ?? "", "refused", 1, "", "no pending command", []);
    }
    this.pending = null;
    this.log("warn", `denied: ${p.command}`);
    return this.finish(p.corr, "refused", 1, "", "fleet: denied at the machine", []);
  }

  tick(): RunOutcome | null {
    const p = this.pending;
    if (!p) return null;
    if (this.now() - p.requestedAt <= this.askTimeoutMs) return null;
    this.pending = null;
    this.log("warn", "consent timed out");
    return this.finish(p.corr, "refused", 1, "", "fleet: consent timed out", []);
  }

  private refusePending(reason: string) {
    const p = this.pending;
    this.pending = null;
    if (p) this.log("warn", `pending dropped (${reason})`);
  }

  private exec(corr: string, command: string, prefix: Envelope[]): RunOutcome {
    const result = this.execute(command);
    const events = [...prefix];
    if (result.stdout) events.push(makeEnvelope("chunk", { stream: "stdout", data: result.stdout }, corr));
    if (result.stderr) events.push(makeEnvelope("chunk", { stream: "stderr", data: result.stderr }, corr));
    events.push(makeEnvelope("result", { ok: result.exitCode === 0, exit_code: result.exitCode }, corr));
    const status = result.exitCode === 0 ? "ok" : "error";
    this.log(status === "ok" ? "info" : "warn", `result ${result.exitCode}: ${command}`);
    const outcome: RunOutcome = {
      corr,
      status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      events,
    };
    this.lastOutcome = outcome;
    return outcome;
  }

  private finish(
    corr: string,
    status: RunOutcome["status"],
    exitCode: number,
    stdout: string,
    stderr: string,
    events: Envelope[],
  ): RunOutcome {
    const resultEnv = makeEnvelope("result", { ok: false, error: stderr, exit_code: exitCode }, corr || undefined);
    const outcome: RunOutcome = {
      corr,
      status,
      exitCode,
      stdout,
      stderr,
      events: [...events, resultEnv],
    };
    this.lastOutcome = outcome;
    return outcome;
  }
}
