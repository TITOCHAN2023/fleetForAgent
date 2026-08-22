# Fleet 介绍视频 — 全片脚本

目标观众：已经在用 Cursor / Claude / 其它 Agent 的人，机器却散落在家里、公司、机房。  
一句话：官方远程通道爱断；Fleet 用出网 WebSocket + 一个 MCP，让任意交互式 AI 操作你所有电脑。

建议规格：1920×1080 · 30fps · 双语两版口播 · 片长 **75 秒**（可剪 30 秒短版）。  
视觉：现有圆角 Logo、扇出架构、fleet.ginfo.cc，浅色/深色均可，不要霓虹赛博。

先体验：**https://fleet.ginfo.cc**

---

## 怎么讲（结构）

| 段 | 时间 | 任务 |
|---|---|---|
| 1 痛点 | 0–12s | 人对上了，电脑对不上。官方通道一断，家、公司、机房各是各的。 |
| 2 产品 | 12–22s | Fleet：一个 Tool，连上所有电脑。 |
| 3 原理 | 22–42s | Tool → 云端中枢 → WebSocket 扇出 Windows / Linux / macOS。只出网。 |
| 4 协同 | 42–55s | 任意交互式 AI 挂上 MCP，认 URL + token，就能用全部设备。 |
| 5 上手 | 55–68s | 四样东西。本地只是命令行，云端才是产品。 |
| 6 CTA | 68–75s | fleet.ginfo.cc |

不要先讲协议字段。先讲「断」和「全都能用」，扇出图放在中间。

---

## TTS 念稿（中文，给 CosyVoice / 洞白）

念稿原则：短句、句号换气；不念 NAT、本机回环地址、WebSocket、连在一起的域名。
Fleet 念「飞特」。MCP 拆成字母。站点念「fleet 点 ginfo 点 cc」。

| 段 | 秒 | 字数约 | 口播 |
|---|---|---|---|
| 1 痛点 | 0–12 | 48 | 你已经有很强的助手了。可电脑还是各管各的。官方远程通道动不动掉线。家里、公司、机房，永远对不齐。 |
| 2 产品 | 12–22 | 42 | 飞特不替代你的人工智能。任意交互式助手，挂上一个 M C P，就能用你名下每一台电脑。 |
| 3 原理 | 22–42 | 78 | Cursor、Claude，或任何客户端，只连云端中枢。每台电脑上的代理，自己向外连出去。Windows、Linux、Mac，架构不限。命令跑在你选的那一台，结果原路返回。家里不用开端口，也不用公网地址。 |
| 4 协同 | 42–55 | 58 | 官方通道一断，上下文就没了。飞特认的是中枢，不是某一家客户端。今天用 Cursor，明天换 Claude，只要导入我们的工具，你的舰队还在。 |
| 5 上手 | 55–68 | 54 | 四样东西。网站地址、一把令牌、每台电脑装代理、把工具导入助手。本地把中枢跑在本机，发挥不出多端互联。要随时随地，把服务放到云上。 |
| 6 CTA | 68–75 | 32 | 先上飞特网站体验。地址是 fleet 点 ginfo 点 cc。一个工具，你的所有电脑。 |

音色：`G:\project\F5-TTS\origin_audio\洞白\洞白.MP3`（参考句：这里是有点脏的，但是是鞋底。）
合成：`docs/media/promo/scripts/gen_vo.py` → `docs/media/promo/vo/`

---

## 分镜 + 口播（中文，75s）

### 1. 痛点  0:00–0:12

**画面**  
分屏三台机器：家里 Windows、公司 Mac、机房 Linux。中间一个对话框在转圈，然后灰色「连接已断开」。字幕：`官方通道 · 又断了`。

**口播**  
你已经有很强的 Agent 了。可电脑还是各管各的。官方远程通道动不动掉线，家里 NAT、公司笔记本、机房盒子，永远对不齐。

### 2. 产品  0:12–0:22

**画面**  
Logo 圆角方标入画。标题：`一个工具。所有电脑。随时随地。`  
三台机器收到同一条命令。

**口播**  
Fleet 不替代你的 AI。它让任意交互式 AI，挂上一个 MCP，就能用你名下每一台电脑。

### 3. 原理  0:22–0:42

**画面**  
扇出：左边 Cursor / Claude，中间 `fleet.ginfo.cc`，右边 Windows · Linux · macOS（amd64 / arm64）。光点从 Tool 进中枢，再同时打到三端，结果收回来。底部小字：`设备只出网 · 不开端口`。

**口播**  
Cursor、Claude，或任何 MCP 客户端，只连云端中枢。每台电脑上的 Agent 自己打出 WebSocket：Windows、Linux、macOS，架构不限。命令跑在你选的那一台，结果原路返回。家里不用映射端口，也不用公网 IP。

### 4. 协同  0:42–0:55

**画面**  
同一段对话：`list` → 三台在线 → `run hostname` 打到家里那台。换一个 Agent 客户端，还是同一套 URL + token，机器列表不变。对比闪一下：官方通道断开 vs Fleet 还在。

**口播**  
官方通道一断，上下文就没了。Fleet 认的是中枢，不是某一家客户端。今天用 Cursor，明天换 Claude，只要导入我们的 MCP，你的舰队还在。

### 5. 上手  0:55–1:08

**画面**  
四张卡：`01 域名 URL` `https://fleet.ginfo.cc` · `02 Hub token` · `03 每台电脑的 Agent` · `04 导入 Tool`。  
然后左右对比：本地 `npm run dev` 灰色「最多是个命令行」；右边高亮「云端才是产品」。

**口播**  
四样东西：网站地址、一把 token、每台电脑装 Agent、把 Tool 导入你的 AI。本地把中枢跑在 127.0.0.1，发挥不出多端互联。要随时随地，把 Server 放到云上，或直接来我们的站点。

### 6. CTA  1:08–1:15

**画面**  
大号 `fleet.ginfo.cc`。副标题：登录 · 生成 token · 装 Agent · 导入 MCP。Logo 停在角落。

**口播**  
先上 fleet.ginfo.cc 体验。一个 MCP，你的所有电脑。

---

## English VO (75s)

0–12s  
Your agent is strong. Your computers are not. Vendor remote channels drop. Home NAT, a work laptop, and a colo box never sit in the same conversation.

12–22s  
Fleet does not replace your AI. Any interactive agent that can load an MCP server can reach every machine you enrolled.

22–42s  
Cursor, Claude, or any MCP client talks to the cloud hub. Each Agent dials out over WebSocket — Windows, Linux, macOS, any arch. Jobs run on the box you pick. No inbound ports.

42–55s  
When the official channel dies, the session dies with it. Fleet is bound to the hub, not to one vendor client. Switch from Cursor to Claude: same URL, same token, same fleet.

55–68s  
Four values: the domain URL, a hub token, an Agent on each PC, import the tool. Localhost is a CLI. The product is the cloud.

68–75s  
Start at fleet.ginfo.cc.

---

## 30 秒短版（片头/信息流）

口播只留四句：

1. 官方远程通道爱断，电脑对不齐。  
2. Fleet：任意 AI 挂上 MCP，就能用你所有设备。  
3. Tool 连中枢，Windows / Linux / Mac 自己出网。  
4. 先上 fleet.ginfo.cc。

画面：断开 → Logo → 扇出三端 → CTA。

---

## 画面资产（已有 / 要补）

已有：`title.png`、`architecture.svg`、`architecture-flow.gif`、`architecture.mp4`、圆角 Logo。  
要补（做片时再渲）：官方通道断开对比、同一对话切客户端、四张上手卡、CTA 大字。  
实拍可选：托盘图标、设置页填 URL+token、Cursor 里出现 `list_computers` / `run`。不要拍 token 明文。

---

## 成片（本目录 promo 工程）

- 中文：`docs/media/promo/out/intro-zh.mp4`（约 78s，洞白口播）
- 英文：`docs/media/promo/out/intro-en.mp4`（约 88s，洞白口播）
- 口播稿：`docs/media/promo/vo/script.json`
- 合成 / 听检：`docs/media/promo/scripts/gen_vo.py`、`listen_asr.py`、`mux_intro.py`

---

## 制作顺序（先脚本，后成片）

1. 定 75s 中文口播，过一遍语速（约 4 字/秒）。  
2. Remotion 按六段 Sequences 铺画面；口播另录，ffmpeg 叠轨。  
3. 再剪 30s 短版。  
4. 片尾固定 `https://fleet.ginfo.cc`。

不要在片里讲 Worker / Durable Object / ConPTY。那是文档的事。
