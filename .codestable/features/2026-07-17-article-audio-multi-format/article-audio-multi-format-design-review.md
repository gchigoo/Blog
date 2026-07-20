---
doc_type: feature-design-review
feature: 2026-07-17-article-audio-multi-format
status: passed
reviewed: 2026-07-17
round: 3
---

# article-audio-multi-format feature design 审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-article-audio-multi-format/article-audio-multi-format-design.md`
- Checklist: `.codestable/features/2026-07-17-article-audio-multi-format/article-audio-multi-format-checklist.yaml`
- Intent / brainstorm: 沿用已验收 `article-audio-playback` 能力及本轮用户确认的多格式增量；本目录无独立 intent / brainstorm 文件
- Roadmap: none
- Related docs: `.codestable/requirements/article-audio-playback.md`、`.codestable/architecture/ARCHITECTURE.md`、已验收 `2026-07-17-article-audio-playback` feature
- Code facts checked: `server/article-audio/assets.js`、`server/article-audio/markdown.js`、`server/article-audio/publication.js`、`server/routes/admin.js`、`server/index.js`、`server/analytics/middleware.js`、`package.json`

### Independent Review

- Status: completed
- Detection: native-agent
- Provider / agent: `/root/article_audio_design_review`
- Raw output: 首轮发现 2 blocking、7 important、3 nit；第二轮确认旧问题关闭，但发现 M4A AOT 接受范围与浏览器矩阵不一致；收紧为 AAC-LC AOT 2 后，第三轮完整复审为 passed
- Merge policy: 主 agent 已逐条对照 design、checklist、代码现状和浏览器 spike 核验；未直接照抄未经验证结论
- Gate effect: none；最终独立 verdict 为 passed，但仍必须停在 owner 整体确认 gate
- Residual reviewer risk: 同类 native agent 审查，不具备异构 provider 差异

## 2. Design Summary

- Goal: 把文章音频从 MP3-only 扩展为 `.mp3`、ADTS `.aac`、AAC-LC `.m4a` 和 `.flac`，沿用 ZIP 发布、文章原生播放器和随文章删除能力。
- Key contracts: 唯一格式 registry；严格小写扩展名和 canonical MIME；格式特定有界结构校验；按 `(sha256, extension)` 发布；typed `<source>` + 始终可见文件链接；显式 `/audio` GET/HEAD/Range；不转码、不全量解码。
- Steps: 9 步，先做 MP3 seam 行为等价微重构，再独立实现 AAC/M4A/FLAC validator，随后接通资源边界、DOM/static、生命周期、自动化和浏览器证据。
- Checks: 15 条，覆盖格式、大小、错误语义、资源生命周期、MIME/Range、XSS、浏览器降级、文档治理和清洁度。
- Baseline / validation: 现有 `npm test` 105 tests / 104 passed / 1 Linux-only skipped；音频 Playwright 2/2；完整 EJS gate 的 17 HTML + 102 visual 通过。最终必须执行 CMD-001 至 CMD-005。

## 3. Findings

### blocking

none

### important

none

### nit

none

### suggestion

none

### learning

- “支持 AAC”必须区分 ADTS `.aac` 与 ISO BMFF `.m4a`，并进一步区分 MP4 OTI 与 AAC AOT，不能只凭扩展名或 magic 判定。
- 服务端结构校验与浏览器真实解码是两类证据；前者可拒绝伪装和越界容器，但不能宣称完整媒体 payload 可解码。

### praise

- 设计把扩展名、MIME、大小和 validator 收敛到唯一 registry，避免资产、DOM 与 HTTP 映射漂移。
- 浏览器矩阵先尝试真实播放，仅在 WebKit+FLAC 实际失败时允许可访问文件链接降级，没有把 `canPlayType()` 当作播放证据。

## 4. User Review Focus

- 用户需要重点拍板：只支持 `.mp3/.aac/.m4a/.flac`；`.aac` 与 `.m4a` 首版均只接受 AAC-LC，M4A AOT 5/29 暂不接受。
- 用户需要重点拍板：MP3/AAC/M4A 单文件 20 MiB，FLAC 50 MiB；ZIP 压缩包与声明展开总量均为 100 MiB。
- 用户需要重点拍板：不做 ffmpeg 转码或兼容副本；validator 只做有界结构筛查，不解码整段 payload。
- 用户需要重点拍板：所有 browser/format 先真实播放；只有 WebKit+FLAC 实际失败时可转文件链接 fallback，若其环境已支持则必须记为 `played`。
- implement 需要重点遵守：S1 re-export 兼容、精确 gate 顺序与错误 code、逐 entry stage/release、流式冲突 hash、canonical MIME 和 Range 字节契约。
- code review / acceptance 需要重点复核：M4A/FLAC parser 的越界防护、SC-13 的结构深度表述、资源峰值、混合格式 rollback/并发、冻结 EJS 零改动。

## 5. Evidence Confidence Ledger

| Check | Verdict | Evidence Class | Basis | Follow-up |
|---|---|---|---|---|
| Acceptance Coverage Matrix | pass | E | design §3.3 将 SC-01 至 SC-13 映射到 S1-S9、证据类型和命令 | acceptance 逐条回填 |
| DoD Contract | pass | E | design §3.4 与 checklist `dod.commands` 覆盖 Design/Implementation/Review/QA/Acceptance 和 CMD-001 至 CMD-005 | implementation 不得降低 core gate |
| Steps and checks traceability | pass | E | checklist 9 steps / 15 checks 均有 design 或 scenario 来源，状态全为 pending | implementation 按退出信号更新 |
| Roadmap contract compliance | n/a | E | design 无 roadmap metadata，直接从 current requirement 增量起头 | none |
| Module interface design | pass | C | 代码现状与 design §2.1/§2.2 明确 registry seam、validator error mode、资产 metadata 和 orchestration 顺序 | code review 复核 registry 未变为多份映射 |
| Validation and artifacts | pass | C | package scripts、现有音频/EJS gates 与 design CMD-001 至 CMD-005 一致 | acceptance 保存真实 HTTP/浏览器证据 |

Summary: E=4, C=2, H=0, H-only core checks=none。

## 6. Residual Risk

- `adm-zip` 的 `getData()` 仍会为单 entry 分配完整 Buffer；设计只把 feature 自身的同时存活音频 Buffer 控制为一个最大资产，不能承诺进程总峰值等于 100 MiB。
- M4A/FLAC parser 是严格受限结构筛查，可能拒绝超出本轮 brand/profile/box 约束的合法文件；这是范围选择，不是通用媒体兼容层。
- MP3/AAC/M4A/FLAC 均不做整段 payload 解码；结构合法但 payload 损坏时可能通过服务器 gate，必须由真实浏览器证据和文件链接降级承接。
- WebKit FLAC 支持取决于具体浏览器构建和系统解码能力，不能固定写死为支持或不支持。

## 7. Verdict

- Status: passed
- Next: 交给用户整体 review；用户明确批准后把 design 标为 `approved` 并进入 Standard implementation。

## 8. Focused Closure

- Closed findings: FDR-B01/B02、FDR-I01-I07、FDR2-I01，以及两轮 nit
- Attributed delta: M4A 首版接受范围收紧为 AAC-LC AOT 2；SC-03/SC-13 step 映射补齐；S8/S9 的 SC-13 服务端与浏览器证据职责澄清
- Verification: design frontmatter 与 checklist YAML 校验通过；9 steps / 15 checks 均为 pending；第三轮完整独立 reviewer verdict 为 passed
- Classification: AOT 接受范围改变公开契约，已执行第三轮完整独立复审；最后 S8/S9 文案只澄清既有 Acceptance Matrix 的证据归属，不改变行为、范围或验收语义
