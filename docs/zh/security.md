# 为什么 Fleet MCP 是安全的

只要 **Hub token（`flt_1…`）不离开你的电脑**，没有人能通过 MCP 工具操作你的设备。这篇说明从「为什么必须做非对称加密」开始，把一路上可能被攻的点写清楚，以及每一处为什么过不去。

登录、OAuth、签发步骤见 [auth.md](auth.md)。这里只讲 **MCP / Agent 这条控机通道**。

---

## 结论

| 谁 | 能不能用 MCP 控你的机 |
| --- | --- |
| 拿着你那份 `flt_1` 的人（你自己，或你贴进 Cursor 的环境） | 能。这就是设计用途。 |
| 网站登录 cookie（包括别人的、管理员的） | 不能控别人的机。管理员 `/ops` 只能看状态、封禁账号。 |
| 读生产库 / Durable Object 目录 | 看不到 token 明文，拼不出 MCP 身份。 |
| 截获线上的 `Authorization` 头 | 看到的是一次性 OAEP 包装，不是 token。 |
| GitHub 上的代码、开发者 clone | 不能。 |

**泄露 token = 把钥匙交给对方。** 除此之外，MCP 这条路走不通。怀疑泄露了：设置页重置 token。旧钥匙立刻作废，所有已连接的 Agent 被踢下线（`1008 token reset`），设备要重新贴新 token 才能再连。

---

## 为什么要做非对称加密

如果 MCP 把 `flt_1…` 整串当成 `Authorization: Bearer` 每次请求带出去，会出现这些洞：

1. **线路上就是那把钥匙。** 代理、CDN、HAR、支持日志、浏览器扩展，任何碰到 HTTPS 解密或明文日志的地方，都能把 token 存下来，以后无限重放。
2. **中枢若把「用户的 token」原样入库，读库等于拿到 MCP。** 开发者、备份、一次错误的 dump，都会变成全舰队遥控器。
3. **Bearer 没有「这一次」的概念。** 抄到一次，就能一直用，直到你想起去改。

所以 v1 不发 Bearer。设置页为每个账号生成一对 **RSA-2048**：

- **私钥**只放在中枢（Durable Object 用户行的 `priv`），用来拆开客户端送来的包装、给 challenge 做 PSS 签名。
- **公钥**和一份随机 **secret（`sec`）** 写进你复制的 `flt_1.<payload>.<sig>`。payload 用同一把私钥做 PSS 签名，并绑死 `aud = HUB_ORIGIN`（例如 `https://fleet.ginfo.cc`），不绑 HTTP `Host`，防换域名重放。

Agent 和 MCP **永远不会把 `flt_1` 放进 Header**。每次连上或发指令：

1. `GET /v1/challenge?kid=…` — 中枢用私钥给一个短时 nonce 做 PSS 签名（默认两分钟、每个 kid 最多 8 个未用 challenge）。
2. 客户端用 token 里的 **公钥** 做 RSA-OAEP，包一层 `{ sec, nonce }`。
3. Header 只发 `Authorization: Fleet-OAEP <kid>.<wrap>`。
4. 中枢用私钥解开，核对 nonce 是自己刚签的、且 `SHA-256(sec)` 等于库存的 `tokenHash`。对得上，才当成这个账号。

线路上没有 `sec`，库里也没有 `sec`。库里是 hash。公钥加密、私钥解密：截获包装的人没有私钥解不开；读到私钥的人没有 `sec` 做不出能过 hash 的包装。两边缺一不可，而 `sec` 只存在你贴过的那串 token 里。

Token **只在生成或重置时显示一次**。之后 GET `/v1/hub_token` 只返回「有没有 token、前缀、创建时间」，再也不会把明文吐出来。

---

## 可能攻破的地方（以及过不去的原因）

### 1. 截获 MCP / Agent 的 HTTPS 或 WSS

看到的是 `Fleet-OAEP` 包装和 challenge 签名。没有私钥解不开 `{sec, nonce}`；就算解开（只有中枢能），nonce 用过即删，过期作废，不能拿去重放下一次。

### 2. 读生产数据库（Durable Object）

设备目录只有 id、在线、系统、lastSeen 一类。用户行有 `priv` 和 `tokenHash`，**没有** `flt_1` 明文。SHA-256 不可逆，32 字节随机 `sec` 穷举不了。没有 `sec` 就过不了第 4 步校验，MCP 身份做不出来。

### 3. 伪装网站登录 cookie

网站 cookie 只能当 **这个账号自己**。操作接口要 `owns()`：`device.userId === 当前用户`。A 的 cookie 打 B 的设备是 404。Cookie 也换不出 `flt_1`。产品里控机走的是 MCP + token，不是网页控制台代你敲命令。

`/ops` 管理员另算：只看用量和新鲜度、可以 Ban。Ban **操作不了机器**。Overview 会剥掉主机名和 IP。管理员 cookie 不是 Fleet-OAEP，进不了 MCP 通道。

### 4. GitHub 开发者、clone 仓库

仓库里没有生产 token、没有用户私钥、没有 session。代码能告诉你协议长什么样，不能当你登录。

### 5. 抢设备的 WebSocket

设备只 **出站** 连 `WSS /v1/device`，不开放入站端口。绑定规则：空闲设备谁登录谁占；已被账号 A 占用时，B（以及开发用的超级令牌身份 `*`）都不能把 socket 抢过来。新连接会踢掉同一设备的旧连接，避免两条线同时指挥。

### 6. 重置 token

重置会删掉旧密钥对、旧 hash，签发新 `flt_1`（又只显示一次），并对该账号下每台在线设备关闭 WebSocket（`1008 token reset`）。旧 token 立刻失败。这不是绕过，是 **机主主动换锁**：所有设备要重新配对。攻击者拿不到新明文。

### 7. 真的泄露了 token

对方若得到完整 `flt_1`（聊天记录、截图、提交到 git 的 `mcp.env`、共享的 Cursor 配置），就能像你一样做 OAEP 握手，指挥 **这个账号已连上的机器**。这是唯一对 MCP 成立的攻破方式。处理：立刻重置；旧连接掉线；换新 token 只贴在本机。

---

## 你需要守住的只有这一件事

1. Token 只放本机：`~/.fleet/mcp.env` 或 MCP 配置，不要发进对话、Issue、截图、网盘。
2. 怀疑漏了就重置。接受所有设备要重新贴 token。
3. 不要用别人的电脑登录你的 fleet.ginfo.cc 再把 token 生成在那台机器上。

做到这些，用 Fleet MCP 操作你自己的 Windows / Linux / macOS，对其他人就是锁上的。钥匙在 token 里；钥匙不离开你，门就不会给别人开。
