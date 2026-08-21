#!/usr/bin/env node
/**
 * KEEL device daemon — run on each Mac / Windows / Linux box.
 * Connects OUT over WSS. Never opens an inbound port.
 *
 *   KEEL_URL=wss://keel.example.com/v1/device \
 *   KEEL_DEVICE_ID=mac-mini-home \
 *   KEEL_TOKEN=dt_... \
 *   node index.mjs
 */
import { spawn } from "node:child_process";
import os from "node:os";

const url = process.env.KEEL_URL;
const deviceId = process.env.KEEL_DEVICE_ID;
const token = process.env.KEEL_TOKEN;
if (!url || !deviceId || !token) {
  console.error("Need KEEL_URL, KEEL_DEVICE_ID, KEEL_TOKEN");
  process.exit(1);
}

const caps = ["shell"];
let socket;
let backoff = 1000;

function connect() {
  socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Device-Id": deviceId,
      "X-Fleet-Proto": "1",
    },
  });

  socket.addEventListener("open", () => {
    backoff = 1000;
    send({
      v: 1,
      type: "hello",
      id: crypto.randomUUID(),
      t: Date.now(),
      body: {
        os: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux",
        arch: os.arch(),
        hostname: os.hostname(),
        caps,
        agent_ver: "0.1.0",
      },
    });
  });

  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "ping") {
      send({ v: 1, type: "pong", id: crypto.randomUUID(), t: Date.now(), body: {}, corr: msg.id });
      return;
    }
    if (msg.type === "run") void runCommand(msg);
    if (msg.type === "cancel") {
      /* v1: one command, process killed in a later revision */
    }
  });

  socket.addEventListener("close", () => {
    const wait = backoff;
    backoff = Math.min(backoff * 2, 15000);
    setTimeout(connect, wait);
  });

  socket.addEventListener("error", () => {
    socket?.close();
  });
}

function send(obj) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function runCommand(msg) {
  const command = String(msg.body?.command ?? "");
  const corr = msg.corr ?? msg.id;
  const shell = process.platform === "win32" ? ["cmd.exe", "/c", command] : ["/bin/sh", "-c", command];
  const child = spawn(shell[0], shell.slice(1), { timeout: Number(msg.body?.timeout_ms) || 25000 });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (buf) => {
    const data = buf.toString("utf8");
    stdout += data;
    send({ v: 1, type: "chunk", id: crypto.randomUUID(), corr, t: Date.now(), body: { stream: "stdout", data } });
  });
  child.stderr?.on("data", (buf) => {
    stderr += buf.toString("utf8");
  });
  child.on("close", (code) => {
    send({
      v: 1,
      type: "result",
      id: crypto.randomUUID(),
      corr,
      t: Date.now(),
      body: { ok: code === 0, exit_code: code ?? 1 },
    });
    void stdout;
    void stderr;
  });
}

connect();
