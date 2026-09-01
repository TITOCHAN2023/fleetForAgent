import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPeerSessionTicketStatement,
  canonicalPeerFingerprint,
  PEER_SESSION_CONTROL_MAX_BYTES,
  PEER_SESSION_MAX_ROUNDS,
  PEER_SESSION_PROTOCOL,
  PEER_SESSION_TTL_MS,
  PeerSessionDO,
  readPeerSessionControlText,
  type PeerSessionRecord,
} from "./src/peer-session.ts";
import fleetWorker, {
  DEVICE_WS_TEXT_MAX_BYTES,
  DEVICE_ACTIVE_SESSION_TTL_MS,
  DEVICE_RESULT_TTL_MS,
  DEVICE_STORED_PAYLOAD_MAX_BYTES,
  DeviceDO,
  FLEET_SESSION_IDLE_MS,
  FLEET_SESSION_MAX_AGE_MS,
  FleetDO,
  isTaskPluginAction,
  MCP_HTTP_TOUCH_MS,
  McpDO,
  OAUTH_PENDING_LIMIT,
  OAUTH_PENDING_SOURCE_LIMIT,
  PEER_SESSION_ACCOUNT_LIMIT,
  REVOCATION_FANOUT,
  RevocationDO,
} from "./src/index.ts";
import { handleOAuth } from "./src/oauth.ts";
import { MCP_SESSION_IDLE_MS, MCP_SESSION_MAX_AGE_MS } from "./src/mcp-sse.mjs";

const SESSION = "00000000-0000-4000-8000-000000000001";
const CONNECTION_OLD = "00000000-0000-4000-8000-000000000011";
const CONNECTION_NEW = "00000000-0000-4000-8000-000000000012";

test("peer ticket fingerprint fixture is canonical lowercase hex without separators", () => {
  assert.equal(canonicalPeerFingerprint(sdp("a")), "aa".repeat(32));
  assert.equal(canonicalPeerFingerprint(sdp("b")), "bb".repeat(32));
});

test("task dispatch rejects peer actions while preserving legacy task manifests", () => {
  assert.equal(isTaskPluginAction({ actions: ["run"] }, "run"), true);
  assert.equal(
    isTaskPluginAction(
      {
        runtime: "task",
        actions: ["run"],
        action_specs: { run: { runtime: "task" } },
      },
      "run",
    ),
    true,
  );
  assert.equal(
    isTaskPluginAction(
      {
        runtime: "peer",
        actions: ["source"],
        action_specs: { source: { runtime: "peer", role: "source" } },
      },
      "source",
    ),
    false,
  );
  assert.equal(isTaskPluginAction({ actions: ["run"] }, "missing"), false);
});

test("FleetDO migrates legacy cookie sessions and enforces idle and absolute expiry", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  await seedFleetAccount(state);

  await state.storage.put("sess:legacy", "account-a");
  assert.equal(
    (
      await fleet.resolve(
        new Request("https://fleet/resolve", {
          headers: { cookie: "fleet_session=legacy" },
        }),
      )
    )?.id,
    "account-a",
  );
  assert.deepEqual(state.value<{ userId: string }>("sess:legacy")?.userId, "account-a");
  assert.ok(
    state.keys().some((key) => key.startsWith("~expiry:fleet:index:")),
    "the migrated row must have an alarm index",
  );

  const now = Date.now();
  await state.storage.put("sess:idle", {
    userId: "account-a",
    issuedAt: now - 1_000,
    lastSeenAt: now - FLEET_SESSION_IDLE_MS - 1,
  });
  await state.storage.put("sess:absolute", {
    userId: "account-a",
    issuedAt: now - FLEET_SESSION_MAX_AGE_MS - 1,
    lastSeenAt: now,
  });
  for (const sid of ["idle", "absolute"]) {
    assert.equal(
      await fleet.resolve(
        new Request("https://fleet/resolve", {
          headers: { cookie: `fleet_session=${sid}` },
        }),
      ),
      null,
    );
    assert.equal(state.value(`sess:${sid}`), undefined);
  }
});

test("FleetDO OAuth pending state is bounded, browser-bound, and single-use", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  const oauthState = "s".repeat(43);
  const binding = "b".repeat(43);
  const source = "o".repeat(43);
  const put = await fleet.fetch(
    new Request("https://fleet/oauth-pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: oauthState,
        provider: "google",
        binding_hash: binding,
        source_hash: source,
        exp: Date.now() + 60_000,
      }),
    }),
  );
  assert.equal(put.status, 200);
  assert.equal(
    (
      await fleet.fetch(
        new Request(
          `https://fleet/oauth-pending?state=${oauthState}&binding_hash=${"c".repeat(43)}`,
        ),
      )
    ).status,
    404,
  );
  assert.ok(state.value(`oauth:${oauthState}`), "a forged callback must not consume real state");
  assert.equal(
    (
      await fleet.fetch(
        new Request(`https://fleet/oauth-pending?state=${oauthState}&binding_hash=${binding}`),
      )
    ).status,
    200,
  );
  assert.equal(state.value(`oauth:${oauthState}`), undefined);

  for (let index = 0; index < OAUTH_PENDING_LIMIT; index += 1) {
    await state.storage.put(`oauth:${String(index).padStart(32, "0")}`, {
      provider: "google",
      bindingHash: binding,
      exp: Date.now() + 60_000,
    });
  }
  const full = await fleet.fetch(
    new Request("https://fleet/oauth-pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "n".repeat(43),
        provider: "google",
        binding_hash: binding,
        source_hash: source,
        exp: Date.now() + 60_000,
      }),
    }),
  );
  assert.equal(full.status, 429);
});

test("OAuth pending admission isolates one anonymous source and ignores forged IP headers", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  const oauthEnv = {
    GOOGLE_CLIENT_ID: "client-id",
    FLEET: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => fleet.fetch(request) }),
    },
  } as unknown as Parameters<typeof handleOAuth>[1];

  for (let index = 0; index < OAUTH_PENDING_SOURCE_LIMIT; index += 1) {
    const request = new Request("https://fleet.test/v1/auth/google", {
      headers: { "cf-connecting-ip": `198.51.100.${index + 1}` },
    });
    assert.equal((await handleOAuth(request, oauthEnv))?.status, 302);
  }
  const forgedBypass = await handleOAuth(
    new Request("https://fleet.test/v1/auth/google", {
      headers: { "cf-connecting-ip": "203.0.113.99" },
    }),
    oauthEnv,
  );
  assert.equal(forgedBypass?.status, 503, "a client-set IP header must not create a new bucket");

  const trustedRequest = new Request("https://fleet.test/v1/auth/google", {
    headers: { "cf-connecting-ip": "203.0.113.99" },
  });
  Object.defineProperty(trustedRequest, "cf", { value: { colo: "SIN" } });
  assert.equal((await handleOAuth(trustedRequest, oauthEnv))?.status, 302);
});

test("OAuth admission does not commit state when transactional alarm publication fails", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  await fleet.fetch(new Request("https://fleet/noop"));
  await fleet.alarm();
  state.failNextAlarm();
  const oauthState = "f".repeat(43);
  await assert.rejects(
    fleet.fetch(
      new Request("https://fleet/oauth-pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: oauthState,
          provider: "google",
          binding_hash: "b".repeat(43),
          source_hash: "s".repeat(43),
          exp: Date.now() + 60_000,
        }),
      }),
    ),
    /injected alarm failure/,
  );
  assert.equal(state.value(`oauth:${oauthState}`), undefined);
  assert.equal(state.value(`~expiry:fleet:meta:oauth:${oauthState}`), undefined);
});

test("OAuth start binds state to an HttpOnly callback cookie", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  const oauthEnv = {
    GOOGLE_CLIENT_ID: "client-id",
    FLEET: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => fleet.fetch(request) }),
    },
  } as unknown as Parameters<typeof handleOAuth>[1];
  const started = await handleOAuth(new Request("https://fleet.test/v1/auth/google"), oauthEnv);
  assert.equal(started?.status, 302);
  const location = new URL(started!.headers.get("location")!);
  const oauthState = location.searchParams.get("state")!;
  const setCookie = started!.headers.get("set-cookie")!;
  assert.match(setCookie, new RegExp(`^fleet_oauth_${oauthState}=`));
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
  const cookiePair = setCookie.split(";", 1)[0]!;
  const bindingValue = cookiePair.slice(cookiePair.indexOf("=") + 1);

  const forged = await handleOAuth(
    new Request(`https://fleet.test/v1/auth/callback/google?code=x&state=${oauthState}`),
    oauthEnv,
  );
  assert.equal(forged?.status, 400);
  assert.ok(state.value(`oauth:${oauthState}`), "missing browser cookie must not consume state");
  assert.match(forged!.headers.get("set-cookie") ?? "", /Max-Age=0/);

  const bindingHash = createHash("sha256").update(bindingValue).digest("base64url");
  const consumed = await fleet.fetch(
    new Request(`https://fleet/oauth-pending?state=${oauthState}&binding_hash=${bindingHash}`),
  );
  assert.equal(consumed.status, 200);
  assert.equal(state.value(`oauth:${oauthState}`), undefined);
});

test("FleetDO atomically admits only 32 concurrent peer session reservations", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  const responses = await Promise.all(
    Array.from({ length: PEER_SESSION_ACCOUNT_LIMIT + 1 }, (_, index) =>
      reserve(fleet, "account-a", numberedSession(index + 1)),
    ),
  );
  assert.equal(responses.filter((response) => response.status === 200).length, 32);
  assert.equal(responses.filter((response) => response.status === 429).length, 1);
  const rejected = responses.find((response) => response.status === 429)!;
  const body = (await rejected.json()) as Record<string, unknown>;
  assert.equal(body.code, "PEER_SESSION_LIMIT");
  assert.equal(body.limit, PEER_SESSION_ACCOUNT_LIMIT);
  assert.match(rejected.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
});

test("FleetDO treats concurrent retries of one session as one reservation", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  const retries = await Promise.all(
    Array.from({ length: 16 }, () => reserve(fleet, "account-a", numberedSession(1))),
  );
  assert.ok(retries.every((response) => response.ok));
  const retryBodies = await Promise.all(
    retries.map((response) => response.json() as Promise<{ replay: boolean }>),
  );
  assert.equal(retryBodies.filter((body) => body.replay === false).length, 1);
  assert.equal(retryBodies.filter((body) => body.replay === true).length, 15);
  for (let index = 2; index <= PEER_SESSION_ACCOUNT_LIMIT; index += 1) {
    assert.equal((await reserve(fleet, "account-a", numberedSession(index))).status, 200);
  }
  const retryAtCapacity = await reserve(fleet, "account-a", numberedSession(1));
  assert.equal(retryAtCapacity.status, 200);
  assert.equal(((await retryAtCapacity.json()) as { replay: boolean }).replay, true);
  assert.equal(
    (await reserve(fleet, "account-a", numberedSession(PEER_SESSION_ACCOUNT_LIMIT + 1))).status,
    429,
  );
});

test("FleetDO peer session limits are isolated between accounts", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  for (const account of ["account-a", "account-b"]) {
    const responses = await Promise.all(
      Array.from({ length: PEER_SESSION_ACCOUNT_LIMIT }, (_, index) =>
        reserve(fleet, account, numberedSession(index + 1)),
      ),
    );
    assert.ok(responses.every((response) => response.ok));
  }
  assert.equal((await reserve(fleet, "account-a", numberedSession(33))).status, 429);
  assert.equal((await reserve(fleet, "account-b", numberedSession(33))).status, 429);
});

test("FleetDO refuses an unscoped device list instead of scanning every account", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  const response = await fleet.fetch(new Request("https://fleet/list"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "user required" });
});

test("FleetDO rejects a new device id that would steal an existing alias", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  const upsert = (id: string) =>
    fleet.fetch(
      new Request("https://fleet/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, userId: "account-a", name: id, os: "linux", online: true }),
      }),
    );

  assert.equal((await upsert("device-a")).status, 200);
  assert.equal(
    (
      await fleet.fetch(
        new Request("https://fleet/set-alias", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            user_id: "account-a",
            device_id: "device-a",
            alias: "future-device",
          }),
        }),
      )
    ).status,
    200,
  );
  const stolen = await upsert("future-device");
  assert.equal(stolen.status, 409);
  assert.deepEqual(await stolen.json(), { error: "device id conflicts with alias" });
  assert.equal((await upsert("device-a")).status, 200, "the original device can still reconnect");
});

test("FleetDO claim rejects a revoked kid before creating a catalog row", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  await seedFleetUser(state, "kid-old");

  assert.equal((await claimFleetDevice(fleet, "device-a", "kid-old")).status, 200);
  assert.equal(state.value<{ connectionId?: string }>("d:device-a")?.connectionId, CONNECTION_OLD);
  assert.equal(state.value("udi:account-a:device-a"), "d:device-a");

  await state.storage.put("revoked:kid-old", Date.now());
  const rejected = await claimFleetDevice(fleet, "device-b", "kid-old");
  assert.equal(rejected.status, 401);
  assert.equal(state.value("d:device-b"), undefined);
  assert.equal(state.value("udi:account-a:device-b"), undefined);
});

test("an old connection generation cannot touch or release its replacement", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  await seedFleetUser(state, "kid-old");
  assert.equal((await claimFleetDevice(fleet, "device-a", "kid-old", CONNECTION_OLD)).status, 200);

  assert.equal((await claimFleetDevice(fleet, "device-a", "kid-old", CONNECTION_NEW)).status, 200);
  const staleTouch = await touchFleetDevice(fleet, "device-a", "kid-old", CONNECTION_OLD);
  assert.equal(staleTouch.status, 409);
  assert.deepEqual(await staleTouch.json(), { error: "stale device connection" });
  const stale = await releaseFleetDevice(fleet, "device-a", "kid-old", CONNECTION_OLD);
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), { ok: true, stale: true });
  assert.equal(state.value<{ online: boolean; connectionId: string }>("d:device-a")?.online, true);
  assert.equal(
    state.value<{ online: boolean; connectionId: string }>("d:device-a")?.connectionId,
    CONNECTION_NEW,
  );

  const current = await releaseFleetDevice(fleet, "device-a", "kid-old", CONNECTION_NEW);
  assert.deepEqual(await current.json(), { ok: true, stale: false });
  assert.equal(state.value<{ online: boolean }>("d:device-a")?.online, false);
});

test("same-account token resets serialize and revoke the token minted by the prior reset", async () => {
  const state = fakeState();
  await seedFleetAccount(state);
  let releaseFirst!: () => void;
  let noteFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    noteFirst = resolve;
  });
  const roots: Array<Record<string, unknown>> = [];
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {
      HUB_ORIGIN: "https://fleet.example",
      REVOCATION: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async (request: Request) => {
            roots.push((await request.json()) as Record<string, unknown>);
            if (roots.length === 1) {
              noteFirst();
              await firstGate;
            }
            return Response.json({ ok: true });
          },
        }),
      },
    } as unknown as ConstructorParameters<typeof FleetDO>[1],
  );
  fleet.list = async () => [
    { id: "device-a", name: "device-a", os: "linux", online: true, lastSeen: 1 },
  ];
  const issue = () =>
    fleet.fetch(
      new Request("https://fleet/token-issue?user=account-a&aud=https%3A%2F%2Ffleet.example", {
        method: "POST",
      }),
    );

  const first = issue();
  await firstStarted;
  const second = issue();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(roots.length, 1, "the second reset must wait before reading or kicking");
  releaseFirst();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(roots.length, 2);
  assert.ok((roots[1]!.revocation as { kid?: string } | null)?.kid);

  const firstToken = ((await firstResponse.json()) as { token: string }).token;
  const secondToken = ((await secondResponse.json()) as { token: string }).token;
  assert.equal((await resolveFleetBearer(fleet, firstToken)).status, 401);
  assert.equal((await resolveFleetBearer(fleet, secondToken)).status, 200);
});

test("ban waits for an in-flight reset and remains authoritative", async () => {
  const state = fakeState({ cloneReads: true });
  await seedFleetAccount(state);
  let releaseKick!: () => void;
  let noteKick!: () => void;
  const kickGate = new Promise<void>((resolve) => {
    releaseKick = resolve;
  });
  const kickStarted = new Promise<void>((resolve) => {
    noteKick = resolve;
  });
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {
      HUB_ORIGIN: "https://fleet.example",
      REVOCATION: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async () => {
            noteKick();
            await kickGate;
            return Response.json({ ok: true });
          },
        }),
      },
    } as unknown as ConstructorParameters<typeof FleetDO>[1],
  );
  fleet.list = async () => [
    { id: "device-a", name: "device-a", os: "linux", online: true, lastSeen: 1 },
  ];

  const reset = fleet.fetch(
    new Request("https://fleet/token-issue?user=account-a&aud=https%3A%2F%2Ffleet.example", {
      method: "POST",
    }),
  );
  await kickStarted;
  let banSettled = false;
  const ban = fleet.setUserBanned("account-a", true).then((row) => {
    banSettled = true;
    return row;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(banSettled, false, "ban must queue behind the account mutation already in flight");

  releaseKick();
  const resetResponse = await reset;
  assert.equal(resetResponse.status, 200);
  const issuedToken = ((await resetResponse.json()) as { token: string }).token;
  assert.deepEqual(await ban, {
    id: "account-a",
    banned: true,
    bannedAt: state.value<{ bannedAt: number }>("u:account-a@example.test")?.bannedAt,
  });
  assert.equal(state.value<{ banned?: boolean }>("u:account-a@example.test")?.banned, true);
  assert.equal((await resolveFleetBearer(fleet, issuedToken)).status, 403);

  const rejected = await fleet.fetch(
    new Request("https://fleet/token-issue?user=account-a&aud=https%3A%2F%2Ffleet.example", {
      method: "POST",
    }),
  );
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "banned" });
});

test("FleetDO delegates an unbounded account catalog through one revocation root", async () => {
  const roots: Array<Record<string, unknown>> = [];
  const fleet = new FleetDO(
    fakeState() as unknown as DurableObjectState,
    {
      REVOCATION: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async (request: Request) => {
            roots.push((await request.json()) as Record<string, unknown>);
            return Response.json({ ok: true });
          },
        }),
      },
    } as unknown as ConstructorParameters<typeof FleetDO>[1],
  );
  fleet.list = async () =>
    Array.from({ length: 2_050 }, (_, index) => ({
      id: `device-${String(index + 1).padStart(2, "0")}`,
      name: "device",
      os: "linux",
      online: index !== 2_049,
      lastSeen: 1,
    }));

  await fleet.kickUserDevices("account-a", {
    kid: "kid-old",
    statement: { payload: "payload", sig: "sig" },
  });
  assert.equal(roots.length, 1, "FleetDO must spend one subrequest regardless of fleet size");
  assert.equal((roots[0]!.devices as string[]).length, 2_050);
  assert.equal((roots[0]!.devices as string[]).includes("device-2050"), true);
});

test("RevocationDO recursively bounds fanout and attempts every catalog DeviceDO", async () => {
  const attempted: string[] = [];
  const children: string[] = [];
  const env = revocationEnv(attempted, children, "device-001");
  const root = new RevocationDO(
    {} as DurableObjectState,
    env as unknown as ConstructorParameters<typeof RevocationDO>[1],
  );
  const devices = Array.from(
    { length: REVOCATION_FANOUT * 2 + 1 },
    (_, index) => `device-${String(index + 1).padStart(3, "0")}`,
  );
  const legacyZeroWidth = "legacy\u200bdevice";
  const legacyLong = "legacy-" + "x".repeat(300);
  devices.push(legacyZeroWidth, legacyLong);
  const response = await root.fetch(
    new Request("https://revocation/kick-tree", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ devices, job: "job-1", node: "root", revocation: { kid: "old" } }),
    }),
  );
  assert.equal(response.status, 500, "one failed leaf must fail the entire reset");
  assert.deepEqual(new Set(attempted), new Set(devices));
  assert.ok(attempted.includes(legacyZeroWidth), "legacy ID must reach its exact DeviceDO name");
  assert.ok(attempted.includes(legacyLong), "legacy long ID must not poison the whole batch");
  assert.ok(children.length > 0, "a batch larger than the leaf fanout must recurse");
  const firstLevel = children.filter((name) => /^job-1:root\.\d+$/.test(name));
  assert.ok(firstLevel.length <= REVOCATION_FANOUT);
});

test("FleetDO prunes expired reservations at the PeerSession TTL boundary", async () => {
  const state = fakeState();
  const fleet = new FleetDO(
    state as unknown as DurableObjectState,
    {} as ConstructorParameters<typeof FleetDO>[1],
  );
  assert.equal((await reserve(fleet, "account-a", numberedSession(1))).status, 200);
  const key = "peer-session-reservations:account-a";
  const stored = state.value<Array<{ sessionId: string; expiresAt: number }>>(key)!;
  stored[0]!.expiresAt = Date.now();
  await state.storage.put(key, stored);

  const responses = await Promise.all(
    Array.from({ length: PEER_SESSION_ACCOUNT_LIMIT }, (_, index) =>
      reserve(fleet, "account-a", numberedSession(index + 2)),
    ),
  );
  assert.ok(responses.every((response) => response.ok));
  assert.equal((await reserve(fleet, "account-a", numberedSession(34))).status, 429);
  assert.equal(state.value<Array<unknown>>(key)?.length, PEER_SESSION_ACCOUNT_LIMIT);
});

test("Streamable HTTP MCP preserves the Hub key when creating a device peer session", async () => {
  const state = fakeMcpState();
  const peerCalls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const control = new McpDO(
    state as unknown as DurableObjectState,
    mcpPeerEnv(peerCalls) as unknown as ConstructorParameters<typeof McpDO>[1],
  );
  const opened = await control.fetch(
    new Request("https://mcp/http-open", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fleet-actor": "account-a",
        "x-fleet-kid": "kid-a",
      },
      body: JSON.stringify(initializeMessage(1)),
    }),
  );
  assert.equal(opened.status, 200);
  const called = await control.fetch(
    new Request("https://mcp/http-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(startTransferMessage(2)),
    }),
  );
  assert.equal(called.status, 200);
  const calledBody = (await called.json()) as { error?: unknown };
  assert.equal(calledBody.error, undefined, JSON.stringify(calledBody));
  assert.equal(peerCalls.length, 1);
  assert.equal(peerCalls[0]!.headers.get("x-fleet-user"), "account-a");
  assert.equal(peerCalls[0]!.headers.get("x-fleet-kid"), "kid-a");
});

test("Streamable HTTP MCP alarm deletes an abandoned durable session", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const state = fakeMcpState();
    const control = new McpDO(
      state as unknown as DurableObjectState,
      mcpPeerEnv([]) as unknown as ConstructorParameters<typeof McpDO>[1],
    );
    const opened = await control.fetch(
      new Request("https://mcp/http-open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-actor": "account-a",
          "x-fleet-kid": "kid-a",
        },
        body: JSON.stringify(initializeMessage(1)),
      }),
    );
    assert.equal(opened.status, 200);
    assert.ok(state.value("http:session"));
    assert.equal(state.alarm(), now + MCP_SESSION_IDLE_MS + MCP_HTTP_TOUCH_MS);

    now += MCP_SESSION_IDLE_MS + MCP_HTTP_TOUCH_MS;
    await control.alarm();
    assert.equal(state.value("http:session"), undefined);
    assert.equal(state.alarm(), null);
  } finally {
    Date.now = realNow;
  }
});

test("Streamable HTTP MCP coalesces meaningful touches and never persists ping notifications", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const state = fakeMcpState();
    const control = new McpDO(
      state as unknown as DurableObjectState,
      mcpPeerEnv([]) as unknown as ConstructorParameters<typeof McpDO>[1],
    );
    await control.fetch(
      new Request("https://mcp/http-open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-actor": "account-a",
          "x-fleet-kid": "kid-a",
        },
        body: JSON.stringify(initializeMessage(1)),
      }),
    );
    const baseline = state.counts();
    for (const message of [
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]) {
      await control.fetch(
        new Request("https://mcp/http-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        }),
      );
    }
    assert.deepEqual(state.counts(), baseline);

    now += MCP_HTTP_TOUCH_MS - 1;
    await control.fetch(
      new Request("https://mcp/http-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      }),
    );
    assert.deepEqual(state.counts(), baseline, "touches inside the window must stay in memory");

    now += 1;
    await control.fetch(
      new Request("https://mcp/http-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      }),
    );
    assert.deepEqual(state.counts(), {
      puts: baseline.puts + 1,
      alarmWrites: baseline.alarmWrites + 1,
    });
  } finally {
    Date.now = realNow;
  }
});

test("Streamable HTTP MCP idle alarm defers while meaningful dispatch is in flight", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const state = fakeMcpState();
    const control = new McpDO(
      state as unknown as DurableObjectState,
      mcpPeerEnv([]) as unknown as ConstructorParameters<typeof McpDO>[1],
    );
    await control.fetch(
      new Request("https://mcp/http-open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-actor": "account-a",
          "x-fleet-kid": "kid-a",
        },
        body: JSON.stringify(initializeMessage(1)),
      }),
    );

    let releaseSecond!: () => void;
    let markEntered!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const secondControl = new McpDO(
      state as unknown as DurableObjectState,
      mcpPeerEnv([], {
        validateMcp: () => {
          markEntered();
          return secondGate;
        },
      }) as unknown as ConstructorParameters<typeof McpDO>[1],
    );
    now += MCP_SESSION_IDLE_MS + MCP_HTTP_TOUCH_MS - 1;
    const pending = secondControl.fetch(
      new Request("https://mcp/http-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );
    await entered;
    now += 1;
    await secondControl.alarm();
    assert.ok(state.value("http:session"), "idle alarm must not delete an executing request");
    releaseSecond();
    assert.equal((await pending).status, 200);
    assert.ok(state.value("http:session"));
  } finally {
    Date.now = realNow;
  }
});

test("Streamable HTTP MCP absolute max-age hard-cuts an in-flight dispatch", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const state = fakeMcpState();
    const control = new McpDO(
      state as unknown as DurableObjectState,
      mcpPeerEnv([]) as unknown as ConstructorParameters<typeof McpDO>[1],
    );
    const open = control.fetch(
      new Request("https://mcp/http-open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-actor": "account-a",
          "x-fleet-kid": "kid-a",
        },
        body: JSON.stringify(initializeMessage(1)),
      }),
    );
    await open;

    let releaseSecond!: () => void;
    let markEntered!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const secondControl = new McpDO(
      state as unknown as DurableObjectState,
      mcpPeerEnv([], {
        validateMcp: () => {
          markEntered();
          return secondGate;
        },
      }) as unknown as ConstructorParameters<typeof McpDO>[1],
    );
    now += MCP_SESSION_MAX_AGE_MS - 1;
    const stored = state.value<{ lastActivityAt: number }>("http:session")!;
    stored.lastActivityAt = now;
    await state.storage.put("http:session", stored);
    const pending = secondControl.fetch(
      new Request("https://mcp/http-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );
    await entered;
    now += 1;
    await secondControl.alarm();
    assert.equal(state.value("http:session"), undefined);
    releaseSecond();
    await pending;
    assert.equal(
      state.value("http:session"),
      undefined,
      "completion must not resurrect the session",
    );
  } finally {
    Date.now = realNow;
  }
});

test("MCP reservation failure blocks create and lookup before touching PeerSessionDO", async () => {
  const state = fakeMcpState();
  const peerCalls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const order: string[] = [];
  const control = new McpDO(
    state as unknown as DurableObjectState,
    mcpPeerEnv(peerCalls, { rejectReservation: true, order }) as unknown as ConstructorParameters<
      typeof McpDO
    >[1],
  );
  assert.equal(
    (
      await control.fetch(
        new Request("https://mcp/http-open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fleet-actor": "account-a",
            "x-fleet-kid": "kid-a",
          },
          body: JSON.stringify(initializeMessage(1)),
        }),
      )
    ).status,
    200,
  );
  for (const message of [startTransferMessage(2), getTransferMessage(3)]) {
    const called = await control.fetch(
      new Request("https://mcp/http-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      }),
    );
    const body = (await called.json()) as { error?: { message?: string } };
    assert.equal(called.status, 200);
    assert.match(body.error?.message ?? "", /too many peer sessions/);
  }
  assert.deepEqual(order, ["reserve", "reserve"]);
  assert.equal(peerCalls.length, 0);
});

test("classic SSE MCP preserves the Hub key when creating a device peer session", async () => {
  const state = fakeMcpState();
  const peerCalls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const control = new McpDO(
    state as unknown as DurableObjectState,
    mcpPeerEnv(peerCalls) as unknown as ConstructorParameters<typeof McpDO>[1],
  );
  const stream = await control.fetch(
    new Request("https://mcp/open?sessionId=00000000-0000-4000-8000-000000000099", {
      headers: { "x-fleet-actor": "account-a", "x-fleet-kid": "kid-a" },
    }),
  );
  assert.equal(stream.status, 200);
  try {
    const accepted = await control.fetch(
      new Request("https://mcp/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startTransferMessage(2)),
      }),
    );
    assert.equal(accepted.status, 202);
    await state.drain();
    assert.equal(peerCalls.length, 1);
    assert.equal(peerCalls[0]!.headers.get("x-fleet-user"), "account-a");
    assert.equal(peerCalls[0]!.headers.get("x-fleet-kid"), "kid-a");
  } finally {
    await stream.body?.cancel();
  }
});

test("device WebSocket rejects oversized text before JSON parsing or forwarding", async () => {
  const closed: Array<[number, string]> = [];
  const device = fakeDeviceDO();
  await device.webSocketMessage(
    {
      close: (code: number, reason: string) => closed.push([code, reason]),
    } as unknown as WebSocket,
    "x".repeat(DEVICE_WS_TEXT_MAX_BYTES + 1),
  );
  assert.deepEqual(closed, [[1009, "frame too large"]]);
});

test("DeviceDO moves completed ownership into the short-lived result and GC removes every trace", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { device, state } = fakeDeviceHarness();
    const ws = {
      deserializeAttachment: () => ({}),
      send() {},
      close() {},
    } as unknown as WebSocket;
    const corr = "corr-complete";
    await device.webSocketMessage(
      ws,
      JSON.stringify({
        v: 1,
        type: "rtc_claim",
        id: "claim",
        corr,
        t: now,
        body: { sid: SESSION, operator_id: "operator-a" },
      }),
    );
    await device.webSocketMessage(
      ws,
      JSON.stringify({
        v: 1,
        type: "screen",
        id: "screen",
        corr,
        t: now,
        body: { text: "private screen" },
      }),
    );
    await device.webSocketMessage(
      ws,
      JSON.stringify({
        v: 1,
        type: "result",
        id: "result",
        corr,
        t: now,
        body: { ok: true, exit_code: 0, stdout: "done" },
      }),
    );

    assert.equal(
      state.value(`own:${corr}`),
      undefined,
      "completed ownership must not leak separately",
    );
    assert.equal(state.value("alive:operator-a"), undefined);
    assert.equal(state.value<Record<string, unknown>>(`res:${corr}`)?.__fleet_owner, "operator-a");
    assert.equal(
      state.value("screen:last"),
      undefined,
      "the unused global screen copy is forbidden",
    );
    const foreign = await device.fetch(
      new Request(`https://device/result?corr=${corr}`, {
        headers: { "X-Fleet-Operator": "operator-b" },
      }),
    );
    assert.deepEqual(await foreign.json(), { status: "pending" });
    const response = await device.fetch(
      new Request(`https://device/result?corr=${corr}`, {
        headers: { "X-Fleet-Operator": "operator-a" },
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.stdout, "done");
    assert.equal(body.__fleet_owner, undefined, "internal ownership must never cross the API");

    now += DEVICE_RESULT_TTL_MS + 1;
    await device.alarm();
    for (const key of [
      `res:${corr}`,
      `screen:${corr}`,
      "live:operator-a",
      `own:${corr}`,
      "alive:operator-a",
    ]) {
      assert.equal(state.value(key), undefined, `${key} must expire`);
    }
  } finally {
    Date.now = realNow;
  }
});

test("DeviceDO expires abandoned correlation ownership and live pointers", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { device, state } = fakeDeviceHarness();
    await device.webSocketMessage(
      { deserializeAttachment: () => ({}) } as unknown as WebSocket,
      JSON.stringify({
        v: 1,
        type: "rtc_claim",
        id: "claim",
        corr: "corr-abandoned",
        t: now,
        body: { sid: SESSION, operator_id: "operator-a" },
      }),
    );
    assert.equal(state.value("own:corr-abandoned"), "operator-a");
    assert.equal(state.value("live:operator-a"), "corr-abandoned");
    assert.deepEqual(state.value("alive:operator-a"), ["corr-abandoned"]);

    now += DEVICE_ACTIVE_SESSION_TTL_MS + 1;
    await device.alarm();
    assert.equal(state.value("own:corr-abandoned"), undefined);
    assert.equal(state.value("live:operator-a"), undefined);
    assert.equal(state.value("alive:operator-a"), undefined);
  } finally {
    Date.now = realNow;
  }
});

test("DeviceDO alarm adopts and expires rows written by pre-TTL Workers", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { device, state } = fakeDeviceHarness();
    await state.storage.put("res:legacy", { ok: true, exit_code: 0, stdout: "old" });
    await state.storage.put("screen:legacy", { text: "old screen" });
    await state.storage.put("own:legacy", "operator-a");
    await state.storage.put("live:operator-a", "legacy");
    await state.storage.put("alive:operator-a", ["legacy"]);
    await state.storage.put(`rtc:${SESSION}`, { exp: now + 60_000 });

    await device.fetch(new Request("https://device/noop"));
    await device.alarm();
    for (const key of [
      "res:legacy",
      "screen:legacy",
      "own:legacy",
      "live:operator-a",
      "alive:operator-a",
      `rtc:${SESSION}`,
    ]) {
      assert.ok(
        state.keys().includes(`~expiry:device:meta:${key}`),
        `${key} must receive a legacy expiry index`,
      );
    }

    now += DEVICE_ACTIVE_SESSION_TTL_MS + 1;
    await device.alarm();
    for (const key of [
      "res:legacy",
      "screen:legacy",
      "own:legacy",
      "live:operator-a",
      "alive:operator-a",
      `rtc:${SESSION}`,
    ]) {
      assert.equal(state.value(key), undefined, `${key} must be collected`);
    }
  } finally {
    Date.now = realNow;
  }
});

test("DeviceDO periodically reconciles legacy rows created after the first migration pass", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { device, state } = fakeDeviceHarness();
    await device.fetch(new Request("https://device/noop"));
    await device.alarm();
    assert.ok((state.alarm() ?? 0) > now, "an empty pass must retain a reconcile alarm");

    await state.storage.put("screen:late-legacy", { text: "late" });
    assert.equal(state.value("~expiry:device:meta:screen:late-legacy"), undefined);
    now = state.alarm()!;
    await device.alarm();
    assert.ok(
      state.value("~expiry:device:meta:screen:late-legacy"),
      "a legacy row written by an older Worker version must eventually be indexed",
    );
  } finally {
    Date.now = realNow;
  }
});

test("DeviceDO expiry row and alarm publication fail atomically", async () => {
  const { device, state } = fakeDeviceHarness();
  await device.fetch(new Request("https://device/noop"));
  await device.alarm();
  state.failNextAlarm();
  await assert.rejects(
    device.webSocketMessage(
      { deserializeAttachment: () => ({}) } as unknown as WebSocket,
      JSON.stringify({
        v: 1,
        type: "screen",
        id: "screen",
        corr: "alarm-failure",
        t: Date.now(),
        body: { text: "must not commit" },
      }),
    ),
    /injected alarm failure/,
  );
  assert.equal(state.value("screen:alarm-failure"), undefined);
  assert.equal(state.value("~expiry:device:meta:screen:alarm-failure"), undefined);
  assert.equal(
    state.keys().some((key) => key.includes(":alarm-failure")),
    false,
  );
});

test("DeviceDO degrades an oversized command result instead of throwing from storage", async () => {
  const { device, state } = fakeDeviceHarness();
  const ws = { deserializeAttachment: () => ({}) } as unknown as WebSocket;
  const corr = "corr-large";
  await device.webSocketMessage(
    ws,
    JSON.stringify({
      v: 1,
      type: "rtc_claim",
      id: "claim",
      corr,
      t: Date.now(),
      body: { sid: SESSION, operator_id: "operator-a" },
    }),
  );
  await device.webSocketMessage(
    ws,
    JSON.stringify({
      v: 1,
      type: "result",
      id: "result",
      corr,
      t: Date.now(),
      body: {
        ok: true,
        exit_code: 0,
        stdout: "x".repeat(DEVICE_STORED_PAYLOAD_MAX_BYTES + 1),
      },
    }),
  );
  const stored = state.value<Record<string, unknown>>(`res:${corr}`)!;
  assert.equal(stored.code, "STORED_PAYLOAD_TOO_LARGE");
  assert.equal(stored.truncated, true);
  assert.equal(stored.stdout, "");
  assert.ok(JSON.stringify(stored).length < 2_000);
  const response = await device.fetch(
    new Request(`https://device/result?corr=${corr}`, {
      headers: { "X-Fleet-Operator": "operator-a" },
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "done");
  assert.equal(body.code, "STORED_PAYLOAD_TOO_LARGE");
  assert.equal(body.__fleet_owner, undefined);
});

test("DeviceDO screen snapshots overwrite in place without rebuilding expiry on every frame", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { device, state } = fakeDeviceHarness();
    const ws = { deserializeAttachment: () => ({}) } as unknown as WebSocket;
    const frame = (text: string) =>
      JSON.stringify({
        v: 1,
        type: "screen",
        id: text,
        corr: "corr-screen",
        t: now,
        body: { text },
      });
    await device.webSocketMessage(ws, frame("one"));
    const firstMeta = structuredClone(
      state.value<{ expiresAt: number; indexKey: string }>(
        "~expiry:device:meta:screen:corr-screen",
      ),
    );
    now += 1_000;
    await device.webSocketMessage(ws, frame("two"));
    assert.deepEqual(state.value("~expiry:device:meta:screen:corr-screen"), firstMeta);
    assert.deepEqual(state.value("screen:corr-screen"), { text: "two" });
    assert.equal(state.keys().filter((key) => key.startsWith("~expiry:device:index:")).length, 1);
    assert.equal(state.value("screen:last"), undefined);
  } finally {
    Date.now = realNow;
  }
});

test("DeviceDO expires successful RTC signaling without waiting for rtc_closed", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const sent: string[] = [];
    const socket = {
      deserializeAttachment: () => ({
        userId: "account-a",
        kid: "kid-a",
        deviceId: "device-a",
        caps: ["rtc_v1"],
      }),
      send: (value: string) => sent.push(value),
    } as unknown as WebSocket;
    const { device, state } = fakeDeviceHarness([socket]);
    const response = await device.fetch(
      new Request("https://device/rtc-offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sid: SESSION,
          offer: sdp("a"),
          user_id: "account-a",
          kid: "kid-a",
          device_id: "device-a",
          operator_id: "operator-a",
        }),
      }),
    );
    assert.equal(response.status, 200);
    assert.ok(state.value(`rtc:${SESSION}`));
    assert.equal(sent.length, 1);

    now += 60_001;
    await device.alarm();
    assert.equal(state.value(`rtc:${SESSION}`), undefined);
  } finally {
    Date.now = realNow;
  }
});

test("DeviceDO kick closes every socket when an auth_revoked send fails", async () => {
  const events: string[] = [];
  const sockets = [
    {
      send: () => {
        events.push("send:first");
        throw new Error("stale socket");
      },
      close: (code: number, reason: string) => events.push(`close:first:${code}:${reason}`),
    },
    {
      send: () => events.push("send:second"),
      close: (code: number, reason: string) => events.push(`close:second:${code}:${reason}`),
    },
  ] as unknown as WebSocket[];
  const response = await fakeDeviceDO(sockets).fetch(
    new Request("https://device/kick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kid: "kid-old",
        statement: { payload: "payload", sig: "sig" },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, [
    "send:first",
    "close:first:1008:token reset",
    "send:second",
    "close:second:1008:token reset",
  ]);
});

test("DeviceDO kick reports a close failure only after trying every socket", async () => {
  const closed: string[] = [];
  const sockets = [
    {
      send() {},
      close: () => {
        closed.push("first");
        throw new Error("close failed");
      },
    },
    {
      send() {},
      close: () => closed.push("second"),
    },
  ] as unknown as WebSocket[];
  const response = await fakeDeviceDO(sockets).fetch(
    new Request("https://device/kick", { method: "POST", body: "{}" }),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "device revocation incomplete" });
  assert.deepEqual(closed, ["first", "second"]);
});

test("a kick that wins while claim is pending prevents the old kid from accepting later", async () => {
  let claimStarted!: () => void;
  let resolveClaim!: () => void;
  const started = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  const claimGate = new Promise<void>((resolve) => {
    resolveClaim = resolve;
  });
  const paths: string[] = [];
  const device = fakeDeviceDO([], {
    FLEET: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/claim-device") {
            claimStarted();
            await claimGate;
          }
          return Response.json({ ok: true });
        },
      }),
    },
  } as unknown as ConstructorParameters<typeof DeviceDO>[1]);

  const connecting = device.fetch(
    new Request("https://device/socket?id=device-a", {
      headers: {
        Upgrade: "websocket",
        "x-fleet-user": "account-a",
        "x-fleet-kid": "kid-old",
      },
    }),
  );
  await started;
  assert.equal(
    (
      await device.fetch(
        new Request("https://device/kick", {
          method: "POST",
          body: JSON.stringify({ kid: "kid-old" }),
        }),
      )
    ).status,
    200,
  );
  resolveClaim();
  const response = await connecting;
  assert.equal(response.status, 401);
  assert.deepEqual(paths, ["/claim-device", "/release-device"]);
});

test("device WebSocket rejects cookie actors and arbitrary Bearer credentials before allocating a DeviceDO", async () => {
  let deviceGets = 0;
  const retiredSharedSecretName = ["HUB", "TOKEN"].join("_");
  const testEnv = {
    [retiredSharedSecretName]: "arbitrary-shared-secret",
    FLEET: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) =>
          new URL(request.url).pathname === "/resolve"
            ? Response.json({ id: "account-a" })
            : Response.json({}),
      }),
    },
    DEVICE: {
      idFromName: (name: string) => name,
      get: () => {
        deviceGets += 1;
        return { fetch: async () => Response.json({}) };
      },
    },
  } as unknown as Parameters<typeof fleetWorker.fetch>[1];
  const bearerResponse = await fleetWorker.fetch(
    new Request("https://fleet.test/v1/device?id=device-a", {
      headers: { authorization: "Bearer arbitrary-shared-secret", upgrade: "websocket" },
    }),
    testEnv,
  );
  const listResponse = await fleetWorker.fetch(
    new Request("https://fleet.test/v1/list_computers", {
      method: "POST",
      headers: { authorization: "Bearer arbitrary-shared-secret" },
      body: "{}",
    }),
    testEnv,
  );
  const loginResponse = await fleetWorker.fetch(
    new Request("https://fleet.test/v1/device?id=device-a", {
      headers: { cookie: "fleet_session=session-a", upgrade: "websocket" },
    }),
    testEnv,
  );
  assert.equal(bearerResponse.status, 401);
  assert.equal(
    listResponse.status,
    401,
    "a retired deployment secret must not regain super access",
  );
  assert.equal(loginResponse.status, 401);
  assert.equal(deviceGets, 0, "missing per-account kid must not allocate a DeviceDO");

  const device = fakeDeviceDO();
  const defenseInDepth = await device.fetch(
    new Request("https://device.test/?id=device-a", {
      headers: { upgrade: "websocket", "x-fleet-user": "account-a" },
    }),
  );
  assert.equal(defenseInDepth.status, 401);
});

test("Worker scopes every Fleet-OAEP device listing to the resolved account", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fleet = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const body =
        request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
      requests.push({ url: `${url.pathname}${url.search}`, body });
      if (url.pathname === "/resolve-wrap") {
        return Response.json({ id: "account-a", kid: "kid-a" });
      }
      if (url.pathname === "/validate-mcp") return Response.json({ ok: true });
      if (url.pathname === "/list") return Response.json({ computers: [] });
      return Response.json({ error: "unexpected test request" }, { status: 500 });
    },
  };
  const testEnv = {
    FLEET: {
      idFromName: (name: string) => name,
      get: () => fleet,
    },
  } as unknown as Parameters<typeof fleetWorker.fetch>[1];

  const response = await fleetWorker.fetch(
    new Request("https://fleet.test/v1/list_computers", {
      method: "POST",
      headers: { authorization: "Fleet-OAEP kid-a.wrap-a" },
      body: "{}",
    }),
    testEnv,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(requests, [
    { url: "/resolve-wrap", body: { kid: "kid-a", wrap: "wrap-a" } },
    { url: "/validate-mcp", body: { id: "account-a", kid: "kid-a" } },
    { url: "/list?user=account-a", body: undefined },
  ]);
});

test("Worker resolves an account alias to the immutable id before dispatching", async () => {
  const deviceGets: string[] = [];
  const fleet = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/resolve-wrap") {
        return Response.json({ id: "account-a", kid: "kid-a" });
      }
      if (url.pathname === "/validate-mcp") return Response.json({ ok: true });
      if (url.pathname === "/resolve-device") {
        assert.equal(url.searchParams.get("user"), "account-a");
        assert.equal(url.searchParams.get("ref"), "Singapore 128GB");
        return Response.json({
          id: "device-real",
          alias: "Singapore 128GB",
          name: "n251-234-193",
          os: "linux",
          online: true,
          lastSeen: 1,
          userId: "account-a",
        });
      }
      return Response.json({ error: "unexpected test request" }, { status: 500 });
    },
  };
  const testEnv = {
    FLEET: { idFromName: (name: string) => name, get: () => fleet },
    DEVICE: {
      idFromName: (id: string) => id,
      get: (id: string) => {
        deviceGets.push(id);
        return {
          fetch: async (request: Request) => {
            assert.equal(new URL(request.url).pathname, "/run");
            return Response.json({ corr: "corr-a", status: "running" });
          },
        };
      },
    },
  } as unknown as Parameters<typeof fleetWorker.fetch>[1];

  const response = await fleetWorker.fetch(
    new Request("https://fleet.test/v1/run", {
      method: "POST",
      headers: {
        authorization: "Fleet-OAEP kid-a.wrap-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ device_id: "Singapore 128GB", command: "pwd" }),
    }),
    testEnv,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(deviceGets, ["device-real"]);
});

test("Worker binds alias changes to the authenticated account", async () => {
  const writes: unknown[] = [];
  const fleet = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/resolve-wrap") {
        return Response.json({ id: "account-a", kid: "kid-a" });
      }
      if (url.pathname === "/validate-mcp") return Response.json({ ok: true });
      if (url.pathname === "/set-alias") {
        writes.push(await request.json());
        return Response.json({ id: "device-real", alias: "Build Box" });
      }
      return Response.json({ error: "unexpected test request" }, { status: 500 });
    },
  };
  const testEnv = {
    FLEET: { idFromName: (name: string) => name, get: () => fleet },
  } as unknown as Parameters<typeof fleetWorker.fetch>[1];

  const response = await fleetWorker.fetch(
    new Request("https://fleet.test/v1/set_computer_alias", {
      method: "POST",
      headers: {
        authorization: "Fleet-OAEP kid-a.wrap-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_id: "account-b", device_id: "device-real", alias: "Build Box" }),
    }),
    testEnv,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(writes, [
    { user_id: "account-a", device_id: "device-real", alias: "Build Box" },
  ]);
});

test("a delayed old-token body is revalidated after reset before device dispatch", async () => {
  let releaseBody!: () => void;
  let noteResolved!: () => void;
  const resolved = new Promise<void>((resolve) => {
    noteResolved = resolve;
  });
  let currentKid = "kid-old";
  let deviceGets = 0;
  const fleet = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/resolve-wrap") {
        noteResolved();
        return Response.json({ id: "account-a", kid: "kid-old" });
      }
      if (url.pathname === "/validate-mcp") {
        const body = (await request.json()) as { id?: string; kid?: string };
        return body.id === "account-a" && body.kid === currentKid
          ? Response.json({ ok: true })
          : Response.json({ error: "Hub token was reset or revoked" }, { status: 401 });
      }
      if (url.pathname === "/resolve-device") {
        return Response.json({
          id: "device-real",
          name: "device-real",
          os: "linux",
          online: true,
          lastSeen: 1,
          userId: "account-a",
        });
      }
      return Response.json({ error: "unexpected test request" }, { status: 500 });
    },
  };
  const testEnv = {
    FLEET: { idFromName: (name: string) => name, get: () => fleet },
    DEVICE: {
      idFromName: (id: string) => id,
      get: () => {
        deviceGets += 1;
        return { fetch: async () => Response.json({ corr: "bad", status: "running" }) };
      },
    },
  } as unknown as Parameters<typeof fleetWorker.fetch>[1];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      releaseBody = () => {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ device_id: "device-real", command: "pwd" })),
        );
        controller.close();
      };
    },
  });
  const request = new Request("https://fleet.test/v1/run", {
    method: "POST",
    headers: {
      authorization: "Fleet-OAEP kid-old.wrap-old",
      "content-type": "application/json",
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const running = fleetWorker.fetch(request, testEnv);
  await resolved;
  currentKid = "kid-new";
  releaseBody();
  const response = await running;
  assert.equal(response.status, 401);
  assert.equal(deviceGets, 0);
});

test("a non-admin ops request is rejected before the global catalog is read", async () => {
  const paths: string[] = [];
  const fleet = {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/resolve") {
        return Response.json({ id: "account-a", email: "user@example.com" });
      }
      return Response.json({ error: "unexpected test request" }, { status: 500 });
    },
  };
  const testEnv = {
    ADMIN_EMAILS: "ops@example.com",
    FLEET: {
      idFromName: (name: string) => name,
      get: () => fleet,
    },
  } as unknown as Parameters<typeof fleetWorker.fetch>[1];

  const response = await fleetWorker.fetch(
    new Request("https://fleet.test/v1/ops/overview", {
      headers: { cookie: "fleet_session=session-a" },
    }),
    testEnv,
  );

  assert.equal(response.status, 404);
  assert.deepEqual(paths, ["/resolve"]);
});

test("device WebSocket rejects oversized peer control before touching its session", async () => {
  const closed: Array<[number, string]> = [];
  const device = fakeDeviceDO();
  await device.webSocketMessage(
    {
      close: (code: number, reason: string) => closed.push([code, reason]),
    } as unknown as WebSocket,
    JSON.stringify({
      v: 1,
      type: "peer_session_signal",
      body: { padding: "x".repeat(PEER_SESSION_CONTROL_MAX_BYTES) },
    }),
  );
  assert.deepEqual(closed, [[1009, "peer control frame too large"]]);
});

test("device WebSocket rejects non-object envelopes without throwing", async () => {
  for (const message of [
    "null",
    JSON.stringify({ v: 1, type: "peer_session_event", body: null }),
  ]) {
    const closed: Array<[number, string]> = [];
    const device = fakeDeviceDO();
    await device.webSocketMessage(
      {
        close: (code: number, reason: string) => closed.push([code, reason]),
      } as unknown as WebSocket,
      message,
    );
    assert.deepEqual(closed, [[1003, "bad proto"]]);
  }
});

test("create stores only generic identities and hashes no application input", async () => {
  const state = fakeState();
  const pushes: Array<Record<string, unknown>> = [];
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({
      push: async (body) => {
        pushes.push(body);
        return new Response("{}", { status: 200 });
      },
    }),
  );
  assert.equal(
    (await control.fetch(req("/create", "tool", "operator-a", createBody()))).status,
    201,
  );
  const record = state.value<PeerSessionRecord>("session")!;
  assert.match(record.round.id, /^[0-9a-f-]{36}$/i);
  assert.equal(record.protocol.id, "fleet.transfer.v2");
  assert.equal(record.endpoints.source.role, "source");
  assert.equal(record.signalSides.initiator, "source");
  assert.equal(record.expiresAt - record.createdAt, 30 * 60_000);
  assert.equal(record.expiresAt - record.createdAt, PEER_SESSION_TTL_MS);
  assert.doesNotMatch(
    JSON.stringify(record),
    /source-path|target-path|manifest|chunk|resume|offset/i,
  );
  assert.doesNotMatch(JSON.stringify(record), /private\/input/);
  assert.equal("round_id" in createBody(), false);
  assert.equal(
    (pushes[0]?.body as { peer?: { action?: string } } | undefined)?.peer?.action,
    "prepare_target",
  );
});

test("lost create response retries one session and keeps the first opaque input", async () => {
  const state = fakeState();
  const pushes: Array<Record<string, unknown>> = [];
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({
      push: async (body) => {
        pushes.push(body);
        return new Response("{}", { status: 200 });
      },
    }),
  );
  const first = createBody();
  assert.equal((await control.fetch(req("/create", "tool", "operator-a", first))).status, 201);
  const original = state.value<PeerSessionRecord>("session")!;
  const originalOutbox = state.value<Array<{ envelope: { body: unknown } }>>("outbox")!;
  const retry = createBody();
  retry.source = {
    ...retry.source,
    name: "renamed after a lost response",
    input: { opaque: "must-not-win" },
  };
  assert.equal((await control.fetch(req("/create", "tool", "operator-a", retry))).status, 200);
  assert.equal(state.value<PeerSessionRecord>("session")!.round.id, original.round.id);
  assert.deepEqual(state.value("outbox"), originalOutbox);
  assert.equal(pushes.length, 2, "idempotent create must not synchronously redeliver prepare");
  assert.doesNotMatch(JSON.stringify(state.value("outbox")), /must-not-win/);
});

test("concurrent identical create requests commit one peer session", async () => {
  const state = fakeState();
  const pushes: Array<Record<string, unknown>> = [];
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({
      push: async (body) => {
        pushes.push(body);
        return new Response("{}", { status: 200 });
      },
    }),
  );
  const responses = await Promise.all([
    control.fetch(req("/create", "tool", "operator-a", createBody())),
    control.fetch(req("/create", "tool", "operator-a", createBody())),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  assert.equal(state.value<PeerSessionRecord>("session")?.round.no, 1);
  assert.equal(pushes.length, 2, "only the transaction winner may drain initial delivery");
});

test("create retry rejects changed durable intent without mutating the first session", async () => {
  const mutations: Array<[string, (body: ReturnType<typeof createBody>) => void]> = [
    [
      "operator",
      (body) => {
        body.operator_id = "operator-b";
      },
    ],
    [
      "protocol",
      (body) => {
        body.protocol.id = "fleet.transfer.v3";
      },
    ],
    [
      "initiator",
      (body) => {
        body.initiator = "target";
      },
    ],
    [
      "endpoint identity",
      (body) => {
        body.source.id = "device-c";
      },
    ],
    [
      "plugin version",
      (body) => {
        body.source.plugin_version = "0.3.0";
      },
    ],
    [
      "action",
      (body) => {
        body.target.action = "prepare_other";
      },
    ],
  ];

  for (const [field, mutate] of mutations) {
    const state = fakeState();
    const control = new PeerSessionDO(
      state as unknown as DurableObjectState,
      env({ push: async () => new Response("{}", { status: 200 }) }),
    );
    assert.equal(
      (await control.fetch(req("/create", "tool", "operator-a", createBody()))).status,
      201,
      field,
    );
    const originalRecord = structuredClone(state.value<PeerSessionRecord>("session"));
    const originalOutbox = structuredClone(state.value("outbox"));
    const changed = createBody();
    mutate(changed);

    const response = await control.fetch(req("/create", "tool", "operator-a", changed));
    assert.equal(response.status, 409, field);
    assert.equal(((await response.json()) as { code: string }).code, "CREATE_CONFLICT", field);
    assert.deepEqual(state.value("session"), originalRecord, field);
    assert.deepEqual(state.value("outbox"), originalOutbox, field);
  }
});

test("failed device push remains in persistent outbox with a stable delivery id", async () => {
  const state = fakeState();
  let offline = true;
  const attempts: string[] = [];
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({
      push: async (body) => {
        attempts.push(String(body.delivery_id));
        return new Response("{}", { status: offline ? 409 : 200 });
      },
    }),
  );
  assert.equal(
    (await control.fetch(req("/create", "tool", "operator-a", createBody()))).status,
    201,
  );
  const first = (state.value<Array<{ deliveryId: string }>>("outbox") ?? [])[0]!.deliveryId;
  assert.equal(attempts[0], first);
  offline = false;
  await due(state);
  await control.alarm();
  assert.ok((state.value<Array<unknown>>("outbox") ?? []).length > 0);
  await ackDeviceDeliveries(control, state);
  assert.deepEqual(state.value("outbox"), []);
  assert.ok(attempts.filter((id) => id === first).length >= 2);
});

test("successful device push remains durable until the owning Agent acknowledges it", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  await control.fetch(req("/create", "tool", "operator-a", createBody()));
  const first = (
    state.value<
      Array<{ kind: string; deliveryId: string; endpoint: { kind: string; id: string } }>
    >("outbox") ?? []
  ).find((item) => item.kind === "deliver" && item.endpoint.id === "device-a")!;
  assert.ok(first, "successful ws.send must not delete the persistent delivery");
  const forged = await control.fetch(
    req("/delivery/ack", "device", "device-b", { delivery_id: first.deliveryId }),
  );
  assert.equal(forged.status, 403);
  const wrongSession = await control.fetch(
    req("/delivery/ack", "device", "device-a", {
      delivery_id: "ps:00000000-0000-4000-8000-000000000002:r1:prepare:source",
    }),
  );
  assert.equal(wrongSession.status, 400);
  assert.equal(((await wrongSession.json()) as { code: string }).code, "DELIVERY_MISMATCH");
  assert.ok(
    (state.value<Array<{ deliveryId: string }>>("outbox") ?? []).some(
      (item) => item.deliveryId === first.deliveryId,
    ),
  );
  assert.equal(
    (
      await control.fetch(
        req("/delivery/ack", "device", "device-a", { delivery_id: first.deliveryId }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await control.fetch(
        req("/delivery/ack", "device", "device-a", { delivery_id: first.deliveryId }),
      )
    ).status,
    200,
  );
  assert.equal(
    (state.value<Array<{ deliveryId: string }>>("outbox") ?? []).some(
      (item) => item.deliveryId === first.deliveryId,
    ),
    false,
  );
});

test("tool inbox is replayable until stable delivery ids are acknowledged", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const body = createBody();
  body.source = { ...body.source, kind: "tool", id: "operator-a" };
  assert.equal((await control.fetch(req("/create", "tool", "operator-a", body))).status, 201);
  const first = await control.fetch(req("/inbox/poll", "tool", "operator-a", {}));
  const firstItems = ((await first.json()) as { items: Array<{ delivery_id: string }> }).items;
  assert.equal(firstItems.length, 1);
  const replay = await control.fetch(req("/inbox/poll", "tool", "operator-a", {}));
  assert.deepEqual(((await replay.json()) as { items: unknown[] }).items, firstItems);
  const acked = await control.fetch(
    req("/inbox/poll", "tool", "operator-a", {
      ack_delivery_ids: [firstItems[0]!.delivery_id],
    }),
  );
  assert.deepEqual(((await acked.json()) as { items: unknown[] }).items, []);
});

test("tool delivery commits the remaining outbox and its next alarm together", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({ push: async () => new Response("{}", { status: 409 }) }),
  );
  const body = createBody();
  body.target = { ...body.target, kind: "tool", id: "operator-b" };
  assert.equal((await control.fetch(req("/create", "tool", "operator-a", body))).status, 201);
  const toolDelivery = (
    state.value<
      Array<{
        kind: "deliver";
        deliveryId: string;
        side: "source" | "target";
        endpoint: { kind: "tool" | "device"; id: string };
        envelope: { type: string; body: Record<string, unknown> };
        attempts: number;
        nextAttemptAt: number;
      }>
    >("outbox") ?? []
  ).find((item) => item.endpoint.kind === "tool");
  assert.ok(toolDelivery);
  await state.storage.setAlarm(0);

  await (control as unknown as { mail(item: typeof toolDelivery): Promise<void> }).mail(
    toolDelivery,
  );

  assert.equal(
    (state.value<Array<{ deliveryId: string }>>("outbox") ?? []).some(
      (item) => item.deliveryId === toolDelivery.deliveryId,
    ),
    false,
  );
  assert.equal(
    (state.value<Array<{ delivery_id: string }>>("mail:target") ?? [])[0]?.delivery_id,
    toolDelivery.deliveryId,
  );
  assert.ok((state.alarm() ?? 0) > 0, "persisted queue state must never be left without an alarm");
});

test("endpoint collision and non-base64url core nonce fail closed", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const collision = createBody();
  collision.target = { ...collision.target, id: "device-a" };
  assert.equal((await control.fetch(req("/create", "tool", "operator-a", collision))).status, 400);

  assert.equal(
    (await control.fetch(req("/create", "tool", "operator-a", createBody()))).status,
    201,
  );
  const round = state.value<PeerSessionRecord>("session")!.round.id;
  const invalid = await control.fetch(
    req("/authorize", "device", "device-a", {
      side: "source",
      round_id: round,
      session_binding: "not+base64",
      round_binding: binding("round"),
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { code: string }).code, "INVALID_BINDING");
});

test("account and kid ownership are indistinguishable from a missing session", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  await control.fetch(req("/create", "tool", "operator-a", createBody()));
  const foreign = await control.fetch(
    req("/status", "tool", "operator-a", {}, "account-b", "kid-b"),
  );
  assert.equal(foreign.status, 404);
  assert.equal(((await foreign.json()) as { code: string }).code, "NOT_FOUND");
});

test("chunked control input is cancelled at the hard byte limit", async () => {
  let cancelled = false;
  const request = new Request("https://worker/v1/plugin-peer-session/create", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    readPeerSessionControlText(request, 8),
    (error: unknown) => (error as { code?: string }).code === "REQUEST_TOO_LARGE",
  );
  assert.equal(cancelled, true);
});

test("unexpected Durable Object failures are reported as internal errors", async () => {
  const state = fakeState();
  state.storage.transaction = async () => {
    throw new Error("storage unavailable");
  };
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const original = console.error;
  console.error = () => {};
  try {
    const response = await control.fetch(req("/create", "tool", "operator-a", createBody()));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "peer session internal error",
      code: "INTERNAL_ERROR",
    });
  } finally {
    console.error = original;
  }
});

test("alarm publishes expired state, retains a short retry grace, then deletes all state", async () => {
  const state = fakeState();
  const pushes: Array<{ type: string; body: { phase?: string } }> = [];
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({
      push: async (body) => {
        pushes.push(body as (typeof pushes)[number]);
        return new Response("{}", { status: 200 });
      },
    }),
  );
  await control.fetch(req("/create", "tool", "operator-a", createBody()));
  const record = state.value<PeerSessionRecord>("session")!;
  record.expiresAt = Date.now() - 1;
  await state.storage.put("session", record);
  await control.alarm();
  const expired = state.value<PeerSessionRecord>("session")!;
  assert.equal(expired.phase, "expired");
  assert.ok((expired.gcAt ?? 0) > Date.now());
  assert.ok(
    pushes.some((push) => push.type === "peer_session_update" && push.body.phase === "expired"),
  );
  expired.gcAt = Date.now() - 1;
  await state.storage.put("session", expired);
  await control.alarm();
  assert.equal(state.value("session"), undefined);
});

test("binding hashes, signer retry, and partial ticket delivery survive independently", async () => {
  const state = fakeState();
  let signerOffline = true;
  let failTargetTicket = true;
  const pushes: Array<{ device_id: string; delivery_id: string; type: string }> = [];
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({
      sign: async () =>
        signerOffline
          ? new Response("{}", { status: 503 })
          : Response.json({ statement: { payload: "payload", sig: "sig" } }),
      push: async (body) => {
        const push = body as { device_id: string; delivery_id: string; type: string };
        pushes.push(push);
        if (
          failTargetTicket &&
          push.device_id === "device-b" &&
          push.type === "peer_session_ticket"
        ) {
          failTargetTicket = false;
          return new Response("{}", { status: 409 });
        }
        return new Response("{}", { status: 200 });
      },
    }),
  );
  const round = await createAndAuthorize(control, state);
  const stored = state.value<PeerSessionRecord>("session")!;
  assert.match(stored.endpoints.source.sessionBindingHash ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(stored.endpoints.source.sessionBindingHash, binding("source-session-secret"));
  assert.doesNotMatch(JSON.stringify(stored), /source-session-secret|source-round-secret/);

  assert.equal((await signal(control, "device-a", "initiator", offer(1), round)).status, 200);
  assert.equal((await signal(control, "device-b", "responder", answer(1), round)).status, 200);
  assert.equal((await signal(control, "device-a", "initiator", candidate(2), round)).status, 200);
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "connecting");
  assert.ok(
    (state.value<Array<{ kind: string }>>("outbox") ?? []).some((x) => x.kind === "issue_ticket"),
  );
  await ackDeviceDeliveries(control, state);

  signerOffline = false;
  await due(state);
  await control.alarm();
  let record = state.value<PeerSessionRecord>("session")!;
  assert.deepEqual(record.ticket, { payload: "payload", sig: "sig" });
  await ackDeviceDeliveries(control, state, (item) => item.endpoint.id === "device-a");
  const remaining = state.value<Array<{ deliveryId: string }>>("outbox") ?? [];
  assert.equal(remaining.length, 1);
  const retryId = remaining[0]!.deliveryId;
  await due(state);
  await control.alarm();
  await ackDeviceDeliveries(control, state);
  assert.deepEqual(state.value("outbox"), []);
  assert.ok(pushes.filter((push) => push.delivery_id === retryId).length >= 2);

  record = state.value<PeerSessionRecord>("session")!;
  const ticket = buildPeerSessionTicketStatement(record);
  assert.equal(ticket.kind, "plugin_peer");
  assert.equal(ticket.protocol, "fleet.transfer.v2");
  assert.equal(ticket.abi, "fleet.plugin.peer.v1");
  assert.equal(ticket.transport, "direct_ordered");
  assert.equal(ticket.approval, "both_once");
  assert.equal(ticket.source_action, "prepare_source");
  assert.equal(ticket.source_role, "source");
  assert.equal(ticket.capability_digest, record.capabilityDigest);
  assert.equal(ticket.source_session_binding_hash, record.endpoints.source.sessionBindingHash);
  assert.equal(ticket.target_round_binding_hash, record.endpoints.target.roundBindingHash);
  assert.equal(ticket.offer_fp, "aa".repeat(32));
  assert.equal(ticket.answer_fp, "bb".repeat(32));
  assert.equal(ticket.initiator_kind, "device");
  assert.equal(ticket.initiator_id, "device-a");
  assert.equal(ticket.responder_kind, "device");
  assert.equal(ticket.responder_id, "device-b");
  assert.doesNotMatch(JSON.stringify(ticket), /input|file|manifest|chunk|resume|prompt/i);
});

test("a signer response arriving after session expiry cannot install or deliver a ticket", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  let markSignerStarted!: () => void;
  let releaseSigner!: () => void;
  const signerStarted = new Promise<void>((resolve) => {
    markSignerStarted = resolve;
  });
  const signerRelease = new Promise<void>((resolve) => {
    releaseSigner = resolve;
  });
  const pushedTypes: string[] = [];
  Date.now = () => now;
  try {
    const state = fakeState();
    const control = new PeerSessionDO(
      state as unknown as DurableObjectState,
      env({
        sign: async () => {
          markSignerStarted();
          await signerRelease;
          return Response.json({ statement: { payload: "late", sig: "late" } });
        },
        push: async (body) => {
          pushedTypes.push(String(body.type ?? ""));
          return new Response("{}", { status: 200 });
        },
      }),
    );
    const round = await createAndAuthorize(control, state);
    assert.equal((await signal(control, "device-a", "initiator", offer(1), round)).status, 200);
    const pendingAnswer = signal(control, "device-b", "responder", answer(1), round);
    await signerStarted;
    now += PEER_SESSION_TTL_MS;
    releaseSigner();

    assert.equal((await pendingAnswer).status, 200);
    assert.equal(state.value<PeerSessionRecord>("session")?.ticket, undefined);
    assert.equal(pushedTypes.includes("peer_session_ticket"), false);
    assert.equal(
      (state.value<Array<{ kind: string }>>("outbox") ?? []).some(
        (item) => item.kind === "issue_ticket",
      ),
      false,
    );
    await control.alarm();
    assert.equal(state.value<PeerSessionRecord>("session")?.phase, "expired");
  } finally {
    Date.now = originalNow;
  }
});

test("same signal retry is idempotent while changed payload at the same sequence conflicts", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const round = await createAndAuthorize(control, state);
  assert.equal((await signal(control, "device-a", "initiator", offer(1), round)).status, 200);
  assert.equal((await signal(control, "device-a", "initiator", offer(1), round)).status, 200);
  const conflict = await signal(
    control,
    "device-a",
    "initiator",
    { kind: "offer", seq: 1, sdp: sdp("c") },
    round,
  );
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { code: string }).code, "SIGNAL_CONFLICT");
});

test("body parsing precedes the state transaction so a delayed signal cannot resurrect cancel", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const round = await createAndAuthorize(control, state);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = control.fetch(
    delayedReq(
      "/signal",
      "device",
      "device-a",
      {
        signal_role: "initiator",
        round_id: round,
        signal: offer(1),
      },
      gate,
    ),
  );
  assert.equal(
    (await control.fetch(req("/event", "tool", "operator-a", { round_id: round, event: "cancel" })))
      .status,
    200,
  );
  release();
  assert.equal((await pending).status, 409);
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "cancelled");
});

test("interrupt generates a server round and rejects old-round round-scoped callbacks", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const oldRound = await createAndAuthorize(control, state);
  await signal(control, "device-a", "initiator", offer(1), oldRound);
  await signal(control, "device-b", "responder", answer(1), oldRound);
  assert.equal(
    (
      await control.fetch(
        req("/event", "device", "device-a", { round_id: oldRound, event: "active" }),
      )
    ).status,
    200,
  );
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "connecting");
  assert.equal(
    (
      await control.fetch(
        req("/event", "device", "device-b", { round_id: oldRound, event: "active" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await control.fetch(
        req("/event", "device", "device-a", { round_id: oldRound, event: "interrupt" }),
      )
    ).status,
    200,
  );
  const current = state.value<PeerSessionRecord>("session")!;
  assert.notEqual(current.round.id, oldRound);
  assert.equal(current.phase, "waiting_approval");
  assert.equal(current.endpoints.source.roundBindingHash, undefined);
  assert.ok(current.endpoints.source.sessionBindingHash);
  const stale = await signal(control, "device-a", "initiator", offer(2), oldRound);
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "STALE_ROUND");
  for (const event of ["active", "complete", "interrupt", "cancel"] as const) {
    const response = await control.fetch(
      req("/event", "device", "device-a", { round_id: oldRound, event }),
    );
    assert.equal(response.status, 409, `old-round ${event} must fail`);
    assert.equal(((await response.json()) as { code: string }).code, "STALE_ROUND");
  }
});

test("an endpoint failure from the interrupted round terminates the replacement round", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const oldRound = await createAndAuthorize(control, state);
  await signal(control, "device-a", "initiator", offer(1), oldRound);
  await signal(control, "device-b", "responder", answer(1), oldRound);
  assert.equal(
    (
      await control.fetch(
        req("/event", "device", "device-a", { round_id: oldRound, event: "interrupt" }),
      )
    ).status,
    200,
  );
  const replacementRound = state.value<PeerSessionRecord>("session")!.round.id;
  assert.notEqual(replacementRound, oldRound);

  for (const [kind, id] of [
    ["tool", "operator-a"],
    ["device", "device-c"],
  ] as const) {
    const unauthorized = await control.fetch(
      req("/event", kind, id, {
        round_id: oldRound,
        event: "fail",
        failure_code: "TARGET_EXISTS",
      }),
    );
    assert.equal(unauthorized.status, 403);
  }
  const malformed = await control.fetch(
    req("/event", "device", "device-b", {
      round_id: oldRound,
      event: "fail",
      failure_code: "not-valid",
    }),
  );
  assert.equal(malformed.status, 400);
  assert.equal(state.value<PeerSessionRecord>("session")!.phase, "waiting_approval");

  const failedResponse = await control.fetch(
    req("/event", "device", "device-b", {
      round_id: oldRound,
      event: "fail",
      failure_code: "TARGET_EXISTS",
    }),
  );
  assert.equal(failedResponse.status, 200);
  const failed = state.value<PeerSessionRecord>("session")!;
  assert.equal(failed.round.id, replacementRound);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.failureCode, "TARGET_EXISTS");
  const outbox = state.value<
    Array<{
      kind: string;
      side: string;
      envelope: {
        type: string;
        body: { phase: string; session: { round: { id: string }; failure_code: string } };
      };
    }>
  >("outbox")!;
  assert.equal(outbox.length, 2);
  assert.deepEqual(new Set(outbox.map((entry) => entry.side)), new Set(["source", "target"]));
  for (const entry of outbox) {
    assert.equal(entry.kind, "deliver");
    assert.equal(entry.envelope.type, "peer_session_update");
    assert.equal(entry.envelope.body.phase, "failed");
    assert.equal(entry.envelope.body.session.round.id, replacementRound);
    assert.equal(entry.envelope.body.session.failure_code, "TARGET_EXISTS");
  }
});

test("the Hub enforces one initial round plus at most three resume rounds", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  assert.equal(
    (await control.fetch(req("/create", "tool", "operator-a", createBody()))).status,
    201,
  );
  for (let roundNo = 2; roundNo <= PEER_SESSION_MAX_ROUNDS; roundNo += 1) {
    const record = state.value<PeerSessionRecord>("session")!;
    record.phase = "active";
    await state.storage.put("session", record);
    const response = await control.fetch(
      req("/event", "device", "device-a", { round_id: record.round.id, event: "interrupt" }),
    );
    assert.equal(response.status, 200);
    assert.equal(state.value<PeerSessionRecord>("session")!.round.no, roundNo);
  }
  const finalRound = state.value<PeerSessionRecord>("session")!;
  finalRound.phase = "active";
  await state.storage.put("session", finalRound);
  const response = await control.fetch(
    req("/event", "device", "device-a", { round_id: finalRound.round.id, event: "interrupt" }),
  );
  assert.equal(response.status, 200);
  const failed = state.value<PeerSessionRecord>("session")!;
  assert.equal(failed.round.id, finalRound.round.id);
  assert.equal(failed.round.no, PEER_SESSION_MAX_ROUNDS);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.failureCode, "ROUND_LIMIT");
});

test("active and complete receipts are per-side, idempotent, and aggregate both endpoints", async () => {
  const state = fakeState();
  const control = new PeerSessionDO(state as unknown as DurableObjectState, env());
  const round = await createAndAuthorize(control, state);
  await signal(control, "device-a", "initiator", offer(1), round);
  await signal(control, "device-b", "responder", answer(1), round);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(
      (
        await control.fetch(
          req("/event", "device", "device-a", { round_id: round, event: "active" }),
        )
      ).status,
      200,
    );
  }
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "connecting");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(
      (
        await control.fetch(
          req("/event", "device", "device-a", { round_id: round, event: "complete" }),
        )
      ).status,
      200,
    );
  }
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "connecting");
  assert.equal(
    (await control.fetch(req("/event", "device", "device-b", { round_id: round, event: "active" })))
      .status,
    200,
  );
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "active");
  assert.equal(
    (
      await control.fetch(
        req("/event", "device", "device-b", { round_id: round, event: "complete" }),
      )
    ).status,
    200,
  );
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "completed");
});

test("interrupt atomically discards pending deliveries captured by the old round", async () => {
  const state = fakeState();
  const pushes: Array<{ type: string; body: Record<string, unknown> }> = [];
  const control = new PeerSessionDO(
    state as unknown as DurableObjectState,
    env({
      push: async (body) => {
        pushes.push(body as (typeof pushes)[number]);
        return body.type === "peer_session_signal"
          ? new Response("{}", { status: 409 })
          : new Response("{}", { status: 200 });
      },
    }),
  );
  const oldRound = await createAndAuthorize(control, state);
  await signal(control, "device-a", "initiator", offer(1), oldRound);
  await signal(control, "device-b", "responder", answer(1), oldRound);
  assert.ok(JSON.stringify(state.value("outbox")).includes(oldRound));
  assert.equal(
    (
      await control.fetch(
        req("/event", "device", "device-a", { round_id: oldRound, event: "interrupt" }),
      )
    ).status,
    200,
  );
  const record = state.value<PeerSessionRecord>("session")!;
  assert.notEqual(record.round.id, oldRound);
  assert.doesNotMatch(JSON.stringify(state.value("outbox")), new RegExp(oldRound));
  const roundPrepares = pushes.filter((item) => item.type === "peer_session_round_prepare");
  assert.equal(roundPrepares.length, 2);
  assert.deepEqual(Object.keys(roundPrepares[0]!.body).sort(), [
    "direct_only",
    "round_id",
    "round_no",
    "session_id",
    "side",
    "signal_role",
  ]);
  assert.equal(roundPrepares[0]!.body.round_id, record.round.id);
  assert.deepEqual(
    new Set(roundPrepares.map((item) => item.body.signal_role)),
    new Set(["initiator", "responder"]),
  );
});

test("Worker keeps immutable migration history for generic peer and revocation DOs", async () => {
  const [worker, wrangler] = await Promise.all([
    readFile(new URL("./src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./wrangler.toml", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /env\.PEER_SESSION\.idFromName\(sessionId\)/);
  assert.match(worker, /runtime !== "peer"/);
  assert.match(worker, /action_specs/);
  assert.match(worker, /peer_protocols/);
  assert.match(worker, /peer-delivery-ids/);
  assert.match(worker, /known\?\.state === "acked"/);
  assert.match(worker, /if \(known\) return "pending"/);
  assert.match(worker, /replay: deliveryState === "pending"/);
  assert.match(worker, /handlePeerSessionAck/);
  assert.match(worker, /https:\/\/peer-session\/delivery\/ack/);
  assert.match(worker, /"peer_session_round_prepare"/);
  assert.equal(worker.match(/PEER_SESSION\.get/g)?.length, 3);
  assert.equal(worker.match(/await reservePeerSession\(/g)?.length, 3);
  assert.doesNotMatch(worker, /\/v1\/transfer\//);
  assert.doesNotMatch(worker, /env\.TRANSFER/);
  assert.doesNotMatch(worker, /peer[-_]session[-_](?:upload|download|chunk|bytes)/i);
  assert.match(wrangler, /name = "PEER_SESSION"\s+class_name = "PeerSessionDO"/);
  assert.match(wrangler, /name = "REVOCATION"\s+class_name = "RevocationDO"/);
  assert.match(wrangler, /tag = "v3"\s+new_sqlite_classes = \["TransferDO"\]/);
  assert.match(
    wrangler,
    /tag = "v4"\s+new_sqlite_classes = \["PeerSessionDO"\]\s+deleted_classes = \["TransferDO"\]/,
  );
  assert.match(wrangler, /tag = "v5"\s+new_sqlite_classes = \["RevocationDO"\]/);
});

async function createAndAuthorize(control: PeerSessionDO, state: ReturnType<typeof fakeState>) {
  assert.equal(
    (await control.fetch(req("/create", "tool", "operator-a", createBody()))).status,
    201,
  );
  await ackDeviceDeliveries(control, state);
  const round = state.value<PeerSessionRecord>("session")!.round.id;
  for (const [side, device, sessionBinding, roundBinding] of [
    ["source", "device-a", "source-session-secret", "source-round-secret"],
    ["target", "device-b", "target-session-secret", "target-round-secret"],
  ] as const) {
    const response = await control.fetch(
      req("/authorize", "device", device, {
        side,
        round_id: round,
        session_binding: binding(sessionBinding),
        round_binding: binding(roundBinding),
      }),
    );
    assert.equal(response.status, 200);
  }
  await ackDeviceDeliveries(control, state);
  assert.equal(state.value<PeerSessionRecord>("session")?.phase, "signaling");
  return round;
}

function createBody() {
  return {
    session_id: SESSION,
    user_id: "account-a",
    kid: "kid-a",
    operator_id: "operator-a",
    coordinator: { kind: "tool", id: "operator-a" },
    protocol: {
      id: "fleet.transfer.v2",
      abi: "fleet.plugin.peer.v1",
      transport: "direct_ordered",
      approval: "both_once",
    },
    initiator: "source",
    source: {
      kind: "device",
      id: "device-a",
      plugin_id: "fleet.transfer",
      plugin_version: "0.2.0",
      action: "prepare_source",
      role: "source",
      input: { opaque: "private/input/a" },
    },
    target: {
      kind: "device",
      id: "device-b",
      plugin_id: "fleet.transfer",
      plugin_version: "0.2.0",
      action: "prepare_target",
      role: "target",
      input: { opaque: "private/input/b" },
    },
  };
}

function req(
  path: string,
  kind: "tool" | "device",
  id: string,
  body: unknown,
  userId = "account-a",
  kid = "kid-a",
) {
  return new Request(`https://peer${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fleet-user": userId,
      "x-fleet-kid": kid,
      "x-peer-caller-kind": kind,
      "x-peer-caller-id": id,
    },
    body: JSON.stringify(body),
  });
}

function delayedReq(
  path: string,
  kind: "tool" | "device",
  id: string,
  body: unknown,
  gate: Promise<void>,
) {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  let sent = false;
  return new Request(`https://peer${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fleet-user": "account-a",
      "x-fleet-kid": "kid-a",
      "x-peer-caller-kind": kind,
      "x-peer-caller-id": id,
    },
    body: new ReadableStream({
      async pull(controller) {
        if (sent) return;
        sent = true;
        await gate;
        controller.enqueue(encoded);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function signal(
  control: PeerSessionDO,
  id: string,
  role: "initiator" | "responder",
  value: unknown,
  round: string,
) {
  return control.fetch(
    req("/signal", "device", id, { signal_role: role, round_id: round, signal: value }),
  );
}
function offer(seq: number) {
  return { kind: "offer", seq, sdp: sdp("a") };
}
function answer(seq: number) {
  return { kind: "answer", seq, sdp: sdp("b") };
}
function candidate(seq: number) {
  return {
    kind: "candidate",
    seq,
    candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host",
    sdp_mid: "0",
    sdp_mline_index: 0,
  };
}
function sdp(hex: string) {
  return `v=0\r\na=fingerprint:sha-256 ${Array.from({ length: 32 }, () => hex + hex).join(":")}\r\n`;
}
function binding(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function env(
  options: {
    push?: (body: Record<string, unknown>) => Promise<Response>;
    sign?: () => Promise<Response>;
  } = {},
) {
  return {
    DEVICE: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (request: Request) =>
          options.push?.((await request.json()) as Record<string, unknown>) ??
          new Response("{}", { status: 200 }),
      }),
    },
    FLEET: {
      idFromName: () => "fleet",
      get: () => ({
        fetch: async () =>
          options.sign?.() ?? Response.json({ statement: { payload: "payload", sig: "sig" } }),
      }),
    },
  } as unknown as { DEVICE: DurableObjectNamespace; FLEET: DurableObjectNamespace };
}

async function due(state: ReturnType<typeof fakeState>) {
  const outbox = state.value<Array<{ nextAttemptAt: number }>>("outbox") ?? [];
  for (const entry of outbox) entry.nextAttemptAt = 0;
  await state.storage.put("outbox", outbox);
}

async function ackDeviceDeliveries(
  control: PeerSessionDO,
  state: ReturnType<typeof fakeState>,
  include: (item: { endpoint: { kind: string; id: string } }) => boolean = () => true,
) {
  const entries =
    state.value<
      Array<{
        kind: string;
        deliveryId: string;
        endpoint?: { kind: string; id: string };
      }>
    >("outbox") ?? [];
  for (const item of entries) {
    if (item.kind !== "deliver" || !item.endpoint || item.endpoint.kind !== "device") {
      continue;
    }
    if (!include({ endpoint: item.endpoint })) continue;
    const response = await control.fetch(
      req("/delivery/ack", "device", item.endpoint.id, { delivery_id: item.deliveryId }),
    );
    assert.equal(response.status, 200);
  }
}

async function seedFleetUser(state: ReturnType<typeof fakeState>, kid: string) {
  const email = "account-a@example.test";
  await state.storage.put("id:account-a", email);
  await state.storage.put(`u:${email}`, {
    id: "account-a",
    email,
    salt: "salt",
    pass: "pass",
    tokenHash: `hash-${kid}`,
    kid,
  });
}

async function seedFleetAccount(state: ReturnType<typeof fakeState>) {
  const email = "account-a@example.test";
  await state.storage.put("id:account-a", email);
  await state.storage.put(`u:${email}`, {
    id: "account-a",
    email,
    salt: "salt",
    pass: "pass",
  });
}

function resolveFleetBearer(fleet: FleetDO, token: string) {
  return fleet.fetch(
    new Request("https://fleet/resolve-bearer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
}

function claimFleetDevice(fleet: FleetDO, id: string, kid: string, connectionId = CONNECTION_OLD) {
  return fleet.fetch(
    new Request("https://fleet/claim-device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        userId: "account-a",
        name: id,
        os: "linux",
        online: true,
        kid,
        connectionId,
      }),
    }),
  );
}

function touchFleetDevice(fleet: FleetDO, id: string, kid: string, connectionId = CONNECTION_OLD) {
  return fleet.fetch(
    new Request("https://fleet/touch-device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        userId: "account-a",
        name: id,
        os: "linux",
        online: true,
        kid,
        connectionId,
      }),
    }),
  );
}

function releaseFleetDevice(
  fleet: FleetDO,
  id: string,
  kid: string,
  connectionId = CONNECTION_OLD,
) {
  return fleet.fetch(
    new Request("https://fleet/release-device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        userId: "account-a",
        name: id,
        os: "linux",
        online: false,
        kid,
        connectionId,
      }),
    }),
  );
}

function revocationEnv(attempted: string[], children: string[], failId = "") {
  const env: Record<string, unknown> = {};
  env.DEVICE = {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      fetch: async () => {
        attempted.push(id);
        return id === failId
          ? Response.json({ error: "injected failure" }, { status: 500 })
          : Response.json({ ok: true });
      },
    }),
  };
  env.REVOCATION = {
    idFromName: (id: string) => id,
    get: (id: string) => {
      children.push(id);
      return {
        fetch: (request: Request) =>
          new RevocationDO(
            {} as DurableObjectState,
            env as unknown as ConstructorParameters<typeof RevocationDO>[1],
          ).fetch(request),
      };
    },
  };
  return env;
}

function fakeState({ cloneReads = false }: { cloneReads?: boolean } = {}) {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let failNextAlarm = false;
  let tail = Promise.resolve();
  const read = <T>(value: T): T => (cloneReads ? structuredClone(value) : value);
  const storage = {
    get: async <T>(key: string | string[]) => {
      if (Array.isArray(key)) {
        return new Map(
          key.filter((item) => values.has(item)).map((item) => [item, read(values.get(item) as T)]),
        );
      }
      return read(values.get(key) as T | undefined);
    },
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") {
        values.set(key, structuredClone(value));
        return;
      }
      for (const [entryKey, entryValue] of Object.entries(key)) {
        values.set(entryKey, structuredClone(entryValue));
      }
    },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix = "", startAfter = "", limit = 128 } = {}) =>
      new Map(
        [...values]
          .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, limit),
      ),
    deleteAll: async () => {
      values.clear();
      alarm = null;
    },
    setAlarm: async (value: number) => {
      if (failNextAlarm) {
        failNextAlarm = false;
        throw new Error("injected alarm failure");
      }
      alarm = value;
    },
    getAlarm: async () => alarm,
    deleteAlarm: async () => {
      alarm = null;
    },
    transaction: async <T>(callback: (txn: typeof storage) => Promise<T>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(storage);
      } finally {
        release();
      }
    },
  };
  return {
    storage,
    value: <T>(key: string) => values.get(key) as T | undefined,
    keys: () => [...values.keys()],
    alarm: () => alarm,
    failNextAlarm: () => {
      failNextAlarm = true;
    },
  };
}

function initializeMessage(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} },
  };
}

function startTransferMessage(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "start_file_transfer",
      arguments: {
        source: { kind: "device", device_id: "device-a", path: "/srv/source.bin" },
        target: { kind: "device", device_id: "device-b", directory: "/srv/incoming" },
      },
    },
  };
}

function getTransferMessage(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "get_file_transfer",
      arguments: { transfer_id: numberedSession(99) },
    },
  };
}

function numberedSession(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function reserve(fleet: FleetDO, userId: string, sessionId: string): Promise<Response> {
  return fleet.fetch(
    new Request("https://fleet/peer-session-reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId, session_id: sessionId }),
    }),
  );
}

function mcpPeerEnv(
  peerCalls: Array<{ headers: Headers; body: Record<string, unknown> }>,
  options: {
    rejectReservation?: boolean;
    order?: string[];
    validateMcp?: () => Promise<void>;
  } = {},
) {
  return {
    FLEET: {
      idFromName: () => "fleet",
      get: () => ({
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          if (url.pathname === "/validate-mcp") {
            await options.validateMcp?.();
            return Response.json({ ok: true });
          }
          if (url.pathname === "/peer-session-reserve") {
            options.order?.push("reserve");
            if (options.rejectReservation) {
              return Response.json(
                { error: "too many peer sessions", code: "PEER_SESSION_LIMIT" },
                { status: 429 },
              );
            }
            return Response.json({ ok: true });
          }
          if (url.pathname === "/resolve-device") {
            const id = url.searchParams.get("ref") ?? "";
            return Response.json({
              id,
              userId: "account-a",
              name: id,
              os: "linux",
              online: true,
              caps: [PEER_SESSION_PROTOCOL],
            });
          }
          return Response.json({ error: "not found" }, { status: 404 });
        },
      }),
    },
    PEER_SESSION: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (request: Request) => {
          options.order?.push("peer");
          const body = (await request.json()) as Record<string, unknown>;
          peerCalls.push({ headers: request.headers, body });
          return Response.json(
            {
              session: {
                session_id: body.session_id,
                phase: "waiting_approval",
                round: { id: "00000000-0000-4000-8000-000000000123" },
              },
            },
            { status: 201 },
          );
        },
      }),
    },
  };
}

function fakeMcpState() {
  const values = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  let alarm: number | null = null;
  let puts = 0;
  let alarmWrites = 0;
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      puts += 1;
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
    setAlarm: async (value: number) => {
      alarmWrites += 1;
      alarm = value;
    },
    getAlarm: async () => alarm,
    deleteAlarm: async () => {
      alarm = null;
    },
    transaction: async <T>(callback: (txn: typeof storage) => Promise<T>) => callback(storage),
  };
  return {
    storage,
    waitUntil(value: Promise<unknown>) {
      pending.push(Promise.resolve(value));
    },
    async drain() {
      await Promise.all(pending.splice(0));
    },
    value: <T>(key: string) => values.get(key) as T | undefined,
    alarm: () => alarm,
    counts: () => ({ puts, alarmWrites }),
  };
}

function fakeDeviceDO(
  sockets: WebSocket[] = [],
  env: ConstructorParameters<typeof DeviceDO>[1] = {} as ConstructorParameters<typeof DeviceDO>[1],
) {
  return fakeDeviceHarness(sockets, env).device;
}

function fakeDeviceHarness(
  sockets: WebSocket[] = [],
  env: ConstructorParameters<typeof DeviceDO>[1] = {} as ConstructorParameters<typeof DeviceDO>[1],
) {
  const previous = Reflect.get(globalThis, "WebSocketRequestResponsePair");
  class FakeWebSocketRequestResponsePair {
    constructor(_request: string, _response: string) {}
  }
  Reflect.set(globalThis, "WebSocketRequestResponsePair", FakeWebSocketRequestResponsePair);
  try {
    const state = fakeState();
    const device = new DeviceDO(
      {
        storage: state.storage,
        setWebSocketAutoResponse() {},
        getWebSockets: () => sockets,
      } as unknown as DurableObjectState,
      env,
    );
    return { device, state };
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "WebSocketRequestResponsePair");
    else Reflect.set(globalThis, "WebSocketRequestResponsePair", previous);
  }
}
