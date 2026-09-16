# Hub 发布证据与信任边界

长期维护的图解说明：[如何核验 Fleet Hub](../blog/same-source-as-github.zh.md)。网站固定入口：[/docs/same-source-as-github](https://fleet.ginfo.cc/docs/same-source-as-github)，在 docs 首页置顶。

该文档统一维护发布文件下载与核验方法、生产落实状态、独立审计计划和信任边界。`/source` 是自报版本，旧字段 `verified` 仅检查 commit 格式，不能证明线上代码一致。

修改发布机制时，在同一个 PR 更新中英文正文，并运行 `npm run pack:blog` 同步网站资源。没有成功发布记录或审计报告，不得宣称相应事项已在生产完成。
