#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { RoomRunner } from "./runner.mjs";

const filename = process.argv[2];
if (!filename) { console.error("Usage: node packages/fleet-room/cli.mjs CONFIG.json (Node >=22.16). Token is read from FLEET_TOKEN, never from command arguments."); process.exit(2); }
const config = JSON.parse(readFileSync(filename, "utf8"));
if (config.token) throw new Error("Do not store tokens in a Room config; use FLEET_TOKEN");
const runner = new RoomRunner({ ...config, token: process.env.FLEET_TOKEN });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await runner.stop(); }
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try { await runner.start(); console.error(`Fleet Room Agent ${config.id} ready; history stays on its leader.`); }
catch (e) { console.error(`Room startup failed: ${e.code || e.name}`); await stop(); process.exitCode = 1; }
