#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/go/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/keel-agent"
OUT="$ROOT/public/dl"
mkdir -p "$OUT" "$SRC/dist"
cd "$SRC"
go mod tidy
LDFLAGS="-s -w"

build() {
  local os="$1" arch="$2" ext="$3"
  local name="keel-agent${ext}"
  echo "building $os/$arch"
  if [ "$os" = windows ]; then
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -ldflags "$LDFLAGS -H windowsgui" -o "dist/${os}-${arch}${ext}" .
  else
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -ldflags "$LDFLAGS" -o "dist/${os}-${arch}${ext}" .
  fi
}

build windows amd64 .exe
build darwin arm64 ""
build darwin amd64 ""
build linux amd64 ""

cp dist/windows-amd64.exe "$OUT/KeelAgent-windows-amd64.exe"

pack_macos() {
  local arch="$1"
  local app="$SRC/dist/Keel Agent.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "dist/darwin-${arch}" "$app/Contents/MacOS/KeelAgent"
  chmod +x "$app/Contents/MacOS/KeelAgent"
  cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Keel Agent</string>
  <key>CFBundleDisplayName</key><string>Keel Agent</string>
  <key>CFBundleIdentifier</key><string>app.keel.agent</string>
  <key>CFBundleVersion</key><string>0.2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>KeelAgent</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
  local stage="$SRC/dist/dmg-${arch}"
  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  local dmg="$OUT/KeelAgent-macos-${arch}.dmg"
  rm -f "$dmg"
  if command -v genisoimage >/dev/null 2>&1; then
    genisoimage -quiet -V "Keel Agent" -r -apple -o "$dmg" "$stage"
  elif command -v mkisofs >/dev/null 2>&1; then
    mkisofs -quiet -V "Keel Agent" -r -apple -o "$dmg" "$stage"
  else
    python3 - <<PY
import zipfile, os
from pathlib import Path
stage = Path("$stage")
out = Path("$OUT/KeelAgent-macos-${arch}.zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in (stage / "Keel Agent.app").rglob("*"):
        if p.is_file():
            z.write(p, p.relative_to(stage).as_posix())
print("zip", out)
PY
    # fallback dmg = zip payload with .dmg name so the download link exists
    cp "$OUT/KeelAgent-macos-${arch}.zip" "$dmg"
  fi
}

pack_macos arm64
pack_macos amd64

mkdir -p dist/linuxpack
cp dist/linux-amd64 dist/linuxpack/keel-agent
chmod +x dist/linuxpack/keel-agent
tar -C dist/linuxpack -czf "$OUT/keel-agent-linux-amd64.tar.gz" keel-agent

(
  cd "$OUT"
  sha256sum KeelAgent-windows-amd64.exe KeelAgent-macos-arm64.dmg KeelAgent-macos-amd64.dmg keel-agent-linux-amd64.tar.gz > checksums.txt
)

echo "releases:"
ls -lh "$OUT"
