#!/usr/bin/env bash
# Build installers into public/dl/. macOS .dmg MUST be a UDIF disk image.
# Never copy a zip to *.dmg — Finder will say the disk image is damaged.
set -euo pipefail
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/fleet-agent"
OUT="$ROOT/public/dl"
mkdir -p "$OUT" "$SRC/dist"
cd "$SRC"
go mod tidy
LDFLAGS="-s -w"
VERSION="${VERSION:-0.5.1}"

build() {
  local os="$1" arch="$2" ext="$3"
  echo "building $os/$arch"
  if [ "$os" = windows ]; then
    # Windows tray is syscall-only. Keep CGO off so we can cross-compile from a Mac.
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -ldflags "$LDFLAGS -H windowsgui" -o "dist/${os}-${arch}${ext}" .
  elif [ "$os" = darwin ]; then
    # Menu bar (systray) needs CGO on macOS.
    CGO_ENABLED=1 GOOS="$os" GOARCH="$arch" go build -ldflags "$LDFLAGS" -o "dist/${os}-${arch}${ext}" .
  else
    # Linux tray is DBus StatusNotifierItem (no CGO). Keep CGO off so we can cross-compile.
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -ldflags "$LDFLAGS" -o "dist/${os}-${arch}${ext}" .
  fi
}

build windows amd64 .exe
build windows arm64 .exe
build darwin arm64 ""
build darwin amd64 ""
build linux amd64 ""
build linux arm64 ""

cp dist/windows-amd64.exe "$OUT/FleetAgent-windows-amd64.exe"
cp dist/windows-arm64.exe "$OUT/FleetAgent-windows-arm64.exe"

is_zip() {
  # PK\x03\x04
  local magic
  magic="$(dd if="$1" bs=4 count=1 2>/dev/null | LC_ALL=C od -An -tx1 | tr -d ' \n')"
  [ "$magic" = "504b0304" ]
}

pack_macos() {
  local arch="$1"
  local app="$SRC/dist/Fleet Agent.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "dist/darwin-${arch}" "$app/Contents/MacOS/FleetAgent"
  chmod +x "$app/Contents/MacOS/FleetAgent"
  cp "$ROOT/docs/media/brand/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
  printf 'APPL????' > "$app/Contents/PkgInfo"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Fleet Agent</string>
  <key>CFBundleDisplayName</key><string>Fleet Agent</string>
  <key>CFBundleIdentifier</key><string>app.fleet.agent</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>FleetAgent</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppSleepDisabled</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict>
</plist>
PLIST

  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$app"
  fi

  # ditto keeps +x and AppleDouble. python zipfile does not.
  local zip="$OUT/FleetAgent-macos-${arch}.zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"

  local stage="$SRC/dist/dmg-${arch}"
  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"

  local dmg="$OUT/FleetAgent-macos-${arch}.dmg"
  rm -f "$dmg"
  if ! command -v hdiutil >/dev/null 2>&1; then
    echo "error: hdiutil missing. Build macOS .dmg on a Mac. Do not rename the zip." >&2
    exit 1
  fi
  hdiutil create \
    -volname "Fleet Agent" \
    -srcfolder "$stage" \
    -ov -format UDZO -fs HFS+ \
    "$dmg" >/dev/null

  if is_zip "$dmg"; then
    echo "error: $dmg starts with PK (it is a zip). Finder cannot mount it." >&2
    exit 1
  fi
  echo "dmg $arch $(file -b "$dmg")"
}

pack_macos arm64
pack_macos amd64

mkdir -p dist/linuxpack
cp dist/linux-amd64 dist/linuxpack/fleet-agent
cp dist/linux-amd64 dist/linuxpack/fleet
chmod +x dist/linuxpack/fleet-agent dist/linuxpack/fleet
tar -C dist/linuxpack -czf "$OUT/fleet-agent-linux-amd64.tar.gz" fleet-agent fleet

mkdir -p dist/linuxpack-arm64
cp dist/linux-arm64 dist/linuxpack-arm64/fleet-agent
cp dist/linux-arm64 dist/linuxpack-arm64/fleet
chmod +x dist/linuxpack-arm64/fleet-agent dist/linuxpack-arm64/fleet
tar -C dist/linuxpack-arm64 -czf "$OUT/fleet-agent-linux-arm64.tar.gz" fleet-agent fleet

(
  cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum \
      FleetAgent-windows-amd64.exe FleetAgent-windows-arm64.exe \
      FleetAgent-macos-arm64.dmg FleetAgent-macos-amd64.dmg \
      FleetAgent-macos-arm64.zip FleetAgent-macos-amd64.zip \
      fleet-agent-linux-amd64.tar.gz fleet-agent-linux-arm64.tar.gz > checksums.txt
  else
    shasum -a 256 \
      FleetAgent-windows-amd64.exe FleetAgent-windows-arm64.exe \
      FleetAgent-macos-arm64.dmg FleetAgent-macos-amd64.dmg \
      FleetAgent-macos-arm64.zip FleetAgent-macos-amd64.zip \
      fleet-agent-linux-amd64.tar.gz fleet-agent-linux-arm64.tar.gz > checksums.txt
  fi
)
cp "$OUT/checksums.txt" "$OUT/checksums-${VERSION}.txt"

echo "releases:"
ls -lh "$OUT"
