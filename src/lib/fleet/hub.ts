import { makeEnvelope, type Envelope } from "./protocol";
import { runSimulated, type ShellDevice, type ShellResult } from "./shell";
import { resolveNode } from "./world";
import { LocalPane, ScreenCoalescer, acceptSpawn } from "./pane";

export type HubEvent = {
  direction: "up" | "down";
  envelope: Envelope;
};

export type HubDispatch = {
  corr: string;
  status: "ok" | "error" | "offline" | "running";
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

/** Async pane spawn: hub returns before the job could have finished. */
export function dispatchPaneStart(opts: {
  device: ShellDevice;
  online: boolean;
  command: string;
  now?: number;
}): HubDispatch {
  const corr = crypto.randomUUID();
  const t0 = opts.now ?? 0;
  const events: HubEvent[] = [
    {
      direction: "down",
      envelope: makeEnvelope("run", { command: opts.command, mode: "pane", cwd: home(opts.device) }, corr),
    },
  ];
  if (!opts.online) {
    events.push({ direction: "up", envelope: makeEnvelope("result", { ok: false, error: "offline" }, corr) });
    return { corr, status: "offline", exitCode: 1, stdout: "", stderr: "offline", events };
  }
  const ack = acceptSpawn(corr, `pane-${corr.slice(0, 8)}`, t0, t0 + 1);
  events.push({
    direction: "up",
    envelope: makeEnvelope("accepted", { pane_id: ack.paneId, status: "running" }, corr),
  });
  return {
    corr,
    status: "running",
    exitCode: 0,
    stdout: "",
    stderr: "",
    events,
  };
}

export function burstScreens(writes: number, intervalMs = 250) {
  let t = 1_000;
  const coal = new ScreenCoalescer(intervalMs, () => t);
  const pane = new LocalPane("p", "c", "yes");
  const wire: string[] = [];
  for (let i = 0; i < writes; i++) {
    pane.append(`#${i}\n`);
    const frame = coal.onWrite(pane.snapshot(t));
    if (frame) wire.push(frame.text);
  }
  t += intervalMs;
  const last = coal.tick();
  if (last) wire.push(last.text);
  return { wire, coalescer: coal, pane };
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
    caps: ["shell", "pane"],
    agent_ver: "0.2.0",
  });
  const ok = makeEnvelope("hello_ok", { session_id: device.slug, heartbeat_s: 25 }, hello.id);
  return [
    { direction: "up", envelope: hello },
    { direction: "down", envelope: ok },
  ];
}
