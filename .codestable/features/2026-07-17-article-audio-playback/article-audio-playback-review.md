---
doc_type: feature-review
feature: 2026-07-17-article-audio-playback
status: passed
reviewer: subagent
reviewed: 2026-07-17
round: 3
---

# article-audio-playback 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-article-audio-playback/article-audio-playback-design.md`
- Checklist: `.codestable/features/2026-07-17-article-audio-playback/article-audio-playback-checklist.yaml`，S1-S8 全部 `done`
- Evidence pack: none（Standard lane）
- Gate results: none（Standard lane）
- DoD results: 对话中的实现证据；`npm test`、独立音频 Playwright、完整 EJS gate、`npm ls --depth=0`
- Implementation evidence: 当前对话中的 RED/GREEN、API、文件系统、浏览器截图和冻结基线结果
- Diff basis: 当前 unstaged/untracked 工作区中可归因于本 feature 的代码、测试、README 与 feature 产物
- Review mode: initial
- Baseline dirty files: `.codestable/reference/maintainer-notes.md`、`requirement-example.md`、`shared-conventions.md`、`system-overview.md`、`tools.md` 及其他现有 CodeStable 骨架文件不属于本轮代码审查范围

### Independent Review

- Detection: 原生 Task agent 可用；`ocr` CLI 已安装但 `ocr llm test` 因没有有效 LLM endpoint 配置失败，且工作区还含范围外 dirty 文件
- 环节 A 独立隔离 Task agent: `native-agent` + `completed`
- 环节 B OCR CLI: `failed`（no valid LLM endpoint；未启动 workspace review）
- OCR severity mapping: High→blocking/important，Medium→nit/suggestion，Low→discarded
- Merge policy: 独立 agent 结果已逐条按本地代码与确定性复现核验后合并
- Gate effect: 三轮完整独立审查均已完成；两轮并发 blocking 经 material review-fix 后关闭

## 2. Diff Summary

- 新增：`server/article-audio/*.js`、`public/css/article-audio.css`、四组 Node 测试与独立 Playwright 场景
- 修改：Markdown 工具、管理员上传/删除编排、analytics 排除、配置、测试 fixture、Playwright 配置、README
- 删除：none
- 未跟踪 / staged：本 feature 新文件均未跟踪；无 staged diff
- 风险热点：文件系统与 SQLite 补偿事务、相同 slug 并发 ownership、ZIP/MP3 输入边界、用户可见音频控件

## 3. Adversarial Pass

- 假设的生产 bug：两个相同 slug 上传在 DB commit 前交错，失败请求的补偿可能删除成功请求已经发布的最终资源
- 主动攻击过的反例：相同 slug 并发、一个 SQLite UNIQUE 失败、Markdown rename 覆盖、音频目录复用与 ownership、rollback 重入、浏览器测试假阳性
- 结果：并发反例升级为 `REV-001` blocking；真实播放/seek 与 HTTP 失败证据进入 important；进程崩溃窗口和固定 ID 冲突进入 residual risk

## 4. Findings

### blocking

none

- `REV-001` closed：slug 选择、资产准备、promotion 与 DB commit 已纳入同一 serializer；Markdown 使用原子 no-clobber hard-link；loser 不再删除 winner，真实同 slug HTTP 并发会得到两个不同且完整的发布 slug。
- `REV-001-R2` closed：最终资源 rollback 不再在 serializer 外重试。旧 rollback-failure + queued upload 反例复跑为前一请求 `article_publish_rollback_failed`、后一请求成功，且后一请求 Markdown/音频均保留，rollback 只调用一次。

### important

none

- `REV-002` reclassified to acceptance focus：原生控件、GET/HEAD/Range 与浏览器焦点已有分层证据；实际播放/暂停/seek 仍需 acceptance 不能过度声称 CMD-002 已完全证明。
- `REV-003` reclassified to residual risk：模块层输入/错误、publication 层 promotion/SQLite/rollback、HTTP 层成功/读取/删除/并发均已有证据；逐项 HTTP 错误矩阵属于加强项。

### nit

none

### suggestion

- `server/article-audio/assets.js:220-230` 可按规范化 ZIP entry 缓存 `getData()`、校验和 hash，避免同一 MP3 多次引用时重复工作；本轮不阻塞。

### learning

- 文件系统 promotion 与 SQLite 只能构成补偿事务；资源 ownership 必须和并发模型一起验证，单请求内的布尔 ownership 不能自动保证跨请求安全。

### praise

- 作者态相对路径与 published URL 两阶段分离清晰；固定 DOM、HTML 转义、`html: false`、SHA-256 命名与 Range 集成验证方向正确。
- 没有修改冻结 EJS、`custom.css` 或引入自定义播放器依赖。

## 5. Test And QA Focus

- QA 必须重点复核：相同 slug 并发（相同/不同音频、一方 DB 失败）；桌面/手机实际播放暂停 seek；20/100 MiB 边界；稳定错误 code 与零残留；rollback 失败脱敏。
- Evidence pack residual risks / gate warnings：完整 EJS gate 已通过；OCR 因本机未配置 endpoint 未运行。
- 建议新增或加强的测试：确定性并发 publication/HTTP 测试；表驱动 HTTP 输入错误；可解码的运行时合成 MP3 浏览器验证。
- 不能靠 review 完全确认的点：ZIP size/CRC 不一致时 `adm-zip` 内存行为；进程在 promotion 与 DB commit 之间崩溃后的孤儿清理。

## 6. Residual Risk

- 独立 Playwright 当前证明布局、样式加载、无 autoplay、可聚焦与无溢出；实际播放/暂停/seek 需在 acceptance 补自动化或人工证据。
- malformed/missing/oversize 的逐项 HTTP 表驱动覆盖可继续加强，但稳定 code 已由模块测试覆盖。
- `article-audio-title-N` 可能与 markdown-it-anchor 生成的标题 ID 冲突，acceptance 需决定是否作为无障碍收尾项。
- 同一进程在 promotion 后、DB commit 前崩溃仍可能留下孤儿文件；当前补偿只能覆盖可捕获异常。
- ZIP 100 MiB gate 基于声明展开大小，尚未对恶意 size/CRC 不一致做专门内存压测。
- serializer 仅覆盖当前单 Node 进程；多实例部署需要跨进程协调。

## 7. Verdict

- Status: passed
- Next: Standard feature 进入 `cs-feat` accept-inline；重点复核实际播放/暂停/seek，并重跑最终完整门禁

## 8. Focused Closure（无则写 none）

none
