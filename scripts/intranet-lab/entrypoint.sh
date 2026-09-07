#!/bin/sh
set -eu
HOME_DIR="${FLEET_HOME:-/data}"
mkdir -p "$HOME_DIR"
# permit=allow: lab has no human at the tray. Ask would hang every run.
cat >"$HOME_DIR/config.json" <<EOF
{"enabled":true,"permit":"allow","hubInput":"${FLEET_URL:-}","hubToken":"${FLEET_TOKEN:-}","deviceId":""}
EOF
export FLEET_HOME="$HOME_DIR"
export FLEET_BACKEND_TYPE="${FLEET_BACKEND_TYPE:-pty}"
export FLEET_ENABLED="${FLEET_ENABLED:-true}"
exec /usr/local/bin/fleet-agent
