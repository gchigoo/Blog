---
doc_type: feature-review
feature: 2026-07-16-google-auth-comments
status: passed
reviewer: subagent
reviewed: 2026-07-16
round: 3
---

# google-auth-comments 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-16-google-auth-comments/google-auth-comments-design.md`
- Checklist: `.codestable/features/2026-07-16-google-auth-comments/google-auth-comments-checklist.yaml`
- Evidence pack: none
- Gate results: `npm test` 51/51、生产依赖审计 0 漏洞、`npm ls --depth=0` exit 0、`git diff --check` 通过、仓库真实 OAuth secret 扫描无命中
- DoD results: `google-auth-comments-checklist.yaml` 的 CMD-001–004 与生产 smoke 记录
- Implementation evidence: 当前对话、`google-auth-comments-step-8-fix.md`、工作区实现与测试
- Diff basis: 当前 unstaged/untracked feature diff；staged diff 为空
- Review mode: initial
- Baseline dirty files: `.codestable/reference/*`、`.codestable/requirements/VISION.md` 等 CodeStable 基础设施改动属于范围外

### Independent Review

- Detection: 原生 Task agent 可用；OCR CLI 存在但未配置 LLM endpoint
- 环节 A 独立隔离 Task agent: native-agent + completed
- 环节 B OCR CLI: failed
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: Task agent 结果已由主 agent 用源码、设计和对抗测试逐条核验
- Gate effect: 首轮 REV-001 曾阻塞 push、部署与 acceptance；第三轮完整独立复审已关闭阻塞

## 2. Diff Summary

- 新增：`server/comments/*`、`public/js/comments.js`、`public/js/admin-comments.js`、评论测试、后台审核视图与 feature 产物
- 修改：应用挂载、文章/后台模板、CSS、Nginx、依赖锁文件、README/DEPLOY 与测试 helper
- 删除：none
- 未跟踪 / staged：feature 新文件未跟踪；staged 为空
- 风险热点：OAuth replay、身份隔离、审核权限、SQLite 状态、生产部署、响应式 UI

## 3. Adversarial Pass

- 假设的生产 bug：无状态 OAuth context 只能证明完整性和有效期，不能证明未被消费。
- 主动攻击过的反例：同一 Cookie/state/code 重放、ID token 验证网络失败、后台元信息命中全局 header、退出按钮 CSS specificity。
- 结果：重放实际得到 302，升级为 blocking；其余进入 important/nit。

## 4. Findings

### blocking

- [x] REV-001 `server/comments/module.js:119-164` OAuth context 没有服务端一次性消费。
  - Evidence: 同一有效 `comment_oauth` Cookie 与 state 第二次请求仍会进入 exchange 并签发 session；`test/comments-auth.test.js:219-226` 第二次没有携带 Cookie，只验证缺 Cookie。
  - Impact: 违反 design SC-04；并发或保留 Cookie 的客户端可以重复消费 context。
  - Expected fix scope: 持久化 token id 的哈希，在 exchange 前原子 claim/consume；覆盖同 Cookie 重放、第二个 code、并发和进程重建。

### important

- [x] REV-002 `server/comments/google-identity.js:57-66` ID token 验证阶段的网络/5xx 错误被统一映射为 400。
  - Evidence: `verifyIdToken()` 所有异常均转为 `identity_invalid`，而 SC-18 要求 provider 网络/5xx 为 502。
  - Impact: 临时服务端故障被误报为客户端身份无效，错误语义与可重试性不符合设计。
- [x] REV-003 `views/admin/comments.ejs:20` 后台元信息使用全局 `header` 元素。
  - Evidence: `public/css/custom.css` 和 new.css 对所有 `header` 应用页面级布局；公开评论已因同一问题改用普通容器。
  - Impact: 审核卡片可能出现页头背景、宽度和边距污染。

### nit

- [x] REV-004 `public/css/custom.css` 退出按钮透明背景被后置 `.secondary-button` 规则覆盖。

### suggestion

- [x] REV-005 后续可为公开评论和审核队列增加分页；当前个人博客规模不阻塞。

### learning

- 有签名的无状态 OAuth Cookie 不具备一次性语义；一次性消费需要服务端原子状态。

### praise

- 管理员与评论者的 Cookie、audience 和 HKDF 子密钥完全隔离。
- pending 插入与限流检查处于同一事务，公开查询只返回 approved。

## 5. Test And QA Focus

- QA 必须重点复核：同 context 重放/并发、进程重建、Google token 证书验证网络错误、后台长名称/标题与手机布局。
- Evidence pack residual risks / gate warnings：生产完整提交→批准→拒绝→删除仍需最终 smoke。
- 建议新增或加强的测试：OAuth 持久化一次性消费集成测试、verifyIdToken 错误分类测试、后台容器结构回归。
- 不能靠 review 完全确认的点：真实 Google/Cloudflare 网络时序和生产多进程行为。

## 6. Residual Risk

- `blog.db` 不在 Git 中；删除代码回滚备份前必须保留独立数据库备份，否则 GitHub 只能恢复代码。

## 7. Verdict

- Status: passed
- Next: Standard feature 进入 acceptance 与 GitHub 发布。

## 8. Focused Closure

### Round 2 完整独立复审

- 结果：changes-requested。
- 新发现：补齐 `ENOTFOUND`、`EAI_AGAIN` 与一层 `cause.code` 的 502 分类；连续 80 字符展示名/标题需要显式断行。
- 修复：统一临时 provider 错误判断，补 DNS 回归测试；为评论身份与审核元信息增加 `min-width: 0` 和 `overflow-wrap: anywhere`；浏览器 harness 使用连续 80 字符 fixture。

### Round 3 完整独立复审

- 结果：passed；blocking none，important none。
- 独立验证：51/51 tests、audit 0、`npm ls` exit 0、`git diff --check` 通过。
- 安全结论：OAuth context 只保存 SHA-256 token id hash，通过条件 `UPDATE` 原子一次消费；同 Cookie 重放、第二 code、并发 callback 与 store 重建均有覆盖。
- 残余 nit：尚未显式测试 81+ code points 展示名截断与缺失名称 fallback；当前生产实现正确，不阻塞发布。
- 部署约束：GitHub 不包含 `blog.db`、`articles/`、`public/images/`，删除代码回滚备份前必须保留独立且校验通过的数据备份，不执行 `git clean -fdx`。
