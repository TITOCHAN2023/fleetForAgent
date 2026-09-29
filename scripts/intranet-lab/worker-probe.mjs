import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  highSecAuthorization,
  verifyTokenV1,
  verifyFleetStatement,
} from "../../packages/fleet-worker/src/tokenv1.mjs";
import { isFinishedResult } from "../../packages/fleet-tool/operator.mjs";
import { createRtcManager } from "../../packages/fleet-tool/rtc.mjs";
const { token, cookie } = JSON.parse(readFileSync("/evidence/seed.json", "utf8"));
const url = "http://hub:8787";
const operatorId = "fleet-herdr-lab";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(path, body) {
  const authorization = await highSecAuthorization(token, url);
  const res = await fetch(url + path, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", "x-fleet-operator": operatorId },
    body: JSON.stringify(body),
  });
  const value = await res.json();
  assert.ok(res.ok, JSON.stringify(value));
  return value;
}
let computers = [];
for (let i = 0; i < 100; i++) {
  computers = (await rpc("/v1/list_computers", {})).computers?.filter((c) => c.online) || [];
  if (computers.length === 2) break;
  await pause(200);
}
assert.equal(computers.length, 2, "two real agents online");
// Use an actual browser session on the real Worker, then prove rejection did
// not rotate the machine token used below.
assert.ok(cookie?.startsWith("fleet_session="));
for (const origin of ["http://evil.hub:8787", "https://attacker.invalid", "null"]) {
  const res = await fetch(url + "/v1/hub_token", {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 403, origin);
}
const sameOrigin = await fetch(url + "/v1/me", { headers: { cookie } });
assert.equal(sameOrigin.status, 200, "seeded session is valid");
console.log("PASS: real Worker rejects cross-origin cookie writes; session remains valid");
const rtc = createRtcManager({
  hubPost: rpc,
  token,
  operatorId,
  verifyTokenV1,
  verifyFleetStatement,
  officialPlugin: () => null,
});
async function direct(path, body) {
  const row = await rtc.tryRpc(path, body);
  assert.equal(row.handled, true, `RTC did not handle ${path}`);
  assert.equal(row.transport, "rtc");
  return row.value;
}
async function done(device, corr, expectedExit = 0) {
  for (let i = 0; i < 100; i++) {
    const row = await direct("/v1/get_result", { device_id: device, corr });
    if (isFinishedResult(row)) {
      if (expectedExit === 0) assert.equal(row.ok, true, JSON.stringify(row));
      assert.equal(row.exit_code, expectedExit);
      return row;
    }
    await pause(100);
  }
  throw new Error("command never finished");
}
async function screen(device, corr, marker) {
  let row;
  for (let i = 0; i < 80; i++) {
    row = await direct("/v1/read_screen", { device_id: device, corr });
    if (JSON.stringify(row).includes(marker)) return;
    await pause(100);
  }
  throw new Error(`screen lacks ${marker}: ${JSON.stringify(row)}`);
}
try {
  for (const device of computers) {
    const id = device.id;
    const one = await direct("/v1/run", { device_id: id, command: 'printf %s "$HOSTNAME"' });
    assert.equal((await done(id, one.corr)).stdout.trim(), device.name);
    for (const backend of ["tmux", "herdr", "pty"]) {
      const command = `FLEET_BACKEND_TYPE=${backend} fleet-agent session lab`;
      const first = await direct("/v1/run", { device_id: id, command });
      // Synchronize on the shell prompt before typing: creation can take time.
      await screen(id, first.corr, "#");
      await direct("/v1/type", {
        device_id: id,
        corr: first.corr,
        keys: "FLEET_LAB_VALUE=retained; printf 'initialized%s\\n' '-ok'\r",
      });
      await screen(id, first.corr, "initialized-ok");
      for (const [index, key] of ["ctrl+c", "ctrl+\\"].entries()) {
        await direct("/v1/type", {
          device_id: id,
          corr: first.corr,
          keys: `printf 'sleeping%s\\n' '-${index}'; sleep 60\r`,
        });
        await screen(id, first.corr, `sleeping-${index}`);
        await pause(200);
        await direct("/v1/type", { device_id: id, corr: first.corr, key });
        await direct("/v1/type", {
          device_id: id,
          corr: first.corr,
          keys: `printf 'interrupted%s\\n' '-${index}'\r`,
        });
        await screen(id, first.corr, `interrupted-${index}`);
        assert.equal(
          isFinishedResult(await direct("/v1/get_result", { device_id: id, corr: first.corr })),
          false,
        );
      }
      if (backend === "pty") {
        const close = await direct("/v1/run", {
          device_id: id,
          command: "FLEET_BACKEND_TYPE=pty fleet-agent session close lab",
        });
        const rejected = await done(id, close.corr, 1);
        assert.match(JSON.stringify(rejected), /does not support closing sessions by name/);
        await direct("/v1/type", { device_id: id, corr: first.corr, keys: "\u001d" });
        await done(id, first.corr);
        console.log(
          `PASS: ${device.name} pty interrupts preserve viewer; named close explicitly rejected`,
        );
        continue;
      }
      await direct("/v1/type", { device_id: id, corr: first.corr, keys: "\u001d" });
      await done(id, first.corr);
      const next = await direct("/v1/run", { device_id: id, command });
      await screen(id, next.corr, "#");
      await direct("/v1/type", {
        device_id: id,
        corr: next.corr,
        keys: "printf 'state:%s\\n' \"$FLEET_LAB_VALUE\"\r",
      });
      await screen(id, next.corr, "state:retained");
      await direct("/v1/type", { device_id: id, corr: next.corr, keys: "\u001d" });
      await done(id, next.corr);
      const close = await direct("/v1/run", {
        device_id: id,
        command: `FLEET_BACKEND_TYPE=${backend} fleet-agent session close lab`,
      });
      await done(id, close.corr);
      console.log(
        `PASS: ${device.name} ${backend} via real Worker + direct RTC: open/type/screen/interrupt/detach/reattach/state/close`,
      );
    }
  }
} finally {
  await rtc.shutdown();
}
console.log("PASS: two-endpoint Worker/RTC session lab");
