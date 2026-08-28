# 打 macOS 安装包

`npm run release:agent` 必须在 **Mac** 上跑。产物进 `public/dl/`，再上传 GitHub Release。不要把安装包 commit 进 git。

## 禁止事项（已经踩过）

1. **禁止把 zip 改名为 `.dmg`。**  
   Finder 打开会报磁盘映像损坏 / 无法打开。`PK\x03\x04` 开头的是 zip，不是 UDIF。v0.2.0 的 `FleetAgent-macos-*.dmg` 就是这个坑：`genisoimage` 不存在时脚本把 zip 复制成了 dmg。
2. **禁止用 Python `zipfile` 打 `.app`。**  
   默认不保存 Unix 可执行位，解压后 `FleetAgent` 可能丢掉 `+x`，双击没反应。
3. **禁止在 Linux CI 上“凑合”出 dmg。**  
   没有 `hdiutil` 就不要发 `.dmg`。zip 用 macOS `ditto`，dmg 用 `hdiutil create -format UDZO`。
4. **`.dmg` 能挂载 ≠ Gatekeeper 放行。**  
   未公证的包从浏览器下载后仍会隔离。这和“假 dmg”是两件事。

## 正确做法

```bash
# .app  （LSUIElement + NSAppSleepDisabled：菜单栏常驻，禁止 App Nap）
codesign --force --deep --sign - "Fleet Agent.app"   # ad-hoc，至少能当 app 打开

# zip（保留 +x、资源叉）
ditto -c -k --keepParent "Fleet Agent.app" FleetAgent-macos-arm64.zip

# dmg（真磁盘映像）
hdiutil create -volname "Fleet Agent" -srcfolder stage -ov -format UDZO -fs HFS+ out.dmg
```

脚本里会检查 dmg 是否以 `PK` 开头，是就失败。

校验：

```bash
file public/dl/FleetAgent-macos-arm64.dmg
# 期望：zlib compressed data / Apple disk image / UDIF
# 禁止：Zip archive data

hdiutil imageinfo public/dl/FleetAgent-macos-arm64.dmg >/dev/null
```

## 用户侧：未公证

没有 Developer ID + notary 时，从 GitHub 下的包会被隔离：

1. 系统设置 → 隐私与安全性 → 仍要打开。  
2. 或右键 `.app` → 打开。  
3. 或：

```bash
xattr -cr "/Applications/Fleet Agent.app"
```

不要告诉用户“dmg 打不开就下 zip 当 dmg 用”。zip 是备用格式，解压出 `.app` 再拖进应用程序。

## Release

```bash
VERSION=0.6.0 npm run release:agent
gh release create v0.6.0 \
  public/dl/FleetAgent-* \
  public/dl/fleet-agent-linux-*.tar.gz \
  public/dl/checksums.txt \
  public/dl/checksums-0.6.0.txt
```

macOS 菜单栏需要 **CGO_ENABLED=1**（本机 clang）。Windows 托盘是 syscall，Linux 托盘是 DBus，交叉编译都保持 `CGO_ENABLED=0`。Windows 加 `-H windowsgui`。

打包命令也是发布门禁，不只是编译器。它会拒绝带 AppleDouble/PAX 元数据或非 root 归属的 Linux 包，再在只读、无 capability 的 Docker 容器中分别把两种架构的正式二进制运行十轮。执行前必须启动 Docker；门禁失败就不能上传 Release。
