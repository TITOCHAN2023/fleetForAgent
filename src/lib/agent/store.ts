import { AgentRuntime, type AgentSnapshot, type Permit } from "./runtime";

const runtime = new AgentRuntime();
const listeners = new Set<() => void>();
let cached: AgentSnapshot = runtime.snapshot();

function emit() {
  cached = runtime.snapshot();
  for (const l of listeners) l();
}

export function getAgentRuntime() {
  return runtime;
}

export function subscribeAgent(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAgentSnapshot(): AgentSnapshot {
  return cached;
}

export async function agentConnect(hubInput: string) {
  if (!runtime.enabled) runtime.setEnabled(true);
  await runtime.connect(hubInput, {
    connect: async () => {
      await new Promise((r) => setTimeout(r, 220));
    },
  });
  emit();
  return runtime.snapshot();
}

export function agentDisconnect() {
  runtime.disconnect("manual disconnect");
  emit();
}

export function agentSetEnabled(enabled: boolean) {
  runtime.setEnabled(enabled);
  emit();
}

export function agentSetPermit(permit: Permit) {
  runtime.setPermit(permit);
  emit();
}

export function agentIncoming(command: string) {
  const out = runtime.incomingRun(command);
  emit();
  return out;
}

export function agentApprove() {
  const out = runtime.approve();
  emit();
  return out;
}

export function agentDeny() {
  const out = runtime.deny();
  emit();
  return out;
}

export function agentTick() {
  const out = runtime.tick();
  if (out) emit();
  return out;
}
