# Fleet

[English](../en/README.md) · [项目概览](../../README.md) · [免登录只读演示](https://fleet.ginfo.cc/demo/)

Fleet 让 AI 使用你已有的电脑。**Fleet Sandbox 插件**安装在机器上，**Fleet Tool**连接 MCP 客户端，**Fleet Agent**指 Room 中的 AI 参与者。现有二进制名称、Token 字段和配置路径继续兼容。Sandbox 是产品名称，不代表操作系统隔离。

## 连接第一台机器

1. 选择[公共 Hub](https://fleet.ginfo.cc)或[自己部署](deploy.md)。
2. 公共 Hub 在设置页生成 Token。给目标机器安装 Sandbox 插件，填相同的中枢地址和 Token，从需要本机确认的 `ask` 权限开始。
3. 在设置页复制 Streamable HTTP、经典 SSE 或 stdio MCP 配置，导入 AI 客户端。
4. 列出机器，按设备 ID 或唯一别名选中一台，执行无副作用的测试命令。任务运行中用 `wait` 或 `get_result` 继续查看；断线后先用 `recover_session` 回查，结果不明时不要直接重跑。

公共 Hub 使用每个账号独立的 `flt_1` Token。[个人 Node Hub](../../packages/fleet-hub/README.md)使用自己的 `SELF_HOST_TOKEN`。自托管可以放在互通的内网，环回地址只能指向当前电脑。

## 目前的能力边界

- 普通命令支持 RTC 直连与 WebSocket 回退。文件传输等 direct-only 插件打洞失败就会失败，不会悄悄改走中枢传输文件。
- 插件安装和调用服从机器侧权限。`allow` 不会再要求额外点击，插件具有运行服务的系统用户权限。
- [Rooms](../../packages/fleet-room/README.md)把任务记录保存在 leader 上。成员运行器目前要求 Linux tmpfs，Windows/macOS 的同等隔离尚未实现。
- 中枢能看到经过它转发的内容。Worker 命令和插件结果保留 15 分钟，屏幕快照 5 分钟且可随活动续期，活动记录 24 小时。这些期限不能当作全系统删除保证。

[完整安装说明](deploy.md) · [隐私与留存](privacy.md) · [发布证据](trust.md) · [登录](auth.md) · [安全问题报告](../../SECURITY.md)
