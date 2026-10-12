#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lab_work="$(mktemp -d /tmp/fleet-room-lab.XXXXXX)"
lab_id="fleet-room-lab-$$"
docker() { sudo -n docker "$@"; }
cleanup() {
  docker rm -f "$lab_id-a" "$lab_id-b" "$lab_id-hub" >/dev/null 2>&1 || true
  docker network rm "$lab_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
(cd "$repo_root/packages/fleet-agent" && CGO_ENABLED=0 go build -buildvcs=false -trimpath -o "$lab_work/fleet-agent" .)
mkdir -p "$lab_work/a" "$lab_work/b"
cat >"$lab_work/a/runner.json" <<'EOF'
{"id":"leader","name":"pod-a-codex","leader":true,"url":"http://hub:8787","dataDir":"/data/room","fleetHome":"/data/sandbox","command":"node","args":["/app/scripts/room-lab/acp-device.mjs"],"cwd":"/data"}
EOF
cat >"$lab_work/b/runner.json" <<'EOF'
{"id":"peer","name":"pod-b-grok","url":"http://hub:8787","dataDir":"/data/room","cliStateDir":"/dev/shm/fleet-room-state","command":"node","args":["/app/scripts/room-lab/acp-device.mjs"],"cwd":"/data"}
EOF
docker network create "$lab_id" >/dev/null
limits=(--cpus=1 --memory=1g --memory-swap=1g --pids-limit=128 --security-opt=no-new-privileges --user="$(id -u):$(id -g)")
mounts=(-v "$repo_root:/app:ro" -v "$lab_work:/lab:ro" -w /app)
envs=(-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e NO_PROXY='*' -e no_proxy='*')
docker run -d --name "$lab_id-hub" --network "$lab_id" --network-alias hub "${limits[@]}" "${mounts[@]}" "${envs[@]}" -p 127.0.0.1::8787 -e SELF_HOST_TOKEN=room-lab-only -e HOST=0.0.0.0 -e PORT=8787 node:22.22.0-bookworm-slim node packages/fleet-hub/index.mjs >/dev/null
for side in a b; do
  docker run -d --name "$lab_id-$side" --network "$lab_id" --hostname "pod-$side" "${limits[@]}" "${mounts[@]}" "${envs[@]}" -v "$lab_work/$side:/data" -e FLEET_URL=http://hub:8787 -e FLEET_TOKEN=room-lab-only -e "FLEET_NAME=pod-$side" node:22.22.0-bookworm-slim sh scripts/room-lab/endpoint.sh >/dev/null
done
docker inspect "$lab_id-hub" "$lab_id-a" "$lab_id-b" --format '{{.Name}} cpu={{.HostConfig.NanoCpus}} memory={{.HostConfig.Memory}}'
lab_port="$(docker port "$lab_id-hub" 8787/tcp | cut -d: -f2)"
if ! node "$repo_root/scripts/room-lab/probe.mjs" "http://127.0.0.1:$lab_port"; then
  for ctr in hub a b; do docker logs "$lab_id-$ctr"; done
  exit 1
fi
test -f "$lab_work/a/room/room.sqlite"
test ! -e "$lab_work/b/room/room.sqlite"
printf 'PASS: only leader has a Room database; artifacts: %s\n' "$lab_work"
