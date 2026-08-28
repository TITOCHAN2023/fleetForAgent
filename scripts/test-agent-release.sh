#!/usr/bin/env bash
set -euo pipefail

release_dir="${1:?usage: test-agent-release.sh RELEASE_DIR VERSION}"
version="${2:?usage: test-agent-release.sh RELEASE_DIR VERSION}"
image="${FLEET_RELEASE_TEST_IMAGE:-debian:12-slim}"

release_dir="$(cd "$release_dir" && pwd)"

for arch in amd64 arm64; do
  asset="fleet-agent-linux-${arch}.tar.gz"
  echo "testing $asset in linux/$arch"
  docker run --rm \
    --interactive \
    --platform "linux/$arch" \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 64 \
    --memory 128m \
    --cpus 1 \
    --tmpfs /tmp:rw,exec,nosuid,nodev,size=64m \
    --env "EXPECTED_VERSION=$version" \
    "$image" \
    sh -ceu '
      mkdir /tmp/fleet
      tar -xzf - -C /tmp/fleet 2>/tmp/tar.stderr
      test ! -s /tmp/tar.stderr
      entries=$(find /tmp/fleet -mindepth 1 -maxdepth 1 -printf "%f\n" | LC_ALL=C sort)
      test "$entries" = "fleet
fleet-agent"
      test -x /tmp/fleet/fleet
      test -x /tmp/fleet/fleet-agent
      i=0
      while [ "$i" -lt 10 ]; do
        test "$(/tmp/fleet/fleet version)" = "fleet $EXPECTED_VERSION"
        test "$(/tmp/fleet/fleet-agent version)" = "fleet $EXPECTED_VERSION"
        i=$((i + 1))
      done
    ' < "$release_dir/$asset"
done
