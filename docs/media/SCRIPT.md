# Intro video — script seed

Visual bed: `architecture.mp4` (30s, 1920×1080, silent).

```bash
ffmpeg -i architecture.mp4 -i voice.wav -c:v copy -c:a aac -shortest fleet-intro.mp4
```

## English VO (~30s)

0–3s  
Fleet. One tool. Every computer. Anywhere.

3–9s  
Your Cursor or Claude talks to the cloud hub. The hub already holds a WebSocket from each Agent — Windows, Linux, macOS, any arch that can run it.

9–15s  
Pick a machine, run a command, get the result. Devices only dial out. No inbound ports.

15–20s  
Four values: the domain URL, a hub token, an Agent on each PC, and the MCP tool.

20–25s  
Local deploy cannot run a fleet. At most a CLI. Cloud is the product.

25–30s  
Start at fleet.ginfo.cc.

## 中文口播

0–3s  
Fleet。一个工具，连上你所有电脑。随时随地。

3–9s  
Cursor / Claude 连云端中枢。中枢握着每台 Agent 打出来的 WebSocket：Windows、Linux、macOS，能跑就能加。

9–15s  
选一台，跑命令，拿结果。设备只出网，家里不用开端口。

15–20s  
四样东西：域名 URL、Hub token、每台电脑的 Agent、导入 MCP 工具。

20–25s  
本地部署发挥不出多端互联，最多是个命令行。要有用，必须上云。

25–30s  
先上 fleet.ginfo.cc 体验。
