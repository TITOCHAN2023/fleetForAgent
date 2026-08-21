import { makeEnvelope, type Envelope } from "./protocol";
import { runSimulated, type ShellDevice, type ShellResult } from "./shell";
import { resolveNode } from "./world";

export type HubEvent = {
  direction: "up" | "down";
  envelope: Envelope;
};

export type HubDispatch = {
  corr: string;
  status: "ok" | "error" | "offline";
  exitCode: number;
  stdout: string;
  stderr: string;
  events: HubEvent[];
};

function home(device: ShellDevice) {
  return resolveNode(device).os === "windows" ? "C:\\Users\\keel" : device.os === "darwin" ? "/Users/keel" : "/home/keel";
}

export function dispatchRun(opts: {
  device: ShellDevice;
  online: boolean;
  command: string;
}): HubDispatch {
  const corr = crypto.randomUUID();
  const events: HubEvent[] = [];
  const runEnv = makeEnvelope(
    "run",
    { command: opts.command, timeout_ms: 25000, cwd: home(opts.device) },
    corr,
  );
  events.push({ direction: "down", envelope: runEnv });

  if (!opts.online) {
    const off = makeEnvelope("result", { ok: false, error: "offline" }, corr);
    events.push({ direction: "up", envelope: off });
    return {
      corr,
      status: "offline",
      exitCode: 1,
      stdout: "",
      stderr: `${opts.device.name} is offline`,
      events,
    };
  }

  const result: ShellResult = runSimulated(opts.device, opts.command);
  if (result.stdout) {
    events.push({
      direction: "up",
      envelope: makeEnvelope("chunk", { stream: "stdout", data: result.stdout }, corr),
    });
  }
  if (result.stderr) {
    events.push({
      direction: "up",
      envelope: makeEnvelope("chunk", { stream: "stderr", data: result.stderr }, corr),
    });
  }
  events.push({
    direction: "up",
    envelope: makeEnvelope(
      "result",
      { ok: result.exitCode === 0, exit_code: result.exitCode },
      corr,
    ),
  });

  return {
    corr,
    status: result.exitCode === 0 ? "ok" : "error",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    events,
  };
}

export function dispatchHello(device: ShellDevice): HubEvent[] {
  const node = resolveNode(device);
  const hello = makeEnvelope("hello", {
    os: device.os,
    arch: device.arch,
    hostname: node.hostname,
    pod: node.podId,
    egress: "internet",
    intranet_ip: null,
    caps: ["shell"],
    agent_ver: "0.1.0",
  });
  const ok = makeEnvelope("hello_ok", { session_id: device.slug, heartbeat_s: 25 }, hello.id);
  return [
    { direction: "up", envelope: hello },
    { direction: "down", envelope: ok },
  ];
}
