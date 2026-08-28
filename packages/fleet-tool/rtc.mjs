const CONNECT_TIMEOUT_MS = 12_000;
const REPLY_TIMEOUT_MS = 8_000;
const MAX_SESSION_ROWS = 256;
const ACK_TYPES = new Set(["result", "plugin_result", "desktop"]);
let peerConnectionCtor;

async function loadPeerConnection() {
  peerConnectionCtor ||= import("werift").then((module) => module.RTCPeerConnection);
  return peerConnectionCtor;
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("RTC request cancelled");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const done = (callback, value) => {
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => done(reject, abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => done(resolve, value),
      (error) => done(reject, error),
    );
  });
}

function delay(ms, signal) {
  let timer;
  const pending = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return abortable(pending, signal).finally(() => clearTimeout(timer));
}

function settleWithin(promise, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    Promise.resolve(promise).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function fingerprint(sdp) {
  const match = String(sdp || "").match(/^a=fingerprint:sha-256\s+([0-9a-f:]+)\s*$/im);
  const value = match ? match[1].replaceAll(":", "").toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(value) ? value : "";
}

function envelope(type, body = {}, corr = "") {
  return { v: 1, type, id: crypto.randomUUID(), ...(corr ? { corr } : {}), t: Date.now(), body };
}

class DirectSession {
  constructor({ sid, deviceId, operatorId, pc, dc }) {
    this.sid = sid;
    this.deviceId = deviceId;
    this.operatorId = operatorId;
    this.pc = pc;
    this.dc = dc;
    this.open = false;
    this.directReady = false;
    this.closed = false;
    this.lastCorr = "";
    this.rows = new Map();
    this.waiters = new Set();
    dc.onopen = () => {
      this.open = true;
      this.wake();
    };
    dc.onclose = () => {
      this.closed = true;
      this.open = false;
      this.directReady = false;
      this.wake(new Error("RTC data channel closed"));
    };
    dc.onerror = () => {
      this.closed = true;
      this.open = false;
      this.directReady = false;
      this.wake(new Error("RTC data channel failed"));
    };
    dc.onmessage = (event) => this.onMessage(event.data);
    pc.connectionStateChange.subscribe((state) => {
      if (["closed", "failed", "disconnected"].includes(state)) {
        this.closed = true;
        this.open = false;
        this.directReady = false;
        this.wake(new Error(`RTC ${state}`));
      }
    });
  }

  wake(error) {
    for (const waiter of [...this.waiters]) waiter(error);
  }

  onMessage(raw) {
    const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
    if (size > 2 << 20) {
      void this.close();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    } catch {
      return;
    }
    if (msg?.v !== 1 || typeof msg.type !== "string") return;
    if (msg.type === "rtc_ready" && msg.body?.sid === this.sid) {
      this.directReady = true;
      try {
        this.send(envelope("rtc_ack_ready", { version: 1 }));
      } catch {
        /* The channel state handler will force WSS fallback. */
      }
      this.wake();
      return;
    }
    const corr = String(msg.corr || "");
    if (corr) {
      if (!this.rows.has(corr) && this.rows.size >= MAX_SESSION_ROWS) {
        const completed = [...this.rows].find(([, row]) => row.result || row.plugin_result);
        this.rows.delete(completed?.[0] || this.rows.keys().next().value);
      }
      const current = this.rows.get(corr) || {};
      this.rows.set(corr, { ...current, [msg.type]: msg });
      if (ACK_TYPES.has(msg.type)) {
        try {
          this.send(envelope("rtc_ack", { type: msg.type }, corr));
        } catch {
          /* Agent will replay the result through WSS. */
        }
      }
    }
    this.wake();
  }

  async waitReady(timeoutMs = CONNECT_TIMEOUT_MS, signal) {
    if (this.open && this.directReady && !this.closed) return;
    await this.waitFor(() => this.open && this.directReady && !this.closed, timeoutMs, signal);
  }

  async waitFor(check, timeoutMs = REPLY_TIMEOUT_MS, signal) {
    throwIfAborted(signal);
    if (check()) return check();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve, reject) => {
        let settled = false;
        const left = Math.max(1, deadline - Date.now());
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.waiters.delete(onWake);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(), Math.min(left, 250));
        const onWake = (error) => {
          finish(error);
        };
        const onAbort = () => finish(abortReason(signal));
        this.waiters.add(onWake);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      if (this.closed) throw new Error("RTC data channel closed");
      const found = check();
      if (found) return found;
    }
    throw new Error("RTC reply timeout");
  }

  send(msg) {
    if (!this.open || !this.directReady || this.closed)
      throw new Error("RTC data channel unavailable");
    this.dc.send(JSON.stringify(msg));
  }

  result(corr) {
    const row = this.rows.get(corr) || {};
    const msg = row.result;
    if (msg) return { corr, ...msg.body, t: msg.t };
    const accepted = row.accepted;
    return accepted
      ? { corr, status: "running", pane_id: accepted.body?.pane_id, t: accepted.t }
      : { corr, status: "running" };
  }

  pluginResult(corr) {
    const row = this.rows.get(corr) || {};
    const done = row.plugin_result;
    if (done) return { corr, ...done.body, t: done.t };
    const accepted = row.plugin_accepted;
    return { corr, status: accepted?.body?.status || "pending" };
  }

  async close() {
    this.closed = true;
    this.open = false;
    this.directReady = false;
    try {
      this.dc.close();
    } catch {
      /* already closed */
    }
    try {
      await settleWithin(this.pc.close());
    } catch {
      /* already closed */
    }
    this.wake(new Error("RTC session closed"));
  }
}

export function createRtcManager({
  hubPost,
  token,
  operatorId,
  verifyTokenV1,
  verifyFleetStatement,
  officialPlugin,
}) {
  const sessions = new Map();
  const connecting = new Map();
  const retryAt = new Map();
  let claimsPromise;

  async function claims() {
    claimsPromise ||= verifyTokenV1(token);
    return claimsPromise;
  }

  async function doEstablish(deviceId, signal) {
    throwIfAborted(signal);
    const existing = sessions.get(deviceId);
    if (existing?.open && existing.directReady && !existing.closed) return existing;
    if ((retryAt.get(deviceId) || 0) > Date.now()) return null;
    let config;
    let session;
    try {
      config = await hubPost("/v1/rtc/config", { device_id: deviceId }, { signal });
    } catch (error) {
      if (!signal?.aborted) retryAt.set(deviceId, Date.now() + 60_000);
      throw error;
    }
    if (!config?.available) {
      retryAt.set(deviceId, Date.now() + 60_000);
      return null;
    }
    retryAt.delete(deviceId);
    const iceServers = (Array.isArray(config.stun_urls) ? config.stun_urls : []).map((urls) => ({
      urls,
    }));
    const RTCPeerConnection = await abortable(loadPeerConnection(), signal);
    const pc = new RTCPeerConnection({ iceServers });
    const dc = pc.createDataChannel("fleet-v1", { ordered: true });
    const sid = crypto.randomUUID();
    try {
      const offer = await abortable(pc.createOffer(), signal);
      await abortable(pc.setLocalDescription(offer), signal);
      const offerSdp = pc.localDescription?.sdp || offer.sdp;
      if (!fingerprint(offerSdp)) throw new Error("RTC offer fingerprint missing");
      session = new DirectSession({ sid, deviceId, operatorId, pc, dc });
      const previous = sessions.get(deviceId);
      sessions.set(deviceId, session);
      if (previous) void previous.close();
      await hubPost("/v1/rtc/offer", { device_id: deviceId, sid, offer: offerSdp }, { signal });
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      let ready;
      while (Date.now() < deadline) {
        ready = await hubPost("/v1/rtc/session", { device_id: deviceId, sid }, { signal });
        if (ready?.status === "ready") break;
        await delay(100, signal);
      }
      if (ready?.status !== "ready") throw new Error("RTC signaling timeout");
      const tokenClaims = await abortable(claims(), signal);
      const ticket = await abortable(verifyFleetStatement({
        publicSpkiB64: tokenClaims.pub,
        ...ready.statement,
      }), signal);
      const now = Date.now();
      if (
        !ticket ||
        ticket.v !== 1 ||
        ticket.kind !== "rtc_session" ||
        ticket.sid !== sid ||
        ticket.kid !== tokenClaims.kid ||
        ticket.device_id !== deviceId ||
        ticket.operator_id !== operatorId ||
        ticket.offer_fp !== fingerprint(offerSdp) ||
        ticket.answer_fp !== fingerprint(ready.answer) ||
        !Number.isFinite(Number(ticket.iat)) ||
        !Number.isFinite(Number(ticket.exp)) ||
        Number(ticket.iat) <= 0 ||
        Number(ticket.iat) > now + 30_000 ||
        Number(ticket.exp) <= Number(ticket.iat) ||
        Number(ticket.exp) <= now ||
        Number(ticket.exp) - Number(ticket.iat) > 60_000
      ) {
        throw new Error("RTC session ticket rejected");
      }
      await abortable(pc.setRemoteDescription({ type: "answer", sdp: ready.answer }), signal);
      await session.waitReady(CONNECT_TIMEOUT_MS, signal);
      retryAt.delete(deviceId);
      return session;
    } catch (error) {
      if (!signal?.aborted) {
        try {
          await hubPost("/v1/rtc/cancel", { device_id: deviceId, sid });
        } catch {
          /* best effort */
        }
      }
      try {
        dc.close();
      } catch {
        /* already closed */
      }
      try {
        await settleWithin(pc.close());
      } catch {
        /* already closed */
      }
      if (sessions.get(deviceId) === session) sessions.delete(deviceId);
      if (!signal?.aborted) retryAt.set(deviceId, Date.now() + 60_000);
      throw error;
    }
  }

  async function establish(rawDeviceId, { signal } = {}) {
    throwIfAborted(signal);
    const deviceId = String(rawDeviceId || "").trim();
    const current = sessions.get(deviceId);
    if (current?.open && current.directReady && !current.closed) return current;
    if ((retryAt.get(deviceId) || 0) > Date.now()) return null;
    const active = connecting.get(deviceId);
    if (active) return abortable(active, signal);
    const pending = doEstablish(deviceId, signal).finally(() => {
      if (connecting.get(deviceId) === pending) connecting.delete(deviceId);
    });
    connecting.set(deviceId, pending);
    return abortable(pending, signal);
  }

  function existing(deviceId) {
    return sessions.get(String(deviceId || "")) || null;
  }

  function sendDirect(deviceId, session, message) {
    try {
      session.send(message);
      return true;
    } catch {
      if (sessions.get(deviceId) === session) sessions.delete(deviceId);
      void session.close();
      return false;
    }
  }

  async function tryRpc(path, body = {}, { signal } = {}) {
    throwIfAborted(signal);
    const deviceId = String(body.device_id || "").trim();
    if (!deviceId || ["/v1/list_computers", "/v1/get_computer", "/v1/heartbeat"].includes(path)) {
      return { handled: false };
    }
    let session = existing(deviceId);
    if (path === "/v1/get_result" && session) {
      const corr = String(body.corr || session.lastCorr || "");
      if (!corr) return { handled: false };
      if (session.rows.get(corr)?.result || (!session.closed && session.open)) {
        return { handled: true, value: session.result(corr), transport: "rtc" };
      }
      return { handled: false };
    }
    if (path === "/v1/plugin_result" && session) {
      const corr = String(body.corr || "");
      if (!corr) return { handled: false };
      if (session.rows.get(corr)?.plugin_result || (!session.closed && session.open)) {
        return { handled: true, value: session.pluginResult(corr), transport: "rtc" };
      }
      return { handled: false };
    }
    if (["/v1/get_result", "/v1/plugin_result"].includes(path)) return { handled: false };
    if (
      ["/v1/type", "/v1/read_screen"].includes(path) &&
      !String(body.corr || session?.lastCorr || "")
    ) {
      return { handled: false };
    }
    if (!session?.open || !session.directReady || session.closed) {
      try {
        session = await establish(deviceId, { signal });
      } catch {
        throwIfAborted(signal);
        return { handled: false };
      }
    }
    if (!session) return { handled: false };

    if (path === "/v1/run") {
      const corr = crypto.randomUUID();
      session.lastCorr = corr;
      if (
        !sendDirect(
          deviceId,
          session,
          envelope(
            "run",
            { command: body.command, mode: "pane", fingerprint: operatorId },
            corr,
          ),
        )
      ) {
        return { handled: false };
      }
      return { handled: true, value: { corr, status: "running" }, transport: "rtc" };
    }
    if (path === "/v1/type") {
      const corr = String(body.corr || session.lastCorr || "");
      if (
        !sendDirect(
          deviceId,
          session,
          envelope("type", { keys: body.keys, key: body.key, corr, fingerprint: operatorId }),
        )
      ) {
        return { handled: false };
      }
      return { handled: true, value: { ok: true, status: "typed" }, transport: "rtc" };
    }
    if (path === "/v1/read_screen") {
      const corr = String(body.corr || session.lastCorr || "");
      if (
        !sendDirect(
          deviceId,
          session,
          envelope("read_screen", { corr, fingerprint: operatorId }, corr),
        )
      ) {
        return { handled: false };
      }
      try {
        const msg = await session.waitFor(() => session.rows.get(corr)?.screen, REPLY_TIMEOUT_MS, signal);
        return { handled: true, value: { status: "ok", screen: msg.body }, transport: "rtc" };
      } catch {
        throwIfAborted(signal);
        return { handled: false };
      }
    }
    if (path === "/v1/desktop_screenshot" || path === "/v1/desktop_action") {
      const corr = crypto.randomUUID();
      const type = path.endsWith("desktop_screenshot") ? "desktop_screenshot" : "desktop_action";
      const payload = { ...body };
      delete payload.device_id;
      if (!sendDirect(deviceId, session, envelope(type, payload, corr))) {
        return { handled: false };
      }
      try {
        const msg = await session.waitFor(() => session.rows.get(corr)?.desktop, REPLY_TIMEOUT_MS, signal);
        return { handled: true, value: msg.body, transport: "rtc" };
      } catch (error) {
        throwIfAborted(signal);
        const deadline = Date.now() + REPLY_TIMEOUT_MS;
        while (Date.now() < deadline) {
          try {
            const fallback = await hubPost("/v1/rtc/result", {
              device_id: deviceId,
              corr,
              type: "desktop",
            }, { signal });
            if (fallback?.status === "done") {
              return { handled: true, value: fallback.body, transport: "ws" };
            }
          } catch {
            throwIfAborted(signal);
            /* keep the original RTC failure if relay recovery also fails */
          }
          await delay(100, signal);
        }
        throw error;
      }
    }
    if (path === "/v1/plugin") {
      const corr = crypto.randomUUID();
      const payload = { ...body };
      delete payload.device_id;
      const manifest = payload.operation === "list" ? null : officialPlugin(payload.plugin_id);
      if (payload.operation !== "list" && !manifest) throw new Error("official plugin not found");
      if (payload.operation === "install") {
        payload.manifest = manifest;
      }
      if (!sendDirect(deviceId, session, envelope("plugin", payload, corr))) {
        return { handled: false };
      }
      return { handled: true, value: { corr, status: "pending" }, transport: "rtc" };
    }
    return { handled: false };
  }

  async function shutdown() {
    const current = [...sessions.values()];
    sessions.clear();
    retryAt.clear();
    await Promise.allSettled(current.map((session) => session.close()));
  }

  return { tryRpc, establish, shutdown, sessions, connecting };
}

export const _test = { DirectSession, fingerprint, envelope };
