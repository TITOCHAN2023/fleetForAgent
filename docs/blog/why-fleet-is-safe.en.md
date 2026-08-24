---
title: Who can touch your machines
date: 2026-08-21
summary: Devices only dial out, the token rides a one-shot asymmetric handshake, every query is cut by account, and the last switch stays on your own machine. Including the layers I can bypass myself.
---

There is no column in the Fleet database that stores a device IP. The only ip field in the whole schema is `session.ipAddress`, left behind by a browser login, and it appears in no `/v1/*` response.

That constraint was cheap, and I got it for free while writing the schema. The hard question is a different one. Who can run a command on your machine. What follows goes layer by layer, who each layer stops, and which layers I can walk through myself.

## The device dials out

The Agent comes up and dials `WSS /v1/device` on its own. No inbound port on the device, no public IP requirement, no port mapping on a home router. The operator talks HTTPS to the website, and the website already holds these sockets.

A port scan therefore has nothing to aim at. The machines cannot see each other either, and there is no LAN overlay underneath.

Once a device id lands under an account, it is taken. The handshake checks first.

```ts
// src/lib/fleet/v1.server.ts
async function stolenDevice(userId: string, deviceId: string) {
  const rows = await sql`select user_id from devices where id = ${deviceId}`;
  return Boolean(rows[0] && rows[0].user_id !== userId);
}
```

A hit returns 409 plus `socket.destroy()`, and the WebSocket never upgrades. The same account reconnecting counts as a replacement, and the old connection gets `1012 replaced`.

## Why the agent gets a token

The Agent is a long-running process on your own machine with nobody watching it. It cannot hold your login password and it cannot keep a browser session alive. It needs a credential that fits in a config file and can be revoked on its own.

So credentials come in two kinds that do not overlap. Cookie login only opens Settings and mints tokens, and the endpoints that move machines ignore cookies. The Hub token only moves machines, and it cannot mint another token, since `/v1/hub_token` on the Worker refuses super outright.

Leak one and the other still holds. Resetting the token needs no password change for the same reason. `issueHubToken` replaces that row in `hub_tokens`, then `kickUser` drops every live socket on the account with `1008 token reset`. One row per account, keyed by `user_id`, and every later query cuts by it.

## What Bearer costs

Bearer means every request hands the long-lived secret over verbatim, once per request.

The Agent is always on and speaks every few seconds, tens of thousands of verbatim handovers a day. Any single one that gets recorded gives the account away for good, until you go reset it yourself. And the places that record it all exist. Reverse proxy access logs keep headers, a corporate egress box with its root CA installed sees plaintext, cloud request logs sit there too, and then there is the screen of `curl` output you pasted somewhere while debugging.

Keeping the secret in a header instead of the URL stops only the coarsest cases, query strings in logs and referer leaks. Anything that records headers goes right through it.

So the full `flt_1` string never reaches the wire. Both ends refuse to downgrade.

```ts
// src/lib/fleet/v1.server.ts
if (auth.kind === "bearer" && (isLegacyFlt(auth.token) || auth.token.startsWith("flt_1."))) {
  return { error: HIGH_SEC_UPGRADE, code: "HIGH_SEC" };
}
```

On the client side `highSecAuthorization` refuses first, and a legacy `flt_` hex token never even opens a handshake. Try the new way and fall back to the old one on failure, that path is not there. Leaving it in would have erased the point.

## The private key stays on the hub, the public key goes to you

The string you paste looks like this.

```
flt_1.<base64url(payload)>.<base64url(sig)>

payload = {"v":1,"aud":"https://fleet.ginfo.cc","kid":"<uuid>","pub":"<SPKI>","iat":1756...,"sec":"<64 hex>"}
```

`sig` is RSA-PSS-SHA256 with salt 32, over the payload bytes. `payloadBytes` serializes in a fixed field order, and `verifyTokenV1` serializes again on arrival and compares byte for byte. Reorder a field or slip in one extra key and it fails.

The key direction runs against the intuition, and it carries the whole design. The private key stays on the hub, the public key goes to you.

A client needs to do two things, encrypt something to the hub, and check that the far side really is the hub. Both need the public key alone. It never has to open anything, so it never gets a private key. The hub, holding the private key, can both open the client's ciphertext and sign for itself in front of the client.

One authentication takes three steps.

Step one fetches a challenge. `GET /v1/challenge?kid=…` needs no authentication.

```ts
// src/lib/fleet/v1.server.ts
const nonce = /* 32 random bytes as 64 hex */;
const exp = Date.now() + CHALLENGE_TTL_MS;        // 120 seconds
challenges().put(kid, nonce, { userId: row.user_id, exp });
const sig = await signChallenge({ privatePkcs8B64: row.priv, aud: origin, kid, nonce });
return json({ nonce, kid, aud: origin, exp, sig });
```

The hub PSS-signs `v1|<aud>|<kid>|<nonce>` with that account's private key. At most 8 unused nonces stay alive per `kid`, which is what `nextChallengeList` handles, so hammering this endpoint anonymously cannot fill storage.

Step two, the client checks that signature with the `pub` from its token and wraps only after it passes.

```go
// packages/fleet-agent/tokenv1.go
if !verifyChallenge(pub, claims.Aud, claims.Kid, chal.Nonce, chal.Sig) {
    return "", fmt.Errorf("%s", highSecKeyMismatch)
}
wrap, err := wrapAuth(pub, claims.Sec, chal.Nonce)   // OAEP-SHA256({sec, nonce})
return "Fleet-OAEP " + claims.Kid + "." + wrap, nil
```

Step three, the hub checks three things. The `wrap` opens with that `kid`'s private key. The nonce is in the book, unexpired, with `kid` and `user_id` both matching, and `challenges().take(nonce)` takes it rather than peeking. `sha256(sec)` equals the stored `token_hash`. Miss one and it is a 401.

Nothing reusable travels the wire after that. A captured header is spent ciphertext once it has been used, and it expires on its own within 120 seconds.

## What lets the client trust the far side

The Agent runs on somebody else's network, unwatched, with no second place to check. All it holds is a token file at `~/.fleet-agent/config.json`, mode `0600`. It has to answer for itself who is on the other end.

The token pins two things, `aud` and `pub`.

Wrong `aud` and it will not connect. The comparison uses the configured origin, the Host header takes no part in it, so swapping a Host header fools nothing. Binding `aud` to `HUB_ORIGIN` exists for exactly this.

A far side that cannot sign `v1|<aud>|<kid>|<nonce>` gets no connection either. The check runs against the `pub` inside the token, and failure is `HIGH_SEC_KEY_MISMATCH`.

The second one matters because it leans on nothing from TLS. A corporate middlebox with its root CA installed, DNS hijacking, a lookalike domain one letter off, all of them can hand you a TLS channel that looks perfectly valid. None of them holds this account's private key, so none can sign that nonce. The Agent stops before it hands anything over.

The order is deliberate as well, verify the hub and then wrap, with `verifyChallenge` sitting ahead of `wrapAuth`. Skip that step and the wrap is still encrypted to the public key, so a fake hub without the private key cannot read `sec` out of it. The two layers stand on their own.

That is what isolated means here. The Agent trusts no DNS, no corporate proxy, and no human standing by. The peer's identity ships with the token.

## What operations and I can see

Isolation lives in every query. HTTP endpoints that move a device go through `ownsDevice(userId, deviceId)` first, with `where user_id` in the SQL. Then the in-memory socket table checks again.

```ts
// src/lib/fleet/live.ts
export function sendToDevice(userId: string, deviceId: string, payload: unknown): boolean {
  const slot = store().byDevice.get(deviceId);
  if (!slot || slot.userId !== userId) return false;
  if (slot.ws.readyState !== OPEN) return false;
  slot.ws.send(JSON.stringify(payload));
  return true;
}
```

Both checks stay on purpose. The day a new endpoint forgets `ownsDevice`, the frame still cannot leave. Frames reach a device through one exit only, `sendToDevice`, and it requires a `userId`. `kickUser` is the only function that walks sockets across a set, and all it does is `close(1008, "token reset")`, with no send in it.

On the `/ops` page, `isOpsAdmin` refuses super, refuses banned, refuses anyone without an email, and accepts only cookie emails listed in `ADMIN_EMAILS`. Anyone off the list gets a 404, and the page does not hint that it exists. Neither `HUB_TOKEN` nor Fleet-OAEP opens it.

What shows up there is whatever `deviceOpsPublic` projects, `id`, `os`, `arch`, `agentVer`, `online`, `lastSeen`, `userId`. A device is a string of UUID. The `name`, `hostname` and `ip` keys in `SENSITIVE_KEYS` get pulled out of the whole response by `stripSensitive`.

One thing can be changed. Three routes, `GET /ops`, `GET /v1/ops/overview`, `POST /v1/ops/banned`, and the last one puts a banned flag on an account, where `banTargetError` refuses to flag yourself or another admin. Flagging it does not even drop the connection, it turns into a 403 at the next authentication. There is no run in `ops.mjs`, no device stub, no `sendToDevice`.

## Where I can walk through

All of the above holds against log leaks, read-only dumps, and a machine in the middle of the path. Against me with write access to the server, it does not hold.

Dump the database read-only and you get `token_hash`, `kid`, `pub`, `priv`, `aud`. The handshake stays out of reach, because `sec` is not in there, only `sha256(sec)` is, and the wrap has to produce `sec` itself.

`priv` living in the database deserves its own note. Whoever holds it can forge challenge signatures at clients, which amounts to the ability to play the hub. That does not take over the account directly, though it is the precondition for a machine in the middle. A `priv` leak and a `sec` leak differ in kind, and neither is small.

Write access is another matter. `mintTokenV1` signs a fresh token, the upsert writes it in, `kickUser` follows, and the account is mine. I cannot stop that path. Any claim that the hub is incapable of misbehaving would be a lie.

The Worker also has a `HUB_TOKEN`. Set it and you have super, `owns()` returns true unconditionally, and you can send run to any online device. It cannot steal a device WebSocket, since `canClaimDevice("user-a", "*")` is false, but the command goes through. The new-user path has no need for it, so leave it unset. The website path in `v1.server.ts` has no `HUB_TOKEN` branch at all.

Whatever backstops this layer therefore does not live on the hub.

## The last one sits on your own machine

Permit is local state. The protocol has no `set_permit` message, so the hub cannot change it. The `devices.permit` column is a mirror, reported by the agent in a ping and updated by the hub for the list view. Device to hub, never back.

Two places change it, both on that machine, a right-click in the tray or the local page on `127.0.0.1:17890`, bound to loopback only.

`inputVerdict` has three states. At off, or not enabled, run and type are both refused, returning exit 126 with a `permit=off` line, and panes already open are refused the same way. At ask, the command waits there until you tap on the machine, later keystrokes need a tap too, grants stay separate, a screenshot grant carries no input grant, and grants clear when the socket drops. At allow it runs, with a local `devicePolicyBlocked` still holding back `shutdown`, `reboot`, `mkfs`, `format c:`, `diskpart`, and `rm -rf` without an absolute path. That regex catches slips only, so do not treat it as a security boundary.

Even with the hub taken over by me, even with the token leaked, a machine at `permit=off` still refuses to execute. It is the one constraint that requires no trust in the hub.

## The holes left over

`allow` hands that machine to whoever holds the token. It is supposed to look like that.

`read_screen` and `list_panes` do not consult permit. They execute nothing, and at `permit=off` they will still return pane snapshots. For full silence, turn Enabled off.

Ban does not drop the connection, it becomes a 403 at the next authentication.

Lid-close sleep is not blocked. Unnotarized Mac builds still get quarantined by Gatekeeper.

One token covers every device under the account. Splitting privileges today means splitting accounts.

Every line above is readable in the repo, `src/lib/fleet/v1.server.ts`, `packages/fleet-worker/src/tokenv1.mjs`, `src/lib/fleet/live.ts`, `packages/fleet-worker/src/ops.mjs`, `packages/fleet-agent/main.go`.
