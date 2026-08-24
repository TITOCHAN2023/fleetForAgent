#!/bin/sh
set -eu

base_url="https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download"
hub=${FLEET_URL:-}
token=${FLEET_TOKEN:-}
permit=ask

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub)
      [ "$#" -ge 2 ] || { echo "fleet installer: --hub needs a value" >&2; exit 2; }
      hub=$2
      shift 2
      ;;
    --token)
      [ "$#" -ge 2 ] || { echo "fleet installer: --token needs a value" >&2; exit 2; }
      token=$2
      shift 2
      ;;
    --permit)
      [ "$#" -ge 2 ] || { echo "fleet installer: --permit needs a value" >&2; exit 2; }
      permit=$2
      shift 2
      ;;
    *)
      echo "fleet installer: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

[ -n "$hub" ] || { echo "fleet installer: --hub is required" >&2; exit 2; }
[ -n "$token" ] || { echo "fleet installer: --token is required" >&2; exit 2; }
case "$permit" in off|ask|allow) ;; *) echo "fleet installer: bad permit $permit" >&2; exit 2 ;; esac
command -v curl >/dev/null 2>&1 || { echo "fleet installer: curl is required" >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "fleet installer: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

case "$(uname -s)" in
  Linux)
    asset="fleet-agent-linux-$arch.tar.gz"
    kind=linux
    ;;
  Darwin)
    asset="FleetAgent-macos-$arch.zip"
    kind=darwin
    command -v ditto >/dev/null 2>&1 || { echo "fleet installer: ditto is required on macOS" >&2; exit 1; }
    ;;
  *)
    echo "fleet installer: use install.ps1 on Windows" >&2
    exit 1
    ;;
esac

umask 077
tmp=$(mktemp -d "${TMPDIR:-/tmp}/fleet-install.XXXXXX")
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT HUP INT TERM

archive="$tmp/$asset"
curl -fsSL "$base_url/$asset" -o "$archive"
checksum_text=$(curl -fsSL "$base_url/checksums.txt")
want=$(printf '%s\n' "$checksum_text" | awk -v file="$asset" '$2 == file { print $1; exit }')
[ -n "$want" ] || { echo "fleet installer: checksum missing for $asset" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$archive" | awk '{print $1}')
else
  command -v shasum >/dev/null 2>&1 || { echo "fleet installer: sha256sum or shasum is required" >&2; exit 1; }
  got=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
[ "$got" = "$want" ] || { echo "fleet installer: SHA-256 mismatch for $asset" >&2; exit 1; }

extract="$tmp/extract"
mkdir -p "$extract"
if [ "$kind" = linux ]; then
  tar -xzf "$archive" -C "$extract"
  source_bin="$extract/fleet"
else
  ditto -x -k "$archive" "$extract"
  source_bin="$extract/Fleet Agent.app/Contents/MacOS/FleetAgent"
fi
[ -f "$source_bin" ] || { echo "fleet installer: Fleet binary missing from $asset" >&2; exit 1; }

bin_dir="$HOME/.local/bin"
target="$bin_dir/fleet"
staged="$bin_dir/.fleet.new.$$"
mkdir -p "$bin_dir"
if [ -x "$target" ]; then
  "$target" quit >/dev/null 2>&1 || true
  attempt=0
  stopped=0
  while [ "$attempt" -lt 50 ]; do
    status_text=$("$target" status 2>/dev/null || true)
    case "$status_text" in
      *"running: no"*) stopped=1; break ;;
    esac
    attempt=$((attempt + 1))
    sleep 0.1
  done
  [ "$stopped" -eq 1 ] || { echo "fleet installer: existing agent did not stop" >&2; exit 1; }
fi
install -m 0755 "$source_bin" "$staged"
mv -f "$staged" "$target"
ln -sf fleet "$bin_dir/fleet-agent"

echo "Fleet installed at $target"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH to run 'fleet' directly." ;;
esac
exec "$target" start --hub "$hub" --token "$token" --permit "$permit"
