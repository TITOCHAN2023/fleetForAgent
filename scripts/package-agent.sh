#!/usr/bin/env bash
# Build installers into public/dl/. macOS .dmg MUST be a UDIF disk image.
# Never copy a zip to *.dmg — Finder will say the disk image is damaged.
set -euo pipefail
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/fleet-agent"
OUT="$ROOT/public/dl"

die() {
  echo "error: $*" >&2
  exit 1
}

# A remote-control binary must be traceable to one immutable source revision.
# Refuse local snapshots, dirty trees, and tags that disagree with the version
# compiled into the Agent. CI passes RELEASE_TAG explicitly; local releases use
# the single v* tag pointing at HEAD.
command -v git >/dev/null 2>&1 || die "git is required"
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT is not a git checkout"
[ -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" ] || \
  die "release checkout is dirty; commit or remove every tracked and untracked change first"

GIT_REVISION="$(git -C "$ROOT" rev-parse HEAD)"
RELEASE_TAG="${RELEASE_TAG:-$(git -C "$ROOT" tag --points-at HEAD --list 'v*')}"
[ -n "$RELEASE_TAG" ] || die "HEAD must have exactly one release tag (vMAJOR.MINOR.PATCH)"
case "$RELEASE_TAG" in
  *$'\n'*) die "HEAD has multiple v* tags; set RELEASE_TAG to the intended exact tag" ;;
esac
[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  die "release tag must be vMAJOR.MINOR.PATCH, got $RELEASE_TAG"
[ "$(git -C "$ROOT" rev-parse "$RELEASE_TAG^{commit}")" = "$GIT_REVISION" ] || \
  die "$RELEASE_TAG does not point at HEAD"

VERSION="${VERSION:-${RELEASE_TAG#v}}"
[ "$RELEASE_TAG" = "v$VERSION" ] || die "VERSION=$VERSION disagrees with $RELEASE_TAG"
SOURCE_VERSION="$(sed -nE 's/^var agentVersion = "([^"]+)"$/\1/p' "$SRC/main.go")"
[ -n "$SOURCE_VERSION" ] || die "cannot read agentVersion from packages/fleet-agent/main.go"
[ "$SOURCE_VERSION" = "$VERSION" ] || \
  die "Agent source version $SOURCE_VERSION disagrees with release version $VERSION"

[ "$(uname -s)" = "Darwin" ] || \
  die "full Agent releases must run on macOS because a real DMG and CGO menu-bar binaries are required"
command -v hdiutil >/dev/null 2>&1 || die "hdiutil is required; never rename a zip to .dmg"
command -v ditto >/dev/null 2>&1 || die "ditto is required for the macOS application zip"

export SOURCE_DATE_EPOCH="$(git -C "$ROOT" show -s --format=%ct HEAD)"
BUILD_TOUCH_TIME="$(date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S)"
LDFLAGS="-s -w -buildid= -X=main.agentVersion=${VERSION}"

mkdir -p "$OUT" "$SRC/dist"
rm -f \
  "$OUT/FleetAgent-windows-amd64.exe" "$OUT/FleetAgent-windows-arm64.exe" \
  "$OUT/FleetAgent-macos-arm64.dmg" "$OUT/FleetAgent-macos-amd64.dmg" \
  "$OUT/FleetAgent-macos-arm64.zip" "$OUT/FleetAgent-macos-amd64.zip" \
  "$OUT/fleet-agent-linux-amd64.tar.gz" "$OUT/fleet-agent-linux-arm64.tar.gz" \
  "$OUT/checksums-${VERSION}.txt"

cd "$SRC"
go mod verify

verify_build_info() {
  local binary="$1" metadata
  metadata="$(go version -m "$binary")"
  grep -Fq "vcs.revision=$GIT_REVISION" <<<"$metadata" || \
    die "$binary does not embed vcs.revision=$GIT_REVISION"
  grep -Fq "vcs.modified=false" <<<"$metadata" || \
    die "$binary was built from a dirty or unverifiable checkout"
}

build() {
  local os="$1" arch="$2" ext="$3"
  echo "building $os/$arch"
  if [ "$os" = windows ]; then
    # Windows tray is syscall-only. Keep CGO off so we can cross-compile from a Mac.
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -mod=readonly -trimpath -buildvcs=true -ldflags "$LDFLAGS -H windowsgui" -o "dist/${os}-${arch}${ext}" .
  elif [ "$os" = darwin ]; then
    # Menu bar (systray) needs CGO on macOS.
    CGO_ENABLED=1 GOOS="$os" GOARCH="$arch" go build -mod=readonly -trimpath -buildvcs=true -ldflags "$LDFLAGS" -o "dist/${os}-${arch}${ext}" .
  else
    # Linux tray is DBus StatusNotifierItem (no CGO). Keep CGO off so we can cross-compile.
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -mod=readonly -trimpath -buildvcs=true -ldflags "$LDFLAGS" -o "dist/${os}-${arch}${ext}" .
  fi
  verify_build_info "dist/${os}-${arch}${ext}"
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

  # Archive timestamps are tied to the source commit, not runner time. Do this
  # after ad-hoc signing because codesign creates _CodeSignature files.
  find "$app" -exec touch -t "$BUILD_TOUCH_TIME" {} +

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

pack_linux() {
  local arch="$1"
  local stage="$SRC/dist/linuxpack-${arch}"
  local archive="$OUT/fleet-agent-linux-${arch}.tar.gz"

  rm -rf "$stage"
  mkdir -p "$stage"
  cp "dist/linux-${arch}" "$stage/fleet-agent"
  cp "dist/linux-${arch}" "$stage/fleet"
  chmod +x "$stage/fleet-agent" "$stage/fleet"
  touch -t "$BUILD_TOUCH_TIME" "$stage/fleet-agent" "$stage/fleet"

  # macOS bsdtar otherwise emits AppleDouble (._*) and provenance PAX records.
  # Normalize ownership so extraction also works for capability-dropped root.
  local raw_archive="$SRC/dist/linux-${arch}.tar"
  rm -f "$raw_archive"
  COPYFILE_DISABLE=1 tar \
    --format=ustar --no-xattrs \
    --owner=0 --group=0 --numeric-owner \
    -C "$stage" -cf "$raw_archive" fleet-agent fleet
  gzip -n -9 < "$raw_archive" > "$archive"
  rm -f "$raw_archive"
}

pack_linux amd64
pack_linux arm64

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

node --test "$ROOT/scripts/releases.test.mjs"
if [ "${FLEET_RELEASE_DEFER_DOCKER_TEST:-0}" = "1" ]; then
  echo "Docker release test deferred; the release workflow must run it on Linux before publishing."
else
  bash "$ROOT/scripts/test-agent-release.sh" "$OUT" "$VERSION"
fi

# Publish the Tool as a versioned Release asset. Keep the website's
# existing /fleet-tool.tgz untouched until its consumer URL is deliberately
# migrated in a separate change.
cd "$ROOT"
TOOL_VERSION="$(node --input-type=module -e 'import { fleetToolVersion } from "./scripts/pack-fleet-tool.mjs"; process.stdout.write(fleetToolVersion())')"
[[ "$TOOL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid Fleet Tool version: $TOOL_VERSION"
TOOL_ASSET="fleet-tool-${TOOL_VERSION}.tgz"
TOOL_OUT="$SRC/dist/release"
mkdir -p "$TOOL_OUT"
rm -f "$TOOL_OUT/$TOOL_ASSET" "$TOOL_OUT/$TOOL_ASSET.sha256"
node --input-type=module -e \
  'import { packFleetTool } from "./scripts/pack-fleet-tool.mjs"; packFleetTool({ outFile: process.argv[1] });' \
  "$TOOL_OUT/$TOOL_ASSET"
(
  cd "$TOOL_OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$TOOL_ASSET" > "$TOOL_ASSET.sha256"
  else
    shasum -a 256 "$TOOL_ASSET" > "$TOOL_ASSET.sha256"
  fi
)

echo "releases:"
ls -lh "$OUT"
ls -lh "$TOOL_OUT/$TOOL_ASSET" "$TOOL_OUT/$TOOL_ASSET.sha256"
