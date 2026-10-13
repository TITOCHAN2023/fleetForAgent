# Linux 双虚拟机隔离与稳定性验证

日期：2026-10-13。分支：`codex/linux-sandbox-isolation`，基于
`a999aee14ecc467cd75139239f9a2194a99504f3`。
原工作区未改动。本次作为依赖 PR #22 的独立审查变更；合并、发布、部署是另外的动作。
私有实验磁盘及脱敏证据保留，不提交实验状态。

## 环境与边界

- 两台真实 Debian 12 arm64 / Lima VZ 虚拟机，各 2 CPU、3 GiB 内存、12 GiB 磁盘。
- 独立内网，VM A 运行本地 Worker/DO Hub、STUN、Agent、Room leader 和一个 runner；
  VM B 运行另一个 Agent、runner。两台均无宿主目录挂载、SSH agent 转发或生产凭据。
- 准备依赖后通过 guest nftables 禁止外网与宿主网关访问，只保留实验内网和管理连接。
- Agent 和测试任务以非 root 用户运行；自动更新关闭；故障及危险命令回归均在 VM 中。
- Agent 是本地未发布构建，版本字段仍为 `0.6.6`，不是下载新版或自动更新。
  回收版二进制 SHA-256：`16804a0a505d9836524d5523f20ad90c4f347d3b56d629ae8651351cfffaf41e`。
  此前重连修复版为 `d2f0d842193b8e0c505369dcc2fb2a92a2a5ef6e658c789d713eb3e32dca16c1`。
- Hub 使用固定构建的 Miniflare/workerd，不部署 Cloudflare，不使用远程绑定。
  依赖及复现步骤见 [实验说明](../../scripts/plugin-peer-vm/LINUX.md)。
- 官方 ACP 0.1.2 使用目录中的真实发布二进制并验证 SHA-256；离线放置安装产物，
  不把本轮声称为下载安装链路验证。下游 ACP 是确定性测试程序，不调用真实大模型。

## 发现并修复

1. **任务登记时序竞争**：发送 `run` 后立即查询，可能先于设备登记，误报 unknown；
   RTC 和远程 MCP 均复现。最终在 Agent 共用入口先做无 I/O 的内存登记，再启动异步
   处理；查询区分排队与缺失收据。磁盘 intent 仍必须在执行前写入，真正 unknown
   仍不允许重跑。撤回了最初仅覆盖 RTC 的 Tool 等待补丁，避免两套逻辑。
2. **并发握手挤占**：账号级仅 8 个 challenge 槽位，32 个同时握手只成功 8 个。
   调整为有界 64 个；签名、120 秒 TTL、单次消费及撤销校验不变。修复后 32/32
   真实握手成功，重复使用 nonce 仍返回 401。错误提示不再要求盲目重置有效 token。
3. **瞬时网络故障变永久认证失败**：挑战请求连接失败、429/5xx 等曾被归为 HIGH_SEC，
   Agent 随后不再重连。现在走原有重连退避；撤销及错误签名仍失败关闭。
4. **插件完成结果写入旧连接**：任务在 Hub 重启期间继续执行，但旧 socket 的写入可能
   返回成功而没有送达。按当前 socket 身份投递，最多两分钟重试完成结果，绝不重跑插件。
   结果绑定请求时的 Hub/token；Token、地址变更或撤销后不得转发到新身份。
   RTC 回退同样检查原授权身份。
5. **重传覆盖结果归属/状态**：第二份插件结果会丢失完成记录中的 owner，迟到的
   accepted 还会覆盖 done。保留原 owner，不降级已完成状态；其他操作者仍读不到结果。
   新增回归先复现失败，再验证修复。
6. **RTC 回退连带关闭 WS**：关闭直连会取消 session context，随后将该 context
   传给 WebSocket 写入，可能把共享控制连接也关闭。新增回归在旧逻辑下报
   `context canceled`；回退改用独立的五秒写入期限，并保留原授权身份检查。
   另用真实 WebSocket 验证回退结果和后续控制消息都能送达。
7. **已完成 pane 无回收机制**：所有 backend 共用登记路径，全局按完成顺序保留最近
   256 个已完成 pane。不回收运行/排队任务，不清空投递协程持有的输出，不删除磁盘
   收据。可恢复请求仍保留退出码，旧输出返回 `output_unavailable`，绝不因此重跑。
   不关闭命名持久终端。这是数量上限，不是严格的字节上限。

同时修正了中英文部署文档：普通 `run` 不持久化 cwd/env；显式
`fleet session NAME` 才是按操作者隔离的持久终端。没有改变这个现有行为。

## 验证结果

- Linux Go：回收版本 268 通过、2 跳过，覆盖 Agent、pane、backend、policy；
  已启用仅限隔离环境的真实进程去重/断线测试。缺少 Git、Herdr 的两项未覆盖。
- 回收单测连续 50 轮通过；真实进程测试回收输出后强制从磁盘读收据，仍返回退出码 7，
  拒绝其他操作者读取，并确认原请求只执行一次。
- 完整 `npm test`：570 通过、7 跳过；类型检查通过；lint 无错误，仅有原有宣传组件
  的两条 warning。Windows amd64、macOS arm64 pane 测试交叉编译通过，不代表真机测试。
- RTC 专项连续 50 轮通过，包括真实 WS 回退、授权身份及旧协议兼容。
- Tool/Room/认证 Node：236 通过、1 跳过。
- Worker/DO TypeScript：74 通过，包含插件重传归属和旧 Agent 兼容回归。
- 真实流程：最终版本连续三轮，240 个 RPC、120 个 stdio MCP、60 个 Room 任务；
  四个独立操作者及四个 MCP stdio 进程，交替同机与跨机执行；检查 corr、
  hostname、唯一输出标记、默认机器、cwd/env、取消范围及异主结果读取。
- Room：三个 runner 使用相同显示名，以身份和目标设备路由任务；执行实际 Fleet 命令。
- 远程 MCP：四个 Streamable HTTP 会话、四个经典 SSE 会话，80 个任务通过，
  同机与跨机输出隔离，结果 transport 为 WS。
- 同名持久终端：不同操作者的 cwd/env、detach/reattach 不串台。
- RTC 实际建立后关闭直连，同一 corr 经 WS 返回结果，不重跑命令。
- 故障矩阵六项通过：35 秒断网、Hub 重启、插件离线完成后投递、插件跨 Hub 重启、
  Agent 重启后的完成收据、Agent 强杀后的 unknown；文件执行次数均按用例核验。
- 官方 ACP：20 个并发任务、崩溃/超时隔离及 10 分钟长任务均通过；长任务观测
  回收构建 604.976 秒、118 次结果/心跳检查，`allow` 下无需第二次人工批准。
- 此前重连修复版的 30 分钟并发 soak：115 轮、920 个短任务全部通过；29 分钟单任务正常完成。
- 健康窗口为 2026-10-13 05:05:44–05:35:50 UTC（新加坡 13:05:44–13:35:50）：
  双机共 122 条采样全部在线，六个服务 PID 未变化、重启增量为 0、无 OOM。
  同窗口 Agent 日志无 `socket closed`、HIGH_SEC 或 auth_failed。

## 回收前基线与策略边界

30 分钟功能验证通过，不等于长期内存稳定。服务 cgroup 内存观测如下（MiB，非单进程 RSS）：

| 服务 | 起始 | 结束 | 峰值 |
|---|---:|---:|---:|
| Agent A | 29 | 244 | 244 |
| Agent B | 8 | 79 | 79 |
| 本地 Hub | 272 | 511 | 514 |

Agent A 收尾时匿名内存约 220 MiB，不能全部归因为文件缓存。代码检查确认
`Supervisor.panes/order` 会保留已完成 pane，未见回收逻辑；其增长值得进一步做
内存剖析，不能把上表全部增长未经剖析就归因于单一原因。

用户已在此基线后批准全局 256 个已完成 pane 的保留策略。新实验使用新的可丢弃
Agent 状态目录，同时保留原目录全部收据（A 为 2,890，B 为 949）。没有增加收据
清理逻辑，原有 4,096 个收据的准入上限不变。没有收据的旧协议请求无法恢复回收后的
输出；运行任务并发数、单 pane 输出大小仍是另外的边界，不能声称进程内存存在硬上限。

## 回收版本：重复压测与自然回收

窗口：2026-10-13 06:19:12–06:39:17 UTC（新加坡 14:19:12–14:39:17）。
四波共完成 4,096 个短任务，每波每机 512 个，同时叠加三轮完整集成、远程 MCP
和官方 ACP 长任务。两台机器各一个 15 分钟任务经过四次溢出后正常完成、输出正确。
窗口内未强制 GC，未重启 Agent 或 Hub。

双机共 82 条健康采样全部在线，六个服务 PID 未变、重启增量为 0、无 OOM。
下表单位均为 MiB：

| 指标 | Agent A | Agent B | 本地 Hub 服务组 |
|---|---:|---:|---:|
| cgroup 结束 / 峰值 | 113.4 / 114.0 | 108.1 / 118.9 | 604.7 / 629.3 |
| 匿名内存结束 / 峰值 | 96.5 / 97.9 | 94.6 / 104.5 | 483.0 / 504.0 |
| Agent 进程 RSS 结束 / 峰值 | 105.0 / 105.4 | 105.1 / 105.2 | — |
| 最后 8 分钟 Agent RSS 范围 | 67.8–105.4 | 103.6–105.2 | — |

缓存预热后进入上述观测范围，没有继续为每个完成任务永久保留 pane；可见自然回收
下降，不依赖重启。这里证明的是有界数量回归和有限窗口内的平台期，不声称所有负载
都无泄漏，更不保证永久在线。

稳态窗口结束后清除可丢弃 Hub 的结果缓存，旧请求仍返回退出码 7 和
`output_unavailable`。重复相同 request ID，文件执行计数仍为 **1**，通过真实
Hub/Tool/Agent 链路验证回收不允许重放。原收据目录数量不变。本轮证据为
`retention-final`、`retention-round-1/2/3`、`sessions-retention-final`、
`remote-retention-final`、`auth-retention-final`、`plugins-retention-final`、
`health-retention-final.ndjson`。

窗口结束后在回收构建重跑全部六项故障测试，均通过（`faults-retention-final`）。
故障注入造成的重启不混入稳态指标。证据收集后停止两台 VM，保留磁盘、旧收据及
原工作区。

脱敏证据由 `linux-collect-host.mjs` 导出：`relay-round-1/2/3`、`remote-relay-final`、
`sessions-relay-final`、`auth-relay-final`、`faults-relay-final`、`plugins-relay-final`、
`soak-relay-final`；健康记录为 `health-relay-final.ndjson`。失败的 `unified-round-1` 也保留。

## 失败记录与限制

审查时父 PR #22 已存在 Windows CI 失败：
`TestOperationUnavailableStoreNeverStartsCommand` 断言必须为 unknown，而 Windows
文件系统路径返回执行前拒绝（退出码 126，无法持久化 intent）。父分支 Linux/Web
检查通过。本次不修改这处跨平台状态契约，也不声称 Windows CI 全绿。

回收验证期间曾在 VM A 启动 Node 测试，但该机缺少测试专用 Hub 源码和共享 JSON
夹具；换到完整的 VM B 后为 236 通过、1 跳过。macOS 上完整 Room CLI 测试的 13 项
因需要 Linux `/dev/shm` 而失败；这些用例在 VM B 通过。不把不支持/不完整环境的
失败记成通过。

初始本地 Wrangler 开发模式曾因 1 GiB cgroup 限额 OOM；提高到 2 GiB 后仍出现一次
无完整错误栈的开发进程退出。它暴露了真实的 Agent 重连和插件投递缺陷。
最终固定构建运行时仍使用相同业务代码和 DO 数据；早期失败时长不计入最终 soak。
目前没有证据把后一次开发进程退出归因于生产 Cloudflare 服务。

统一入口修复后的第一轮并行测试还复现了上述 RTC/WS 连带断线；该轮 MCP 失败
及被主动终止的 soak 均保留，不计作最终通过。修复后重新完整计时。

这里的“隔离”是任务路由隔离，不是同一管理员 token 下敌对 agent 的强安全隔离。
插件完成结果只在内存中重试两分钟；进程死亡、长时间断网仍可能丢失结果。
unknown 不能视为失败或允许自动重跑。有限时长测试也不能保证永久在线。

本轮不覆盖 macOS/Windows 真机、系统休眠/合盖、真实公网 NAT、浏览器外观或线上部署。
已有同一 Agent 二进制提供 `fleet start/status/--daemon`；没有新增第二套 Mac 守护进程。

[English](../en/linux-sandbox-validation.md)
