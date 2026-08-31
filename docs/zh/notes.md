# 做 Fleet 时记下的东西

Help 是[怎么用](https://fleet.ginfo.cc/help)。这篇是怎么做成的，以及已经付过学费的坑。同一份内容在 **https://fleet.ginfo.cc/docs**（不用登录）。

## 1. 中枢是信箱

任务活在**设备上**。中枢不拥有进程、PTY、字节流。`POST /v1/run` 立刻返回 `{ corr, status: "running" }`。中枢如果 `Wait()` / `CombinedOutput`，设计已经错了。

## 2. 设备只往外连

Agent 主动开 `WSS /v1/device`。不开入站端口，不用 VPN，`list_computers` 不返回公网 IP。操作端只 HTTPS 打网站；网站手里已经握着那些 socket。

## 3. 窗格是 latest-wins，不是流

机器上一个环（约 200 行）。线上看到的是快照（约 4 Hz），中间帧丢掉。`ping` / `type` / `read_screen` 不得等任务结束。

## 4. 权限在那台电脑上

`off` / `ask` / `allow`。中枢不能覆盖。危险命令正则照样拦。`ask` 意味着键盘前面要有人。

## 5. Token 存哈希。重置就是切断

只存哈希。明文只显示一次。重置立刻作废，并把在线 socket 踢掉（`1008 token reset`）。生产上是 Fleet-OAEP，不是日志里一长串 Bearer。公网 Worker 没有共享机器控制 secret，也没有所有权绕过；`ADMIN_EMAILS` 只授权 cookie 会话进入 Ops 视图。

## 6. macOS「打不开」是两件不同的事

1. **假 dmg** — zip 改后缀。Finder 报磁盘映像损坏。`PK\x03\x04` 是 zip，不是 UDIF。用 `hdiutil create -format UDZO`。打 `.app` 用 `ditto`，不要用 Python `zipfile`（会丢掉 `+x`）。
2. **Gatekeeper** — 真 dmg，浏览器下完仍被隔离。没公证。右键打开，或 `xattr -cr`。别让人把 zip 改名当 dmg。

## 7. 托盘是进程。CLI 是客户端

同一个二进制。无参数 / `--daemon` 起托盘。`fleet status` 打 `127.0.0.1:17890`。Agent 在跑时不要手改 `~/.fleet-agent/config.json`。这是 Tailscale 那套：一份状态。

## 8. Linux 没有设置页

`FLEET_URL` + `FLEET_TOKEN`。托盘或命令行。没图形会话就当后台。GNOME 需要 AppIndicator 扩展，否则图标不出现。

## 9. 锁屏不是休眠

开关打开时挡住空闲休眠：Mac `caffeinate -i`，Windows `SetThreadExecutionState(ES_SYSTEM_REQUIRED|ES_CONTINUOUS)`，Linux `systemd-inhibit --what=idle:sleep`。屏幕可以锁。合盖**不拦**。

## 10. 对着你手里的 SDK 编译

macOS 15 的头文件把 `CGDisplayCreateImage` 标成 unavailable。dylib 里符号还在，用 `dlsym`。Darwin 托盘需要 `CGO_ENABLED=1`。Windows 托盘是 syscall，Linux 是 DBus StatusNotifierItem，交叉编译都可以关 CGO。

## 11. 每个 OS/arch 都要出包，否则自更新是假的

`/releases/latest/download` 必须有 Windows/macOS/Linux 的 amd64+arm64，外加 `checksums.txt`。v0.3.0 没出 Mac 包，Mac 上的 Agent 没有东西可拉。dmg **必须在 Mac 上**用 `hdiutil` 打。

## 12. 登录是 Google / X

邮箱密码是弯路。Grok OAuth 中介只给沙盒（`*.grok-sandbox.com`）。生产回调是这个域名上的原生 Google/X。

源码：[GitHub](https://github.com/TITOCHAN2023/fleetForAgent)
