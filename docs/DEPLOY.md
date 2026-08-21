# 部署 FleetForAgent

没有 VPS。机器只出网，Cloudflare Worker 做中转。家宽 NAT、机房、云主机都可以加入。机器之间没有内网 IP。

```
[Mac mini / Windows / Linux]
        只出网 WSS
            │
            ▼
   Cloudflare Worker  (keel-hub)
   Durable Object / 设备
            ▲
            │  HTTPS
   [你 / Cursor / 其它 Agent]
   list_computers → 选一台 → run
```

安装包在 GitHub Release，不在仓库里：

https://github.com/TITOCHAN2023/fleetForAgent/releases/latest

---

## 1. 部署 Worker

需要：Cloudflare 账号、Node 18+。

```bash
git clone https://github.com/TITOCHAN2023/fleetForAgent.git
cd fleetForAgent/packages/keel-worker
npm install
npx wrangler login
npx wrangler deploy
```

成功后会打印类似：

```
https://keel-hub.<你的账号>.workers.dev
```

这就是 Agent 里填的 **Worker 域名**。也可以绑自己的域名（Cloudflare Dashboard → Workers → Triggers → Custom Domain）。

### 令牌（建议生产打开）

```bash
npx wrangler secret put HUB_TOKEN
```

设了之后，设备连接和控制面调用都要带：

```
Authorization: Bearer <HUB_TOKEN>
```

本机 Agent 设置页有「Hub token」栏。没设 secret 时 Worker 是开放的，只适合自己先打通。

本地调试：

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev --port 8787
```

Agent 填 `http://127.0.0.1:8787`（会转成 `ws://…/v1/device`）。

---

## 2. 每台电脑装 Agent

到 [Releases](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest) 下载：

| 系统 | 文件 |
|---|---|
| Windows | `KeelAgent-windows-amd64.exe` |
| macOS Apple 芯片 | `KeelAgent-macos-arm64.dmg`（打不开用旁边的 zip） |
| macOS Intel | `KeelAgent-macos-amd64.dmg` |
| Linux | `keel-agent-linux-amd64.tar.gz` |

然后：

1. 打开安装包（Windows 双击 exe；Mac 拖到应用程序；Linux 解压跑 `./keel-agent`）。
2. 浏览器会开 `http://127.0.0.1:17890` 设置页。
3. 打开「允许在这台电脑上运行」。
4. 填 Worker 域名（不要带路径，例如 `keel-hub.xxx.workers.dev`）。
5. 如果 Worker 设了 `HUB_TOKEN`，填同一个 token。
6. 点连接，状态变成「已连接 Worker」。
7. 选权限：
   - **停用**：什么都不跑
   - **需当面同意**：电脑前的人要点同意
   - **自动执行**：直接跑（危险命令仍拦截）

设备只主动连 Worker，**不用开端口、不用公网 IP、不用 VPN**。

自己重打安装包：

```bash
npm run release:agent
gh release create v0.x.0 public/dl/KeelAgent-* public/dl/keel-agent-linux-amd64.tar.gz
```

---

## 3. 列机器、选一台、执行

健康检查：

```bash
curl https://keel-hub.<account>.workers.dev/v1/health
```

列设备（不返回 IP）：

```bash
curl -X POST https://keel-hub.<account>.workers.dev/v1/list_computers \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
```

跑一条命令：

```bash
curl -X POST https://keel-hub.<account>.workers.dev/v1/run \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"<id>","command":"uname -a"}'
```

返回 `{ "corr": "...", "status": "running" }`。再取结果：

```bash
curl -X POST https://keel-hub.<account>.workers.dev/v1/get_result \
  -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"<id>","corr":"<corr>"}'
```

协议信封：`{ v:1, type, id, corr, t, body }`。设备路径只有 `WSS /v1/device`。

### 异步任务怎么避免卡顿（学 tmux hub）

任务活在**设备本地的 pane**里，不活在 Worker 请求上。

| 不要 | 要 |
|---|---|
| 把 stdout 字节流接到 Worker | 本机 ring buffer，像 tmux 的 pane 历史 |
| `pipe-pane` 一直推 | `capture-pane` 式快照 |
| HTTP 等到 `sleep 30` 结束 | 立刻 `accepted`，之后 `read_screen` / `get_result` |
| 每次输出一条 WS | 4Hz latest-wins，中间帧丢掉 |

```bash
# 立刻返回 { corr, status: running }
curl -X POST $HUB/v1/run -H "authorization: Bearer $HUB_TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"<id>","command":"yes"}'

# 拉屏幕快照，不 attach
curl -X POST $HUB/v1/read_screen -d '{"device_id":"<id>"}' ...

# 往 stdin 打字，不等进程
curl -X POST $HUB/v1/type -d '{"device_id":"<id>","keys":"q\n"}' ...
```

控制面（ping / type / read_screen）不进 `Wait()`。编译打一万行也不会把枢纽打卡。


---

## 4. 可选：部署控制台网站

仓库根目录是 TanStack Start 控制台（登录、实验室、下载页）。预览用进程内 PGLite；正式库用 Postgres。

```bash
# 根目录
cp .env.example .env.local
# DATABASE_URL=postgres://...
# BETTER_AUTH_SECRET=长随机串
# BETTER_AUTH_URL=https://你的网站
npm install
npm run build
```

可以放到任意 Node 主机，或接 Neon + 你常用的前端托管。控制台和 Worker 是分开的：Worker 管设备中转，网站管登录和 UI。

---

## 5. 安全要点

- 设备只出站。家用路由不用做端口映射。
- Token 走 `Authorization` 头，不要写进 URL。
- 本机三级权限在设备上执行，Worker 改不了。
- 危险命令（`rm -rf`、`format`、关机等）Agent 直接拒。
- 生产必须 `wrangler secret put HUB_TOKEN`。
- 机器之间 ping 不通是预期：没有内网 overlay。

---

## 常见问题

**连不上 Worker**  
域名不要带 `https://` 也行，Agent 会补。确认 `npx wrangler deploy` 成功，本机能 `curl /v1/health`。

**Mac 提示未签名**  
系统设置 → 隐私与安全性 → 仍要打开。或用 zip 里的 `.app`。

**Windows SmartScreen**  
更多信息 → 仍要运行。这是未签名 exe 的正常提示。

**list_computers 是空的**  
Agent 要先显示已连接。刷新几秒后再 POST。

**想换域名**  
Workers 绑 Custom Domain 后，所有 Agent 改填新域名再点连接。
