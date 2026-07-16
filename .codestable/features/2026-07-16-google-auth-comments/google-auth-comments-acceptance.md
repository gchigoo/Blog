---
doc_type: feature-acceptance
feature: 2026-07-16-google-auth-comments
status: passed
accepted: 2026-07-16
---

# google-auth-comments 验收记录

## 结论

SC-01–SC-18 已通过设计要求的自动化、HTTP、数据库、浏览器与真实 Google OAuth 证据，可以发布。

## 证据矩阵

- SC-01–SC-15、SC-18：`npm test` 51/51 通过，覆盖配置三态、OAuth/会话、pending-only 写入、approved-only 公开查询、限流、审核状态机、删除、CSRF、权限隔离及 provider 错误分类。
- SC-04：同 Cookie/state 重放、第二 code、并发 callback、store 重建与只存 SHA-256 token id hash 均有回归测试。
- SC-08、SC-16：桌面与 390px 浏览器 smoke 通过；连续 80 字符 fixture、评论表单纵向卡片布局与审核元信息不产生横向溢出。
- SC-17：`npm ci`、51/51 tests、`npm audit --omit=dev --audit-level=high` 0 漏洞、`npm ls --depth=0` exit 0、`git diff --check` 与真实 secret 扫描通过；生产真实 Google client 已完成登录闭环。

## 发布后复核

- 核对 GitHub `origin/master`、服务器 `HEAD` 与本次 commit SHA 一致。
- 核对 Node 24、PM2 评论环境变量键、SQLite `quick_check=ok`、Nginx `comments-3` 静态资源与外网 HTTP smoke。
- 删除旧代码回滚备份前，单独保留 SQLite 在线备份以及文章、图片快照。

## 非阻塞残余项

- 后续补充 81+ code points 展示名截断与缺失名称 fallback 的显式表驱动测试。
- 后续可增加评论分页及审核动作后的动态计数刷新；不影响当前个人博客规模下的功能正确性。
