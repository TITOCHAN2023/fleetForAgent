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

type ScreenSlot = {
  last?: Record<string, unknown>;
  byCorr: Map<string, Record<string, unknown>>;
};

type LiveStore = {
  byDevice: Map<string, LiveSlot>;
  byUser: Map<string, Set<string>>;
  screens: Map<string, ScreenSlot>;
  results: Map<string, Map<string, Record<string, unknown>>>;
};

const OPEN = 1;

const g = globalThis as typeof globalThis & { __fleetLive__?: LiveStore };

function store(): LiveStore {
  g.__fleetLive__ ??= {
    byDevice: new Map(),
    byUser: new Map(),
    screens: new Map(),
    results: new Map(),
  };
  return g.__fleetLive__;
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
  const s = store();
  const slot: ScreenSlot = s.screens.get(deviceId) ?? { byCorr: new Map() };
  slot.last = body;
  if (corr) slot.byCorr.set(corr, body);
  s.screens.set(deviceId, slot);
}

export function getScreen(deviceId: string, corr?: string): Record<string, unknown> | null {
  const slot = store().screens.get(deviceId);
  if (!slot) return null;
  if (corr && slot.byCorr.get(corr)) return slot.byCorr.get(corr) ?? null;
  return slot.last ?? null;
}

export function putResult(deviceId: string, corr: string, row: Record<string, unknown>) {
  const s = store();
  let m = s.results.get(deviceId);
  if (!m) {
    m = new Map();
    s.results.set(deviceId, m);
  }
  m.set(corr, row);
}

export function getResult(deviceId: string, corr: string): Record<string, unknown> | undefined {
  return store().results.get(deviceId)?.get(corr);
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
export function resetLive() {
  const s = store();
  s.byDevice.clear();
  s.byUser.clear();
  s.screens.clear();
  s.results.clear();
}
