import assert from "node:assert/strict";
const url = process.argv[2], token = "room-lab-only";
async function request(path, body) {
  const r = await fetch(url + path, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data;
}
const control = (action, input) => request("/v1/room-control", { leaderId: "leader", action, input });
async function until(fn) {
  let value;
  for (let i = 0; i < 120; i++) { try { value = await fn(); if (value) return value; } catch (error) { value = { error: error.message }; } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error("Room lab timed out: " + JSON.stringify(value));
}
const computers = await until(async () => { const { computers } = await request("/v1/list_computers", {}); return computers.length === 2 && computers.every((c) => c.online) && computers; });
await until(async () => (await request("/v1/room-agents")).agents.filter((a) => a.callable).length === 2);
const a = computers.find((c) => c.name === "pod-a"), b = computers.find((c) => c.name === "pod-b");
assert.ok(a && b);
await control("rooms.create", { id: "lab-room", leaderId: "leader", defaultDeviceId: a.id });
await control("rooms.invite", { roomId: "lab-room", agentId: "peer" });
for (const [id, deviceId, expected] of [["default", undefined, "pod-a"], ["override", b.id, "pod-b"]]) {
  const { task } = await control("tasks.delegate", { roomId: "lab-room", requestId: id, assigneeId: "peer", sessionId: "lab-room", description: "Read hostname using fleet_run", completionCriteria: "Report target hostname", ...(deviceId ? { deviceId } : {}) });
  const done = await until(async () => { const { task: state } = await control("tasks.get", { roomId: "lab-room", taskId: task.id }); if (["failed", "unknown"].includes(state.status)) throw new Error(JSON.stringify(state)); return state.status === "completed" && state; });
  assert.match(done.result, new RegExp(expected));
  console.log(JSON.stringify({ task: id, expectedDevice: expected, status: done.status, result: done.result }));
}
const { room } = await control("rooms.get", { roomId: "lab-room" });
assert.equal(room.defaultDeviceId, a.id);
console.log("PASS: two real Fleet endpoints; cross-device default and override preserve the room default");
