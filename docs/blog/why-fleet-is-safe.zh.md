---
title: 谁能动你的电脑
date: 2026-08-21
summary: 设备只往外拨，token 走一次性的非对称握手，每条查询按账号切，最后一道开关留在你自己的机器上。也写清楚哪几层我自己就能绕过去。
---

Fleet 的数据库里没有一列存设备 IP。整个 schema 里唯一带 ip 的字段是 `session.ipAddress`，那是浏览器登录留下的，不出现在任何 `/v1/*` 的响应里。

这条约束很便宜，写的时候顺手就做了。难回答的是另一个问题，谁能在你的机器上跑命令。下面按层写，每层拦的是谁，以及哪几层我自己就能绕过去。

## 设备自己往外拨

Agent 起来以后自己拨 `WSS /v1/device`。设备侧不开入站端口，不要求公网 IP，家用路由不用做端口映射。操作端只用 HTTPS 打网站，网站手里已经握着这些 socket。

扫端口这条路上因此没有目标。机器之间也互相看不见，没有局域网 overlay。

设备 id 一旦落到某个账号名下就占住了。握手时先查一次。

```ts
// src/lib/fleet/v1.server.ts
async function stolenDevice(userId: string, deviceId: string) {
  const rows = await sql`select user_id from devices where id = ${deviceId}`;
  return Boolean(rows[0] && rows[0].user_id !== userId);
}
```

命中就回 409 加 `socket.destroy()`，WebSocket 根本不升级。同一个账号自己重连算替换，旧连接收 `1012 replaced`。

## 为什么给 agent 一个 token

Agent 是常驻进程，装在你自己的机器上，没人守着。它存不了你的登录密码，也维持不住浏览器会话。它需要一个能写进配置文件、又能单独作废的凭据。

所以凭据分成两套，管的事不重叠。Cookie 登录只能进设置页和签发 token，动机器的接口不认 cookie。Hub token 只能动机器，它签不出新的 token，Worker 上 `/v1/hub_token` 明确拒 super。

泄了一套，另一套还在。重置 token 也因此不用改密码。`issueHubToken` 把 `hub_tokens` 里那一行换掉，接着 `kickUser` 用 `1008 token reset` 把这个账号所有在线 socket 踢下去。一个账号一行，主键就是 `user_id`，后面每条查询都拿它切。

## Bearer 的代价

Bearer 的意思是每个请求都把长期密钥原样交出去一次。

Agent 常驻，每几秒说一次话，一天几万次原样交出。任何一次被记下来，这个账号就永久归对方，直到你自己去重置。记下来的地方都是真实存在的东西。反代的访问日志会记 header，公司出口装了根证书的中间盒看到的是明文，云厂商的请求日志也在那儿，还有你为了排错贴出去的那一屏 curl。

密钥放 header 不放 URL 只挡住最粗的一类，query string 进日志、referer 泄露。会记 header 的东西它一个也挡不住。

所以 `flt_1` 的整串永远不上线。两边都拒绝降级。

```ts
// src/lib/fleet/v1.server.ts
if (auth.kind === "bearer" && (isLegacyFlt(auth.token) || auth.token.startsWith("flt_1."))) {
  return { error: HIGH_SEC_UPGRADE, code: "HIGH_SEC" };
}
```

客户端那边 `highSecAuthorization` 自己先拒，旧的 `flt_` hex token 连握手都不发起。先试新的、失败退回旧的，这条路没留，留着它等于没做。

## 私钥在中枢，公钥在你手里

你粘贴的那一串长这样。

```
flt_1.<base64url(payload)>.<base64url(sig)>

payload = {"v":1,"aud":"https://fleet.ginfo.cc","kid":"<uuid>","pub":"<SPKI>","iat":1756...,"sec":"<64 hex>"}
```

`sig` 是 RSA-PSS-SHA256，salt 32，签在 payload 的字节上。`payloadBytes` 按固定字段顺序序列化，`verifyTokenV1` 收到以后重新序列化一遍，逐字节比对。换个字段顺序、多塞一个键，都过不去。

密钥的方向和直觉相反，这也是整套东西的支点。私钥留在中枢，公钥在你手里。

客户端只需要做两件事，把东西加密给中枢，再验证对面确实是中枢。两件事都只要公钥。它不需要解开任何东西，所以不给它私钥。中枢握着私钥，既能解客户端的密文，又能在客户端面前签名自证。

一次认证走三步。

第一步取 challenge，`GET /v1/challenge?kid=…` 不需要认证。

```ts
// src/lib/fleet/v1.server.ts
const nonce = /* 32 字节随机，转 64 位 hex */;
const exp = Date.now() + CHALLENGE_TTL_MS;        // 120 秒
challenges().put(kid, nonce, { userId: row.user_id, exp });
const sig = await signChallenge({ privatePkcs8B64: row.priv, aud: origin, kid, nonce });
return json({ nonce, kid, aud: origin, exp, sig });
```

中枢用这个账号的私钥，对 `v1|<aud>|<kid>|<nonce>` 做 PSS 签名。每个 `kid` 最多留 8 个没用过的 nonce，`nextChallengeList` 管这件事，所以匿名刷这个接口灌不满存储。

第二步，客户端先用 token 里的 `pub` 验那条签名，过了才封装。

```go
// packages/fleet-agent/tokenv1.go
if !verifyChallenge(pub, claims.Aud, claims.Kid, chal.Nonce, chal.Sig) {
    return "", fmt.Errorf("%s", highSecKeyMismatch)
}
wrap, err := wrapAuth(pub, claims.Sec, chal.Nonce)   // OAEP-SHA256({sec, nonce})
return "Fleet-OAEP " + claims.Kid + "." + wrap, nil
```

第三步，中枢查三样。`wrap` 能用这个 `kid` 的私钥解开。nonce 在本子里、没过期、`kid` 和 `user_id` 都对得上，`challenges().take(nonce)` 是取走，不是看一眼。`sha256(sec)` 等于库里的 `token_hash`。缺一样就是 401。

线上于是没有可以复用的凭据。抓到的那个头在第一次用掉之后就是一段废密文，最长 120 秒自己过期。

## 客户端凭什么相信对面

Agent 装在别人家的网里，没人盯着，也没有第二个地方可以查。它手上只有一个 token 文件，`~/.fleet-agent/config.json`，权限 `0600`。对面是谁这件事，它得自己判断。

token 里钉住了两样东西，`aud` 和 `pub`。

`aud` 对不上就不连。它比的是配置里的 origin，Host 头不参与，换个 Host 头骗不过去。`aud` 绑 `HUB_ORIGIN` 就是为了这个。

对面签不出 `v1|<aud>|<kid>|<nonce>` 也不连。用 token 里的 `pub` 验，失败就是 `HIGH_SEC_KEY_MISMATCH`。

第二条要紧，因为它不依赖 TLS。公司出口装了根证书的中间盒、DNS 劫持、域名差一个字母的假站，都能给你一条看着合法的 TLS 通道。它们手里没有这个账号的私钥，签不出那条 nonce。Agent 于是在交出任何东西之前就停住了。

顺序也是故意排的，先验中枢再封装，`verifyChallenge` 在 `wrapAuth` 前面。就算跳过这一步，`wrap` 是拿公钥加密的，假中枢没有私钥，拿到密文也读不出 `sec`。两层各自独立。

孤立的意思就在这里。Agent 不用信 DNS，不用信企业代理，也不用有人在旁边确认。对端身份跟着 token 一起发下来。

## 我和运维能看到什么

隔离写在每一条查询里。动设备的 HTTP 端点先过 `ownsDevice(userId, deviceId)`，SQL 带 `where user_id`。内存里的 socket 表再查一遍。

```ts
// src/lib/fleet/live.ts
export function sendToDevice(userId: string, deviceId: string, payload: unknown): boolean {
  const slot = store().byDevice.get(deviceId);
  if (!slot || slot.userId !== userId) return false;
  if (slot.ws.readyState !== OPEN) return false;
  slot.ws.send(JSON.stringify(payload));
  return true;
}
```

两道是故意留的。哪天新加的端点忘了 `ownsDevice`，帧也发不出去。中枢里往设备发帧只有 `sendToDevice` 一个出口，它必须带 `userId`。`kickUser` 是唯一一个能跨着遍历 socket 的函数，它只会 `close(1008, "token reset")`，函数里没有 send。

`/ops` 那个页面，`isOpsAdmin` 拒 super、拒 banned、拒没有邮箱的，只认 `ADMIN_EMAILS` 里列的 cookie 邮箱。不在名单上的人拿到 404，页面不提示自己存在。`HUB_TOKEN` 和 Fleet-OAEP 都打不开它。

页面上看得到的东西只有 `deviceOpsPublic` 投影出来的那几样，`id`、`os`、`arch`、`agentVer`、`online`、`lastSeen`、`userId`。设备就是一串 UUID。`SENSITIVE_KEYS` 里的 `name`、`hostname`、`ip` 会被 `stripSensitive` 从整个响应里剥掉。

能改的只有一件事。三条路由，`GET /ops`、`GET /v1/ops/overview`、`POST /v1/ops/banned`，最后一条给账号打个 banned 标记，`banTargetError` 不许标记自己，也不许标记另一个管理员。标记完连线也不断，只在下次认证时变成 403。`ops.mjs` 里没有 run，没有 device stub，也没有 `sendToDevice`。

## 我能绕过去的地方

上面这些防的是日志泄露、只读拖库、路上的中间人。有服务器写权限的我，它们防不住。

只读拖到库，你拿到 `token_hash`、`kid`、`pub`、`priv`、`aud`。握手补不出来，`sec` 不在库里，库里只有 `sha256(sec)`，而 `wrap` 必须交出 `sec` 本身。

`priv` 在库里这件事得单独说。拿到它的人可以对着客户端伪造 challenge 签名，也就是拿到了扮演中枢的能力。它不能直接接管账号，却是中间人攻击的前提。`priv` 泄露和 `sec` 泄露危害不同，两个都不小。

有库写权限就是另一回事。`mintTokenV1` 重签一个 token，upsert 写进去，再 `kickUser`，这个账号就归我了。这条路我拦不住。任何说中枢完全无法作恶的话都是假的。

Worker 上还有个 `HUB_TOKEN`。设了它就有 super，`owns()` 直接返回 true，可以对任意在线设备发 run。它抢不走设备 WebSocket，`canClaimDevice("user-a", "*")` 是 false，但命令发得出去。新用户路径不需要它，别设。网站这条路的 `v1.server.ts` 里根本没有 `HUB_TOKEN` 分支。

兜住这一层的东西因此不在中枢这边。

## 最后一道在你自己的机器上

permit 是本地状态。协议里没有 `set_permit` 这种消息，中枢改不了它。库里的 `devices.permit` 只是个镜像，agent 在 ping 里报上来，中枢 update 一下给列表用。方向是设备往中枢，反过来没有。

改它只有两个地方，都在那台机器上，托盘右键，或者 `127.0.0.1:17890` 的本地页面，只绑回环。

`inputVerdict` 三态。off 或者没启用，run 和 type 都拒，回 exit 126 带一句 `permit=off`，已经开着的窗格一样拒。ask，命令挂在那里等你在机器上点一下，之后的键鼠也要点，授权还是分开的，截图授权不带输入授权，socket 一断授权清零。allow 直接跑，本机还有一条 `devicePolicyBlocked` 挡 `shutdown`、`reboot`、`mkfs`、`format c:`、`diskpart`，以及不带绝对路径的 `rm -rf`。那条正则只挡手滑，别把它当安全边界。

所以哪怕中枢被我接管，哪怕 token 泄了，`permit=off` 的机器还是不执行。这是唯一一条不用信中枢的约束。

## 剩下的窟窿

`allow` 就是把那台机器交给拿着 token 的人。它该是这个样子。

`read_screen` 和 `list_panes` 不看 permit。它们不执行东西，`permit=off` 的时候还是会返回窗格快照。要彻底静默就把 Enabled 关掉。

ban 不断线，只在下次认证时变成 403。

合盖休眠不拦。没公证的 Mac 包还是会被 Gatekeeper 隔离。

一个 token 覆盖这个账号下所有设备。想分权，现在只能分账号。

上面每条都能在仓库里点开看，`src/lib/fleet/v1.server.ts`、`packages/fleet-worker/src/tokenv1.mjs`、`src/lib/fleet/live.ts`、`packages/fleet-worker/src/ops.mjs`、`packages/fleet-agent/main.go`。
