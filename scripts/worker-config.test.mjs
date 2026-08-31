import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Worker ships Cloudflare STUN as its public RTC default", async () => {
  const config = await readFile(
    new URL("../packages/fleet-worker/wrangler.toml", import.meta.url),
    "utf8",
  );

  assert.match(config, /^RTC_STUN_URLS\s*=\s*"stun:stun\.cloudflare\.com:3478"\s*$/m);
});
