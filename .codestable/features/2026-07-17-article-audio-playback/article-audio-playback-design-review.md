---
doc_type: feature-design-review
feature: 2026-07-17-article-audio-playback
status: passed
reviewed: 2026-07-17
round: 3
---

# article-audio-playback feature design 审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-article-audio-playback/article-audio-playback-design.md`
- Checklist: `.codestable/features/2026-07-17-article-audio-playback/article-audio-playback-checklist.yaml`
- Brainstorm: `.codestable/features/2026-07-17-article-audio-playback/article-audio-playback-brainstorm.md`
- Roadmap: none
- Related docs: `requirements/article-audio-playback.md`、`requirements/VISION.md`、`architecture/ARCHITECTURE.md`
- Compound: 未命中音频、Markdown、上传或目录 convention
- Code facts checked: `server/utils/markdown.js`、`server/routes/admin.js`、`server/config.js`、`server/utils/path-security.js`、`server/analytics/middleware.js`、`server/index.js`、`views/article.ejs`、`views/admin/upload.ejs`、`views/partials/header.ejs`、`package.json`、`playwright.config.js`、EJS frozen baseline gates

### Independent Review

- Status: completed
- Detection: native-agent
- Provider / agent: `/root/article_audio_design_review_fast`
- Raw output: 首轮发现 4 blocking、4 important、2 nit；完整修订复审后剩 2 important；focused closure 最终确认全部关闭
- Merge policy: 主 agent 已逐条对照 design、checklist、代码和 EJS gate 事实核验；未直接照抄未经验证结论
- Gate effect: none；最终独立 verdict 为 passed
- Residual reviewer risk: 同类 native agent 审查，不具备异构 provider 差异

## 2. Design Summary

- Goal: 把随 ZIP 上传的 MP3 作为文章资产，以受控 Markdown 块生成原生音频作品卡片。
- Key contracts: 作者态/发布态 source 分离；以 Markdown entry 目录为相对路径基准；两个连续完整 MPEG frame + SHA-256；stage/promotion/SQLite 最后 commit + 幂等 rollback；冻结 EJS 零改动。
- Steps: 8 步，按作者契约、ZIP 路径、MP3 资产、发布 transaction、生命周期、UI/README、自动化、浏览器/冻结基线切片。
- Checks: 14 条，覆盖名词契约、编排、安全、挂载点、范围守护和验收场景。
- Baseline / validation: `npm test` 80 pass / 1 skip；view/baseline hash 通过；HTML snapshots 17/17；完整 visual 需要至少 300 秒；新增独立音频 Playwright 命令。

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

- 长期作者契约应把不可信作者态 source 和可渲染发布态 source 分成不同类型，避免“重写后又被作者解析器接受”的信任混淆。
- 历史不可变视觉基线不适合作为新 UI 的 expected；新 feature 应保留旧证据，并建立独立运行期浏览器场景。

### praise

- 文件系统和 SQLite 无法共享原子 transaction，design 已把 promotion、最后 DB commit 和幂等补偿写成可注入失败、可证伪的契约。
- checklist 的 8 个步骤均有独立退出信号，Acceptance Matrix 能追踪到命令和证据类型。

## 4. User Review Focus

- 用户需要重点拍板：首版仅 MP3、单文件 20 MiB；ZIP 展开总量 100 MiB；不做专用封面/转码/全站播放器；多张原生控件相互独立。
- 用户需要重点拍板：相对音频路径以 Markdown 文件所在 ZIP 目录为基准；含音频块的单 `.md` 必须拒绝。
- implement 需要重点遵守：作者态/发布态两阶段类型、固定 DOM、两个连续完整 MPEG frame、SHA-256、最终 slug 隔离目录、跨资源 promotion/rollback 顺序。
- code review / acceptance 需要重点复核：同 slug 并发残余风险、`adm-zip` 展开 size 事实、Range/analytics 行为、EJS frozen baseline 零 diff、桌面/手机运行期截图。

## 5. Evidence Confidence Ledger

| Check | Verdict | Evidence Class | Basis | Follow-up |
|---|---|---|---|---|
| Acceptance Coverage Matrix | pass | E | design §3.1/§3.3 把 SC-01 至 SC-11 映射到 S1-S8 和命令 | acceptance 逐条回填 |
| DoD Contract | pass | E | design §3.4 与 checklist `dod.commands` 均含 4 条一致命令 | implementation 创建 CMD-002 script |
| Steps and checks traceability | pass | E | checklist 8 steps / 14 checks 均有 design/SC 来源 | implementation 不改 checks |
| Roadmap contract compliance | n/a | E | design 无 roadmap metadata，feature 直接起头 | none |
| Module interface design | pass | C | 代码现状 + design §2.1 明确 depth、seam、dependency strategy、无假 adapter | code review 复核模块未退化为 pass-through |
| Validation and artifacts | pass | C | package scripts、Playwright/EJS gates 与 design 证据计划一致 | visual 命令使用至少 300 秒窗口 |

Summary: E=4, C=2, H=0, H-only core checks=none。

## 6. Residual Risk

- 同 slug 首次并发上传仍可能在 DB commit 前竞争同一目录；implementation/code review 必须保证失败不会误删另一请求资源。
- ZIP 100 MiB gate 依赖 `adm-zip` 暴露的 entry size；实现阶段要用构造 ZIP 验证声明值与实际解压行为。
- 运行期截图不是长期像素 baseline；本 feature 只把它作为验收证据，不修改 EJS 3 冻结快照。
- 固定 stylesheet link 位于生成的文章内容内而非 EJS head；独立浏览器场景必须验证桌面/移动浏览器实际加载和去重。

## 7. Verdict

- Status: passed
- Next: 交给用户整体 review；用户明确批准后把 design 标为 approved 并进入 Standard implementation。

## 8. Focused Closure

- Closed findings: FDR-B01 至 FDR-B04、FDR-I01 至 FDR-I04、FDR-N01/N02、R2-I01/I02、R2-N01/N02
- Attributed delta: 只修改 design/checklist；未修改实现、范围或 roadmap
- Verification: checklist YAML 校验通过；独立 reviewer 对两轮实质修订和最终窄修均完成复核
- Classification: 首轮修订改变实现契约并做了完整独立复审；最终窄修只闭合 MP3 判定、DoD step 引用和摘要术语，未改变 feature 范围或架构边界
