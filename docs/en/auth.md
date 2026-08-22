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
