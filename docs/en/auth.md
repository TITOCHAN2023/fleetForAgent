# Sign-in

Product login is **Google / X**. Email/password was a temporary path while binding the site to the `fleet.ginfo.cc` Worker. Do not treat it as the main flow.

## Two environments — do not mix

| Environment | How you sign in | Callback |
|---|---|---|
| Local / Grok preview `*.grok-sandbox.com` | TanStack + Better Auth, via the **Grok broker** (`auth.grok.me`) to Google/X | Preview client only allows `*.grok-sandbox.com` |
| Production `https://fleet.ginfo.cc` | Same buttons; the Worker uses **native Google / X OAuth** | See below |

The Grok preview client **must not** be used on `fleet.ginfo.cc`. `redirect_uri` will not match and the broker will reject it. Do not put `PREVIEW_CLIENT_ID` on the production domain.

## Production secrets

In `packages/fleet-worker`:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put X_CLIENT_ID
npx wrangler secret put X_CLIENT_SECRET
```

Google Cloud: Web application, authorized redirect URI:

```
https://fleet.ginfo.cc/v1/auth/callback/google
```

X developer portal OAuth 2.0, callback:

```
https://fleet.ginfo.cc/v1/auth/callback/x
```

If these are unset, the buttons open an explicit error page. Do not add email/password login again. `/v1/register` and `/v1/login` are closed.

Google must return a verified email (`verified_email: true`). X accounts are keyed by user id (`{id}@x.oauth.fleet`), so a renamed handle does not switch accounts.

## High-security hub token (`flt_1`)

Settings mints a per-account RSA-2048 keypair. The string you copy is `flt_1.<payload>.<sig>`: it carries the public key and a secret, and is bound to `HUB_ORIGIN` (`https://fleet.ginfo.cc`), never the HTTP Host header.

Agents and the local stdio MCP do not send that string unchanged as `Authorization: Bearer`. They:

1. `GET /v1/challenge?kid=…` — the hub PSS-signs a nonce with the matching private key.
2. OAEP-wrap `{sec, nonce}` with the public key from the token.
3. Send `Authorization: Fleet-OAEP <kid>.<wrap>` on WSS `/v1/device` and on every operator HTTPS call.

Remote MCP is the explicit Bearer exception. The recommended Streamable HTTP endpoint is `POST /mcp`: initialize sends `Authorization: Bearer <token>`, the response returns a random `Mcp-Session-Id`, and later JSON-RPC requests use the same `/mcp` endpoint. Classic SSE remains at `/mcp/sse`: the initial GET sends Bearer and the Worker announces a random `/mcp/sse?sessionId=…` message endpoint. Neither transport puts the token in a URL, and every JSON-RPC message rechecks the account's current key id, so a token reset invalidates the next call.

Resetting the token deletes the old keypair and closes every live device WebSocket for that account (`1008 token reset`). Legacy `flt_` hex Bearer is rejected with an English `HIGH_SEC` error: update the agent / MCP client, then issue a new token.

`HUB_ORIGIN` is set in `packages/fleet-worker/wrangler.toml` `[vars]`. Optional `HUB_TOKEN` remains HTTP-only super for list/run; it cannot steal a device WebSocket.

Optional `ADMIN_EMAILS` is a different secret: cookie-session emails that may open `/ops` on this Worker. Empty = no admins. Not `HUB_TOKEN` / `actor.super` / `Fleet-OAEP`.

```bash
npx wrangler secret put ADMIN_EMAILS
```
