---
doc_type: feature-review
feature: 2026-07-16-detailed-visitor-analytics
status: passed
reviewer: subagent
reviewed: 2026-07-17
round: 2
---

# detailed-visitor-analytics 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-16-detailed-visitor-analytics/detailed-visitor-analytics-design.md`
- Checklist: `.codestable/features/2026-07-16-detailed-visitor-analytics/detailed-visitor-analytics-checklist.yaml`
- Evidence pack: `.codestable/features/2026-07-16-detailed-visitor-analytics/evidence/`
- Gate results: checklist 内实现证据与本地测试输出
- DoD results: pending review-fix
- Implementation evidence: 当前工作区源码、测试、部署脚本与文档
- Diff basis: `git status --short` 与当前未提交工作区；排除既有 `.codestable/reference/*` 脚手架噪音
- Review mode: full-rereview（round 2；round 1 为 initial）
- Baseline dirty files: `.codestable/reference/*`、`.codestable/requirements/VISION.md` 等 CodeStable 既有工作区变更，不归入本功能审查范围

### Independent Review

- Detection: 原生 Codex Task agent 可用；OCR CLI 已安装但没有配置 LLM endpoint
- 环节 A 独立隔离 Task agent: native-agent + completed
- 环节 B OCR CLI: failed
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: 独立审查结果已逐条用当前源码本地核验后合并
- Gate effect: round 2 无 blocking/important；允许进入 Standard accept-inline

## 2. Diff Summary

- 新增：访客明细实体/仓储/查询/API/UI、浏览器上下文采集、GeoIP resolver、GeoIP 周更新脚本与 systemd units、相关测试
- 修改：analytics 挂载链路、配置、后台页面、Nginx、README/DEPLOY、依赖与样式
- 删除：旧 `server/routes/analytics.js`，职责迁入模块化 analytics 实现
- 未跟踪 / staged：本功能文件均未 staged；工作区另有 CodeStable scaffold 噪音
- 风险热点：文件原子切换与异步生命周期、100k 明细聚合、游标边界、认证响应缓存、浏览器 Client Hints

## 3. Adversarial Pass

- 假设的生产 bug：每周 MMDB 原子替换与 resolver 轮询交错，导致旧 reader 被错误标记为新 fingerprint；后台冷查询在高基数数据上阻塞事件循环
- 主动攻击过的反例：rename/stat/read 时序、poll 中 stop、非法日期/超大游标、每次写入后的冷 overview、unknown 地区下钻、未认证页面缓存、Chromium high-entropy 返回额外低熵字段
- 结果：round 1 的 1 个 blocking、4 个 important（含本地 Chromium finding）、2 个 nit 和 2 个 suggestion 均已闭合；round 2 为 0 blocking / 0 important / 2 个非阻塞 nit

## 4. Findings

### blocking

- [x] REV-001 `server/analytics/adapters/geo-resolver.js:143` MMDB 内容与 fingerprint 绑定同一 file handle（closed in round 2）
  - Closure evidence: `handle.stat()`/`handle.readFile()` 来自同一 inode；确定性 fake FS 测试覆盖读期间 atomic replacement 并验证下一轮正确加载

### important

- [x] REV-002 `server/analytics/query/analytics-query.js:269` overview 使用事务内小时预聚合和 SQLite top-51（closed in round 2）
  - Closure evidence: metric/detail/七维小时预聚合同事务写入；查询只对预聚合行做 SQL `GROUP BY`/top-51；100k 每轮真实写入后冷 query+serialize p95 364.60 ms，响应 128,759 bytes
- [x] REV-003 `server/analytics/adapters/geo-resolver.js:182` generation guard 阻止 stop 后 poll 写回（closed in round 2）
  - Closure evidence: poll/start 在异步边界检查 `started + generation`，deferred candidate 测试证明 stop 后 reader 保持 null
- [x] REV-004 `server/analytics/query/analytics-query.js:46` cursor 严格日期 round-trip 与 safe positive rowid（closed in round 2）
  - Closure evidence: 日期要求 parse 后 ISO round-trip 相等，metricId 要求 positive safe integer；非法月份/闰日/超大值 fixture 均返回 `invalid_filter`
- [x] REV-005 `public/js/analytics-context.js:41` Chromium high-entropy 返回值二次 allowlist（closed in round 2）
  - Closure evidence: collector 只复制请求过的高熵键；测试模拟 Chromium 同时返回低熵键并通过服务端 validator

### nit

- [x] REV-006 `server/analytics/admin-page.js:39` 管理员 HTML 在认证前设置 `no-store`（closed in round 2）
- [x] REV-007 `views/admin/analytics.ejs:91` composite unknown 不再渲染下钻按钮（closed in round 2）
- [ ] NIT-201 `server/analytics/repository.js:162` 仅针对运行过未发布中间 schema 的 ALTER/backfill 不是完全 crash-idempotent
- [ ] NIT-202 `server/analytics/adapters/geo-resolver.js:59` status timestamp 仍可接受会被 JS 归一化的日历无效日期

### suggestion

- [x] REV-008 overview cache 已限制为最多 8 项（closed in round 2）
- [x] REV-009 updater status `errorCategory` 已收紧为固定 enum（closed in round 2）
- [ ] 建议监控 365 天/百万级高基数下预聚合表体积、写放大、rebuild 时长与索引形态
- [ ] 若模块未来用于热重载，module 层可再增加 stop-during-start generation
- [ ] updater 真实 I/O 失败前可预设阶段类别，提升 status 排障精度

### learning

- atomic rename 的读取方不能把 path metadata 与另一次 path read 当作同一文件快照；应绑定同一 file handle。

### praise

- 路径展示 helper 统一覆盖全部路径且保留 raw identity；token、context hash、路由局部 16 KiB body parser、凭据清理及 updater 的同盘 staging/rollback 边界清晰。

## 5. Test And QA Focus

- QA 必须重点复核：Linux updater/systemd/Nginx、真实 MMDB、Cloudflare/source headers、跨浏览器 UAData；本地已覆盖 MMDB rename 交错、poll 中 stop、100k 冷 overview+序列化、非法 cursor、未认证 no-store、Chromium allowlist、unknown 地区 UI
- Evidence pack residual risks / gate warnings：Windows 无法验证真实 systemd/flock/Nginx/Cloudflare/真实 GeoLite2 数据库，留到 Linux 发布环境
- 建议新增或加强的测试：旧中间 details schema 中断恢复、真实 Linux I/O failure、百万级高基数与 365 天存储基线
- 不能靠 review 完全确认的点：真实 `geoipupdate`、systemd Persistent missed-run、`nginx -t`、跨浏览器端到端

## 6. Residual Risk

- Linux updater integration 在当前 Windows 环境被 skip；上线前需在 Linux 执行脚本故障注入、真实 MMDB 校验、systemd 与 Nginx 验证。100k 每轮真实写入失效后的冷 overview+serialize p95 为 364.60 ms，距离 500 ms 预算仍需生产磁盘复核。

## 7. Verdict

- Status: passed
- Next: Standard feature accept-inline

## 8. Focused Closure（无则写 none）

none（本轮为行为、并发与数据架构发生实质变化后的完整独立复审，不是 focused closure）
