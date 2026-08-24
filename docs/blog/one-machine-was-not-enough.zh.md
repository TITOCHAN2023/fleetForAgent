---
title: 一台不够
date: 2026-08-24
summary: Grok 那个 bot 一次只能碰一台机器，那台机器还不是我的。我想要的是让任何能加载 MCP 的 agent 够到我自己所有的电脑，于是先解决出站，再解决模型会重发命令这件事。
---

我做 Fleet 的起点是 grok 上那个 bot。它能跑命令，一次只能碰一台机器，那台机器还是它自己的沙箱。

我缺的东西不是一台机器。机器已经在手上了，Windows、Linux、macOS 都算，架构也不限。缺的是让 agent 够到它们的那一层。

## 为什么做成 MCP

我没有写新的客户端。写了也没人用，因为好用的 agent 已经在别的地方了。

MCP 这层的好处是它不挑宿主。能加载 MCP server 的 agent，装上就有一整个机器列表可以用。配置只有两个值，`FLEET_URL` 和 `FLEET_TOKEN`，跟 Go agent 那边填的是同一对。`~/.fleet/mcp.env` 也会读，已经设过的环境变量不覆盖。

入口就一个文件。带参数是 CLI，不带参数进 MCP stdio。

```js
// packages/fleet-tool/index.mjs
const argv = applyCliDevFlag(process.argv.slice(2), process.env);
if (argv.length) {
  // ... node index.mjs list / run <device_id> '...'
} else {
  mcp();
}
```

省掉一个二进制的维护成本，也省掉两套代码互相说谎的机会。

## 工具面长什么样

十二个工具。`list_computers` 拿账号下的机器，`set_computer` 记住一台，之后的调用可以不带 `device_id`。

`set_computer` 只活在当前这个 stdio 进程里，不写盘，不写回账号，别的客户端看不见。这条是故意的。一个账号底下可能开着网页控制台和两个 agent，谁都不该改掉别人正在操作的那台机器。

它也不会替你挑唯一在线的那台。模型很愿意猜，猜错的后果是命令跑到另一台电脑上。没有记住设备的时候它直接报错，让你说清楚。

## 模型不是人

这是整件事里我改得最多的地方。

人在终端里等命令跑完。模型不等，它会以为自己没成功，然后把同一条命令再发一遍。这件事被认真对付过的痕迹留在工具描述里，同一句警告写了四遍，`run`、`get_result`、`wait` 各一次，初始化时递给模型的 instructions 里还有一次。

`run` 立刻回，`wait_ms` 只是这次 MCP 调用愿意等多久的预算，跟超时杀进程没有关系。

```js
// packages/fleet-tool/operator.mjs
/** MCP-call wait budget only. Not a kill timeout. Hosts cancel tools at ~60s. */
export const WAIT_MAX_MS = 30_000;
```

上限压在 30 秒。宿主大约 60 秒就会把工具调用取消掉，留出余量。等不到就回一行 `still running`，这行字不算错误，取消等待也不会杀掉远端的命令。

给模型看的说明里就写着这句。

```
run waits up to 30s; if the text is still running, call wait — do not run again.
```

## 设备那边为此改了什么

命令要是挂在中枢的请求上，中枢就得一直举着一个进程，模型一断线这条命令的输出就没人接了。所以任务活在设备上。

每个 `run` 在设备上起一个自己的进程，POSIX 下是 `shell -c` 带一个 PTY，Windows 是 `cmd /C`。判断跑完看的是子进程退出码，不是提示符。一个卡住的任务因此吃不掉下一条命令。

输出留在本地的环里，长度写死。

```go
// packages/fleet-agent/internal/pane/pane.go
const (
	ScreenInterval = 250 * time.Millisecond
	ringLines      = 200
	headLines      = 200
	screenLines    = 80
)
```

线上走的是快照，250 毫秒一帧，最新的那帧赢，中间的丢掉。模型读屏幕要的是现在是什么样子，不是这两秒里滚过的每一个字节。

## 只出站是前提

家用宽带后面的机器通常没有公网 IP，路由器也不该为了这件事开一个端口。agent 自己往外拨 `WSS /v1/device`，设备侧不开入站端口，操作端只用 HTTPS 打网站。

这条决定了整套东西能不能给普通人用。要是还得先教人做端口映射，前面那些工具做得再顺也没意义。

## 拿着 token 的是模型

这也是我把开关留在本机的原因。permit 三态在 agent 里，off、ask、allow，中枢改不了它，协议里没有对应的消息。ask 的时候命令挂在那儿等你在机器上点一下。

模型会自作主张。人也会手滑。开关放在被操作的那台机器上，两种情况都盖得住。

机器数量没有上限。

```ts
// src/lib/fleet/cap.ts
/** Fleet size is unbounded. Three seed boxes are a demo, not a ceiling. */
export const FLEET_CAP: number | null = null;
```
