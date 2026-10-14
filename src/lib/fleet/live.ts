import { HubPayloads, expiredResult, isTerminalResult } from "../../../packages/fleet-hub/payload-cache.mjs";

type WsLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type LiveSlot = {
  userId: string;
  deviceId: string;
  ws: WsLike;
};

type BeatWaiter = { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> };
type BeatSlot = { seq: number; waiters: BeatWaiter[] };
type DesktopWaiter = {
  resolve: (body: Record<string, unknown> | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
};

type LiveStore = {
  byDevice: Map<string, LiveSlot>;
  byUser: Map<string, Set<string>>;
  payloads: HubPayloads;
  completed: Set<string>;
  agentVer: Map<string, string>;
  beats: Map<string, BeatSlot>;
  desktop: Map<string, DesktopWaiter>;
};

const OPEN = 1;

const g = globalThis as typeof globalThis & { __fleetLive__?: LiveStore };

function store(): LiveStore {
  g.__fleetLive__ ??= {
    byDevice: new Map(),
    byUser: new Map(),
    payloads: new HubPayloads(),
    completed: new Set(),
    agentVer: new Map(),
    beats: new Map(),
    desktop: new Map(),
  };
  const s = g.__fleetLive__;
  s.completed ??= new Set();
  if (!s.payloads) {
    s.payloads = new HubPayloads();
    // Development hot reload: migrate snapshots into the bounded cache rather
    // than discarding still-useful output. This never alters routing/auth state.
    const old = s as LiveStore & {
      results?: Map<string, Map<string, Record<string, unknown>>>;
      screens?: Map<string, { last?: Record<string, unknown>; byCorr: Map<string, Record<string, unknown>> }>;
    };
    for (const [device, rows] of old.results ?? []) for (const [corr, row] of rows) {
      s.payloads.putResult(device, corr, row);
      if (isTerminalResult(row)) s.completed.add(s.payloads.key(device, corr));
    }
    for (const [device, slot] of old.screens ?? []) {
      for (const [corr, row] of slot.byCorr) s.payloads.putScreen(device, corr, row);
      if (slot.last) s.payloads.putScreen(device, "", slot.last);
    }
    Reflect.deleteProperty(s, "screens");
    Reflect.deleteProperty(s, "results");
  }
  s.agentVer ??= new Map();
  s.beats ??= new Map();
  s.desktop ??= new Map();
  return s;
}

export function attachDevice(userId: string, deviceId: string, ws: WsLike) {
  const s = store();
  const prev = s.byDevice.get(deviceId);
  if (prev && prev.ws !== ws) {
    try {
      prev.ws.close(1012, "replaced");
    } catch {
      /* ignore */
    }
    userSet(prev.userId).delete(deviceId);
  }
  s.byDevice.set(deviceId, { userId, deviceId, ws });
  userSet(userId).add(deviceId);
}

export function detachDevice(deviceId: string, ws?: WsLike) {
  const s = store();
  const slot = s.byDevice.get(deviceId);
  if (!slot) return;
  if (ws && slot.ws !== ws) return;
  s.byDevice.delete(deviceId);
  userSet(slot.userId).delete(deviceId);
}

export function kickUser(userId: string) {
  const ids = [...userSet(userId)];
  for (const id of ids) {
    const slot = store().byDevice.get(id);
    if (slot) {
      try {
        slot.ws.close(1008, "token reset");
      } catch {
        /* ignore */
      }
    }
    detachDevice(id);
  }
}

export function sendToDevice(userId: string, deviceId: string, payload: unknown): boolean {
  const slot = store().byDevice.get(deviceId);
  if (!slot || slot.userId !== userId) return false;
  if (slot.ws.readyState !== OPEN) return false;
  slot.ws.send(JSON.stringify(payload));
  return true;
}

export function isOnline(deviceId: string): boolean {
  const slot = store().byDevice.get(deviceId);
  return Boolean(slot && slot.ws.readyState === OPEN);
}

export function ownerOf(deviceId: string): string | null {
  return store().byDevice.get(deviceId)?.userId ?? null;
}

export function putScreen(deviceId: string, body: Record<string, unknown>, corr?: string) {
  store().payloads.putScreen(deviceId, corr, body);
}

export function getScreen(deviceId: string, corr?: string): Record<string, unknown> | null {
  // A missing explicit handle is not permission to show another task's pane.
  return store().payloads.getScreen(deviceId, corr) ?? null;
}

export function putResult(deviceId: string, corr: string, row: Record<string, unknown>) {
  const s = store();
  const key = s.payloads.key(deviceId, corr);
  if (isTerminalResult(row)) s.completed.add(key);
  else if (s.completed.has(key)) return;
  s.payloads.putResult(deviceId, corr, row);
}

export function getResult(deviceId: string, corr: string): Record<string, unknown> | undefined {
  const s = store();
  return s.payloads.getResult(deviceId, corr) ?? (s.completed.has(s.payloads.key(deviceId, corr)) ? expiredResult() : undefined);
}

export function putAgentVer(deviceId: string, ver?: string) {
  if (ver === undefined) return;
  if (!ver) {
    store().agentVer.delete(deviceId);
    return;
  }
  store().agentVer.set(deviceId, ver);
}

export function getAgentVer(deviceId: string): string | undefined {
  return store().agentVer.get(deviceId);
}

function beatSlot(deviceId: string): BeatSlot {
  const s = store();
  let slot = s.beats.get(deviceId);
  if (!slot) {
    slot = { seq: 0, waiters: [] };
    s.beats.set(deviceId, slot);
  }
  return slot;
}

export function noteHeartbeat(deviceId: string) {
  const slot = beatSlot(deviceId);
  slot.seq += 1;
  const waiters = slot.waiters.splice(0);
  for (const w of waiters) w.resolve(true);
}

export function waitNextHeartbeat(deviceId: string, waitMs: number): Promise<boolean> {
  const slot = beatSlot(deviceId);
  const start = slot.seq;
  return new Promise((resolve) => {
    const waiter: BeatWaiter = {
      resolve: (ok) => {
        clearTimeout(waiter.timer);
        resolve(ok);
      },
      timer: setTimeout(() => {
        slot.waiters = slot.waiters.filter((w) => w !== waiter);
        resolve(slot.seq > start);
      }, waitMs),
    };
    slot.waiters.push(waiter);
  });
}

export function cancelHeartbeatWait(deviceId: string) {
  const slot = store().beats.get(deviceId);
  if (!slot || slot.waiters.length === 0) return;
  const waiter = slot.waiters.pop();
  waiter?.resolve(false);
}

export function waitDesktop(corr: string, waitMs: number): Promise<Record<string, unknown> | undefined> {
  const s = store();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.desktop.delete(corr);
      resolve(undefined);
    }, waitMs);
    s.desktop.set(corr, { resolve, timer });
  });
}

export function noteDesktop(corr: string, body: Record<string, unknown>) {
  if (!corr) return;
  const waiter = store().desktop.get(corr);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  store().desktop.delete(corr);
  waiter.resolve(body);
}

export function cancelDesktopWait(corr: string) {
  const waiter = store().desktop.get(corr);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  store().desktop.delete(corr);
  waiter.resolve(undefined);
}

function userSet(userId: string): Set<string> {
  const s = store();
  let set = s.byUser.get(userId);
  if (!set) {
    set = new Set();
    s.byUser.set(userId, set);
  }
  return set;
}

/** Tests only. */
export function resetLive(payloadOptions = {}) {
  const s = store();
  s.byDevice.clear();
  s.byUser.clear();
  s.payloads = new HubPayloads(payloadOptions);
  s.completed.clear();
  s.agentVer.clear();
  s.beats.clear();
  s.desktop.clear();
}
