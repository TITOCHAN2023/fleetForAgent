# Intro video — script seed

Visual bed: `architecture.mp4` (24s, 1920×1080, silent).  
Record VO separately, then mux:

```bash
ffmpeg -i architecture.mp4 -i voice.wav -c:v copy -c:a aac -shortest fleet-intro.mp4
```

Cut extra live footage (login, Settings token, agent tray) after this VO if the piece grows past 24s.

## English VO (~24s)

0–3s  
Fleet. Your coding agent, on your real machines.

3–8s  
Three pieces. You, in Cursor or Claude. The website — that is the hub. And a small agent on each computer.

8–15s  
You send a command over HTTPS. The hub forwards it. The agent already dialed out on a websocket, so nothing on your LAN has to listen. The result comes back the same way.

15–19s  
No inbound ports. No VPS on the device side. One account, many machines, rows scoped in SQL.

19–24s  
Log in. Mint a hub token. Install the agent. Point MCP at the same origin and token.

## 中文口播（同一时间轴）

0–3s  
Fleet。让你的 Agent 跑在你自己的电脑上。

3–8s  
三块：你这边的 Cursor / Claude，网站本身就是中枢，每台电脑一个 Agent。

8–15s  
命令走 HTTPS 进中枢。Agent 只出网连 WebSocket，家里不用开端口。结果原路返回。

15–19s  
没有入站端口，设备侧不需要 VPS。一个账号多台机器，数据按 user_id 隔离。

19–24s  
登录，生成 Hub token，装 Agent，MCP 填同一对地址和 token。

## Shot list if we extend past 24s

| Shot | Source | Note |
|---|---|---|
| Title | Remotion SceneTitle | keep |
| Topology | Remotion SceneTopology | keep |
| Packet loop | Remotion ScenePacket / GIF | keep |
| Login (Google / X) | screen recording | 6s |
| Settings → generate token | screen recording | 6s |
| Agent tray / paste origin | screen recording | 6s |
| Cursor MCP `list` then `run` | screen recording | 8s |
| Outbound-only recap | Remotion ScenePrinciple | keep |
| CTA | Remotion SceneSetup | keep |
