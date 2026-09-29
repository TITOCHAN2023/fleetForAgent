import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHub } from "../fleet-hub/index.mjs";
import { RoomConnection } from "./client.mjs";

test("Room HTTP preserves Chinese text split across TCP chunks", async (t) => {
  const token = "utf8-test-only";
  const hub = createHub({ token });
  await new Promise((r) => hub.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${hub.server.address().port}`;
  const leader = new RoomConnection({ url, token, id: "leader", mode: "runtime", leader: true, onRequest: async (m) => m.input });
  t.after(async () => { leader.close(); await hub.close(); });
  await leader.connect();
  const text = "中文跨块测试";
  const body = Buffer.from(JSON.stringify({ leaderId: "leader", action: "messages.send", input: { text } }));
  const split = body.indexOf(Buffer.from("中")) + 1;
  const response = await new Promise((resolve, reject) => {
    const req = http.request(url + "/v1/room-control", { method: "POST", headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on("error", reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 30);
  });
  assert.deepEqual(response, { text });
});
