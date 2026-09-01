# Building the macOS installer

`npm run release:agent` must run on a **Mac**. Artifacts go to `public/dl/`, then upload to a GitHub Release. Do not commit installers to git.

## Do not (already burned)

1. **Do not rename a zip to `.dmg`.**  
   Finder reports a damaged disk image. Files that start with `PK\x03\x04` are zip, not UDIF. `FleetAgent-macos-*.dmg` in v0.2.0 hit this: when `genisoimage` was missing the script copied a zip as a dmg.
2. **Do not zip a `.app` with Python `zipfile`.**  
   Default zip does not keep the Unix executable bit. After unzip, `FleetAgent` may lose `+x` and double-click does nothing.
3. **Do not fake a dmg on Linux CI.**  
   No `hdiutil` means do not ship `.dmg`. Use macOS `ditto` for zip and `hdiutil create -format UDZO` for dmg.
4. **A `.dmg` that mounts is not Gatekeeper approval.**  
   Unnotarized downloads are still quarantined. That is separate from a fake dmg.

## Correct

```bash
# .app  (LSUIElement + NSAppSleepDisabled: menu-bar stay, no App Nap)
codesign --force --deep --sign - "Fleet Agent.app"   # ad-hoc, at least opens as an app

# zip (keep +x and resource forks)
ditto -c -k --keepParent "Fleet Agent.app" FleetAgent-macos-arm64.zip

# dmg (real disk image)
hdiutil create -volname "Fleet Agent" -srcfolder stage -ov -format UDZO -fs HFS+ out.dmg
```

The script fails if the dmg starts with `PK`.

Check:

```bash
file public/dl/FleetAgent-macos-arm64.dmg
# expect: zlib compressed data / Apple disk image / UDIF
# never: Zip archive data

hdiutil imageinfo public/dl/FleetAgent-macos-arm64.dmg >/dev/null
```

## User side: not notarized

Without Developer ID + notarization, GitHub downloads are quarantined:

1. System Settings → Privacy & Security → Open Anyway.  
2. Or right-click the `.app` → Open.  
3. Or:

```bash
xattr -cr "/Applications/Fleet Agent.app"
```

Do not tell users “if the dmg will not open, download the zip and use it as a dmg”. Zip is a fallback: unzip the `.app` and drag it to Applications.

## Release

```bash
VERSION=0.6.5 npm run release:agent
gh release create v0.6.5 \
  public/dl/FleetAgent-* \
  public/dl/fleet-agent-linux-*.tar.gz \
  public/dl/checksums.txt \
  public/dl/checksums-0.6.5.txt
```

macOS menu bar needs **CGO_ENABLED=1** (local clang). Windows tray is syscall, Linux tray is DBus; both stay `CGO_ENABLED=0` for cross-compile. Windows adds `-H windowsgui`.

The packaging command is a release gate, not just a compiler. It rejects Linux archives with AppleDouble/PAX metadata or non-root ownership, then extracts and runs both formal Linux binaries ten times in read-only, capability-dropped Docker containers. Docker must be running; a failed gate means the release must not be uploaded.
