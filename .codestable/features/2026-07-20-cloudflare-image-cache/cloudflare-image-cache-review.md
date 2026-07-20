---
doc_type: feature-review
feature: 2026-07-20-cloudflare-image-cache
status: passed
reviewer: subagent
reviewed: 2026-07-20
round: 2
---

# cloudflare-image-cache 代码审查报告

## 1. Scope And Inputs

- Design: none（feature-ff）
- Checklist: none（feature-ff）
- Evidence pack: none
- Gate results: none
- DoD results: none
- Implementation evidence: `cloudflare-image-cache-ff-note.md`、Cloudflare 控制台活动规则和生产 curl smoke
- Diff basis: `git status --short`、`git diff -- DEPLOY.md`；范围仅限 `DEPLOY.md` 与当前 feature 目录
- Review mode: full rereview after production rule and smoke corrections
- Baseline dirty files: 其余 `.codestable/reference/`、requirements 与 runtime 骨架改动均为本轮外既有 dirty baseline

### Independent Review

- Detection: 原生 Task agent 可用；`ocr` CLI 已安装但没有有效 LLM endpoint
- 环节 A 独立隔离 Task agent: native-agent + completed（round 1 与 round 2）
- 环节 B OCR CLI: failed
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: Task agent 结果已逐条用仓库配置、源码和线上响应核验后合并
- Gate effect: round 2 已独立确认两项 important 均关闭

## 2. Diff Summary

- 新增：`cloudflare-image-cache-ff-note.md`
- 修改：`DEPLOY.md`；Cloudflare 生产 Cache Rule
- 删除：none
- 未跟踪 / staged：当前 feature 目录未跟踪；无 staged 文件
- 风险热点：外部缓存规则作用域、错误响应缓存、运维 smoke 假阳性

## 3. Adversarial Pass

- 假设的生产 bug：规则把 zone 内其他 hostname 的 `/images/*` 或不存在图片长期缓存。
- 主动攻击过的反例：其他 hostname 同路径、真实图片、随机不存在 WebP、HTML no-store、TTL 与文件名不可变性。
- 结果：round 1 发现 hostname 作用域和 404 smoke 假阳性；修复后由 round 2 完整复审确认关闭。

## 4. Findings

### blocking

none

### important

- [x] REV-001 `DEPLOY.md` 与生产 Cache Rule 已增加 `blog.cokedaily.space` hostname 条件。
  - Closure evidence: 控制台活动规则与文档表达式均为 `(http.host eq "blog.cokedaily.space" and http.request.uri.path wildcard r"/images/*")`；规则列表显示 `1 active`。
  - Result: zone 内其他或未来 hostname 的 `/images/*` 不再匹配此规则；未改图片 URL 或应用发布链路。

- [x] REV-002 `DEPLOY.md` smoke 已使用真实图片并断言 HTTP 200、`image/webp` 与 `MISS → HIT`；生产 Edge TTL 已取消 1 年强制覆盖。
  - Closure evidence: 真实 WebP 新 nonce 实测 `200 image/webp + MISS → HIT → HIT`，`Age` 从 2 增至 5；随机缺失 WebP 返回 `404`、`max-age=14400`，不再套用 1 年值。
  - Result: 运维 smoke 不会把缓存的 404 误判为图片成功；错误响应沿用较短的现有缓存语义。

### nit

none

### suggestion

- [x] 已补充最小回滚说明：禁用规则；若未来允许同路径内容更新，则更新后 purge 对应 URL。

### learning

- `deploy/nginx/blog.conf` 中 `.webp` regex location 会优先于未使用 `^~` 的 `/images/` prefix location；线上 30 天响应头来自 regex location。这是既有 baseline，本轮不改 Nginx。

### praise

- 文档明确禁止缓存范围扩大到 HTML、管理端和 API。
- 真实 WebP 已证明 `MISS → HIT → HIT`，首页保持 `private, no-store` 与 `DYNAMIC`。

## 5. Test And QA Focus

- QA 复核通过：收紧后的活动规则、真实 WebP 的 `200 + image/webp + MISS/HIT`、随机 404 无 1 年覆盖值、首页仍为 no-store/DYNAMIC。
- Evidence pack residual risks / gate warnings：Cloudflare 控制台规则可能被后续人工修改。
- 建议新增或加强的测试：运维 smoke 同时断言 HTTP status、Content-Type、cache status 和 Age。
- 不能靠 review 完全确认的点：Cloudflare 控制台未来漂移。

## 6. Residual Risk

- “不原地覆盖”是当前文章发布调用路径的事实，不是 `convertToWebP` 存储层强制不变量；未来引入固定文件名更新时必须 purge 或重新版本化。
- 当前 404 会按现有响应缓存约 4 小时；若缺失路径随后原地补文件，必须 purge 对应 URL。

## 7. Verdict

- Status: passed
- Next: feature-ff 收尾；若用户要求，再做仅包含 `DEPLOY.md` 与当前 feature 目录的 scoped commit

## 8. Focused Closure

生产 Cache Rule 的匹配范围和 TTL 修复属于实质性行为变化，因此未用 focused closure 代替复审，而是执行了 round 2 完整独立复审。复审确认 REV-001、REV-002 均已关闭；无新增 blocking、important、nit 或 suggestion。

复审后仅对 `DEPLOY.md` 的 smoke 命令增加了请求超时和首次/二次请求间隔，归类为 test/docs-only delta；`bash -n` 与 `git diff --check` 通过，不改变生产规则或应用行为，按 focused closure 放行。
