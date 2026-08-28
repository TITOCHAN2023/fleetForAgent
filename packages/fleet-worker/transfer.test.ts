import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { generateUserKeypair } from "./src/tokenv1.mjs";
import {
  TransferDO,
  TransferError,
  addTransferSignal,
  applyTransferEvent,
  authorizeTransfer,
  buildTransferTicketStatement,
  createTransferRecord,
  publicTransfer,
  readTransferControlText,
  signTransferTicket,
  validateTransferTicketStatement,
  verifyTransferTicket,
  type TransferCaller,
  type TransferRecord,
} from "./src/transfer.ts";

const H0 = "0".repeat(64);
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NOW = 1_800_000_000_000;
const SID1 = "00000000-0000-4000-8000-000000000011";
const SID2 = "00000000-0000-4000-8000-000000000012";

function record(overrides: Record<string, unknown> = {}) {
  return createTransferRecord(
    {
      transfer_id: "00000000-0000-4000-8000-000000000001",
      user_id: "account-a",
      kid: "kid-a",
      coordinator_id: "operator-a",
      source: { kind: "device", id: "device-a" },
      target: { kind: "tool", id: "operator-a" },
      source_path: "/private/source/report.pdf",
      target_path: "/private/target/report.pdf",
      ...overrides,
    },
    NOW,
  );
}

const sender: TransferCaller = {
  userId: "account-a",
  kid: "kid-a",
  kind: "device",
  id: "device-a",
};
const receiver: TransferCaller = {
  userId: "account-a",
  kid: "kid-a",
  kind: "tool",
  id: "operator-a",
};

async function readyRecord(): Promise<TransferRecord> {
  let next = prepareRecord();
  next = (
    await addTransferSignal(
      next,
      sender,
      "source",
      SID1,
      { kind: "offer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("a")}\r\n` },
      NOW + 3,
    )
  ).record;
  next = (
    await addTransferSignal(
      next,
      receiver,
      "target",
      SID1,
      { kind: "answer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("b")}\r\n` },
      NOW + 4,
    )
  ).record;
  return next;
}

function prepareRecord(): TransferRecord {
  let next = authorizeTransfer(
    record(),
    sender,
    "source",
    { file: { name: "report.pdf", size: 131_072, sha256: H1, chunk_size: 32_768 } },
    NOW + 1,
  );
  next = authorizeTransfer(
    next,
    receiver,
    "target",
    { resume: { offset: 65_536, prefix_sha256: H2 } },
    NOW + 2,
  );
  return next;
}

test("authorization is same-account and role-bound", () => {
  const foreign = { ...sender, userId: "account-b" };
  assert.throws(
    () =>
      authorizeTransfer(
        record(),
        foreign,
        "source",
        { file: { name: "x", size: 0, sha256: H1, chunk_size: 32_768 } },
        NOW + 1,
      ),
    (error: unknown) => error instanceof TransferError && error.status === 404,
  );
  assert.throws(
    () =>
      authorizeTransfer(
        record(),
        sender,
        "target",
        { resume: { offset: 0, prefix_sha256: H_EMPTY } },
        NOW + 1,
      ),
    (error: unknown) => error instanceof TransferError && error.code === "ROLE_MISMATCH",
  );

  let next = authorizeTransfer(
    record(),
    sender,
    "source",
    { file: { name: "report.pdf", size: 131_072, sha256: H1, chunk_size: 32_768 } },
    NOW + 1,
  );
  assert.equal(next.phase, "authorizing");
  next = authorizeTransfer(
    next,
    receiver,
    "target",
    { resume: { offset: 65_536, prefix_sha256: H2 } },
    NOW + 2,
  );
  assert.equal(next.phase, "signaling");
});

test("source and target own immutable preparation fields", () => {
  assert.throws(
    () =>
      authorizeTransfer(
        record(),
        receiver,
        "target",
        { resume: { offset: 0, prefix_sha256: H_EMPTY } },
        NOW + 1,
      ),
    (error: unknown) => error instanceof TransferError && error.code === "SOURCE_NOT_PREPARED",
  );
  let next = authorizeTransfer(
    record(),
    sender,
    "source",
    { file: { name: "report.pdf", size: 131_072, sha256: H1, chunk_size: 32_768 } },
    NOW + 1,
  );
  assert.throws(
    () =>
      authorizeTransfer(
        next,
        sender,
        "source",
        { file: { name: "changed.pdf", size: 1, sha256: H0, chunk_size: 32_768 } },
        NOW + 2,
      ),
    (error: unknown) => error instanceof TransferError && error.code === "ALREADY_PREPARED",
  );
  assert.throws(
    () =>
      authorizeTransfer(
        record(),
        sender,
        "source",
        { file: { name: "x", size: 0, sha256: H1, chunk_size: 65_536 } },
        NOW + 1,
      ),
    (error: unknown) => error instanceof TransferError && error.code === "INVALID_NUMBER",
  );
});

test("state changes are semantic and server validated", async () => {
  let next = await readyRecord();
  assert.equal(next.phase, "ready");
  assert.throws(
    () => applyTransferEvent(next, receiver, "complete", NOW + 5),
    (error: unknown) => error instanceof TransferError && error.code === "BAD_STATE",
  );
  next = applyTransferEvent(next, sender, "start", NOW + 5);
  assert.equal(next.phase, "transferring");
  assert.throws(
    () => applyTransferEvent(next, sender, "complete", NOW + 6),
    (error: unknown) => error instanceof TransferError && error.code === "ROLE_MISMATCH",
  );
  next = applyTransferEvent(next, receiver, "complete", NOW + 7);
  assert.equal(next.phase, "completed");
});

test("direct-only signaling rejects TURN/relay and role swaps", async () => {
  const next = prepareRecord();
  await assert.rejects(
    addTransferSignal(
      next,
      receiver,
      "target",
      SID1,
      { kind: "offer", seq: 1, sdp: "v=0\r\n" },
      NOW + 3,
    ),
    (error: unknown) => error instanceof TransferError && error.code === "ROLE_MISMATCH",
  );
  await assert.rejects(
    addTransferSignal(
      next,
      sender,
      "source",
      SID1,
      {
        kind: "offer",
        seq: 1,
        sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("a")}\r\na=candidate:1 1 udp 1 1.2.3.4 9 typ relay\r\n`,
      },
      NOW + 3,
    ),
    (error: unknown) => error instanceof TransferError && error.code === "DIRECT_ONLY",
  );
  await assert.rejects(
    addTransferSignal(
      next,
      sender,
      "source",
      SID1,
      {
        kind: "candidate",
        seq: 1,
        candidate: "candidate:1 1 udp 1 1.2.3.4 9 typ relay",
        sdp_mid: "0",
        sdp_mline_index: 0,
      },
      NOW + 3,
    ),
    (error: unknown) => error instanceof TransferError && error.code === "DIRECT_ONLY",
  );
});

test("ticket fixes hash, resume offset, prefix hash, roles, expiry, and direct-only", async () => {
  const ready = await readyRecord();
  const statement = buildTransferTicketStatement(ready, NOW + 10);
  assert.equal(statement.direct_only, true);
  assert.equal(statement.sid, SID1);
  assert.equal(statement.prefix_sha256, H2);
  assert.equal(statement.offer_fp, "a".repeat(64));
  assert.ok(statement.exp - statement.iat <= 60_000);
  assert.ok(validateTransferTicketStatement(statement, ready, NOW + 11));

  assert.equal(
    validateTransferTicketStatement({ ...statement, file_sha256: H0 }, ready, NOW + 11),
    null,
  );
  assert.equal(
    validateTransferTicketStatement({ ...statement, resume_offset: 0 }, ready, NOW + 11),
    null,
  );
  assert.equal(
    validateTransferTicketStatement({ ...statement, prefix_sha256: H0 }, ready, NOW + 11),
    null,
  );
  assert.equal(
    validateTransferTicketStatement(
      { ...statement, source_id: statement.target_id, target_id: statement.source_id },
      ready,
      NOW + 11,
    ),
    null,
  );
  assert.equal(validateTransferTicketStatement(statement, ready, statement.exp), null);

  const keys = await generateUserKeypair();
  const signed = await signTransferTicket({
    privatePkcs8B64: keys.privatePkcs8B64,
    record: ready,
    now: NOW + 10,
  });
  assert.ok(
    await verifyTransferTicket({
      publicSpkiB64: keys.publicSpkiB64,
      signed,
      expected: ready,
      now: NOW + 11,
    }),
  );
  const tampered = { ...ready, file: { ...ready.file!, sha256: H0 } };
  assert.equal(
    await verifyTransferTicket({
      publicSpkiB64: keys.publicSpkiB64,
      signed,
      expected: tampered,
      now: NOW + 11,
    }),
    null,
  );
});

test("interrupt requires target resume refresh and a fresh signaling sid", async () => {
  let next = await readyRecord();
  const firstTicket = buildTransferTicketStatement(next, NOW + 5);
  next = applyTransferEvent(next, sender, "start", NOW + 6);
  next = applyTransferEvent(next, receiver, "interrupt", NOW + 7);
  assert.equal(next.phase, "interrupted");
  assert.equal(next.resume, undefined);
  assert.equal(next.approvals.target, undefined);

  next = authorizeTransfer(
    next,
    receiver,
    "target",
    { resume: { offset: 32_768, prefix_sha256: H0 } },
    NOW + 8,
  );
  assert.equal(next.phase, "signaling");
  await assert.rejects(
    addTransferSignal(
      next,
      sender,
      "source",
      SID1,
      { kind: "offer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("c")}\r\n` },
      NOW + 9,
    ),
    (error: unknown) => error instanceof TransferError && error.code === "SID_REUSE",
  );
  next = (
    await addTransferSignal(
      next,
      sender,
      "source",
      SID2,
      { kind: "offer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("c")}\r\n` },
      NOW + 9,
    )
  ).record;
  await assert.rejects(
    addTransferSignal(
      next,
      receiver,
      "target",
      SID1,
      { kind: "answer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("d")}\r\n` },
      NOW + 10,
    ),
    (error: unknown) => error instanceof TransferError && error.code === "SID_MISMATCH",
  );
  next = (
    await addTransferSignal(
      next,
      receiver,
      "target",
      SID2,
      { kind: "answer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("d")}\r\n` },
      NOW + 10,
    )
  ).record;
  const renewed = buildTransferTicketStatement(next, NOW + 11);
  assert.equal(renewed.sid, SID2);
  assert.equal(renewed.resume_offset, 32_768);
  assert.equal(validateTransferTicketStatement(firstTicket, next, NOW + 11), null);
});

test("zero-byte transfer ticket binds SHA-256(empty) at offset zero", async () => {
  let next = authorizeTransfer(
    record(),
    sender,
    "source",
    { file: { name: "empty.bin", size: 0, sha256: H_EMPTY, chunk_size: 32_768 } },
    NOW + 1,
  );
  next = authorizeTransfer(
    next,
    receiver,
    "target",
    { resume: { offset: 0, prefix_sha256: H_EMPTY } },
    NOW + 2,
  );
  next = (
    await addTransferSignal(
      next,
      sender,
      "source",
      SID1,
      { kind: "offer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("a")}\r\n` },
      NOW + 3,
    )
  ).record;
  next = (
    await addTransferSignal(
      next,
      receiver,
      "target",
      SID1,
      { kind: "answer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("b")}\r\n` },
      NOW + 4,
    )
  ).record;
  const statement = buildTransferTicketStatement(next, NOW + 5);
  assert.equal(statement.file_size, 0);
  assert.equal(statement.resume_offset, 0);
  assert.equal(statement.prefix_sha256, H_EMPTY);
});

test("public status contains no SDP, candidate, ticket, account, or device IP", async () => {
  const value = publicTransfer(await readyRecord());
  const encoded = JSON.stringify(value);
  assert.doesNotMatch(encoded, /sdp|candidate|ticket|userId|user_id|kid|path|ip/i);
});

test("unknown transfer and signal fields cannot smuggle file bytes", async () => {
  assert.throws(
    () => record({ data: "bytes" }),
    (error: unknown) => error instanceof TransferError && error.code === "UNKNOWN_FIELD",
  );
  const next = prepareRecord();
  await assert.rejects(
    addTransferSignal(
      next,
      sender,
      "source",
      SID1,
      {
        kind: "offer",
        seq: 1,
        sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("a")}\r\n`,
        data: "bytes",
      },
      NOW + 3,
    ),
    (error: unknown) => error instanceof TransferError && error.code === "UNKNOWN_FIELD",
  );
});

test("transfer control body stops chunked input at the byte limit", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(5));
      if (pulls === 3) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Request("https://worker/v1/transfer/signal", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readTransferControlText(streamed, 8),
    (error: unknown) =>
      error instanceof TransferError && error.status === 413 && error.code === "REQUEST_TOO_LARGE",
  );
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
});

test("invalid content-length is streamed instead of trusted", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode(pulls === 1 ? "12345" : "67890"));
      if (pulls === 2) controller.close();
    },
  });
  const streamed = new Request("https://worker/v1/transfer/signal", {
    method: "POST",
    headers: { "content-length": "not-a-number" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readTransferControlText(streamed, 8),
    (error: unknown) => error instanceof TransferError && error.status === 413,
  );
  assert.equal(pulls, 2);
});

test("TransferDO signal mailbox is participant-only and consume-on-read", async () => {
  const state = fakeState();
  const env = {
    FLEET: {
      idFromName: () => "fleet",
      get: () => ({ fetch: async () => new Response("not used", { status: 500 }) }),
    },
    DEVICE: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
    },
  } as unknown as { FLEET: DurableObjectNamespace };
  const control = new TransferDO(state as unknown as DurableObjectState, env);
  const create = await control.fetch(
    request("/create", "tool", "operator-a", {
      transfer_id: "00000000-0000-4000-8000-000000000009",
      user_id: "account-a",
      kid: "kid-a",
      coordinator_id: "operator-a",
      source: { kind: "device", id: "device-a" },
      target: { kind: "tool", id: "operator-a" },
      source_path: "/private/source/x.bin",
      target_path: "/private/target/x.bin",
    }),
  );
  assert.equal(create.status, 201);
  assert.equal(
    (
      await control.fetch(
        request("/authorize", "device", "device-a", {
          role: "source",
          preparation: { file: { name: "x.bin", size: 0, sha256: H1, chunk_size: 32_768 } },
        }),
      )
    ).status,
    200,
  );
  const preparation = await control.fetch(request("/signal/poll", "tool", "operator-a", {}));
  const preparationItems = ((await preparation.json()) as { items: Array<{ kind: string }> }).items;
  assert.deepEqual(
    preparationItems.map((item) => item.kind),
    ["manifest"],
  );
  assert.equal(
    (
      await control.fetch(
        request("/authorize", "tool", "operator-a", {
          role: "target",
          preparation: { resume: { offset: 0, prefix_sha256: H_EMPTY } },
        }),
      )
    ).status,
    200,
  );

  const sdp = `v=0\r\na=fingerprint:sha-256 ${fingerprint("a")}\r\na=ice-ufrag:private\r\n`;
  const sent = await control.fetch(
    request("/signal", "device", "device-a", {
      role: "source",
      sid: SID1,
      signal: { kind: "offer", seq: 1, sdp },
    }),
  );
  assert.equal(sent.status, 200);
  assert.doesNotMatch(await sent.text(), /ice-ufrag|sdp/);

  const foreign = await control.fetch(
    request("/signal/poll", "device", "device-other", {}, "account-b"),
  );
  assert.equal(foreign.status, 404);

  const first = await control.fetch(request("/signal/poll", "tool", "operator-a", {}));
  const firstBody = (await first.json()) as { items: Array<{ signal?: { sdp?: string } }> };
  assert.equal(firstBody.items.length, 1);
  assert.equal(firstBody.items[0]?.signal?.sdp, sdp);
  const second = await control.fetch(request("/signal/poll", "tool", "operator-a", {}));
  assert.deepEqual(((await second.json()) as { items: unknown[] }).items, []);
  assert.ok(state.transactions() >= 4);
});

test("TransferDO does not let a late ticket overwrite cancellation", async () => {
  const state = fakeState();
  let releaseSigner!: () => void;
  let signerStarted!: () => void;
  const signerGate = new Promise<void>((resolve) => {
    releaseSigner = resolve;
  });
  const signerSeen = new Promise<void>((resolve) => {
    signerStarted = resolve;
  });
  const pushedTypes: string[] = [];
  const env = {
    FLEET: {
      idFromName: () => "fleet",
      get: () => ({
        fetch: async () => {
          signerStarted();
          await signerGate;
          return Response.json({ statement: { payload: "payload", sig: "sig" } });
        },
      }),
    },
    DEVICE: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (incoming: Request) => {
          const pushed = (await incoming.json()) as { type: string };
          pushedTypes.push(pushed.type);
          return new Response("{}", { status: 200 });
        },
      }),
    },
  } as unknown as { FLEET: DurableObjectNamespace; DEVICE: DurableObjectNamespace };
  const control = new TransferDO(state as unknown as DurableObjectState, env);
  let signaling = prepareRecord();
  signaling = (
    await addTransferSignal(
      signaling,
      sender,
      "source",
      SID1,
      { kind: "offer", seq: 1, sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("a")}\r\n` },
      Date.now(),
    )
  ).record;
  signaling = { ...signaling, expiresAt: Date.now() + 60_000 };
  await state.storage.put("transfer", signaling);

  const answer = control.fetch(
    request("/signal", "tool", "operator-a", {
      role: "target",
      sid: SID1,
      signal: {
        kind: "answer",
        seq: 1,
        sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint("b")}\r\n`,
      },
    }),
  );
  await signerSeen;
  const cancelled = await control.fetch(
    request("/event", "tool", "operator-a", { event: "cancel" }),
  );
  assert.equal(cancelled.status, 200);
  releaseSigner();
  assert.equal((await answer).status, 200);

  const stored = await state.storage.get<TransferRecord>("transfer");
  assert.equal(stored?.phase, "cancelled");
  assert.equal(stored?.ticket, undefined);
  assert.equal(pushedTypes.includes("file_ticket"), false);
});

test("TransferDO moves extended expiry alarms and deletes the entire record at expiry", async () => {
  const state = fakeState();
  const expiredUpdates: Array<{ device_id: string; phase: string }> = [];
  const env = {
    FLEET: {
      idFromName: () => "fleet",
      get: () => ({ fetch: async () => new Response("not used", { status: 500 }) }),
    },
    DEVICE: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (incoming: Request) => {
          const pushed = (await incoming.json()) as {
            device_id: string;
            type: string;
            body: { phase?: string };
          };
          if (pushed.type === "file_update" && pushed.body.phase === "expired") {
            expiredUpdates.push({ device_id: pushed.device_id, phase: pushed.body.phase });
          }
          return new Response("{}", { status: 200 });
        },
      }),
    },
  } as unknown as { FLEET: DurableObjectNamespace };
  const control = new TransferDO(state as unknown as DurableObjectState, env);
  const oldExpiry = Date.now() + 1_000;
  const ready = { ...(await readyRecord()), expiresAt: oldExpiry };
  await state.storage.put("transfer", ready);
  await state.storage.setAlarm(oldExpiry);

  const started = await control.fetch(request("/event", "device", "device-a", { event: "start" }));
  assert.equal(started.status, 200);
  const startedRecord = await state.storage.get<TransferRecord>("transfer");
  assert.equal(startedRecord?.phase, "transferring");
  assert.ok((startedRecord?.expiresAt ?? 0) > oldExpiry);
  assert.equal(state.alarm(), startedRecord?.expiresAt);

  await control.alarm();
  assert.equal(state.alarm(), startedRecord?.expiresAt);
  await state.storage.put("mail:source", [{ kind: "signal" }]);
  await state.storage.put("transfer", {
    ...startedRecord!,
    target: { kind: "device", id: "device-b" },
    expiresAt: Date.now() - 1,
  });
  await control.alarm();
  assert.deepEqual(expiredUpdates.map((update) => update.device_id).sort(), [
    "device-a",
    "device-b",
  ]);
  assert.equal(await state.storage.get("transfer"), undefined);
  assert.equal(await state.storage.get("mail:source"), undefined);
  assert.equal(state.size(), 0);
});

test("Worker wires one TransferDO per transfer without a byte relay route", async () => {
  const [worker, wrangler] = await Promise.all([
    readFile(new URL("./src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./wrangler.toml", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /env\.TRANSFER\.idFromName\(transferId\)/);
  assert.match(worker, /parsed\.type === "file_prepared"/);
  assert.match(worker, /parsed\.type === "file_signal"/);
  assert.match(wrangler, /name = "TRANSFER"\s+class_name = "TransferDO"/);
  assert.match(wrangler, /tag = "v3"\s+new_sqlite_classes = \["TransferDO"\]/);
  assert.doesNotMatch(worker, /file[-_]transfer[-_](?:upload|download|chunk|bytes)/i);
});

function request(path: string, kind: string, id: string, body: unknown, userId = "account-a") {
  return new Request(`https://transfer${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fleet-user": userId,
      "x-fleet-kid": "kid-a",
      "x-transfer-caller-kind": kind,
      "x-transfer-caller-id": id,
    },
    body: JSON.stringify(body),
  });
}

function fakeState() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let transactionCount = 0;
  let transactionTail = Promise.resolve();
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
    deleteAll: async () => {
      values.clear();
      alarm = null;
    },
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => {
      alarm = value;
    },
    transaction: async <T>(callback: (txn: typeof storage) => Promise<T>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      transactionCount += 1;
      try {
        return await callback(storage);
      } finally {
        release();
      }
    },
  };
  return {
    alarm: () => alarm,
    size: () => values.size,
    transactions: () => transactionCount,
    storage,
  };
}

function fingerprint(hex: string) {
  return Array.from({ length: 32 }, () => `${hex}${hex}`).join(":");
}
