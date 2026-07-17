---
doc_type: feature-acceptance
feature: 2026-07-16-detailed-visitor-analytics
status: blocked
accepted: 2026-07-17
round: 1
---

# 访客访问明细与设备上下文验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-17
> 关联方案 doc：`.codestable/features/2026-07-16-detailed-visitor-analytics/detailed-visitor-analytics-design.md`

## 1. 接口契约核对

对照方案第 2.1 节逐项核查：

- [x] `createAnalyticsModule()`：返回 collector、public context router、管理员 API/page router 与 lifecycle；`server/index.js` 按设计顺序挂载。
- [x] `GeoResolver.resolve/getStatus/start/stop`：本地 Buffer reader、严格 status snapshot、60 秒 reload 与 generation 生命周期均有源码和确定性测试。
- [x] `POST /api/analytics/client-context`：精确 JSON 路由、同源、短期 event token、425/204/409/4xx 契约与 16 KiB 上限一致。
- [x] `GET /api/admin/analytics`、`/events`、`/events/{eventId}`：旧 overview 字段保持，新增维度、游标列表和完整详情均受管理员认证且 `no-store`。
- [x] 原始路径/展示路径：overview/list/detail 保留 raw identity，并统一 additive 返回 `displayPath/displayPathStatus`；多个中文标签、reserved/invalid/control/bidi/XSS fixture 通过。
- [x] 流程图节点均有落点：成功公开 HTML response → metric/detail/小时预聚合同事务 → token/script 注入 → context 幂等补充 → 管理员 overview/list/detail；GeoIP updater → atomic live → app poll/swap。

接口与名词层未发现未处理偏差。review-fix 新增的小时预聚合已同步回设计数据模型。

## 2. 行为与决策核对

**需求摘要**

- [x] 成功公开 HTML 请求记录时间、原始 IP、公开 URL/来源、地区、UA/浏览器/OS/设备及版本；JS 关闭时仍有服务端数据。
- [x] 浏览器支持时通过第一方脚本补充 UAData、屏幕、视口、语言、时区、CPU/内存/触控/网络；Chromium 返回额外低熵字段时只复制 allowlist。
- [x] 管理页支持筛选、分页、下钻和单条详情；raw 值只以文本呈现。
- [x] 现有 pageViews/anonymousVisitors/byHour/byPage/byDevice 和旧聚合行口径保持兼容。
- [x] 任意合法 UTF-8 percent-encoded path 使用共享 helper 显示 Unicode，不存在标签/路由白名单。

**明确不做**

- [x] 未采集点击、滚动、表单、键盘、正文或评论内容。
- [x] 未引入第三方分析 SDK、在线 GeoIP、长期 visitor/session cookie、实时人数、地图、热力图或导出。
- [x] 未猜测浏览器未暴露的精确硬件；客户端自报与服务端解析来源分离。

**关键决策与流程约束**

- [x] metric/detail/event identity、credential redaction、trusted `req.ip`、Geo/Bowser tagged failure、context canonical hash/idempotency、425 有界重试、限流容量/TTL、retention 与 shutdown 均按设计落地。
- [x] GeoResolver 使用同一 `FileHandle` 获取 MMDB bytes/fingerprint；generation 阻止 stop 后 in-flight poll 复活 reader。
- [x] 七个 overview 新维度由 metric/detail 同一事务维护小时预聚合；冷查询只在 SQLite 内 top-51，不物化全部事实行到 Node。
- [x] updater 具有 bootstrap/no-op/prepare previous/promote/rollback/status、同盘 fsync/rename、锁和测试故障注入。

**挂载点反向核对**

- [x] 配置：`server/config.js`、`server/analytics/config.js`。
- [x] 应用编排：`server/index.js`、`server/analytics/module.js`、header partial、管理员导航。
- [x] 持久化/查询：`server/analytics/store.js`、`repository.js`、`query/analytics-query.js`、旧 `server/routes/analytics.js` 已移除。
- [x] HTTP/UI：collector、public/admin routers、`public/js/*.js`、`views/admin/analytics.ejs`、`public/css/custom.css`。
- [x] 发布面：Nginx exact location、systemd units、verifier/updater、README/DEPLOY。
- [x] 反向 grep 与 `git status` 未发现清单外 analytics 挂载；按上述入口逆向移除可恢复旧 overview，不会遗留公开 context/admin detail 路由或 collector script。

## 3. 验收场景核对

Feature 性质：**mixed functional + operations**。采用 Standard lane accept-inline verification；无独立 QA 报告。

### Inline Verification Matrix

| 范围 | 来源 | 核心性 | 命令/动作 | 结果 |
|---|---|---:|---|---|
| C01–C17 | design SC-01–07/13–17 | core | analytics config/collector/context/security/query tests | passed |
| C18 | SC-11/SC-20 | release core | 本地 HTTP tests + 线上 Cloudflare probe | **blocked**：本地 `private,no-store` 通过；线上尚未部署，无 token/script 且无目标 Cache-Control |
| C19–C32 | SC-01–19/21 | core | analytics tests、100k benchmark、恶意 DOM fixture、Chromium UI walkthrough | passed |
| C33 | SC-12/SC-20 | release core | trusted-IP fixtures + production smoke | **blocked**：fixtures 通过；直达源站/Cloudflare/伪造 XFF/IPv4-mapped IPv6 的生产 DB 证据未执行 |
| C34–C44 | SC-04/06/17/20 | core | token/limiter/lifecycle tests、WSL Linux updater、systemd verify/calendar | passed |
| C45 | SC-20 evidence matrix | release core | 当前 evidence pack 复核 | **blocked**：缺真实 MMDB、Persistent missed-run、真实 promote I/O、Nginx/Cloudflare 的命名生产 artifacts |
| C46–C49 | SC-08/17/20/21 | core | WSL bootstrap/rollback、status tests、path query/UI tests | passed |

### 运行证据

- [x] `node --test test/analytics*.test.js`：31 tests，30 pass，1 Windows 下 Linux-only skip；100k list p95 **0.90 ms**、每轮真实写入失效后的冷 overview+serialize p95 **368.45 ms**、响应 **128,759 bytes**。
- [x] `npm test`：79 tests，78 pass，1 Windows 下 Linux-only skip；同一 100k 场景 p95 **363.40 ms**。
- [x] WSL + Linux Node 24：`node --test test/analytics-geoip-update.test.js` 3/3 passed，Linux lock/bootstrap/no-op/failure/promotion/rollback 全部执行。
- [x] `systemd-analyze --root=<temp> verify ...service ...timer`：exit 0；calendar 规范化为每周日 03:30 CST。
- [x] `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- [x] `git diff --check`、Bash/Node syntax checks、spec-governance analyze：全部 exit 0；spec findings 为空。
- [x] Chromium 实际 EJS 页面 walkthrough：宽屏、375px 窄屏、详情展开、键盘 focus、raw/display 路径与 hostile text 已验证；证据为 `evidence/admin-analytics-wide.png`、`evidence/admin-analytics-narrow.png`。
- [ ] 线上 Cloudflare probe：`https://blog.cokedaily.space/` 当前 200 / `Cf-Cache-Status: DYNAMIC`，但无 analytics token、无 collector script、无目标 Cache-Control，证明本功能尚未部署。
- [ ] 当前环境没有 Nginx binary、MaxMind 生产凭据/合法 GeoLite2 City MMDB，也未部署生产版本，因此不能执行真实 `nginx -t`、MMDB bootstrap/reload、source/Cloudflare IP 与 Safari/Firefox smoke。

review 第 5/6 节已逐条复核；本地代码风险闭合，生产发布 residual 承载的是设计明确要求的 release-core 证据，因此不能降格为普通遗留后放行。

## 4. 术语一致性

- “访问事件 / event_id / metric_id”在 design、repository、query、API 中语义一致。
- “可信客户端地址”只来自规范化后的 `req.ip`，没有读取任意 XFF fallback。
- “原始路径 / 展示路径”分别使用 `requestPath/path` 与 `displayPath/displayPathStatus`，存储/筛选 identity 未混用。
- “浏览器设备上下文”与“服务端客户端信息”在 sources/contextSource 中分离。
- “近似地区 / GeoResolver / updater status”在 adapter、overview 和 UI 中一致。
- “小时预聚合”仅是 overview 加速结构，事实来源仍是 metric/detail。
- 禁用边界 grep 未发现新增长期 visitor/session identity、在线 GeoIP 或第三方 analytics SDK。

## 5. 领域影响盘点（提示而非代写）

- [ ] 术语候选：访问事件、浏览器设备上下文、近似地区、原始路径/展示路径。建议后续用 `cs-domain` 判断是否值得补 `requirements/CONTEXT.md`；当前仓库没有 CONTEXT.md。
- [ ] ADR 候选：metric/detail 一对一 + 小时维度预聚合、短期单事件 HMAC context、独立 systemd GeoIP update + app-owned reload。它们具有长期结构权衡，建议后续由 owner 选择是否用 `cs-domain` 归档。
- [x] acceptance 未直接创建 CONTEXT/ADR，符合流程边界。

## 6. requirement delta / clarification 回写

- [x] 方案指向 draft requirement `detailed-visitor-analytics`。
- [x] 已把用户确认过的设计能力边界落为 owner-approved feature-local delta：`detailed-visitor-analytics-req-delta.md`。
- [ ] 因 acceptance 被生产 release gate 阻塞，delta 暂不 apply；requirement 保持 `draft`，VISION 仍列在 Draft。生产 smoke 通过后再机械升级为 `current` 并追加 change log。

## 7. roadmap 回写

- [x] design frontmatter 没有 `roadmap` / `roadmap_item`，本 feature 非 roadmap 起头；无需回写。

## 8. attention.md 候选盘点

- 候选：Windows 验收 Linux-only systemd/updater 时，WSL 可能只有 Windows npm shim 而没有 Linux `node`；本轮用 `/tmp` 中的 Node 24 Linux runtime 执行。是否写入 attention.md 由用户后续决定。
- 其他知识出口：file-handle atomic snapshot、generation 防异步复活、小时预聚合是 `cs-keep`/ADR 候选；部署步骤已更新 README/DEPLOY，无新增公开库 API 参考需求。

## 9. 遗留

- **阻塞项**：部署当前工作区后执行真实 GeoLite2 bootstrap/reload、`nginx -t`、systemd Persistent missed-run、Nginx/Cloudflare cache/IP/16 KiB、Safari/Firefox/Chromium production smoke，并形成 C18/C33/C45 命名 artifacts。
- **review nits**：仅影响运行过未发布中间 schema 的 `device_model_normalized` ALTER/backfill crash-idempotency；GeoIP status timestamp 尚未拒绝会被 JS 归一化的日历无效日期。
- **扩展性建议**：365 天/百万级高基数预聚合表体积、写放大、rebuild 时长和索引形态；module 未来热重载时的 stop-during-start；updater 真实 I/O 阶段错误分类精度。
- 未创建 commit，未修改/清理既有 `.codestable/reference/*` 工作区噪音。

## 10. 最终审计

- 验证证据来源：accept-inline verification；review round 2 `status=passed`、reviewer=`subagent`。
- Evidence sources：feature evidence screenshots、命令输出、API/DB/DOM tests、WSL Linux updater、systemd verify；无 Goal gate/DoD JSON 产物。
- Inline Verification Matrix：见第 3 节；46 checks passed，C18/C33/C45 failed，0 pending。
- 聚合命令：analytics 30/31（Windows skip 1）、全仓 78/79（Windows skip 1）、Linux updater 3/3、audit 0、systemd verify/calendar 0、syntax/diff/spec governance 0。
- 场景复核：re-verified 18 组 / trust-prior-verify 2 组（Chromium screenshots、先前实际页面 walkthrough）；生产发布项不是 trust-prior，而是明确 failed。
- 交付物复核：代码、配置、schema、路由、UI、测试、systemd、updater/verifier、Nginx、README/DEPLOY、requirement delta 均落盘；architecture/roadmap 无要求。
- 完整工作区复核：已检查 tracked diff 与 untracked files；本功能改动未 staged，既有 CodeStable reference/scaffold 噪音已明确排除。
- diff 清洁度：`git diff --check` 通过；功能源码无新增 debug/TODO/FIXME、无 MMDB/凭据/真实访客 fixture。
- 知识沉淀出口：第 5/8/9 节已分流到 cs-domain/cs-keep/attention/guide；未擅自写长期 ADR/attention。
- 结论：**blocked**。代码实现、review 和本地/WSL 验证通过；必须补齐 C18/C33/C45 的真实生产发布证据后，才能把 checks 全改为 passed、apply requirement delta 并完成用户终审。
