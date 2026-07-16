---
doc_type: feature-design-review
feature: 2026-07-16-google-auth-comments
status: passed
reviewed: 2026-07-16
round: 4
---

# Google 登录评论与审核 feature design 审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-16-google-auth-comments/google-auth-comments-design.md`
- Checklist: `.codestable/features/2026-07-16-google-auth-comments/google-auth-comments-checklist.yaml`
- Brainstorm: `.codestable/features/2026-07-16-google-auth-comments/google-auth-comments-brainstorm.md`
- Roadmap: none
- Requirement: `.codestable/requirements/reader-comments.md`
- Architecture: `.codestable/architecture/ARCHITECTURE.md`
- Code facts checked: `server/index.js`、`server/routes/auth.js`、`server/middleware/auth.js`、`server/scripts/init-db.js`、`server/db.js`、`server/routes/admin.js`、`test/helpers/project-fixture.js`、`views/article.ejs`

### Independent Review

- Status: completed
- Detection: native-agent
- Provider / agent: `/root/google_comments_design_review_final`
- Raw output: Round 4 verdict `passed`，remaining blocking=none，remaining important=none
- Merge policy: 主 agent 已对照当前 design/checklist/code 逐项核验；未修改 reviewer 审查中的文件
- Gate effect: design-review gate 通过，可交 owner 做整体 design review

### Review History

- Round 1 `changes-requested`：关闭禁用 404/503 冲突，补 Cookie 生命周期、module factory seam、场景映射和展示名隐私。
- Round 2 `changes-requested`：补 HKDF token 防混淆、Google adapter 方法协议、完整审核状态机、store-level step、配置 URI 校验和 provider 错误场景。
- Round 3 `changes-requested`：固定 OAuth 四类错误到唯一 400/502 映射，并把 redirect URI 收紧到真实 callback path。
- Round 4 `passed`：全量复审无 remaining blocking/important。

## 2. Design Summary

- Goal: Google 登录后提交单层纯文本评论，管理员先审后显，评论者与管理员身份完全隔离。
- Key contracts: 两类派生签名 token、Google true-external adapter、SQLite 三态审核、approved-only 公开渲染、配置三态、公开展示名告知。
- Steps: 8；module/config、身份、store、公开闭环、审核闭环、横切安全、UI polish、发布验证均有独立退出信号。
- Checks: 17；全部锚定具体 design section/scenario。
- Baseline / validation: Node 24.15.0 与语法检查通过；本地缺 `node_modules`，`npm test` 当前只因依赖未安装失败；implementation 须先 `npm ci`。

## 3. Findings

### blocking

none

### important

none

### nit

none unresolved

### suggestion

- 身份域隔离与 Google adapter 边界满足“难回退 + 非显然 + 有真实权衡”，建议 owner 确认 design 后由 `cs-domain` 记录 ADR；本 gate 不自动创建。

### learning

- 对当前直接 `listen` 的 Express 入口，feature module factory + 最小 HTTP harness 能提供真实第三方 seam，而无需把整个应用重构成 app factory。

### praise

- 管理员/评论者身份、Cookie、secret、issuer/audience/token_use 均隔离；fake adapter 不冒充真实生产登录证据。
- 18 个核心场景均进入 Acceptance Coverage Matrix，design/checklist DoD commands 完全一致。

## 4. User Review Focus

- 公开行为：批准评论显示当前 Google 展示名；再次登录改名后，历史评论署名同步变化；不采集头像/email。
- 会话取舍：评论会话固定 7 天，无单会话即时撤销；登出清除，轮换独立 secret 撤销全部。
- 运行假设：单 PM2 实例、低评论量、首版不分页，每个评论者 10 分钟 5 条。
- 技术边界：保留现有 Express/CommonJS，不在本 feature 迁移 NestJS/Fastify、TypeScript 或 EJS 6。
- 外部依赖：最终 acceptance 必须有真实 Google OAuth test client、精确 `/auth/google/callback` redirect URI 与 HTTPS 浏览器 smoke。
- implement 必须遵守：approved-only 查询、审核状态转换表、两类 token 防混淆、配置 fail-fast、日志不含 token/subject/正文。

## 5. Evidence Confidence Ledger

| Check | Verdict | Evidence Class | Basis | Follow-up |
|---|---|---|---|---|
| Acceptance Coverage Matrix | pass | E | SC-01–SC-18 全部映射到 step、证据和动作 | acceptance 逐项核验 |
| DoD Contract | pass | E | design §3.4 与 checklist `dod.commands` 一致 | none |
| Steps and checks traceability | pass | E | S1–S8 独立退出；17 checks 有精确 source | none |
| Roadmap contract compliance | n/a | E | 非 roadmap feature | none |
| Module interface design | pass | C | module factory 与真实 `server/index.js`/test fixture 兼容 | implementation 不得增加生产 test mode |
| Validation and artifacts | pass | C | 命令、UI evidence、真实 OAuth artifact 均已列 | 外部凭证仍是 acceptance gate |

Summary: E=4, C=2, H=0, H-only core checks=none。

## 6. Residual Risk

- 没有真实 Google OAuth client 和匹配 HTTPS redirect URI 时，最终 acceptance 必须 blocked；fake adapter 不能替代。
- 当前工作区无 `node_modules`，实现前必须 `npm ci` 并重新确认基线测试。
- Google `sub` 限流不能阻止多账号滥用；先审后显保护公开面，但审核队列仍可能承受垃圾提交。
- 固定 7 天 JWT 不支持单会话即时撤销；secret 轮换会让全部评论者登出。
- 单实例、无分页与历史评论使用当前展示名是已声明首版假设；流量或产品边界变化时需重新设计。

## 7. Verdict

- Status: passed
- Next: 交给 owner 整体 review；只有 owner 明确批准后才能把 design 从 `draft` 改为 `approved` 并进入 implementation。

## 8. Focused Closure

none；Round 2–4 均按实质公开契约变化执行完整独立复审。
