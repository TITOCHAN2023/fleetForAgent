#!/bin/sh
set -eu
mkdir -p /data/sandbox
mkdir -m 700 -p /dev/shm/fleet-room-state
printf '%s\n' '{"enabled":true,"permit":"allow","hubInput":"http://hub:8787","hubToken":"room-lab-only","deviceId":""}' >/data/sandbox/config.json
export FLEET_HOME=/data/sandbox FLEET_ENABLED=true FLEET_BACKEND_TYPE=pty
/lab/fleet-agent >/data/device.log 2>&1 &
device_pid=$!
node /app/packages/fleet-room/cli.mjs /data/runner.json &
runner_pid=$!
trap 'kill "$runner_pid" "$device_pid" 2>/dev/null || true; wait || true' EXIT INT TERM
wait "$runner_pid"
