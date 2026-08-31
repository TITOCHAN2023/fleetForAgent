import worker, {
  DeviceDO,
  FleetDO,
  McpDO,
  PeerSessionDO,
  RevocationDO,
  type Env,
} from "../../packages/fleet-worker/src/index";

export { DeviceDO, FleetDO, McpDO, PeerSessionDO, RevocationDO };

type VMEnv = Env & {
  VM_SEED_KEY?: string;
};

let seedUsed = false;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[a-zA-Z0-9._:@/-]{1,160}$/;

/**
 * Local-VM-only wrapper around the real Worker.
 *
 * Production has no account-seeding route. The VM harness supplies a random
 * key at process start, calls this endpoint exactly once, and then exercises
 * the unmodified /v1 control plane through the real Worker export above.
 */
export default {
  async fetch(request: Request, env: VMEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__fleet_vm__/")) {
      return worker.fetch(request, env, ctx);
    }
    if (request.method !== "POST") return vmJSON({ error: "method not allowed" }, 405);

    const configuredKey = env.VM_SEED_KEY?.trim() ?? "";
    const suppliedKey = request.headers.get("x-fleet-vm-key") ?? "";
    if (!configuredKey || suppliedKey !== configuredKey) {
      return vmJSON({ error: "not found" }, 404);
    }
    if (url.pathname === "/__fleet_vm__/interrupt") {
      return interruptPeerRound(request, env);
    }
    if (url.pathname === "/__fleet_vm__/session") {
      return readPeerSession(request, env);
    }
    if (url.pathname !== "/__fleet_vm__/seed") return vmJSON({ error: "not found" }, 404);
    if (seedUsed) return vmJSON({ error: "seed already consumed" }, 409);
    seedUsed = true;

    const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));
    const accountResponse = await fleet.fetch(
      new Request("https://fleet/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "plugin-peer-vm@invalid.example", provider: "vm" }),
      }),
    );
    const account = (await accountResponse.json().catch(() => ({}))) as {
      id?: string;
      error?: string;
    };
    if (!accountResponse.ok || !account.id) {
      return vmJSON({ error: account.error || "could not seed VM account" }, 500);
    }

    const audience = env.HUB_ORIGIN?.trim() ?? "";
    if (!audience) return vmJSON({ error: "HUB_ORIGIN is required" }, 500);
    const tokenResponse = await fleet.fetch(
      new Request(
        `https://fleet/token-issue?user=${encodeURIComponent(account.id)}&aud=${encodeURIComponent(audience)}`,
        { method: "POST" },
      ),
    );
    if (!tokenResponse.ok) {
      const result = (await tokenResponse.json().catch(() => ({}))) as { error?: string };
      return vmJSON({ error: result.error || "could not seed VM token" }, 500);
    }
    const issued = (await tokenResponse.json()) as { token?: string; prefix?: string };
    const kid = tokenKid(issued.token ?? "");
    if (!issued.token || !kid) return vmJSON({ error: "VM token response is invalid" }, 500);
    return vmJSON(
      {
        token: issued.token,
        prefix: issued.prefix ?? "",
        user_id: account.id,
        kid,
      },
      200,
    );
  },
};

type VMPeerContext = {
  body: Record<string, unknown>;
  peer: DurableObjectStub;
  headers: Headers;
};

async function vmPeerContext(request: Request, env: VMEnv): Promise<VMPeerContext | Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = String(body?.session_id ?? "");
  const userId = String(body?.user_id ?? "");
  const kid = String(body?.kid ?? "");
  const callerKind = String(body?.caller_kind ?? "");
  const callerId = String(body?.caller_id ?? "");
  if (
    !UUID.test(sessionId) ||
    !ID.test(userId) ||
    !ID.test(kid) ||
    (callerKind !== "device" && callerKind !== "tool") ||
    !ID.test(callerId)
  ) {
    return vmJSON({ error: "invalid VM peer request" }, 400);
  }

  const fleet = env.FLEET.get(env.FLEET.idFromName("fleet"));
  const valid = await fleet.fetch(
    new Request("https://fleet/validate-mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: userId, kid }),
    }),
  );
  if (!valid.ok) return vmJSON({ error: "VM account is no longer valid" }, 401);

  const peer = env.PEER_SESSION.get(env.PEER_SESSION.idFromName(sessionId));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-fleet-user", userId);
  headers.set("x-fleet-kid", kid);
  headers.set("x-peer-caller-kind", callerKind);
  headers.set("x-peer-caller-id", callerId);
  return { body: body ?? {}, peer, headers };
}

async function readPeerSession(request: Request, env: VMEnv): Promise<Response> {
  const context = await vmPeerContext(request, env);
  if (context instanceof Response) return context;
  return context.peer.fetch(
    new Request("https://peer-session/status", {
      method: "POST",
      headers: context.headers,
      body: "{}",
    }),
  );
}

async function interruptPeerRound(request: Request, env: VMEnv): Promise<Response> {
  const context = await vmPeerContext(request, env);
  if (context instanceof Response) return context;
  const priorRoundId = String(context.body.round_id ?? "");
  if (!UUID.test(priorRoundId)) return vmJSON({ error: "invalid VM interrupt round" }, 400);

  // Never manufacture an endpoint event here. Advancing the Hub without also
  // interrupting the endpoint's local RTC epoch creates an impossible state:
  // the Hub offers round N+1 while both Agents still own round N. The runner
  // creates a real Docker network partition; this route only proves that a
  // real Agent observed it and advanced the durable session.
  const current = await context.peer.fetch(
    new Request("https://peer-session/status", {
      method: "POST",
      headers: context.headers,
      body: "{}",
    }),
  );
  const value = (await current.json().catch(() => ({}))) as {
    session?: { round?: { id?: string; no?: number } };
    error?: string;
  };
  if (!current.ok) return vmJSON({ error: value.error || "could not read VM peer session" }, current.status);
  const roundId = String(value.session?.round?.id ?? "");
  const roundNo = Number(value.session?.round?.no ?? 0);
  if (!UUID.test(roundId) || !Number.isSafeInteger(roundNo) || roundNo < 1) {
    return vmJSON({ error: "VM peer session has an invalid round" }, 500);
  }
  if (roundId === priorRoundId || roundNo < 2) {
    return vmJSON({ error: "interrupt not observed", session: value.session }, 409);
  }
  return vmJSON({ session: value.session }, 200);
}

function tokenKid(token: string): string {
  const payload = token.startsWith("flt_1.") ? token.slice(6).split(".")[0] ?? "" : "";
  try {
    const raw = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const value = JSON.parse(atob(padded)) as { kid?: unknown };
    return typeof value.kid === "string" && ID.test(value.kid) ? value.kid : "";
  } catch {
    return "";
  }
}

function vmJSON(value: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
}
