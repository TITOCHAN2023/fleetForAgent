#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
TRANSFER_ROOT=$(CDPATH= cd -- "$ROOT/../fleet-transfer-plugin" && pwd)
HELPER="$SCRIPT_DIR/helper.mjs"
WRANGLER="$ROOT/packages/fleet-worker/node_modules/.bin/wrangler"
RUN_EXTENDED=0
IMAGE=${FLEET_VM_IMAGE:-node:22-bookworm-slim}

usage() {
  echo "usage: $0 [--extended]" >&2
  echo "  --extended also exercises explicit cancel cleanup" >&2
}

while (($#)); do
  case "$1" in
    --extended) RUN_EXTENDED=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

for command in docker go node curl; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done
[[ -x "$WRANGLER" ]] || { echo "Wrangler is not installed at $WRANGLER" >&2; exit 1; }

echo "[0/9] Self-testing strict transfer-state assertions"
node "$HELPER" self-test

if [[ -n ${FLEET_VM_RUN_ROOT:-} ]]; then
  VM_RUN_ROOT=$FLEET_VM_RUN_ROOT
else
  mkdir -p "$SCRIPT_DIR/.runs"
  VM_RUN_ROOT=$(mktemp -d "$SCRIPT_DIR/.runs/fleet-plugin-peer-vm.XXXXXX")
fi
export VM_RUN_ROOT
mkdir -p "$VM_RUN_ROOT/artifacts" "$VM_RUN_ROOT/logs" "$VM_RUN_ROOT/wrangler-state" "$VM_RUN_ROOT/xdg"
chmod 700 "$VM_RUN_ROOT"

SUFFIX="$$-$(node "$HELPER" random | cut -c1-12)"
NETWORK="fleet-peer-vm-$SUFFIX"
AGENT_A="fleet-peer-a-$SUFFIX"
AGENT_B="fleet-peer-b-$SUFFIX"
TOOL="fleet-peer-tool-$SUFFIX"
WRANGLER_PID=""
TRANSFER_PID=""
TRANSFER_LABEL=""
TRANSFER_OUT=""
TRANSFER_PROGRESS=""

cleanup() {
  local status=${1:-$?}
  trap - EXIT INT TERM
  if [[ -n "$TRANSFER_PID" ]] && kill -0 "$TRANSFER_PID" 2>/dev/null; then
    kill "$TRANSFER_PID" 2>/dev/null || true
    wait "$TRANSFER_PID" 2>/dev/null || true
  fi
  docker logs "$AGENT_A" >"$VM_RUN_ROOT/logs/agent-a.log" 2>&1 || true
  docker logs "$AGENT_B" >"$VM_RUN_ROOT/logs/agent-b.log" 2>&1 || true
  docker logs "$TOOL" >"$VM_RUN_ROOT/logs/tool.log" 2>&1 || true
  docker rm -f "$TOOL" "$AGENT_A" "$AGENT_B" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [[ -n "$WRANGLER_PID" ]] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  if ((status == 0)); then
    echo "VM verification passed. Evidence: $VM_RUN_ROOT"
    echo "Success evidence is intentionally retained; remove it manually after review."
  else
    echo "VM verification failed. Containers were stopped; complete failure evidence is retained at: $VM_RUN_ROOT" >&2
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

echo "[1/9] Checking the local linux/arm64 Docker runtime"
docker info >"$VM_RUN_ROOT/logs/docker-info.txt"
DOCKER_ARCH=$(docker info --format '{{.Architecture}}')
case "$DOCKER_ARCH" in
  arm64|aarch64) ;;
  *) echo "Docker daemon architecture is $DOCKER_ARCH; this harness requires linux/arm64" >&2; exit 1 ;;
esac

echo "[2/9] Building the exact linux/arm64 Agent and transfer binary"
(
  cd "$ROOT/packages/fleet-agent"
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
    go build -trimpath -o "$VM_RUN_ROOT/artifacts/fleet-agent" .
)
(
  cd "$TRANSFER_ROOT"
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
    go build -trimpath -buildvcs=false -ldflags "-s -w" \
    -o "$VM_RUN_ROOT/artifacts/fleet-transfer-plugin-linux-arm64" .
)
chmod 700 "$VM_RUN_ROOT/artifacts/fleet-agent" "$VM_RUN_ROOT/artifacts/fleet-transfer-plugin-linux-arm64"
node "$HELPER" check >"$VM_RUN_ROOT/logs/artifact-check.json"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >"$VM_RUN_ROOT/logs/docker-pull.log"
# Colima does not normally share macOS $TMPDIR (/var/folders) with its VM. A
# missing bind source is silently materialized as a directory, which otherwise
# looks like an Agent permission failure much later. Prove both mounts now.
docker run --rm --platform linux/arm64 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$VM_RUN_ROOT/artifacts/fleet-agent:/probe/fleet-agent:ro" \
  -v "$ROOT:/workspace:ro" \
  "$IMAGE" sh -c \
    'test -f /probe/fleet-agent && test -f /workspace/packages/fleet-tool/index.mjs && /probe/fleet-agent help >/dev/null' \
  >"$VM_RUN_ROOT/logs/docker-bind-probe.log" 2>&1 || {
    echo "Docker cannot execute the Agent or read the workspace bind mounts; use a Colima-shared run directory" >&2
    exit 1
  }

echo "[3/9] Starting the real Worker locally with isolated Durable Object storage"
export VM_WORKER_ORIGIN="http://127.0.0.1:8787"
export VM_SEED_KEY
VM_SEED_KEY=$(node "$HELPER" random)
printf 'VM_SEED_KEY=%s\n' "$VM_SEED_KEY" >"$VM_RUN_ROOT/wrangler.env"
chmod 600 "$VM_RUN_ROOT/wrangler.env"
XDG_CONFIG_HOME="$VM_RUN_ROOT/xdg" \
WRANGLER_LOG_PATH="$VM_RUN_ROOT/logs/wrangler-debug.log" \
  "$WRANGLER" dev \
    --config "$SCRIPT_DIR/wrangler.toml" \
    --var "HUB_ORIGIN:http://fleet-hub.test:8787" \
    --var "VM_SEED_KEY:$VM_SEED_KEY" \
    --local \
    --ip 0.0.0.0 \
    --port 8787 \
    --persist-to "$VM_RUN_ROOT/wrangler-state" \
    --show-interactive-dev-session=false \
    --log-level info \
    >"$VM_RUN_ROOT/logs/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 120); do
  if curl -sS --connect-timeout 0.2 --max-time 0.2 \
    -o /dev/null "$VM_WORKER_ORIGIN/" \
    2>>"$VM_RUN_ROOT/logs/wrangler-readiness.log"; then
    break
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "Wrangler exited during startup" >&2
    exit 1
  fi
  sleep 0.25
done
curl -sS --connect-timeout 0.2 --max-time 0.2 \
  -o /dev/null "$VM_WORKER_ORIGIN/" \
  2>>"$VM_RUN_ROOT/logs/wrangler-readiness.log" || {
    echo "local Worker did not become ready; see logs/wrangler.log" >&2
    exit 1
  }
node "$HELPER" seed >"$VM_RUN_ROOT/seed.json"
chmod 600 "$VM_RUN_ROOT/seed.json"
export FLEET_TOKEN VM_USER_ID VM_KID
FLEET_TOKEN=$(node "$HELPER" seed-field "$VM_RUN_ROOT/seed.json" token)
VM_USER_ID=$(node "$HELPER" seed-field "$VM_RUN_ROOT/seed.json" user_id)
VM_KID=$(node "$HELPER" seed-field "$VM_RUN_ROOT/seed.json" kid)

echo "[4/9] Verifying catalog v0.2 hashes and preparing isolated endpoint state"
node "$HELPER" prepare >"$VM_RUN_ROOT/logs/prepare.json"

echo "[5/9] Starting two Agent containers and one long-lived Tool container"
docker network create "$NETWORK" >"$VM_RUN_ROOT/logs/docker-network.txt"

docker run -d \
  --name "$AGENT_A" --hostname fleet-vm-a --network "$NETWORK" \
  --add-host fleet-hub.test:host-gateway \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  -e FLEET_HOME=/state -e FLEET_SETTINGS_ADDR=127.0.0.1:17890 -e FLEET_NAME="Fleet VM A" \
  -v "$VM_RUN_ROOT/artifacts/fleet-agent:/opt/fleet-agent:ro" \
  -v "$VM_RUN_ROOT/agent-a/home:/state:rw" \
  -v "$VM_RUN_ROOT/agent-a/data:/data:rw" \
  "$IMAGE" /opt/fleet-agent >"$VM_RUN_ROOT/logs/agent-a-container.txt"

docker run -d \
  --name "$AGENT_B" --hostname fleet-vm-b --network "$NETWORK" \
  --add-host fleet-hub.test:host-gateway \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  -e FLEET_HOME=/state -e FLEET_SETTINGS_ADDR=127.0.0.1:17890 -e FLEET_NAME="Fleet VM B" \
  -v "$VM_RUN_ROOT/artifacts/fleet-agent:/opt/fleet-agent:ro" \
  -v "$VM_RUN_ROOT/agent-b/home:/state:rw" \
  -v "$VM_RUN_ROOT/agent-b/data:/data:rw" \
  "$IMAGE" /opt/fleet-agent >"$VM_RUN_ROOT/logs/agent-b-container.txt"

mkdir -p "$VM_RUN_ROOT/tool/data/control"
mkdir -p "$VM_RUN_ROOT/tool/plugins/fleet.transfer/data"
printf '%s\n' \
  'FLEET_URL=http://fleet-hub.test:8787' \
  "FLEET_TOKEN=$FLEET_TOKEN" \
  'FLEET_PLUGIN_DIR=/plugins' \
  >"$VM_RUN_ROOT/tool.env"
chmod 600 "$VM_RUN_ROOT/tool.env"
docker run -d \
  --name "$TOOL" --hostname fleet-vm-tool --network "$NETWORK" \
  --add-host fleet-hub.test:host-gateway \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --cap-drop ALL --security-opt no-new-privileges \
  --env-file "$VM_RUN_ROOT/tool.env" \
  -v "$ROOT:/workspace:ro" \
  -v "$VM_RUN_ROOT/tool/plugins:/plugins:ro" \
  -v "$VM_RUN_ROOT/tool/plugins/fleet.transfer/data:/plugins/fleet.transfer/data:rw" \
  -v "$VM_RUN_ROOT/tool/data:/tool-data:rw" \
  -w /workspace \
  "$IMAGE" sleep infinity >"$VM_RUN_ROOT/logs/tool-container.txt"

tool() {
  docker exec "$TOOL" node /workspace/packages/fleet-tool/index.mjs "$@"
}

agent_status() {
  local container=$1
  local label=$2
  docker exec "$container" /opt/fleet-agent status --json >"$VM_RUN_ROOT/logs/$label-${container}.json" 2>/dev/null
}

approve_once() {
  local container=$1
  local label=$2
  local status_file="$VM_RUN_ROOT/logs/$label-${container}.json"
  if agent_status "$container" "$label" && node "$HELPER" pending "$status_file"; then
    docker exec "$container" /opt/fleet-agent approve >/dev/null
  fi
}

approve_all() {
  local label=$1
  shift
  local container
  for container in "$@"; do approve_once "$container" "$label"; done
}

echo "[6/9] Waiting for both exact devices to advertise the generic peer capability"
for _ in $(seq 1 240); do
  if tool list >"$VM_RUN_ROOT/logs/list.json" 2>"$VM_RUN_ROOT/logs/list.err" && \
     node "$HELPER" online "$VM_RUN_ROOT/logs/list.json" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
tool list >"$VM_RUN_ROOT/logs/list.json" 2>"$VM_RUN_ROOT/logs/list.err"
node "$HELPER" online "$VM_RUN_ROOT/logs/list.json"

start_transfer() {
  local label=$1
  shift
  TRANSFER_LABEL=$label
  TRANSFER_OUT="$VM_RUN_ROOT/logs/$label.out.json"
  TRANSFER_PROGRESS="$VM_RUN_ROOT/logs/$label.progress.ndjson"
  local pid_file="/tool-data/control/$label.pid"
  docker exec "$TOOL" sh -c 'echo "$$" > "$1"; shift; exec "$@"' sh "$pid_file" \
    node /workspace/packages/fleet-tool/index.mjs "$@" \
    >"$TRANSFER_OUT" 2>"$TRANSFER_PROGRESS" &
  TRANSFER_PID=$!
}

wait_transfer() {
  local wanted=$1
  local expected_exit=$2
  shift 2
  local deadline=$((SECONDS + 900))
  while kill -0 "$TRANSFER_PID" 2>/dev/null; do
    approve_all "$TRANSFER_LABEL" "$@"
    if ((SECONDS >= deadline)); then
      echo "$TRANSFER_LABEL timed out" >&2
      return 1
    fi
    sleep 0.05
  done
  set +e
  wait "$TRANSFER_PID"
  local status=$?
  set -e
  TRANSFER_PID=""
  if [[ "$expected_exit" == "zero" && "$status" -ne 0 ]]; then
    echo "$TRANSFER_LABEL failed with exit $status" >&2
    return 1
  fi
  if [[ "$expected_exit" == "nonzero" && "$status" -eq 0 ]]; then
    echo "$TRANSFER_LABEL unexpectedly exited zero" >&2
    return 1
  fi
  if [[ "$expected_exit" == "nonzero" ]]; then
    # Negative-path CLIs deliberately emit diagnostics instead of a success
    # JSON document. Read the authoritative terminal phase from the real DO;
    # the caller must have pinned VM_SESSION_ID to this transfer first.
    node "$HELPER" session-status >"$TRANSFER_OUT"
  fi
  node "$HELPER" terminal "$TRANSFER_OUT" "$wanted"
}

wait_session_id() {
  local deadline=$((SECONDS + 90))
  local id=""
  while [[ -z "$id" ]] && kill -0 "$TRANSFER_PID" 2>/dev/null; do
    id=$(node "$HELPER" session "$TRANSFER_PROGRESS" 2>/dev/null || true)
    [[ -n "$id" ]] && break
    approve_all "$TRANSFER_LABEL" "$@"
    if ((SECONDS >= deadline)); then break; fi
    sleep 0.05
  done
  [[ -n "$id" ]] || { echo "could not observe session id for $TRANSFER_LABEL" >&2; return 1; }
  printf '%s' "$id"
}

wait_verified_offset() {
  local directory=$1
  local minimum=$2
  shift 2
  local deadline=$((SECONDS + 300))
  while kill -0 "$TRANSFER_PID" 2>/dev/null; do
    approve_all "$TRANSFER_LABEL" "$@"
    local size
    size=$(node "$HELPER" verified-offset "$directory")
    if ((size >= minimum)); then return 0; fi
    if ((SECONDS >= deadline)); then break; fi
    sleep 0.02
  done
  echo "$TRANSFER_LABEL ended before its verified resume offset reached $minimum bytes" >&2
  return 1
}

echo "[7/9] Verifying Tool→Client, Client→Tool, and Client→Client"
mkdir -p "$VM_RUN_ROOT/agent-b/data/tool-receive" "$VM_RUN_ROOT/tool/data/client-receive" "$VM_RUN_ROOT/agent-b/data/client-receive"

start_transfer tool-to-client send-file /tool-data/source/tool-empty.bin \
  22222222-2222-4222-8222-222222222222 /data/tool-receive
wait_transfer completed zero "$AGENT_B"
node "$HELPER" verify \
  "$VM_RUN_ROOT/tool/data/source/tool-empty.bin" \
  "$VM_RUN_ROOT/agent-b/data/tool-receive/tool-empty.bin" \
  >"$VM_RUN_ROOT/logs/tool-to-client.sha.json"
node "$HELPER" published-receipt \
  "$VM_RUN_ROOT/tool/data/source/tool-empty.bin" \
  "$VM_RUN_ROOT/agent-b/data/tool-receive/tool-empty.bin" \
  /data/tool-receive/tool-empty.bin \
  "$VM_RUN_ROOT/logs/tool-to-client.out.json" \
  >"$VM_RUN_ROOT/logs/tool-to-client.receipt.json"

start_transfer client-to-tool receive-file \
  11111111-1111-4111-8111-111111111111 /data/source/client-to-tool.bin /tool-data/client-receive
wait_transfer completed zero "$AGENT_A"
node "$HELPER" verify \
  "$VM_RUN_ROOT/agent-a/data/source/client-to-tool.bin" \
  "$VM_RUN_ROOT/tool/data/client-receive/client-to-tool.bin" \
  >"$VM_RUN_ROOT/logs/client-to-tool.sha.json"
node "$HELPER" published-receipt \
  "$VM_RUN_ROOT/agent-a/data/source/client-to-tool.bin" \
  "$VM_RUN_ROOT/tool/data/client-receive/client-to-tool.bin" \
  /tool-data/client-receive/client-to-tool.bin \
  "$VM_RUN_ROOT/logs/client-to-tool.out.json" \
  >"$VM_RUN_ROOT/logs/client-to-tool.receipt.json"

start_transfer client-to-client transfer-file \
  11111111-1111-4111-8111-111111111111 /data/source/client-to-client.bin \
  22222222-2222-4222-8222-222222222222 /data/client-receive
wait_transfer completed zero "$AGENT_A" "$AGENT_B"
node "$HELPER" verify \
  "$VM_RUN_ROOT/agent-a/data/source/client-to-client.bin" \
  "$VM_RUN_ROOT/agent-b/data/client-receive/client-to-client.bin" \
  >"$VM_RUN_ROOT/logs/client-to-client.sha.json"
node "$HELPER" published-receipt \
  "$VM_RUN_ROOT/agent-a/data/source/client-to-client.bin" \
  "$VM_RUN_ROOT/agent-b/data/client-receive/client-to-client.bin" \
  /data/client-receive/client-to-client.bin \
  "$VM_RUN_ROOT/logs/client-to-client.out.json" \
  >"$VM_RUN_ROOT/logs/client-to-client.receipt.json"

echo "[8/9] Interrupting Client→Client at or after 37%, then proving resumable completion"
mkdir -p "$VM_RUN_ROOT/agent-b/data/resume-receive"
RESUME_SOURCE="$VM_RUN_ROOT/agent-a/data/source/resume-37.bin"
RESUME_SIZE=$(wc -c <"$RESUME_SOURCE" | tr -d ' ')
RESUME_THRESHOLD=$((RESUME_SIZE * 37 / 100))
start_transfer resume-37 transfer-file \
  11111111-1111-4111-8111-111111111111 /data/source/resume-37.bin \
  22222222-2222-4222-8222-222222222222 /data/resume-receive
SESSION_ID=$(wait_session_id "$AGENT_A" "$AGENT_B")
wait_verified_offset "$VM_RUN_ROOT/agent-b/data/resume-receive" "$RESUME_THRESHOLD" "$AGENT_A" "$AGENT_B"
node "$HELPER" checkpoint "$VM_RUN_ROOT/agent-b/data/resume-receive" \
  >"$VM_RUN_ROOT/logs/resume-37-checkpoint.json"
export VM_SESSION_ID="$SESSION_ID" VM_CALLER_ID=11111111-1111-4111-8111-111111111111
# A Hub-only synthetic event is not a network interruption: it advances the
# durable round while the Agents still own the old RTC epoch. Remove B from the
# bridge instead. Both Pion endpoints then observe a real direct-channel
# failure; the still-online A reports it to the Hub and the protected VM route
# merely proves that the durable round changed. B keeps its process and partial
# file, then rejoins the same network and resumes in the fresh round.
node "$HELPER" session-status >"$VM_RUN_ROOT/logs/resume-37-before-interrupt.json"
PRIOR_ROUND_ID=$(node "$HELPER" round-id "$VM_RUN_ROOT/logs/resume-37-before-interrupt.json")
docker network disconnect --force "$NETWORK" "$AGENT_B"
node "$HELPER" wait-interrupt "$PRIOR_ROUND_ID" \
  >"$VM_RUN_ROOT/logs/resume-37-interrupt.json" \
  2>"$VM_RUN_ROOT/logs/resume-37-interrupt.err"
# Give the partitioned endpoint's local state callback time to retire the old
# epoch before its WSS can receive the queued round-prepare delivery.
sleep 2
node "$HELPER" receiving-checkpoint \
  "$VM_RUN_ROOT/agent-b/data/resume-receive" \
  "$RESUME_SOURCE" \
  /data/resume-receive/resume-37.bin \
  "$SESSION_ID" device 11111111-1111-4111-8111-111111111111 \
  >"$VM_RUN_ROOT/logs/resume-37-retained-checkpoint.json"
docker network connect "$NETWORK" "$AGENT_B"
wait_transfer completed zero "$AGENT_A" "$AGENT_B"
node "$HELPER" verify \
  "$RESUME_SOURCE" \
  "$VM_RUN_ROOT/agent-b/data/resume-receive/resume-37.bin" \
  >"$VM_RUN_ROOT/logs/resume-37.sha.json"
node "$HELPER" published-receipt \
  "$RESUME_SOURCE" \
  "$VM_RUN_ROOT/agent-b/data/resume-receive/resume-37.bin" \
  /data/resume-receive/resume-37.bin \
  "$VM_RUN_ROOT/logs/resume-37.out.json" \
  >"$VM_RUN_ROOT/logs/resume-37.receipt.json"

if ((RUN_EXTENDED)); then
  echo "[9/9] Verifying no-clobber and explicit cancellation"
else
  echo "[9/9] Verifying no-clobber"
fi
start_transfer no-clobber transfer-file \
  11111111-1111-4111-8111-111111111111 /data/source/no-clobber.bin \
  22222222-2222-4222-8222-222222222222 /data/no-clobber
NO_CLOBBER_SESSION_ID=$(wait_session_id "$AGENT_A" "$AGENT_B")
export VM_SESSION_ID="$NO_CLOBBER_SESSION_ID" VM_CALLER_ID=11111111-1111-4111-8111-111111111111
wait_transfer failed nonzero "$AGENT_A" "$AGENT_B"
node "$HELPER" assert-text "$VM_RUN_ROOT/agent-b/data/no-clobber/no-clobber.bin" $'do-not-replace\n'
node "$HELPER" artifacts-clean "$VM_RUN_ROOT/agent-b/data/no-clobber"

if ((RUN_EXTENDED)); then
  mkdir -p "$VM_RUN_ROOT/agent-b/data/cancel-receive"
  start_transfer cancel transfer-file \
    11111111-1111-4111-8111-111111111111 /data/source/cancel.bin \
    22222222-2222-4222-8222-222222222222 /data/cancel-receive
  CANCEL_SESSION_ID=$(wait_session_id "$AGENT_A" "$AGENT_B")
  wait_verified_offset "$VM_RUN_ROOT/agent-b/data/cancel-receive" 32768 "$AGENT_A" "$AGENT_B"
  docker pause "$AGENT_B" >/dev/null
  node "$HELPER" receiving-checkpoint \
    "$VM_RUN_ROOT/agent-b/data/cancel-receive" \
    "$VM_RUN_ROOT/agent-a/data/source/cancel.bin" \
    /data/cancel-receive/cancel.bin \
    "$CANCEL_SESSION_ID" device 11111111-1111-4111-8111-111111111111 --active \
    >"$VM_RUN_ROOT/logs/cancel-checkpoint.json"
  TOOL_PID=$(tr -d '[:space:]' <"$VM_RUN_ROOT/tool/data/control/cancel.pid")
  docker exec "$TOOL" sh -c 'kill -INT "$1"' sh "$TOOL_PID"
  # Cancellation intentionally rejects the active CLI call. The VM-only status
  # route reads the session as device A, avoiding a second Tool coordinator.
  set +e
  CANCEL_DEADLINE=$((SECONDS + 30))
  while kill -0 "$TRANSFER_PID" 2>/dev/null; do
    if ((SECONDS >= CANCEL_DEADLINE)); then
      docker unpause "$AGENT_B" >/dev/null
      echo "cancel transfer did not exit within 30 seconds" >&2
      exit 1
    fi
    sleep 0.05
  done
  wait "$TRANSFER_PID"
  CANCEL_STATUS=$?
  set -e
  TRANSFER_PID=""
  docker unpause "$AGENT_B" >/dev/null
  ((CANCEL_STATUS != 0)) || { echo "cancel transfer unexpectedly exited zero" >&2; exit 1; }
  export VM_SESSION_ID="$CANCEL_SESSION_ID" VM_CALLER_ID=11111111-1111-4111-8111-111111111111
  node "$HELPER" session-status >"$VM_RUN_ROOT/logs/cancel-status.json"
  node "$HELPER" terminal "$VM_RUN_ROOT/logs/cancel-status.json" cancelled
  for _ in $(seq 1 200); do
    if node "$HELPER" artifacts-clean "$VM_RUN_ROOT/agent-b/data/cancel-receive" 2>/dev/null; then break; fi
    sleep 0.05
  done
  node "$HELPER" artifacts-clean "$VM_RUN_ROOT/agent-b/data/cancel-receive"
  [[ ! -e "$VM_RUN_ROOT/agent-b/data/cancel-receive/cancel.bin" ]] || {
    echo "cancel unexpectedly published its destination" >&2
    exit 1
  }
fi
