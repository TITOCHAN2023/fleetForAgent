# Fleet

**一个 MCP 工具。Windows、Linux、macOS。随时随地。**

先上线体验：**[https://fleet.ginfo.cc](https://fleet.ginfo.cc)**

![命令怎么走](../media/architecture-flow.gif)

每台电脑装一个 Agent，Tool 里导入 **域名 URL + Hub token**。Cursor / Claude 只连中枢；中枢已经握着每台 Windows / Linux / Mac 主动打出来的 WebSocket。哪种架构能跑 Agent，就能进同一支舰队。

[打开 fleet.ginfo.cc](https://fleet.ginfo.cc) · [部署](deploy.md) · [登录](auth.md)

English: [../en/README.md](../en/README.md)

## 怎么工作

![Fleet 架构](../media/architecture.svg)

1. **Tool** — Cursor、Claude、MCP。`FLEET_URL` + `FLEET_TOKEN`。
2. **Server** — [fleet.ginfo.cc](https://fleet.ginfo.cc)（或你自己的 Worker）。转发任务。
3. **Agent** — Windows amd64、Linux amd64/arm64、macOS arm64/amd64 上主动连 `WSS /v1/device`。设备侧不开端口。

讲解视频：[architecture.mp4](../media/architecture.mp4)

## 先用云端试

1. 打开 [https://fleet.ginfo.cc](https://fleet.ginfo.cc)，Google / X 登录。
2. 设置页生成 Hub token。
3. 每台电脑装 [Agent](https://github.com/TITOCHAN2023/fleetForAgent/releases/latest)，中枢地址填 `https://fleet.ginfo.cc`。
4. Tool 填同一对：

```bash
FLEET_URL=https://fleet.ginfo.cc FLEET_TOKEN=flt_... node packages/fleet-tool/index.mjs list
```

完整步骤：[deploy.md](deploy.md) · [auth.md](auth.md)

## 本地只是命令行

```bash
npm install
npm run dev
```

http://127.0.0.1:8080 适合改代码。中枢跑在环回上，看不见 127.0.0.1 的 Windows / Linux / Mac 加不进来，**发挥不出多端互联**，最多是个命令行工具。要随时随地操作所有电脑，必须把 Server 部署到云端，或直接用 **[https://fleet.ginfo.cc](https://fleet.ginfo.cc)**。
