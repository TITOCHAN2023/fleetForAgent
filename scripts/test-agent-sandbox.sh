#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
go_image="${FLEET_TEST_GO_IMAGE:-golang:1.23-bookworm}"

docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 512 \
  --memory 2g \
  --cpus 2 \
  --mount "type=bind,src=${repo_root},dst=/workspace,readonly" \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m \
  --tmpfs /go/pkg/mod:rw,nosuid,nodev,size=768m \
  --tmpfs /root/.cache:rw,nosuid,nodev,size=512m \
  --workdir /workspace/packages/fleet-agent \
  "$go_image" \
  go test -mod=readonly -count=1 ./...
