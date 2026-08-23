# Why the Fleet MCP tool is safe

If the **hub token (`flt_1…`) never leaves your machine**, nobody else can drive your computers through the MCP tool. This note starts from why we use asymmetric encryption, walks every place an attacker might try, and shows why each path fails.

Sign-in and token issuance: [auth.md](auth.md). This page is only the **MCP / Agent control channel**.

---

## Bottom line

| Who | Can they use MCP on your machines? |
| --- | --- |
| Someone who has your `flt_1` string (you, or the env you pasted into Cursor) | Yes. That is the product. |
| A website login cookie (yours, someone else’s, or an ops admin) | Not on another person’s machines. `/ops` can view status and ban accounts only. |
| A dump of production Durable Object storage | No plaintext token, so no MCP identity. |
| A captured `Authorization` header on the wire | A one-shot OAEP wrap, not the token. |
| GitHub source / a developer clone | No. |

**Leaking the token is handing over the key.** Nothing else opens this channel. If you think it leaked: reset the token in Settings. The old key dies immediately and every connected Agent is kicked (`1008 token reset`). Devices must pair again with the new string.

---

## Why asymmetric encryption

If the MCP client sent `flt_1…` as `Authorization: Bearer` on every call:

1. **The key would be on the wire.** Proxies, CDN edges, HAR files, support logs, and browser extensions that see decrypted HTTPS could keep it and replay forever.
2. **If the hub stored “the user’s token” in plaintext, a database read would be MCP access.** A backup or a mistaken dump would remote-control the fleet.
3. **Bearer has no notion of “this request”.** Steal it once, use it until someone remembers to rotate.

So v1 never sends Bearer. Settings mints a per-account **RSA-2048** pair:

- The **private key** stays on the hub (Durable Object user row `priv`). It unwraps client blobs and PSS-signs challenges.
- The **public key** and a random **secret (`sec`)** live in the string you copy: `flt_1.<payload>.<sig>`. The payload is PSS-signed with the same key and bound to `aud = HUB_ORIGIN` (for example `https://fleet.ginfo.cc`), never the HTTP `Host` header, so a copied token cannot be replayed against another origin.

Agents and MCP **never put `flt_1` in a header**. Each connect or action:

1. `GET /v1/challenge?kid=…` — the hub PSS-signs a short-lived nonce (about two minutes; at most eight unused challenges per kid).
2. The client RSA-OAEP-wraps `{ sec, nonce }` with the **public** key from the token.
3. The header is only `Authorization: Fleet-OAEP <kid>.<wrap>`.
4. The hub unwraps with the private key, checks the nonce is one it just signed, and that `SHA-256(sec)` equals the stored `tokenHash`. Only then is the caller that account.

`sec` is not on the wire and not in the database. The database has a hash. Public encrypt / private decrypt: a sniffer without the private key cannot open the wrap; someone who reads the private key still cannot mint a wrap whose `sec` hashes to `tokenHash`. Both pieces are required, and `sec` exists only inside the token you pasted.

The token is **shown once**, at generate or reset. Later GET `/v1/hub_token` returns whether a token exists, a prefix, and a timestamp — never the secret again.

---

## Attack surfaces (and why they fail)

### 1. Intercept MCP / Agent HTTPS or WSS

The capture is a `Fleet-OAEP` wrap plus a challenge signature. Without the private key you cannot recover `{sec, nonce}`. Even the hub, which can unwrap, deletes the nonce after use and rejects expiry. The wrap does not replay.

### 2. Read production storage (Durable Objects)

The device catalog is ids, online flags, OS, lastSeen. The user row has `priv` and `tokenHash`, **not** the `flt_1` string. SHA-256 of a 32-byte random `sec` is not reversible. Without `sec`, step 4 fails and there is no MCP identity.

### 3. Impersonate a website cookie

A login cookie is **that account only**. Operator APIs require `owns()`: `device.userId === current user`. Cookie A against device B is 404. A cookie also cannot mint the `flt_1` string. Driving a machine is MCP + token, not the website console typing commands for you.

`/ops` admins are separate: usage and freshness, plus Ban. Ban **cannot operate machines**. Overview strips hostname and IP. An admin cookie is not Fleet-OAEP and never enters the MCP channel.

### 4. GitHub developers, cloning the repo

The repo has no production tokens, user private keys, or sessions. Source explains the protocol; it does not log you in.

### 5. Steal the device WebSocket

Devices **dial out** to `WSS /v1/device`. No inbound port. An unbound device can be claimed by the signed-in owner; once account A holds it, account B (and the HTTP super-token identity `*`) cannot take the socket. A new connection kicks the old one on the same device so two operators cannot steer it at once.

### 6. Reset the token

Reset deletes the old keypair and hash, issues a new `flt_1` (shown once), and closes every live WebSocket for that account (`1008 token reset`). The old token fails immediately. That is the owner changing the lock: every device must pair again. An attacker never sees the new plaintext.

### 7. The token actually leaks

If someone gets the full `flt_1` (chat logs, screenshots, a committed `mcp.env`, a shared Cursor config), they can complete the OAEP handshake and drive **machines already connected under that account**. That is the only MCP break that works. Fix: reset now; old sockets drop; put the new token only on your machine.

---

## What you must protect

1. Keep the token on your machine: `~/.fleet/mcp.env` or MCP config. Do not paste it into chats, issues, screenshots, or shared drives.
2. If you think it leaked, reset. Expect every device to need the new token.
3. Do not generate a token on someone else’s computer while logged into your fleet.ginfo.cc account.

Do that, and using Fleet MCP on your own Windows / Linux / macOS boxes is locked to everyone else. The key is the token; if the key stays with you, the door does not open for them.
