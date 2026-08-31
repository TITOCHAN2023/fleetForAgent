# Fleet

**一个 MCP 工具。Windows、Linux、macOS。随时随地。**

先用线上版体验：**[https://fleet.ginfo.cc](https://fleet.ginfo.cc)**

![命令怎么走](../media/architecture-flow.gif)

每台电脑装一个 Agent，工具里导入 **网站地址 + Hub token**。Cursor / Claude 只连中枢；每台 Windows / Linux / Mac 都主动向中枢建立 WebSocket，中枢手里握着所有连接。能跑 Agent 的架构，就能加入同一支舰队。

[打开 fleet.ginfo.cc](https://fleet.ginfo.cc) · [文档](https://fleet.ginfo.cc/docs) · [部署](deploy.md) · [登录](auth.md) · [手记](notes.md)

English: [../en/README.md](../en/README.md)

## 工作原理

![Fleet 架构](../media/architecture.svg)

1. **Tool** — Cursor、Claude、MCP。`FLEET_URL` + `FLEET_TOKEN`。
2. **Server** — [fleet.ginfo.cc](https://fleet.ginfo.cc)（或配置好 OAuth 和按账号签发 Token 的 Worker）。负责转发任务。更简单的单用户自托管路径是 Node 中枢。
3. **Agent** — Windows amd64、Linux amd64/arm64、macOS arm64/amd64 上主动连 `WSS /v1/device`。设备侧不开端口。

讲解视频：[architecture.mp4](../media/architecture.mp4)

## 先试云端版

1. 打开 [https://fleet.ginfo.cc](https://fleet.ginfo.cc)，Google / X 登录。
2. 设置页生成 Hub token。
3. 每台电脑装 [Agent](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest)，中枢地址填 `https://fleet.ginfo.cc`。
4. Tool 填同一对：

```bash
FLEET_URL=https://fleet.ginfo.cc FLEET_TOKEN=flt_... node packages/fleet-tool/index.mjs list
```

同一 Worker 上的 `/ops` 给 `ADMIN_EMAILS` 里的登录邮箱看用量和 last-seen 新鲜度，并可以 Ban。空 secret = 没有管理员。不是单独的 Worker。Ops 和 Ban 都不会增加机器控制权限。

完整步骤：[deploy.md](deploy.md) · [auth.md](auth.md)

## 本地只是命令行

```bash
npm install
npm run dev
```

http://127.0.0.1:8080 适合改代码。中枢跑在环回地址上，别的电脑根本够不到这个地址，自然加不进来——本地部署永远成不了舰队，最多算个命令行工具。想随时随地操作所有电脑，就把中枢部署到云端，或者直接用 **[https://fleet.ginfo.cc](https://fleet.ginfo.cc)**。
