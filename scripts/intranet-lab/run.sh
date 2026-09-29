#!/usr/bin/env bash
# Linux two-pod intranet lab. Each container is capped at 1 CPU / 1 GiB.
# Hub is a third capped container. Tool stays on the host (curl/python).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lab_dir="$repo_root/scripts/intranet-lab"
token="${FLEET_LAB_TOKEN:-lab-intranet}"
hub_port="${FLEET_LAB_HUB_PORT:-18787}"
cpus="${FLEET_LAB_CPUS:-1}"
mem="${FLEET_LAB_MEM:-1g}"
docker_bin="${FLEET_LAB_DOCKER:-sudo -n docker}"
tag="fleet-lab-linux"
run_id="fleet-lab-$$"
net="${run_id}-net"
hub_ctr="${run_id}-hub"
a_ctr="${run_id}-pod-a"
b_ctr="${run_id}-pod-b"
work="${TMPDIR:-/tmp}/${run_id}"
mkdir -p "$work"

log() { printf '[intranet-lab] %s\n' "$*"; }

cleanup() {
  local c
  for c in "$a_ctr" "$b_ctr" "$hub_ctr"; do
    $docker_bin rm -f "$c" >/dev/null 2>&1 || true
  done
  $docker_bin network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker() { $docker_bin "$@"; }

log "build static agent"
(
  cd "$repo_root/packages/fleet-agent"
  CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o "$work/fleet-agent" .
)
if [[ ! -d "$repo_root/packages/fleet-hub/node_modules/ws" ]]; then
  log "npm install ws for hub image"
  (cd "$repo_root/packages/fleet-hub" && npm install --omit=dev --ignore-scripts)
fi

log "build images (alpine agent + node hub)"
cp "$work/fleet-agent" "$lab_dir/fleet-agent"
docker build -t "${tag}-agent" -f "$lab_dir/Dockerfile.agent" "$lab_dir"
docker build -t "${tag}-hub" -f "$lab_dir/Dockerfile.hub" "$repo_root"
rm -f "$lab_dir/fleet-agent"

limit=(
  --cpus="$cpus"
  --memory="$mem"
  --memory-swap="$mem"
  --pids-limit 128
  --security-opt no-new-privileges
)
# Host HTTP proxy would send hub:8787 to the corp relay.
noproxy=(
  -e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy=
  -e NO_PROXY='*' -e no_proxy='*'
)

log "network $net"
docker network create "$net" >/dev/null

log "hub $hub_ctr (1c1g)"
docker run -d --name "$hub_ctr" --network "$net" --network-alias hub \
  "${limit[@]}" "${noproxy[@]}" \
  -p "127.0.0.1:${hub_port}:8787" \
  -e SELF_HOST_TOKEN="$token" \
  -e HOST=0.0.0.0 \
  -e PORT=8787 \
  "${tag}-hub" >/dev/null

for name in pod-a pod-b; do
  ctr="${run_id}-${name}"
  log "agent $ctr (1c1g)"
  docker run -d --name "$ctr" --network "$net" --hostname "$name" \
    "${limit[@]}" "${noproxy[@]}" \
    -e FLEET_URL=http://hub:8787 \
    -e FLEET_TOKEN="$token" \
    -e FLEET_NAME="$name" \
    -e FLEET_HOME=/data \
    -e FLEET_ENABLED=true \
    -e FLEET_BACKEND_TYPE=pty \
    "${tag}-agent" >/dev/null
done

log "assert docker 1c1g caps"
FLEET_LAB_DOCKER="$docker_bin" python3 - "$hub_ctr" "$a_ctr" "$b_ctr" <<'PY'
import json, os, subprocess, sys
cmd = os.environ.get("FLEET_LAB_DOCKER", "sudo -n docker").split()
want_mem = 1024 * 1024 * 1024
want_cpu = 1_000_000_000
for name in sys.argv[1:]:
    raw = subprocess.check_output(cmd + ["inspect", name], text=True)
    cfg = json.loads(raw)[0]["HostConfig"]
    mem, cpu = int(cfg.get("Memory") or 0), int(cfg.get("NanoCpus") or 0)
    if mem != want_mem or cpu != want_cpu:
        raise SystemExit(f"{name} caps mem={mem} cpu={cpu} want 1GiB/1cpu")
    print(f"  {name}: memory={mem} nano_cpus={cpu}")
PY

log "probe two pods via hub"
if ! python3 "$lab_dir/probe.py" "http://127.0.0.1:${hub_port}" "$token"; then
  log "hub logs"; docker logs "$hub_ctr" || true
  log "pod-a logs"; docker logs "$a_ctr" || true
  log "pod-b logs"; docker logs "$b_ctr" || true
  exit 1
fi

log "docker stats (one sample)"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  "$hub_ctr" "$a_ctr" "$b_ctr"

log "ok"
