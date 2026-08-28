import { signFleetStatement, verifyFleetStatement } from "./tokenv1.mjs";

export const TRANSFER_RECORD_TTL_MS = 24 * 60 * 60_000;
export const TRANSFER_TICKET_TTL_MS = 60_000;
export const TRANSFER_SIGNAL_MAX_BYTES = 128 << 10;
export const TRANSFER_CONTROL_MAX_BYTES = TRANSFER_SIGNAL_MAX_BYTES + 8192;

const MAX_CANDIDATE_BYTES = 4 << 10;
const MAX_MAILBOX_ITEMS = 96;
const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-zA-Z0-9._:@-]{1,128}$/;

export type TransferRole = "source" | "target";
export type TransferEndpointKind = "tool" | "device";
export type TransferPhase =
  | "pending"
  | "authorizing"
  | "signaling"
  | "ready"
  | "transferring"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed"
  | "expired";

export type TransferEndpoint = {
  kind: TransferEndpointKind;
  id: string;
  name?: string;
};

export type TransferFile = {
  name: string;
  size: number;
  sha256: string;
  chunkSize: number;
};

export type TransferResume = {
  offset: number;
  prefixSha256: string;
};

export type TransferRecord = {
  v: 1;
  transferId: string;
  userId: string;
  kid: string;
  coordinatorId: string;
  source: TransferEndpoint;
  target: TransferEndpoint;
  pathHints: Partial<Record<TransferRole, string>>;
  file?: TransferFile;
  resume?: TransferResume;
  approvals: Partial<Record<TransferRole, number>>;
  signalSession?: {
    sid: string;
    offerFp: string;
    answerFp?: string;
  };
  usedSids: string[];
  lastSignalSeq: Partial<Record<TransferRole, number>>;
  phase: TransferPhase;
  createdAt: number;
  expiresAt: number;
  startedAt?: number;
  finishedAt?: number;
  failureCode?: string;
  ticket?: SignedTransferTicket;
};

export type TransferCaller = {
  userId: string;
  kid: string;
  kind: TransferEndpointKind;
  id: string;
};

export type TransferSignal =
  | { kind: "offer"; seq: number; sdp: string }
  | { kind: "answer"; seq: number; sdp: string }
  | {
      kind: "candidate";
      seq: number;
      candidate: string;
      sdpMid: string;
      sdpMLineIndex: number;
    };

export type TransferMailboxItem =
  | { kind: "prepare"; role: TransferRole; pathHint: string; at: number }
  | { kind: "manifest"; file: TransferFile; at: number }
  | { kind: "signal"; from: TransferRole; sid: string; signal: TransferSignal; at: number }
  | { kind: "ticket"; statement: SignedTransferTicket; at: number };

export type SignedTransferTicket = { payload: string; sig: string };

export type TransferTicketStatement = {
  v: 1;
  kind: "file_transfer";
  transfer_id: string;
  sid: string;
  user_id: string;
  kid: string;
  operator_id: string;
  source_kind: TransferEndpointKind;
  source_id: string;
  target_kind: TransferEndpointKind;
  target_id: string;
  offerer_kind: TransferEndpointKind;
  offerer_id: string;
  answerer_kind: TransferEndpointKind;
  answerer_id: string;
  file_name: string;
  file_size: number;
  file_sha256: string;
  chunk_size: number;
  resume_offset: number;
  prefix_sha256: string;
  offer_fp: string;
  answer_fp: string;
  direct_only: true;
  iat: number;
  exp: number;
};

export class TransferError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readTransferControlText(
  request: Request,
  maxBytes = TRANSFER_CONTROL_MAX_BYTES,
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && /^(?:0|[1-9][0-9]*)$/.test(declared) && Number(declared) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new TransferError(413, "REQUEST_TOO_LARGE", "file transfer control request too large");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TransferError(
          413,
          "REQUEST_TOO_LARGE",
          "file transfer control request too large",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError(400, "INVALID_REQUEST", "could not read transfer control request");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TransferError(400, "INVALID_REQUEST", "transfer control request is not UTF-8");
  }
}

export function createTransferRecord(input: unknown, now = Date.now()): TransferRecord {
  const body = object(input, "transfer");
  strictKeys(body, [
    "transfer_id",
    "user_id",
    "kid",
    "coordinator_id",
    "source",
    "target",
    "source_path",
    "target_path",
  ]);
  const transferId = requiredId(body.transfer_id, "transfer_id");
  const userId = requiredId(body.user_id, "user_id");
  const kid = requiredId(body.kid, "kid");
  const coordinatorId = requiredId(body.coordinator_id, "coordinator_id");
  const source = endpoint(body.source, "source");
  const target = endpoint(body.target, "target");
  if (source.kind === target.kind && source.id === target.id) {
    bad("ENDPOINT_COLLISION", "source and target must be different endpoints");
  }
  if (source.kind === "tool" && target.kind === "tool") {
    bad("UNSUPPORTED_PAIR", "tool-to-tool transfer is not supported");
  }

  const sourcePath = pathHint(body.source_path, "source_path", source.kind === "device");
  const targetPath = pathHint(body.target_path, "target_path", target.kind === "device");

  return {
    v: 1,
    transferId,
    userId,
    kid,
    coordinatorId,
    source,
    target,
    pathHints: {
      ...(sourcePath ? { source: sourcePath } : {}),
      ...(targetPath ? { target: targetPath } : {}),
    },
    approvals: {},
    usedSids: [],
    lastSignalSeq: {},
    phase: "pending",
    createdAt: now,
    expiresAt: now + TRANSFER_RECORD_TTL_MS,
  };
}

export function authorizeTransfer(
  record: TransferRecord,
  caller: TransferCaller,
  claimedRole: unknown,
  preparation: unknown,
  now = Date.now(),
): TransferRecord {
  assertLiveOwner(record, caller, now);
  const role = participantRole(record, caller);
  if (!role || claimedRole !== role) {
    throw new TransferError(403, "ROLE_MISMATCH", "caller is not the claimed endpoint role");
  }
  if (terminal(record.phase)) bad("TERMINAL", "transfer is already closed", 409);
  if (record.approvals[role]) bad("ALREADY_PREPARED", `${role} preparation is immutable`, 409);
  const prepared =
    role === "source" ? prepareSource(record, preparation) : prepareTarget(record, preparation);
  const approvals = { ...prepared.approvals, [role]: now };
  return withDerivedPhase({
    ...prepared,
    approvals,
    pathHints: { ...prepared.pathHints, [role]: undefined },
  });
}

export async function addTransferSignal(
  record: TransferRecord,
  caller: TransferCaller,
  claimedRole: unknown,
  rawSid: unknown,
  rawSignal: unknown,
  now = Date.now(),
): Promise<{
  record: TransferRecord;
  recipient: TransferRole;
  sid: string;
  signal: TransferSignal;
}> {
  assertLiveOwner(record, caller, now);
  const role = participantRole(record, caller);
  if (!role || role !== claimedRole) {
    throw new TransferError(403, "ROLE_MISMATCH", "caller is not the claimed endpoint role");
  }
  const sid = transferSid(rawSid);
  if (!record.approvals.source || !record.approvals.target) {
    bad("NOT_AUTHORIZED", "both endpoints must authorize before signaling", 409);
  }
  if (terminal(record.phase) || record.phase === "transferring") {
    bad("BAD_STATE", "signaling is closed", 409);
  }
  const signal = parseTransferSignal(rawSignal);
  if (signal.kind === "offer" && role !== "source") {
    throw new TransferError(403, "ROLE_MISMATCH", "only source can publish an offer");
  }
  if (signal.kind === "answer" && role !== "target") {
    throw new TransferError(403, "ROLE_MISMATCH", "only target can publish an answer");
  }
  let next: TransferRecord;
  if (signal.kind === "offer") {
    if (record.phase !== "signaling" && record.phase !== "interrupted") {
      bad("BAD_STATE", "new offer requires signaling or interrupted state", 409);
    }
    if (record.usedSids.includes(sid)) {
      bad("SID_REUSE", "a new offer requires a new sid", 409);
    }
    next = {
      ...record,
      signalSession: {
        sid,
        offerFp: rtcCertificateFingerprint(signal.sdp),
      },
      usedSids: [...record.usedSids.slice(-15), sid],
      lastSignalSeq: { source: signal.seq },
      ticket: undefined,
      phase: "signaling",
    };
  } else {
    if (!record.signalSession || record.signalSession.sid !== sid) {
      bad("SID_MISMATCH", "signal sid does not match the current offer", 409);
    }
    const previousSeq = record.lastSignalSeq[role] ?? -1;
    if (signal.seq <= previousSeq) bad("STALE_SIGNAL", "signal sequence must increase", 409);
    if (signal.kind === "answer") {
      if (record.signalSession.answerFp) bad("ANSWER_EXISTS", "answer is immutable", 409);
      next = {
        ...record,
        signalSession: {
          ...record.signalSession,
          answerFp: rtcCertificateFingerprint(signal.sdp),
        },
        lastSignalSeq: { ...record.lastSignalSeq, [role]: signal.seq },
        phase: "ready",
      };
    } else {
      next = {
        ...record,
        lastSignalSeq: { ...record.lastSignalSeq, [role]: signal.seq },
      };
    }
  }
  return { record: next, recipient: opposite(role), sid, signal };
}

export function applyTransferEvent(
  record: TransferRecord,
  caller: TransferCaller,
  event: unknown,
  now = Date.now(),
  failureCode?: unknown,
): TransferRecord {
  assertLiveOwner(record, caller, now);
  const role = participantRole(record, caller);
  const coordinator = caller.kind === "tool" && caller.id === record.coordinatorId;
  if (!role && !coordinator)
    throw new TransferError(403, "NOT_PARTICIPANT", "not a transfer endpoint");

  if (event === "cancel") {
    if (terminal(record.phase)) return record;
    return { ...record, phase: "cancelled", finishedAt: now };
  }
  if (!role) throw new TransferError(403, "NOT_PARTICIPANT", "coordinator may only cancel");
  if (event === "start") {
    if (record.phase !== "ready") bad("BAD_STATE", "transfer is not ready", 409);
    return {
      ...record,
      phase: "transferring",
      startedAt: now,
      expiresAt: Math.max(record.expiresAt, now + TRANSFER_RECORD_TTL_MS),
    };
  }
  if (event === "complete") {
    if (role !== "target")
      throw new TransferError(403, "ROLE_MISMATCH", "target completes transfer");
    if (record.phase !== "transferring") bad("BAD_STATE", "transfer has not started", 409);
    return { ...record, phase: "completed", finishedAt: now };
  }
  if (event === "fail") {
    if (terminal(record.phase)) return record;
    const code = String(failureCode ?? "TRANSFER_FAILED");
    if (!/^[A-Z0-9_]{1,64}$/.test(code)) bad("INVALID_FAILURE", "invalid failure code");
    return { ...record, phase: "failed", failureCode: code, finishedAt: now };
  }
  if (event === "interrupt") {
    if (record.phase !== "transferring")
      bad("BAD_STATE", "only an active transfer can interrupt", 409);
    const { target: _targetApproval, ...approvals } = record.approvals;
    return {
      ...record,
      approvals,
      resume: undefined,
      signalSession: undefined,
      lastSignalSeq: {},
      ticket: undefined,
      phase: "interrupted",
      expiresAt: Math.max(record.expiresAt, now + TRANSFER_RECORD_TTL_MS),
    };
  }
  bad("INVALID_EVENT", "event must be start, complete, interrupt, fail, or cancel");
}

export function buildTransferTicketStatement(
  record: TransferRecord,
  now = Date.now(),
): TransferTicketStatement {
  if (record.phase !== "ready" && record.phase !== "transferring") {
    bad("BAD_STATE", "ticket requires a ready transfer", 409);
  }
  if (!record.file || !record.resume) bad("BAD_STATE", "ticket requires endpoint preparation", 409);
  if (!record.signalSession?.answerFp)
    bad("BAD_STATE", "ticket requires one complete signaling sid", 409);
  const offerFp = hash(record.signalSession.offerFp, "offer_fp");
  const answerFp = hash(record.signalSession.answerFp, "answer_fp");
  return {
    v: 1,
    kind: "file_transfer",
    transfer_id: record.transferId,
    sid: record.signalSession.sid,
    user_id: record.userId,
    kid: record.kid,
    operator_id: record.coordinatorId,
    source_kind: record.source.kind,
    source_id: record.source.id,
    target_kind: record.target.kind,
    target_id: record.target.id,
    offerer_kind: record.source.kind,
    offerer_id: record.source.id,
    answerer_kind: record.target.kind,
    answerer_id: record.target.id,
    file_name: record.file.name,
    file_size: record.file.size,
    file_sha256: record.file.sha256,
    chunk_size: record.file.chunkSize,
    resume_offset: record.resume.offset,
    prefix_sha256: record.resume.prefixSha256,
    offer_fp: offerFp,
    answer_fp: answerFp,
    direct_only: true,
    iat: now,
    exp: Math.min(record.expiresAt, now + TRANSFER_TICKET_TTL_MS),
  };
}

export async function signTransferTicket(input: {
  privatePkcs8B64: string;
  record: TransferRecord;
  now?: number;
}): Promise<SignedTransferTicket> {
  const statement = buildTransferTicketStatement(input.record, input.now);
  return signFleetStatement({
    privatePkcs8B64: input.privatePkcs8B64,
    statement: { ...statement },
  });
}

export async function verifyTransferTicket(input: {
  publicSpkiB64: string;
  signed: SignedTransferTicket;
  expected: TransferRecord;
  now?: number;
}): Promise<TransferTicketStatement | null> {
  const decoded = await verifyFleetStatement({
    publicSpkiB64: input.publicSpkiB64,
    payload: input.signed.payload,
    sig: input.signed.sig,
  });
  if (!decoded) return null;
  return validateTransferTicketStatement(decoded, input.expected, input.now);
}

export function validateTransferTicketStatement(
  input: unknown,
  expected: TransferRecord,
  now = Date.now(),
): TransferTicketStatement | null {
  if (!expected.file || !expected.resume) return null;
  let value: Record<string, unknown>;
  try {
    value = object(input, "ticket");
    strictKeys(value, TICKET_KEYS);
  } catch {
    return null;
  }
  const exact: Omit<TransferTicketStatement, "iat" | "exp"> = {
    v: 1,
    kind: "file_transfer",
    transfer_id: expected.transferId,
    sid: expected.signalSession?.sid ?? "",
    user_id: expected.userId,
    kid: expected.kid,
    operator_id: expected.coordinatorId,
    source_kind: expected.source.kind,
    source_id: expected.source.id,
    target_kind: expected.target.kind,
    target_id: expected.target.id,
    offerer_kind: expected.source.kind,
    offerer_id: expected.source.id,
    answerer_kind: expected.target.kind,
    answerer_id: expected.target.id,
    file_name: expected.file.name,
    file_size: expected.file.size,
    file_sha256: expected.file.sha256,
    chunk_size: expected.file.chunkSize,
    resume_offset: expected.resume.offset,
    prefix_sha256: expected.resume.prefixSha256,
    offer_fp: expected.signalSession?.offerFp ?? "",
    answer_fp: expected.signalSession?.answerFp ?? "",
    direct_only: true,
  };
  for (const [key, expectedValue] of Object.entries(exact)) {
    if (value[key] !== expectedValue) return null;
  }
  const iat = value.iat;
  const exp = value.exp;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  if (iat > now + 30_000 || exp <= now) return null;
  if (exp <= iat || exp - iat > TRANSFER_TICKET_TTL_MS) return null;
  if (exp > expected.expiresAt) return null;
  return { ...exact, iat, exp };
}

export function publicTransfer(record: TransferRecord) {
  return {
    v: record.v,
    transfer_id: record.transferId,
    source: record.source,
    target: record.target,
    file: record.file
      ? {
          name: record.file.name,
          size: record.file.size,
          sha256: record.file.sha256,
          chunk_size: record.file.chunkSize,
        }
      : undefined,
    resume: record.resume
      ? {
          offset: record.resume.offset,
          prefix_sha256: record.resume.prefixSha256,
        }
      : undefined,
    authorized: {
      source: Boolean(record.approvals.source),
      target: Boolean(record.approvals.target),
    },
    phase: record.phase,
    direct_only: true,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    failure_code: record.failureCode,
  };
}

export function parseTransferSignal(input: unknown): TransferSignal {
  const value = object(input, "signal");
  const kind = String(value.kind ?? "");
  const seq = safeInt(value.seq, "signal.seq", 0, 1_000_000_000);
  if (kind === "offer" || kind === "answer") {
    strictKeys(value, ["kind", "seq", "sdp"]);
    const sdp = String(value.sdp ?? "");
    if (!sdp.startsWith("v=0") || byteLength(sdp) > TRANSFER_SIGNAL_MAX_BYTES) {
      bad("INVALID_SIGNAL", "invalid SDP");
    }
    rejectRelay(sdp);
    return { kind, seq, sdp };
  }
  if (kind === "candidate") {
    strictKeys(value, ["kind", "seq", "candidate", "sdp_mid", "sdp_mline_index"]);
    const candidate = String(value.candidate ?? "");
    if (!candidate || byteLength(candidate) > MAX_CANDIDATE_BYTES) {
      bad("INVALID_SIGNAL", "invalid ICE candidate");
    }
    rejectRelay(candidate);
    const sdpMid = String(value.sdp_mid ?? "");
    if (sdpMid.length > 128 || hasASCIIControl(sdpMid)) {
      bad("INVALID_SIGNAL", "invalid sdp_mid");
    }
    const sdpMLineIndex = safeInt(value.sdp_mline_index, "sdp_mline_index", 0, 65_535);
    return { kind, seq, candidate, sdpMid, sdpMLineIndex };
  }
  bad("INVALID_SIGNAL", "signal.kind must be offer, answer, or candidate");
}

type TransferDOEnv = {
  FLEET: DurableObjectNamespace;
  DEVICE: DurableObjectNamespace;
  RTC_STUN_URLS?: string;
};

export class TransferDO implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: TransferDOEnv;

  constructor(ctx: DurableObjectState, env: TransferDOEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const caller = callerFromRequest(request);
      if (url.pathname === "/create" && request.method === "POST") {
        const prior = await this.ctx.storage.get<TransferRecord>("transfer");
        if (prior) throw new TransferError(409, "EXISTS", "transfer already exists");
        const body = await request.json();
        const record = createTransferRecord(body);
        assertLiveOwner(record, caller, Date.now());
        if (record.coordinatorId !== caller.id || caller.kind !== "tool") {
          throw new TransferError(403, "COORDINATOR_MISMATCH", "invalid coordinator");
        }
        await this.save(record);
        await this.deliver(record, "source", {
          kind: "prepare",
          role: "source",
          pathHint: record.pathHints.source ?? "",
          at: Date.now(),
        });
        return responseJson({ transfer: publicTransfer(record) }, 201);
      }

      const record = await this.ctx.storage.get<TransferRecord>("transfer");
      if (!record) throw new TransferError(404, "NOT_FOUND", "transfer not found");
      assertLiveOwner(record, caller, Date.now());

      if (url.pathname === "/status" && request.method === "POST") {
        const body = object(await request.json(), "status");
        strictKeys(body, []);
        return responseJson({ transfer: publicTransfer(liveView(record)) });
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        const body = object(await request.json(), "authorization");
        strictKeys(body, ["role", "preparation"]);
        const next = authorizeTransfer(record, caller, body.role, body.preparation);
        await this.save(next);
        if (body.role === "source" && next.file) {
          await this.deliver(next, "target", { kind: "manifest", file: next.file, at: Date.now() });
        }
        await Promise.all(
          (["source", "target"] as const)
            .filter((role) => !sameDeviceCaller(next, role, caller))
            .map((role) => this.pushUpdate(next, role)),
        );
        return responseJson({ transfer: publicTransfer(next) });
      }
      if (url.pathname === "/signal" && request.method === "POST") {
        const body = object(await request.json(), "signal request");
        strictKeys(body, ["role", "sid", "signal"]);
        const added = await addTransferSignal(record, caller, body.role, body.sid, body.signal);
        let next = added.record;
        const callerMessages: Array<{ type: string; body: Record<string, unknown> }> = [];
        await this.save(next);
        await this.deliver(next, added.recipient, {
          kind: "signal",
          from: opposite(added.recipient),
          sid: added.sid,
          signal: added.signal,
          at: Date.now(),
        });
        if (next.phase === "ready" && !next.ticket) {
          const ticketCandidate = next;
          const ticket = await this.attachTicket(ticketCandidate);
          const merged = await this.mergeTicket(ticketCandidate, ticket);
          next = merged.record;
          if (merged.attached) {
            const ticketItem: TransferMailboxItem = {
              kind: "ticket",
              statement: ticket,
              at: Date.now(),
            };
            await Promise.all(
              (["source", "target"] as const).map((role) => {
                if (sameDeviceCaller(next, role, caller)) {
                  callerMessages.push({
                    type: "file_ticket",
                    body: {
                      transfer_id: next.transferId,
                      sid: next.signalSession?.sid ?? "",
                      statement: ticketItem.statement,
                    },
                  });
                  return Promise.resolve();
                }
                return this.deliver(next, role, ticketItem);
              }),
            );
          }
        }
        return responseJson({
          transfer: publicTransfer(next),
          ...(callerMessages.length ? { caller_messages: callerMessages } : {}),
        });
      }
      if (url.pathname === "/signal/poll" && request.method === "POST") {
        const body = object(await request.json(), "signal poll");
        strictKeys(body, []);
        const role = participantRole(record, caller);
        if (!role) throw new TransferError(403, "NOT_PARTICIPANT", "not a transfer endpoint");
        const items = await this.takeMailbox(role);
        return responseJson({ transfer_id: record.transferId, items });
      }
      if (url.pathname === "/event" && request.method === "POST") {
        const body = object(await request.json(), "event");
        strictKeys(body, ["event", "failure_code"]);
        const next = applyTransferEvent(record, caller, body.event, Date.now(), body.failure_code);
        await this.save(next);
        await Promise.all(
          (["source", "target"] as const)
            .filter((role) => !sameDeviceCaller(next, role, caller))
            .map((role) => this.pushUpdate(next, role)),
        );
        return responseJson({ transfer: publicTransfer(next) });
      }
      throw new TransferError(404, "NOT_FOUND", "route not found");
    } catch (error) {
      if (error instanceof TransferError) {
        return responseJson({ error: error.message, code: error.code }, error.status);
      }
      return responseJson({ error: "invalid transfer request", code: "INVALID_REQUEST" }, 400);
    }
  }

  async alarm() {
    const initial = await this.ctx.storage.get<TransferRecord>("transfer");
    if (!initial) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    if (initial.expiresAt > now) {
      await this.ctx.storage.setAlarm(initial.expiresAt);
      return;
    }
    const current = await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<TransferRecord>("transfer");
      if (!record || record.expiresAt > now || terminal(record.phase)) return record;
      const expired: TransferRecord = {
        ...record,
        phase: "expired",
        ticket: undefined,
        finishedAt: now,
      };
      await txn.put("transfer", expired);
      return expired;
    });
    if (!current) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (current.expiresAt > now) {
      await this.ctx.storage.setAlarm(current.expiresAt);
      return;
    }
    if (current.phase === "expired") {
      await Promise.allSettled(
        (["source", "target"] as const).map((role) => this.pushUpdate(current, role)),
      );
    }
    await this.ctx.storage.deleteAll();
  }

  private async save(record: TransferRecord) {
    await this.ctx.storage.put("transfer", record);
    await this.ctx.storage.setAlarm(record.expiresAt);
  }

  private async enqueue(role: TransferRole, item: TransferMailboxItem) {
    const key = `mail:${role}`;
    await this.ctx.storage.transaction(async (txn) => {
      const current = (await txn.get<TransferMailboxItem[]>(key)) ?? [];
      if (current.length >= MAX_MAILBOX_ITEMS) {
        throw new TransferError(409, "SIGNAL_BACKPRESSURE", "peer must consume pending signals");
      }
      await txn.put(key, [...current, item]);
    });
  }

  private async takeMailbox(role: TransferRole) {
    const key = `mail:${role}`;
    return this.ctx.storage.transaction(async (txn) => {
      const items = (await txn.get<TransferMailboxItem[]>(key)) ?? [];
      await txn.delete(key);
      return items;
    });
  }

  private async mergeTicket(candidate: TransferRecord, ticket: SignedTransferTicket) {
    const merged = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<TransferRecord>("transfer");
      if (!current) return null;
      if (current.phase !== "ready" || current.ticket || !sameTicketBinding(current, candidate)) {
        return { record: current, attached: false as const };
      }
      const record = { ...current, ticket };
      await txn.put("transfer", record);
      return { record, attached: true as const };
    });
    if (!merged) throw new TransferError(410, "EXPIRED", "transfer expired");
    return merged;
  }

  private async deliver(record: TransferRecord, role: TransferRole, item: TransferMailboxItem) {
    const endpoint = record[role];
    if (endpoint.kind === "tool") return this.enqueue(role, item);
    const peer = record[opposite(role)];
    let type: string;
    let body: Record<string, unknown>;
    if (item.kind === "prepare") {
      type = "file_prepare";
      body = {
        transfer_id: record.transferId,
        role,
        path_hint: item.pathHint,
        operator_id: record.coordinatorId,
        user_id: record.userId,
        peer: { kind: peer.kind, id: peer.id, name: peer.name ?? peer.id },
        stun_urls: transferStunURLs(this.env.RTC_STUN_URLS),
      };
    } else if (item.kind === "manifest") {
      type = "file_prepare";
      body = {
        transfer_id: record.transferId,
        role,
        path_hint: record.pathHints[role] ?? "",
        operator_id: record.coordinatorId,
        user_id: record.userId,
        peer: { kind: peer.kind, id: peer.id, name: peer.name ?? peer.id },
        stun_urls: transferStunURLs(this.env.RTC_STUN_URLS),
        manifest: {
          name: item.file.name,
          size: item.file.size,
          sha256: item.file.sha256,
          chunk_size: item.file.chunkSize,
        },
      };
    } else if (item.kind === "signal") {
      type = "file_signal";
      body = {
        transfer_id: record.transferId,
        role: item.from,
        sid: item.sid,
        signal: item.signal,
      };
    } else {
      type = "file_ticket";
      body = {
        transfer_id: record.transferId,
        sid: record.signalSession?.sid ?? "",
        statement: item.statement,
      };
    }
    await this.pushDevice(record, endpoint, type, body);
  }

  private async pushUpdate(record: TransferRecord, role: TransferRole) {
    const endpoint = record[role];
    if (endpoint.kind !== "device") return;
    await this.pushDevice(record, endpoint, "file_update", {
      transfer_id: record.transferId,
      phase: record.phase,
      transfer: publicTransfer(record),
    });
  }

  private async pushDevice(
    record: TransferRecord,
    endpoint: TransferEndpoint,
    type: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.env.DEVICE.get(this.env.DEVICE.idFromName(endpoint.id)).fetch(
      new Request("https://device/file-transfer-push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: record.userId,
          kid: record.kid,
          device_id: endpoint.id,
          type,
          body,
        }),
      }),
    );
    if (!response.ok) throw new TransferError(409, "PEER_OFFLINE", "device endpoint is offline");
  }

  private async attachTicket(record: TransferRecord): Promise<SignedTransferTicket> {
    const response = await this.env.FLEET.get(this.env.FLEET.idFromName("fleet")).fetch(
      new Request("https://fleet/transfer-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ record: { ...record, pathHints: {} } }),
      }),
    );
    if (!response.ok) throw new TransferError(401, "TICKET_REJECTED", "transfer ticket rejected");
    const body = (await response.json()) as { statement?: SignedTransferTicket };
    if (!body.statement?.payload || !body.statement.sig) {
      throw new TransferError(500, "TICKET_REJECTED", "transfer ticket missing");
    }
    return body.statement;
  }
}

const TICKET_KEYS = [
  "v",
  "kind",
  "transfer_id",
  "sid",
  "user_id",
  "kid",
  "operator_id",
  "source_kind",
  "source_id",
  "target_kind",
  "target_id",
  "offerer_kind",
  "offerer_id",
  "answerer_kind",
  "answerer_id",
  "file_name",
  "file_size",
  "file_sha256",
  "chunk_size",
  "resume_offset",
  "prefix_sha256",
  "offer_fp",
  "answer_fp",
  "direct_only",
  "iat",
  "exp",
] as const;

function withDerivedPhase(record: TransferRecord): TransferRecord {
  if (terminal(record.phase) || record.phase === "transferring") return record;
  const approvals =
    Number(Boolean(record.approvals.source)) + Number(Boolean(record.approvals.target));
  if (record.phase === "interrupted" && approvals < 2) return record;
  const phase: TransferPhase = record.signalSession?.answerFp
    ? "ready"
    : approvals === 2
      ? "signaling"
      : approvals === 1
        ? "authorizing"
        : "pending";
  return { ...record, phase };
}

function participantRole(record: TransferRecord, caller: TransferCaller): TransferRole | null {
  if (caller.kind === record.source.kind && caller.id === record.source.id) return "source";
  if (caller.kind === record.target.kind && caller.id === record.target.id) return "target";
  return null;
}

function sameDeviceCaller(record: TransferRecord, role: TransferRole, caller: TransferCaller) {
  const endpoint = record[role];
  return caller.kind === "device" && endpoint.kind === "device" && endpoint.id === caller.id;
}

function sameTicketBinding(current: TransferRecord, candidate: TransferRecord) {
  return (
    current.transferId === candidate.transferId &&
    current.userId === candidate.userId &&
    current.kid === candidate.kid &&
    current.coordinatorId === candidate.coordinatorId &&
    current.source.kind === candidate.source.kind &&
    current.source.id === candidate.source.id &&
    current.target.kind === candidate.target.kind &&
    current.target.id === candidate.target.id &&
    current.file?.name === candidate.file?.name &&
    current.file?.size === candidate.file?.size &&
    current.file?.sha256 === candidate.file?.sha256 &&
    current.file?.chunkSize === candidate.file?.chunkSize &&
    current.resume?.offset === candidate.resume?.offset &&
    current.resume?.prefixSha256 === candidate.resume?.prefixSha256 &&
    current.signalSession?.sid === candidate.signalSession?.sid &&
    current.signalSession?.offerFp === candidate.signalSession?.offerFp &&
    current.signalSession?.answerFp === candidate.signalSession?.answerFp
  );
}

function assertLiveOwner(record: TransferRecord, caller: TransferCaller, now: number) {
  if (record.userId !== caller.userId || record.kid !== caller.kid) {
    throw new TransferError(404, "NOT_FOUND", "transfer not found");
  }
  if (record.expiresAt <= now && !terminal(record.phase)) {
    throw new TransferError(410, "EXPIRED", "transfer expired");
  }
}

function callerFromRequest(request: Request): TransferCaller {
  const userId = request.headers.get("x-fleet-user") ?? "";
  const kid = request.headers.get("x-fleet-kid") ?? "";
  const kind = request.headers.get("x-transfer-caller-kind") ?? "";
  const id = request.headers.get("x-transfer-caller-id") ?? "";
  if (!userId || !kid || !id || !["tool", "device"].includes(kind)) {
    throw new TransferError(401, "UNAUTHORIZED", "trusted transfer caller required");
  }
  return { userId, kid, kind: kind as TransferCaller["kind"], id };
}

function endpoint(input: unknown, field: string): TransferEndpoint {
  const value = object(input, field);
  strictKeys(value, ["kind", "id", "name"]);
  const kind = String(value.kind ?? "");
  if (kind !== "tool" && kind !== "device") bad("INVALID_ENDPOINT", `${field}.kind is invalid`);
  const name = String(value.name ?? "");
  if (name.length > 255 || hasASCIIControl(name)) {
    bad("INVALID_ENDPOINT", `${field}.name is invalid`);
  }
  return { kind, id: requiredId(value.id, `${field}.id`), ...(name ? { name } : {}) };
}

function prepareSource(record: TransferRecord, input: unknown): TransferRecord {
  const preparation = object(input, "source preparation");
  strictKeys(preparation, ["file"]);
  const fileBody = object(preparation.file, "file");
  strictKeys(fileBody, ["name", "size", "sha256", "chunk_size"]);
  const name = String(fileBody.name ?? "");
  if (
    !name ||
    name.length > 255 ||
    name.includes("/") ||
    name.includes("\\") ||
    hasASCIIControl(name)
  ) {
    bad("INVALID_FILE", "file.name must be a plain basename");
  }
  const size = safeInt(fileBody.size, "file.size", 0, Number.MAX_SAFE_INTEGER);
  const sha256 = hash(fileBody.sha256, "file.sha256");
  const chunkSize = safeInt(fileBody.chunk_size, "file.chunk_size", 32 << 10, 32 << 10);
  return { ...record, file: { name, size, sha256, chunkSize } };
}

function prepareTarget(record: TransferRecord, input: unknown): TransferRecord {
  if (!record.file) bad("SOURCE_NOT_PREPARED", "source manifest is required", 409);
  const preparation = object(input, "target preparation");
  strictKeys(preparation, ["resume"]);
  const resumeBody = object(preparation.resume, "resume");
  strictKeys(resumeBody, ["offset", "prefix_sha256"]);
  const offset = safeInt(resumeBody.offset, "resume.offset", 0, record.file.size);
  if (offset !== record.file.size && offset % record.file.chunkSize !== 0) {
    bad("INVALID_RESUME", "resume.offset must be a verified chunk boundary");
  }
  const prefixSha256 = hash(resumeBody.prefix_sha256, "resume.prefix_sha256");
  return { ...record, resume: { offset, prefixSha256 } };
}

function liveView(record: TransferRecord): TransferRecord {
  if (record.expiresAt > Date.now() || terminal(record.phase)) return record;
  return { ...record, phase: "expired", ticket: undefined };
}

function terminal(phase: TransferPhase) {
  return (
    phase === "completed" || phase === "cancelled" || phase === "failed" || phase === "expired"
  );
}

function opposite(role: TransferRole): TransferRole {
  return role === "source" ? "target" : "source";
}

function rejectRelay(value: string) {
  if (/(?:^|\s)typ\s+relay(?:\s|$)/im.test(value) || /turns?:/i.test(value)) {
    bad("DIRECT_ONLY", "relay/TURN candidates are forbidden", 409);
  }
}

export function rtcCertificateFingerprint(sdp: string): string {
  const match = sdp.match(/^a=fingerprint:sha-256\s+([0-9a-f:]+)\s*$/im);
  const normalized = match?.[1]?.replaceAll(":", "").toLowerCase() ?? "";
  if (!HASH_RE.test(normalized)) {
    bad("INVALID_SIGNAL", "SDP must contain a SHA-256 certificate fingerprint");
  }
  return normalized;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    bad("INVALID_REQUEST", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown) bad("UNKNOWN_FIELD", `unknown field: ${unknown}`);
}

function requiredId(value: unknown, field: string): string {
  const id = String(value ?? "");
  if (!ID_RE.test(id)) bad("INVALID_ID", `${field} is invalid`);
  return id;
}

function transferSid(value: unknown): string {
  const sid = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sid)) {
    bad("INVALID_SID", "sid must be UUIDv4");
  }
  return sid.toLowerCase();
}

function pathHint(value: unknown, field: string, required: boolean): string {
  const path = String(value ?? "");
  if (!path && !required) return "";
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  if (!absolute || path.length > 4096 || hasASCIIControl(path)) {
    bad("INVALID_PATH_HINT", `${field} is invalid`);
  }
  return path;
}

function transferStunURLs(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("stun:") && value.length <= 512)
    .slice(0, 4);
}

function hasASCIIControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function safeInt(value: unknown, field: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    bad("INVALID_NUMBER", `${field} is invalid`);
  }
  return number;
}

function hash(value: unknown, field: string): string {
  const normalized = String(value ?? "").toLowerCase();
  if (!HASH_RE.test(normalized)) bad("INVALID_HASH", `${field} must be SHA-256 hex`);
  return normalized;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bad(code: string, message: string, status = 400): never {
  throw new TransferError(status, code, message);
}

function responseJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
