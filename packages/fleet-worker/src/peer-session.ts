export const PEER_SESSION_PROTOCOL = "plugin_peer_session_v1";
export const PEER_SESSION_CONTROL_MAX_BYTES = (128 << 10) + 8192;
export const PEER_SESSION_TTL_MS = 30 * 60_000;
export const PEER_SESSION_TICKET_TTL_MS = 60_000;
export const PEER_SESSION_MAX_ROUNDS = 4;

const OPAQUE_INPUT_MAX_BYTES = 8 << 10;
const CORE_NONCE_BYTES = 32;
const SIGNAL_MAX_BYTES = 128 << 10;
const CANDIDATE_MAX_BYTES = 4 << 10;
const MAILBOX_MAX = 96;
const OUTBOX_MAX = 192;
const DRAIN_MAX = 32;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const GC_GRACE_MS = 5 * 60_000;
const ID_RE = /^[a-zA-Z0-9._:@/-]{1,160}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PeerSide = "source" | "target";
export type PeerSignalRole = "initiator" | "responder";
export type PeerEndpointKind = "tool" | "device";
export type PeerApproval = "both_once";
export type PeerPhase =
  | "waiting_approval"
  | "signaling"
  | "connecting"
  | "active"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed"
  | "expired";

export type PeerEndpoint = {
  kind: PeerEndpointKind;
  id: string;
  name?: string;
  pluginId: string;
  pluginVersion: string;
  action: string;
  role: string;
  sessionBindingHash?: string;
  roundBindingHash?: string;
};

export type PeerCaller = { userId: string; kid: string; kind: PeerEndpointKind; id: string };
export type PeerSignal =
  | { kind: "offer" | "answer"; seq: number; sdp: string }
  | { kind: "candidate"; seq: number; candidate: string; sdpMid: string; sdpMLineIndex: number };

export type SignedPeerTicket = { payload: string; sig: string };

export type PeerSessionRecord = {
  v: 1;
  sessionId: string;
  userId: string;
  kid: string;
  operatorId: string;
  coordinator: { kind: PeerEndpointKind; id: string };
  protocol: {
    id: string;
    abi: "fleet.plugin.peer.v1";
    transport: "direct_ordered";
    approval: PeerApproval;
  };
  capabilityDigest: string;
  endpoints: Record<PeerSide, PeerEndpoint>;
  signalSides: Record<PeerSignalRole, PeerSide>;
  approvals: Partial<Record<PeerSide, { at: number; roundId: string }>>;
  endpointEvents: {
    active: Partial<Record<PeerSide, { at: number; roundId: string }>>;
    completed: Partial<Record<PeerSide, { at: number; roundId: string }>>;
  };
  phase: PeerPhase;
  round: {
    no: number;
    id: string;
    state: "awaiting_offer" | "offered" | "answered";
    offerFp?: string;
    answerFp?: string;
    lastSeq: Partial<Record<PeerSignalRole, number>>;
    receipts: Array<{ deliveryId: string; hash: string }>;
  };
  ticket?: SignedPeerTicket;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  gcAt?: number;
  failureCode?: string;
};

export type PeerTicketStatement = {
  v: 1;
  kind: "plugin_peer";
  session_id: string;
  round_id: string;
  kid: string;
  user_id: string;
  operator_id: string;
  protocol: string;
  abi: "fleet.plugin.peer.v1";
  transport: "direct_ordered";
  approval: PeerApproval;
  source_kind: PeerEndpointKind;
  source_id: string;
  source_plugin_id: string;
  source_plugin_version: string;
  source_action: string;
  source_role: string;
  target_kind: PeerEndpointKind;
  target_id: string;
  target_plugin_id: string;
  target_plugin_version: string;
  target_action: string;
  target_role: string;
  initiator_kind: PeerEndpointKind;
  initiator_id: string;
  responder_kind: PeerEndpointKind;
  responder_id: string;
  capability_digest: string;
  source_session_binding_hash: string;
  source_round_binding_hash: string;
  target_session_binding_hash: string;
  target_round_binding_hash: string;
  offer_fp: string;
  answer_fp: string;
  direct_only: true;
  iat: number;
  exp: number;
};

type EndpointCreate = Omit<PeerEndpoint, "sessionBindingHash" | "roundBindingHash"> & {
  input: unknown;
};
type Envelope = { type: string; body: Record<string, unknown> };
type MailboxItem = { delivery_id: string; type: string; body: Record<string, unknown> };
type Delivery = {
  kind: "deliver";
  deliveryId: string;
  side: PeerSide;
  endpoint: { kind: PeerEndpointKind; id: string };
  envelope: Envelope;
  attempts: number;
  nextAttemptAt: number;
};
type TicketJob = {
  kind: "issue_ticket";
  deliveryId: string;
  roundId: string;
  attempts: number;
  nextAttemptAt: number;
};
type OutboxEntry = Delivery | TicketJob;
type PeerEnv = {
  FLEET: DurableObjectNamespace;
  DEVICE: DurableObjectNamespace;
  RTC_STUN_URLS?: string;
};

export class PeerSessionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readPeerSessionControlText(
  request: Request,
  max = PEER_SESSION_CONTROL_MAX_BYTES,
) {
  const declared = request.headers.get("content-length");
  if (declared && /^(?:0|[1-9][0-9]*)$/.test(declared) && Number(declared) > max) {
    await request.body?.cancel().catch(() => undefined);
    fail(413, "REQUEST_TOO_LARGE", "peer control request too large");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        fail(413, "REQUEST_TOO_LARGE", "peer control request too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PeerSessionError) throw error;
    fail(400, "INVALID_REQUEST", "could not read peer control request");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(400, "INVALID_REQUEST", "peer control request is not UTF-8");
  }
}

export function buildPeerSessionTicketStatement(
  record: PeerSessionRecord,
  now = Date.now(),
): PeerTicketStatement {
  const source = record.endpoints.source;
  const target = record.endpoints.target;
  const initiator = record.endpoints[record.signalSides.initiator];
  const responder = record.endpoints[record.signalSides.responder];
  if (
    record.round.state !== "answered" ||
    !record.round.offerFp ||
    !record.round.answerFp ||
    !source.sessionBindingHash ||
    !source.roundBindingHash ||
    !target.sessionBindingHash ||
    !target.roundBindingHash
  )
    fail(409, "BAD_STATE", "ticket binding is incomplete");
  if (record.expiresAt <= now) fail(410, "EXPIRED", "peer session expired");
  return {
    v: 1,
    kind: "plugin_peer",
    session_id: record.sessionId,
    round_id: record.round.id,
    kid: record.kid,
    user_id: record.userId,
    operator_id: record.operatorId,
    protocol: record.protocol.id,
    abi: record.protocol.abi,
    transport: record.protocol.transport,
    approval: record.protocol.approval,
    source_kind: source.kind,
    source_id: source.id,
    source_plugin_id: source.pluginId,
    source_plugin_version: source.pluginVersion,
    source_action: source.action,
    source_role: source.role,
    target_kind: target.kind,
    target_id: target.id,
    target_plugin_id: target.pluginId,
    target_plugin_version: target.pluginVersion,
    target_action: target.action,
    target_role: target.role,
    initiator_kind: initiator.kind,
    initiator_id: initiator.id,
    responder_kind: responder.kind,
    responder_id: responder.id,
    capability_digest: record.capabilityDigest,
    source_session_binding_hash: source.sessionBindingHash,
    source_round_binding_hash: source.roundBindingHash,
    target_session_binding_hash: target.sessionBindingHash,
    target_round_binding_hash: target.roundBindingHash,
    offer_fp: record.round.offerFp,
    answer_fp: record.round.answerFp,
    direct_only: true,
    iat: now,
    exp: Math.min(record.expiresAt, now + PEER_SESSION_TICKET_TTL_MS),
  };
}

export function publicPeerSession(record: PeerSessionRecord) {
  const clean = (endpoint: PeerEndpoint) => ({
    kind: endpoint.kind,
    id: endpoint.id,
    name: endpoint.name,
    plugin_id: endpoint.pluginId,
    plugin_version: endpoint.pluginVersion,
    action: endpoint.action,
    role: endpoint.role,
  });
  return {
    v: record.v,
    session_id: record.sessionId,
    protocol: record.protocol,
    capability_digest: record.capabilityDigest,
    endpoints: { source: clean(record.endpoints.source), target: clean(record.endpoints.target) },
    signal_sides: record.signalSides,
    approvals: {
      source: Boolean(record.approvals.source),
      target: Boolean(record.approvals.target),
    },
    endpoint_events: {
      source: {
        active: record.endpointEvents.active.source?.roundId === record.round.id,
        completed: record.endpointEvents.completed.source?.roundId === record.round.id,
      },
      target: {
        active: record.endpointEvents.active.target?.roundId === record.round.id,
        completed: record.endpointEvents.completed.target?.roundId === record.round.id,
      },
    },
    phase: record.phase,
    round: { no: record.round.no, id: record.round.id, state: record.round.state },
    direct_only: true,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    expires_at: record.expiresAt,
    failure_code: record.failureCode,
  };
}

export class PeerSessionDO implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: PeerEnv;

  constructor(ctx: DurableObjectState, env: PeerEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const caller = callerFrom(request);
      const body = object(await request.json(), "request");
      if (url.pathname === "/create" && request.method === "POST") {
        const parsed = parseCreate(body);
        const now = Date.now();
        const roundId = crypto.randomUUID();
        const candidate = createRecord(parsed, roundId, await capabilityDigest(parsed), now);
        assertOwner(candidate, caller);
        if (!same(candidate.coordinator, caller))
          fail(403, "COORDINATOR_MISMATCH", "invalid coordinator");
        const result = await this.ctx.storage.transaction(async (txn) => {
          const existing = await txn.get<PeerSessionRecord>("session");
          if (existing) {
            assertOwner(existing, caller);
            if (!same(existing.coordinator, caller) || !same(existing.coordinator, parsed.coordinator)) {
              fail(409, "COORDINATOR_MISMATCH", "peer session coordinator changed");
            }
            if (!sameCreateIntent(existing, candidate)) {
              fail(409, "CREATE_CONFLICT", "peer session create request changed");
            }
            return { record: existing, created: false };
          }
          const outbox: OutboxEntry[] = [
            prepareDelivery(candidate, "source", parsed.source.input, now, this.env.RTC_STUN_URLS),
            prepareDelivery(candidate, "target", parsed.target.input, now, this.env.RTC_STUN_URLS),
          ];
          await txn.put("session", candidate);
          await txn.put("outbox", outbox);
          await schedule(txn, candidate, outbox, now);
          return { record: candidate, created: true };
        });
        if (result.created) await this.drain();
        return json({ session: publicPeerSession(result.record) }, result.created ? 201 : 200);
      }
      if (url.pathname === "/status" && request.method === "POST") {
        strictKeys(body, []);
        return json({ session: publicPeerSession(await this.require(caller)) });
      }
      if (url.pathname === "/inbox/poll" && request.method === "POST") {
        strictKeys(body, ["ack_delivery_ids"]);
        const acknowledgements = deliveryIds(body.ack_delivery_ids);
        const record = await this.require(caller);
        const side = participant(record, caller);
        if (!side) fail(403, "NOT_PARTICIPANT", "not a peer endpoint");
        const items = await this.ctx.storage.transaction(async (txn) => {
          const key = `mail:${side}`;
          const current = (await txn.get<MailboxItem[]>(key)) ?? [];
          const remaining = current.filter((item) => !acknowledgements.has(item.delivery_id));
          await txn.put(key, remaining);
          return remaining;
        });
        return json({ session_id: record.sessionId, items });
      }
      if (url.pathname === "/delivery/ack" && request.method === "POST") {
        strictKeys(body, ["delivery_id"]);
        const deliveryId = oneDeliveryId(body.delivery_id);
        const record = await this.ctx.storage.transaction(async (txn) => {
          const current = await txn.get<PeerSessionRecord>("session");
          if (!current) fail(404, "NOT_FOUND", "peer session not found");
          assertOwner(current, caller);
          if (!participant(current, caller)) fail(403, "NOT_PARTICIPANT", "not a peer endpoint");
          if (!deliveryId.startsWith(`ps:${current.sessionId}:`)) {
            fail(400, "DELIVERY_MISMATCH", "delivery belongs to another session");
          }
          const outbox = (await txn.get<OutboxEntry[]>("outbox")) ?? [];
          const item = outbox.find((value) => value.deliveryId === deliveryId);
          if (item) {
            if (
              item.kind !== "deliver" ||
              item.endpoint.kind !== "device" ||
              !same(item.endpoint, caller)
            ) {
              fail(403, "DELIVERY_MISMATCH", "delivery does not belong to caller");
            }
            await txn.put(
              "outbox",
              outbox.filter((value) => value.deliveryId !== deliveryId),
            );
            await schedule(
              txn,
              current,
              outbox.filter((value) => value.deliveryId !== deliveryId),
              Date.now(),
            );
          }
          return current;
        });
        return json({ ok: true, session_id: record.sessionId, delivery_id: deliveryId });
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        strictKeys(body, ["side", "round_id", "session_binding", "round_binding"]);
        const side = peerSide(body.side);
        const roundId = uuid(body.round_id, "round_id");
        const sessionHash = await bindingHash(body.session_binding, "session_binding");
        const roundHash = await bindingHash(body.round_binding, "round_binding");
        const next = await this.mutate(caller, (record, outbox, now) => {
          assertRound(record, roundId);
          assertSide(record, caller, side);
          if (terminal(record.phase)) fail(409, "BAD_STATE", "peer session is closed");
          const endpoint = record.endpoints[side];
          if (endpoint.sessionBindingHash && endpoint.sessionBindingHash !== sessionHash) {
            fail(409, "BINDING_CONFLICT", "session binding changed");
          }
          const prior = record.approvals[side];
          if (prior?.roundId === roundId) {
            if (endpoint.roundBindingHash !== roundHash)
              fail(409, "BINDING_CONFLICT", "round binding changed");
            return record;
          }
          if (record.phase !== "waiting_approval" && record.phase !== "interrupted") {
            fail(409, "BAD_STATE", "peer session is not waiting for approval");
          }
          endpoint.sessionBindingHash = sessionHash;
          endpoint.roundBindingHash = roundHash;
          record.approvals = { ...record.approvals, [side]: { at: now, roundId } };
          record.updatedAt = now;
          if (record.approvals.source && record.approvals.target) record.phase = "signaling";
          enqueueUpdates(record, outbox, `authorize:${side}`, now);
          return record;
        });
        await this.drain();
        return json({ session: publicPeerSession(next) });
      }
      if (url.pathname === "/signal" && request.method === "POST") {
        strictKeys(body, ["signal_role", "round_id", "signal"]);
        const role = signalRole(body.signal_role);
        const roundId = uuid(body.round_id, "round_id");
        const signal = parseSignal(body.signal);
        const payloadHash = await sha256(JSON.stringify(signal));
        const next = await this.mutate(caller, (record, outbox, now) => {
          assertRound(record, roundId);
          assertSide(record, caller, record.signalSides[role]);
          const deliveryId = stableDeliveryId(
            record,
            `signal:${role}:${signal.kind}:${signal.seq}`,
          );
          if (record.phase !== "signaling" && record.phase !== "connecting") {
            fail(409, "BAD_STATE", "session is not signaling");
          }
          const receipt = record.round.receipts.find((value) => value.deliveryId === deliveryId);
          if (receipt) {
            if (receipt.hash !== payloadHash) fail(409, "SIGNAL_CONFLICT", "signal changed");
            return record;
          }
          if (record.phase === "connecting" && signal.kind !== "candidate") {
            fail(409, "BAD_STATE", "only trickle candidates remain open");
          }
          if (signal.seq <= (record.round.lastSeq[role] ?? -1))
            fail(409, "STALE_SIGNAL", "stale signal");
          if (signal.kind === "offer") {
            if (role !== "initiator") fail(403, "ROLE_MISMATCH", "only initiator offers");
            if (record.round.state !== "awaiting_offer") fail(409, "OFFER_EXISTS", "offer exists");
            record.round.offerFp = canonicalPeerFingerprint(signal.sdp);
            record.round.state = "offered";
          } else if (signal.kind === "answer") {
            if (role !== "responder") fail(403, "ROLE_MISMATCH", "only responder answers");
            if (record.round.state !== "offered") fail(409, "BAD_STATE", "answer requires offer");
            record.round.answerFp = canonicalPeerFingerprint(signal.sdp);
            record.round.state = "answered";
            record.phase = "connecting";
          } else if (record.round.state === "awaiting_offer")
            fail(409, "BAD_STATE", "candidate requires offer");
          record.round.lastSeq = { ...record.round.lastSeq, [role]: signal.seq };
          record.round.receipts = [
            ...record.round.receipts.slice(-63),
            { deliveryId, hash: payloadHash },
          ];
          record.updatedAt = now;
          add(outbox, signalDelivery(record, oppositeSignal(role), role, signal, now));
          if (signal.kind === "answer") add(outbox, ticketJob(record, now));
          return record;
        });
        await this.drain();
        return json({ session: publicPeerSession((await this.current()) ?? next) });
      }
      if (url.pathname === "/event" && request.method === "POST") {
        strictKeys(body, ["round_id", "event", "failure_code"]);
        const roundId = uuid(body.round_id, "round_id");
        const event = String(body.event ?? "");
        const next = await this.mutate(caller, (record, outbox, now) => {
          const side = participant(record, caller);
          const coordinator = same(record.coordinator, caller);
          // An endpoint failure terminates the session even if an interrupt already rotated rounds.
          if (event !== "fail") assertRound(record, roundId);
          if (!side && !coordinator) fail(403, "NOT_PARTICIPANT", "not in peer session");
          if (event === "cancel") {
            if (terminal(record.phase)) return record;
            record.phase = "cancelled";
          } else if (!side) fail(403, "NOT_PARTICIPANT", "coordinator may only cancel");
          else if (event === "active") {
            if (record.endpointEvents.active[side]?.roundId === roundId) return record;
            if ((record.phase !== "connecting" && record.phase !== "active") || !record.ticket)
              fail(409, "BAD_STATE", "session is not connecting");
            record.endpointEvents.active = {
              ...record.endpointEvents.active,
              [side]: { at: now, roundId },
            };
            if (record.endpointEvents.active.source && record.endpointEvents.active.target) {
              record.phase = "active";
            }
          } else if (event === "complete") {
            if (record.endpointEvents.completed[side]?.roundId === roundId) return record;
            if (record.phase !== "connecting" && record.phase !== "active") {
              fail(409, "BAD_STATE", "session is not live");
            }
            if (!record.endpointEvents.active[side]) {
              record.endpointEvents.active = {
                ...record.endpointEvents.active,
                [side]: { at: now, roundId },
              };
            }
            record.endpointEvents.completed = {
              ...record.endpointEvents.completed,
              [side]: { at: now, roundId },
            };
            if (record.endpointEvents.completed.source && record.endpointEvents.completed.target) {
              record.phase = "completed";
            } else if (record.endpointEvents.active.source && record.endpointEvents.active.target) {
              record.phase = "active";
            }
          } else if (event === "interrupt") {
            if (record.phase !== "active" && record.phase !== "connecting")
              fail(409, "BAD_STATE", "session is not live");
            outbox.splice(0, outbox.length);
            if (record.round.no >= PEER_SESSION_MAX_ROUNDS) {
              record.phase = "failed";
              record.failureCode = "ROUND_LIMIT";
            } else {
              beginRound(record, crypto.randomUUID(), now);
              record.phase = "interrupted";
              add(outbox, roundDelivery(record, "source", now));
              add(outbox, roundDelivery(record, "target", now));
              record.phase = "waiting_approval";
            }
          } else if (event === "fail") {
            if (terminal(record.phase)) return record;
            const code = String(body.failure_code ?? "PEER_FAILED");
            if (!/^[A-Z0-9_]{1,64}$/.test(code))
              fail(400, "INVALID_FAILURE", "invalid failure code");
            record.phase = "failed";
            record.failureCode = code;
          } else fail(400, "INVALID_EVENT", "invalid peer event");
          record.updatedAt = now;
          if (terminal(record.phase)) outbox.splice(0, outbox.length);
          enqueueUpdates(
            record,
            outbox,
            `event:${event}:${side ?? "coordinator"}:r${record.round.no}`,
            now,
          );
          return record;
        });
        await this.drain();
        return json({ session: publicPeerSession(next) });
      }
      fail(404, "NOT_FOUND", "route not found");
    } catch (error) {
      if (error instanceof PeerSessionError)
        return json({ error: error.message, code: error.code }, error.status);
      console.error("peer session internal error", error);
      return json({ error: "peer session internal error", code: "INTERNAL_ERROR" }, 500);
    }
  }

  async alarm() {
    const now = Date.now();
    const action = await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<PeerSessionRecord>("session");
      if (!record) return "delete";
      let outbox = (await txn.get<OutboxEntry[]>("outbox")) ?? [];
      if (record.phase === "expired" && (record.gcAt ?? record.expiresAt) <= now) return "delete";
      if (record.phase !== "expired" && record.expiresAt <= now) {
        record.phase = "expired";
        record.ticket = undefined;
        record.updatedAt = now;
        record.gcAt = now + GC_GRACE_MS;
        outbox = [];
        enqueueUpdates(record, outbox, "expired", now, true);
        await txn.put("session", record);
        await txn.put("outbox", outbox);
      }
      await schedule(txn, record, outbox, now);
      return "drain";
    });
    if (action === "delete") await this.ctx.storage.deleteAll();
    else await this.drain();
  }

  private current() {
    return this.ctx.storage.get<PeerSessionRecord>("session");
  }

  private async require(caller: PeerCaller) {
    const record = await this.current();
    if (!record) fail(404, "NOT_FOUND", "peer session not found");
    assertOwner(record, caller);
    if (!participant(record, caller) && !same(record.coordinator, caller))
      fail(403, "NOT_PARTICIPANT", "not in session");
    return record;
  }

  private async mutate(
    caller: PeerCaller,
    apply: (r: PeerSessionRecord, o: OutboxEntry[], n: number) => PeerSessionRecord,
  ) {
    return this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<PeerSessionRecord>("session");
      if (!current) fail(404, "NOT_FOUND", "peer session not found");
      assertOwner(current, caller);
      if (current.expiresAt <= Date.now()) fail(410, "EXPIRED", "peer session expired");
      const outbox = (await txn.get<OutboxEntry[]>("outbox")) ?? [];
      const record = apply(structuredClone(current), outbox, Date.now());
      if (outbox.length > OUTBOX_MAX)
        fail(409, "OUTBOX_BACKPRESSURE", "peer control outbox is full");
      await txn.put("session", record);
      await txn.put("outbox", outbox);
      await schedule(txn, record, outbox, Date.now());
      return record;
    });
  }

  private async drain() {
    for (let count = 0; count < DRAIN_MAX; count += 1) {
      const outbox = (await this.ctx.storage.get<OutboxEntry[]>("outbox")) ?? [];
      const item = outbox.find((value) => value.nextAttemptAt <= Date.now());
      if (!item) break;
      try {
        if (item.kind === "issue_ticket") await this.issueTicket(item);
        else if (item.endpoint.kind === "tool") await this.mail(item);
        else {
          await this.push(item);
          await this.retry(item.deliveryId);
        }
      } catch {
        await this.retry(item.deliveryId);
        break;
      }
    }
    await this.reschedule();
  }

  private async mail(item: Delivery) {
    await this.ctx.storage.transaction(async (txn) => {
      const outbox = (await txn.get<OutboxEntry[]>("outbox")) ?? [];
      if (!outbox.some((value) => value.deliveryId === item.deliveryId)) return;
      const key = `mail:${item.side}`;
      const mailbox = (await txn.get<MailboxItem[]>(key)) ?? [];
      if (!mailbox.some((value) => value.delivery_id === item.deliveryId)) {
        if (mailbox.length >= MAILBOX_MAX)
          fail(409, "MAILBOX_BACKPRESSURE", "peer mailbox is full");
        await txn.put(key, [
          ...mailbox,
          { delivery_id: item.deliveryId, type: item.envelope.type, body: item.envelope.body },
        ]);
      }
      const remaining = outbox.filter((value) => value.deliveryId !== item.deliveryId);
      await txn.put("outbox", remaining);
      const record = await txn.get<PeerSessionRecord>("session");
      if (record) await schedule(txn, record, remaining, Date.now());
    });
  }

  private async push(item: Delivery) {
    const record = await this.current();
    if (!record || !same(record.endpoints[item.side], item.endpoint)) {
      await this.ack(item.deliveryId);
      return;
    }
    const response = await this.env.DEVICE.get(this.env.DEVICE.idFromName(item.endpoint.id)).fetch(
      new Request("https://device/plugin-peer-session-push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: record.userId,
          kid: record.kid,
          device_id: item.endpoint.id,
          delivery_id: item.deliveryId,
          type: item.envelope.type,
          body: item.envelope.body,
        }),
      }),
    );
    if (!response.ok) fail(409, "PEER_OFFLINE", "device peer is offline");
  }

  private async issueTicket(job: TicketJob) {
    const candidate = await this.current();
    if (!candidate || !ticketReady(candidate, job.roundId, Date.now())) {
      await this.ack(job.deliveryId);
      return;
    }
    const response = await this.env.FLEET.get(this.env.FLEET.idFromName("fleet")).fetch(
      new Request("https://fleet/peer-session-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ record: candidate }),
      }),
    );
    if (!response.ok) fail(409, "TICKET_REJECTED", "ticket signer rejected session");
    const body = (await response.json()) as { statement?: SignedPeerTicket };
    if (!body.statement?.payload || !body.statement.sig)
      fail(500, "TICKET_REJECTED", "ticket is missing");
    const statement = body.statement;
    await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<PeerSessionRecord>("session");
      let outbox = (await txn.get<OutboxEntry[]>("outbox")) ?? [];
      outbox = outbox.filter((value) => value.deliveryId !== job.deliveryId);
      const now = Date.now();
      if (record && ticketReady(record, job.roundId, now)) {
        record.ticket = statement;
        record.updatedAt = now;
        add(outbox, ticketDelivery(record, "source", statement, now));
        add(outbox, ticketDelivery(record, "target", statement, now));
        await txn.put("session", record);
      }
      await txn.put("outbox", outbox);
      if (record) await schedule(txn, record, outbox, now);
    });
  }

  private ack(id: string) {
    return this.ctx.storage.transaction(async (txn) => {
      const outbox = (await txn.get<OutboxEntry[]>("outbox")) ?? [];
      const remaining = outbox.filter((value) => value.deliveryId !== id);
      await txn.put("outbox", remaining);
      const record = await txn.get<PeerSessionRecord>("session");
      if (record) await schedule(txn, record, remaining, Date.now());
    });
  }

  private retry(id: string) {
    return this.ctx.storage.transaction(async (txn) => {
      const outbox = (await txn.get<OutboxEntry[]>("outbox")) ?? [];
      const now = Date.now();
      for (const item of outbox)
        if (item.deliveryId === id) {
          item.attempts += 1;
          item.nextAttemptAt = now + retryDelay(item.attempts, id);
        }
      await txn.put("outbox", outbox);
      const record = await txn.get<PeerSessionRecord>("session");
      if (record) await schedule(txn, record, outbox, now);
    });
  }

  private reschedule() {
    return this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<PeerSessionRecord>("session");
      if (!record) return;
      await schedule(txn, record, (await txn.get<OutboxEntry[]>("outbox")) ?? [], Date.now());
    });
  }
}

function parseCreate(body: Record<string, unknown>) {
  strictKeys(body, [
    "session_id",
    "user_id",
    "kid",
    "operator_id",
    "coordinator",
    "protocol",
    "initiator",
    "source",
    "target",
  ]);
  const protocol = object(body.protocol, "protocol");
  strictKeys(protocol, ["id", "abi", "transport", "approval"]);
  if (protocol.abi !== "fleet.plugin.peer.v1" || protocol.transport !== "direct_ordered")
    fail(400, "INVALID_PROTOCOL", "unsupported peer protocol");
  if (protocol.approval !== "both_once")
    fail(400, "INVALID_PROTOCOL", "unsupported approval policy");
  const source = createEndpoint(body.source, "source");
  const target = createEndpoint(body.target, "target");
  if (source.kind === target.kind && source.id === target.id) {
    fail(400, "ENDPOINT_COLLISION", "source and target must be different endpoints");
  }
  const coordinatorValue = object(body.coordinator, "coordinator");
  strictKeys(coordinatorValue, ["kind", "id", "name"]);
  return {
    sessionId: uuid(body.session_id, "session_id"),
    userId: id(body.user_id, "user_id"),
    kid: id(body.kid, "kid"),
    operatorId: id(body.operator_id, "operator_id"),
    coordinator: basicEndpoint(coordinatorValue, "coordinator"),
    protocol: {
      id: id(protocol.id, "protocol.id"),
      abi: protocol.abi,
      transport: protocol.transport,
      approval: protocol.approval,
    } as PeerSessionRecord["protocol"],
    initiator: peerSide(body.initiator),
    source,
    target,
  };
}

function createRecord(
  value: ReturnType<typeof parseCreate>,
  roundId: string,
  capabilityDigestValue: string,
  now: number,
): PeerSessionRecord {
  const strip = ({ input: _input, ...endpoint }: EndpointCreate) => endpoint;
  return {
    v: 1,
    sessionId: value.sessionId,
    userId: value.userId,
    kid: value.kid,
    operatorId: value.operatorId,
    coordinator: value.coordinator,
    protocol: value.protocol,
    capabilityDigest: capabilityDigestValue,
    endpoints: { source: strip(value.source), target: strip(value.target) },
    signalSides:
      value.initiator === "source"
        ? { initiator: "source", responder: "target" }
        : { initiator: "target", responder: "source" },
    approvals: {},
    endpointEvents: { active: {}, completed: {} },
    phase: "waiting_approval",
    round: { no: 1, id: roundId, state: "awaiting_offer", lastSeq: {}, receipts: [] },
    createdAt: now,
    updatedAt: now,
    expiresAt: now + PEER_SESSION_TTL_MS,
  };
}

function sameCreateIntent(existing: PeerSessionRecord, candidate: PeerSessionRecord) {
  const sameProtocol =
    existing.protocol.id === candidate.protocol.id &&
    existing.protocol.abi === candidate.protocol.abi &&
    existing.protocol.transport === candidate.protocol.transport &&
    existing.protocol.approval === candidate.protocol.approval;
  const sameEndpoint = (left: PeerEndpoint, right: PeerEndpoint) =>
    left.kind === right.kind &&
    left.id === right.id &&
    left.pluginId === right.pluginId &&
    left.pluginVersion === right.pluginVersion &&
    left.action === right.action &&
    left.role === right.role;
  return (
    existing.sessionId === candidate.sessionId &&
    existing.operatorId === candidate.operatorId &&
    same(existing.coordinator, candidate.coordinator) &&
    sameProtocol &&
    existing.capabilityDigest === candidate.capabilityDigest &&
    sameEndpoint(existing.endpoints.source, candidate.endpoints.source) &&
    sameEndpoint(existing.endpoints.target, candidate.endpoints.target) &&
    existing.signalSides.initiator === candidate.signalSides.initiator &&
    existing.signalSides.responder === candidate.signalSides.responder
  );
}

function createEndpoint(value: unknown, name: string): EndpointCreate {
  const row = object(value, name);
  strictKeys(row, ["kind", "id", "name", "plugin_id", "plugin_version", "action", "role", "input"]);
  const endpoint = basicEndpoint(row, name);
  const input = canonicalOpaque(row.input ?? null, name);
  return {
    ...endpoint,
    pluginId: id(row.plugin_id, `${name}.plugin_id`),
    pluginVersion: id(row.plugin_version, `${name}.plugin_version`),
    action: id(row.action, `${name}.action`),
    role: id(row.role, `${name}.role`),
    input,
  };
}

function basicEndpoint(value: unknown, name: string) {
  const row = object(value, name);
  const kind = String(row.kind ?? "");
  if (kind !== "tool" && kind !== "device") fail(400, "INVALID_ENDPOINT", `invalid ${name}`);
  const endpoint: { kind: PeerEndpointKind; id: string; name?: string } = {
    kind,
    id: id(row.id, `${name}.id`),
  };
  if (row.name !== undefined) {
    const label = String(row.name).trim();
    if (!label || label.length > 128 || hasAsciiControl(label))
      fail(400, "INVALID_ENDPOINT", `invalid ${name}.name`);
    endpoint.name = label;
  }
  return endpoint;
}

function prepareDelivery(
  record: PeerSessionRecord,
  side: PeerSide,
  input: unknown,
  now: number,
  stun?: string,
) {
  const endpoint = record.endpoints[side];
  const peer = record.endpoints[oppositeSide(side)];
  return delivery(
    record,
    side,
    `prepare:${side}`,
    "peer_session_prepare",
    {
      session_id: record.sessionId,
      round_id: record.round.id,
      side,
      user_id: record.userId,
      operator_id: record.operatorId,
      signal_role: record.signalSides.initiator === side ? "initiator" : "responder",
      protocol: record.protocol,
      plugin: {
        id: endpoint.pluginId,
        version: endpoint.pluginVersion,
        action: endpoint.action,
        role: endpoint.role,
      },
      input,
      peer: {
        kind: peer.kind,
        id: peer.id,
        plugin_id: peer.pluginId,
        plugin_version: peer.pluginVersion,
        action: peer.action,
        role: peer.role,
      },
      stun_urls: stunURLs(stun),
      direct_only: true,
    },
    now,
  );
}

function roundDelivery(record: PeerSessionRecord, side: PeerSide, now: number) {
  return delivery(
    record,
    side,
    `round-prepare:${side}`,
    "peer_session_round_prepare",
    {
      session_id: record.sessionId,
      round_id: record.round.id,
      round_no: record.round.no,
      side,
      signal_role: record.signalSides.initiator === side ? "initiator" : "responder",
      direct_only: true,
    },
    now,
  );
}

function signalDelivery(
  record: PeerSessionRecord,
  recipientRole: PeerSignalRole,
  from: PeerSignalRole,
  signal: PeerSignal,
  now: number,
) {
  const side = record.signalSides[recipientRole];
  return delivery(
    record,
    side,
    `signal:${from}:${signal.kind}:${signal.seq}`,
    "peer_session_signal",
    { session_id: record.sessionId, round_id: record.round.id, from, signal },
    now,
  );
}
function ticketJob(record: PeerSessionRecord, now: number): TicketJob {
  return {
    kind: "issue_ticket",
    deliveryId: stableDeliveryId(record, "issue-ticket"),
    roundId: record.round.id,
    attempts: 0,
    nextAttemptAt: now,
  };
}
function ticketDelivery(
  record: PeerSessionRecord,
  side: PeerSide,
  statement: SignedPeerTicket,
  now: number,
) {
  return delivery(
    record,
    side,
    `ticket:${side}`,
    "peer_session_ticket",
    { session_id: record.sessionId, round_id: record.round.id, statement },
    now,
  );
}
function enqueueUpdates(
  record: PeerSessionRecord,
  outbox: OutboxEntry[],
  suffix: string,
  now: number,
  devicesOnly = false,
) {
  for (const side of ["source", "target"] as const) {
    if (devicesOnly && record.endpoints[side].kind !== "device") continue;
    add(
      outbox,
      delivery(
        record,
        side,
        `update:${suffix}:${side}`,
        "peer_session_update",
        { session_id: record.sessionId, phase: record.phase, session: publicPeerSession(record) },
        now,
      ),
    );
  }
}
function delivery(
  record: PeerSessionRecord,
  side: PeerSide,
  suffix: string,
  type: string,
  body: Record<string, unknown>,
  now: number,
): Delivery {
  const endpoint = record.endpoints[side];
  return {
    kind: "deliver",
    deliveryId: stableDeliveryId(record, suffix),
    side,
    endpoint: { kind: endpoint.kind, id: endpoint.id },
    envelope: { type, body },
    attempts: 0,
    nextAttemptAt: now,
  };
}
function stableDeliveryId(record: PeerSessionRecord, suffix: string) {
  return `ps:${record.sessionId}:r${record.round.no}:${suffix}`;
}
function add(outbox: OutboxEntry[], item: OutboxEntry) {
  if (!outbox.some((value) => value.deliveryId === item.deliveryId)) outbox.push(item);
}

function beginRound(record: PeerSessionRecord, roundId: string, now: number) {
  record.round = {
    no: record.round.no + 1,
    id: roundId,
    state: "awaiting_offer",
    lastSeq: {},
    receipts: [],
  };
  record.ticket = undefined;
  record.approvals = {};
  record.endpointEvents = { active: {}, completed: {} };
  for (const side of ["source", "target"] as const)
    record.endpoints[side].roundBindingHash = undefined;
  record.updatedAt = now;
}
function ticketReady(record: PeerSessionRecord, roundId: string, now: number) {
  return (
    record.expiresAt > now &&
    record.phase === "connecting" &&
    record.round.id === roundId &&
    record.round.state === "answered" &&
    !record.ticket
  );
}
async function schedule(
  storage: DurableObjectStorage | DurableObjectTransaction,
  record: PeerSessionRecord,
  outbox: OutboxEntry[],
  now: number,
) {
  const due = outbox.length ? Math.min(...outbox.map((value) => value.nextAttemptAt)) : Infinity;
  const expiry = record.phase === "expired" ? (record.gcAt ?? record.expiresAt) : record.expiresAt;
  await storage.setAlarm(Math.max(now + 1, Math.min(due, expiry)));
}
function retryDelay(attempt: number, key: string) {
  const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(5, attempt - 1));
  let hash = 0;
  for (const char of key) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return Math.min(RETRY_MAX_MS, base + (hash % Math.max(1, Math.floor(base / 4))));
}

function parseSignal(input: unknown): PeerSignal {
  const row = object(input, "signal");
  const kind = String(row.kind ?? "");
  const seq = integer(row.seq, "seq", 0, 1e9);
  if (kind === "offer" || kind === "answer") {
    strictKeys(row, ["kind", "seq", "sdp"]);
    const sdp = String(row.sdp ?? "");
    if (!sdp.startsWith("v=0") || bytes(sdp) > SIGNAL_MAX_BYTES)
      fail(400, "INVALID_SIGNAL", "invalid SDP");
    rejectRelay(sdp);
    canonicalPeerFingerprint(sdp);
    return { kind, seq, sdp };
  }
  if (kind === "candidate") {
    strictKeys(row, ["kind", "seq", "candidate", "sdp_mid", "sdp_mline_index"]);
    const candidate = String(row.candidate ?? "");
    if (!candidate || bytes(candidate) > CANDIDATE_MAX_BYTES)
      fail(400, "INVALID_SIGNAL", "invalid candidate");
    rejectRelay(candidate);
    const sdpMid = String(row.sdp_mid ?? "");
    if (sdpMid.length > 128 || hasAsciiControl(sdpMid))
      fail(400, "INVALID_SIGNAL", "invalid sdp_mid");
    return {
      kind,
      seq,
      candidate,
      sdpMid,
      sdpMLineIndex: integer(row.sdp_mline_index, "sdp_mline_index", 0, 65535),
    };
  }
  fail(400, "INVALID_SIGNAL", "invalid signal kind");
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
export function canonicalPeerFingerprint(sdp: string) {
  const found = [...sdp.matchAll(/^a=fingerprint:sha-256\s+([^\r\n]+)$/gim)];
  if (found.length !== 1) fail(400, "INVALID_SIGNAL", "one fingerprint required");
  const value = String(found[0]?.[1] ?? "")
    .trim()
    .toUpperCase();
  if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))
    fail(400, "INVALID_SIGNAL", "invalid fingerprint");
  return value.replaceAll(":", "").toLowerCase();
}
function rejectRelay(value: string) {
  if (/(?:^|\s)typ\s+relay(?:\s|$)/im.test(value))
    fail(400, "RELAY_FORBIDDEN", "relay candidate forbidden");
}

async function bindingHash(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail(400, "INVALID_BINDING", `invalid ${name}`);
  }
  let decoded: Uint8Array;
  try {
    const padded =
      value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    decoded = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    fail(400, "INVALID_BINDING", `invalid ${name}`);
  }
  if (decoded.byteLength !== CORE_NONCE_BYTES || base64url(decoded) !== value) {
    fail(400, "INVALID_BINDING", `invalid ${name}`);
  }
  return sha256Bytes(decoded);
}
async function capabilityDigest(value: ReturnType<typeof parseCreate>) {
  return sha256(
    JSON.stringify({
      protocol: value.protocol,
      source: {
        plugin_id: value.source.pluginId,
        plugin_version: value.source.pluginVersion,
        action: value.source.action,
        role: value.source.role,
      },
      target: {
        plugin_id: value.target.pluginId,
        plugin_version: value.target.pluginVersion,
        action: value.target.action,
        role: value.target.role,
      },
    }),
  );
}
function canonicalOpaque(value: unknown, name: string): unknown {
  const normalize = (item: unknown, depth = 0): unknown => {
    if (depth > 32) fail(400, "INVALID_INPUT", `${name} input is too deeply nested`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((value) => normalize(value, depth + 1));
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item as Record<string, unknown>)
          .sort()
          .map((key) => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]),
      );
    }
    fail(400, "INVALID_INPUT", `invalid ${name} input`);
  };
  const normalized = normalize(value);
  if (bytes(JSON.stringify(normalized)) > OPAQUE_INPUT_MAX_BYTES) {
    fail(413, "INPUT_TOO_LARGE", `${name} input too large`);
  }
  return normalized;
}
function deliveryIds(value: unknown) {
  if (value === undefined) return new Set<string>();
  if (!Array.isArray(value) || value.length > MAILBOX_MAX)
    fail(400, "INVALID_ACK", "invalid delivery acknowledgements");
  const ids = value.map((item) => oneDeliveryId(item));
  return new Set(ids);
}
function oneDeliveryId(value: unknown) {
  const deliveryId = String(value ?? "");
  if (!/^ps:[a-zA-Z0-9:._@-]{1,384}$/.test(deliveryId)) {
    fail(400, "INVALID_ACK", "invalid delivery acknowledgement");
  }
  return deliveryId;
}
function base64url(value: Uint8Array) {
  let raw = "";
  for (const byte of value) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256(value: string) {
  return sha256Bytes(new TextEncoder().encode(value));
}
async function sha256Bytes(value: Uint8Array) {
  const copy = Uint8Array.from(value);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...hash].map((item) => item.toString(16).padStart(2, "0")).join("");
}
function callerFrom(request: Request): PeerCaller {
  const kind = request.headers.get("x-peer-caller-kind");
  if (kind !== "tool" && kind !== "device") fail(401, "INVALID_CALLER", "invalid caller");
  return {
    userId: id(request.headers.get("x-fleet-user"), "user"),
    kid: id(request.headers.get("x-fleet-kid"), "kid"),
    kind,
    id: id(request.headers.get("x-peer-caller-id"), "caller"),
  };
}
function assertOwner(record: PeerSessionRecord, caller: PeerCaller) {
  if (record.userId !== caller.userId || record.kid !== caller.kid)
    fail(404, "NOT_FOUND", "peer session not found");
}
function assertSide(record: PeerSessionRecord, caller: PeerCaller, side: PeerSide) {
  if (!same(record.endpoints[side], caller))
    fail(403, "ROLE_MISMATCH", "caller is not endpoint side");
}
function assertRound(record: PeerSessionRecord, roundId: string) {
  if (record.round.id !== roundId) fail(409, "STALE_ROUND", "stale peer round");
}
function participant(record: PeerSessionRecord, caller: PeerCaller): PeerSide | null {
  if (same(record.endpoints.source, caller)) return "source";
  if (same(record.endpoints.target, caller)) return "target";
  return null;
}
function same(
  left: { kind: PeerEndpointKind; id: string },
  right: { kind: PeerEndpointKind; id: string },
) {
  return left.kind === right.kind && left.id === right.id;
}
function peerSide(value: unknown): PeerSide {
  if (value !== "source" && value !== "target") fail(400, "INVALID_SIDE", "invalid endpoint side");
  return value;
}
function signalRole(value: unknown): PeerSignalRole {
  if (value !== "initiator" && value !== "responder")
    fail(400, "INVALID_ROLE", "invalid signal role");
  return value;
}
function oppositeSide(side: PeerSide): PeerSide {
  return side === "source" ? "target" : "source";
}
function oppositeSignal(role: PeerSignalRole): PeerSignalRole {
  return role === "initiator" ? "responder" : "initiator";
}
function terminal(phase: PeerPhase) {
  return ["completed", "cancelled", "failed", "expired"].includes(phase);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "INVALID_REQUEST", `${name} must be object`);
  return value as Record<string, unknown>;
}
function strictKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(400, "UNKNOWN_FIELD", `unknown field: ${key}`);
}
function id(value: unknown, name: string) {
  const text = String(value ?? "");
  if (!ID_RE.test(text)) fail(400, "INVALID_ID", `invalid ${name}`);
  return text;
}
function uuid(value: unknown, name: string) {
  const text = String(value ?? "");
  if (!UUID_RE.test(text)) fail(400, "INVALID_ID", `invalid ${name}`);
  return text;
}
function integer(value: unknown, name: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    fail(400, "INVALID_NUMBER", `invalid ${name}`);
  return Number(value);
}
function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
function stunURLs(raw?: string) {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^stuns?:[^\s]{1,512}$/i.test(value))
    .slice(0, 4);
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function fail(status: number, code: string, message: string): never {
  throw new PeerSessionError(status, code, message);
}
