---
doc_type: approval-report
unit: 2026-07-16-google-auth-comments
status: approved
reason: other
created_at: 2026-07-16
---

# Approval Report

## Decision History

- 2026-07-16：owner 选择 Option A“审核优先的单层评论”。第一版保持单 feature，不包含回复、编辑、通知、点赞或用户主页。
- 2026-07-16：owner 以“继续设计”批准 `reader-comments` requirement 初稿，授权写入愿景并继续 feature design。
- 2026-07-16：owner 以“批准，开始实现”批准完整 feature design，授权按 S1→S8 实现；不包含自动提交、部署或代管生产凭证。

## Decision Needed

已完成：`reader-comments` requirement 与完整 feature design 均已批准，可以进入实现。

## Why Now

这是 requirements 中首次出现的读者互动能力。design 需要引用稳定的用户目标和边界，避免后续技术方案悄悄扩大成社区系统。

## Requirement Draft

```markdown
---
doc_type: requirement
slug: reader-comments
pitch: 让读者用可信身份参与文章讨论，同时由博主决定哪些内容公开。
status: draft
last_reviewed: 2026-07-16
implemented_by: []
tags: [comments, readers, moderation]
---

# 读者评论

## 用户故事

- 作为想回应文章的读者，我希望用 Google 账号登录后直接留言，不必再注册和维护一套博客账号。
- 作为提交评论的读者，我希望清楚知道评论正在等待审核，而不是误以为提交失败或已经公开。
- 作为博客管理员，我希望先查看读者评论，再决定批准、拒绝或删除，避免不合适的内容直接出现在文章下方。
- 作为阅读文章的访客，我希望只看到管理员已经批准的评论。

## 为什么需要

博客目前只能单向发布文章，读者看完后没有留下反馈的入口。完全匿名和即时公开的评论又容易带来垃圾内容与维护压力，不适合个人博客。

## 怎么解决

读者通过 Google 账号确认身份后，可以在文章下提交纯文本评论。新评论先进入待审核状态，管理员处理后，只有批准的内容才向所有访客显示。

## 边界

- 不接受匿名评论，登录成功也不代表评论会自动公开。
- 第一版不支持评论回复、编辑、通知、点赞或用户主页。
- 评论只用于文章下的公开反馈，不承担私信或客服沟通。
- 管理员可以拒绝或删除评论，不承诺每条评论都会公开或保留。
```

## Context

- 仓库已经运行 Node `24.15.0`，`.nvmrc` 与 `engines.node` 均固定 Node 24。
- Node 24 安全基线的实施步骤已经全部完成并提交到 `master`。
- 2026-07-16 的 `npm outdated` 结果显示，除 EJS 3 → 6 的独立大版本迁移外，直接依赖均处于当前适用版本；`npm audit --omit=dev` 为 0 漏洞。
- EJS 6 不是 Node 24 兼容性的前置条件，既有批准设计明确将它排除在 Node 24 升级之外。若未来要升级，应单独验证模板兼容性，不与评论功能捆绑。
- 当前 `users` 表和 `token` Cookie 专用于管理员账号。评论用户应使用独立身份表和独立会话 Cookie，避免把 Google 用户误当管理员。
- Google 官方 Node.js 认证库支持 authorization-code flow；登录回调需要校验 `state`，验证 ID token 的 audience，并以不可变的 `sub` claim 作为本地身份键。
- 评论属于公开写入面：即使默认待审核，仍需要内容长度限制、提交频率限制、CSRF 防护和纯文本转义，避免审核队列被滥用。

## Options

### A. 批准愿景初稿（推荐）

按上述文案落盘并继续 design。

### B. 修改愿景初稿

指出需要调整的用户故事、措辞或边界；修改后重新确认。

## Recommendation

批准。初稿完整覆盖已确认的 Google 登录、单层纯文本、先审后显与后台处理，同时没有混入技术实现细节。

## Risks And Tradeoffs

- “可信身份”只表示评论者通过 Google 登录，不代表内容可信或自动公开。
- 初稿刻意不承诺回复、通知等社区能力，未来增加时需要更新 requirement 边界。

## Non-Automatic Actions

- 最新批准授权修改本 feature 范围内的业务代码、数据库 schema、测试、依赖与部署文档。
- 不会自动创建 Google Cloud OAuth 客户端、写入 client secret、提交或部署。

## After You Answer

1. 按批准的 checklist 依次实施 S1→S8。
2. 完成独立 code review 与 acceptance 审计。
3. 真实 Google OAuth smoke 在 owner 提供测试客户端和登记 redirect URI 后执行；凭证不写入仓库。
