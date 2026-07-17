---
doc_type: feature-acceptance
feature: 2026-07-16-detailed-visitor-analytics
status: passed
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
| C18 | SC-11/SC-20 | release core | 本地 HTTP tests + Cloudflare/origin/admin production smoke | passed：公开 token 页面为 `private,no-store`，admin HTML/API 为 `no-store` |
| C19–C32 | SC-01–19/21 | core | analytics tests、100k benchmark、恶意 DOM fixture、Chromium UI walkthrough | passed |
| C33 | SC-12/SC-20 | release core | trusted-IP fixtures + production DB smoke | passed：Cloudflare/直达同一可信地址，伪造 XFF 被覆盖，IPv4-mapped IPv6 规范化为 IPv4 |
| C34–C44 | SC-04/06/17/20 | core | token/limiter/lifecycle tests、WSL Linux updater、systemd verify/calendar | passed |
| C45 | SC-20 evidence matrix | release core | Linux integration + named production evidence | passed：真实 bootstrap/no-op/checksum/epoch/timer/Nginx/Cloudflare artifacts 已落盘；missed-run/失败/锁/回滚由 Linux integration 覆盖 |
| C46–C49 | SC-08/17/20/21 | core | WSL bootstrap/rollback、status tests、path query/UI tests | passed |

### 运行证据

- [x] `node --test test/analytics*.test.js`：31 tests，30 pass，1 Windows 下 Linux-only skip；100k list p95 **0.90 ms**、每轮真实写入失效后的冷 overview+serialize p95 **368.45 ms**、响应 **128,759 bytes**。
- [x] `npm test`：79 tests，78 pass，1 Windows 下 Linux-only skip；同一 100k 场景 p95 **363.40 ms**。
- [x] WSL + Linux Node 24：`node --test test/analytics-geoip-update.test.js` 3/3 passed，Linux lock/bootstrap/no-op/failure/promotion/rollback 全部执行。
- [x] `systemd-analyze --root=<temp> verify ...service ...timer`：exit 0；calendar 规范化为每周日 03:30 CST。
- [x] `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- [x] `git diff --check`、Bash/Node syntax checks、spec-governance analyze：全部 exit 0；spec findings 为空。
- [x] Chromium 实际 EJS 页面 walkthrough：宽屏、375px 窄屏、详情展开、键盘 focus、raw/display 路径与 hostile text 已验证；证据为 `evidence/admin-analytics-wide.png`、`evidence/admin-analytics-narrow.png`。
- [x] 线上 Cloudflare probe：HTTP 200、`Cf-Cache-Status: DYNAMIC`、`Cache-Control: private,no-store`，token/meta 与 collector script 存在；context POST 为 204。
- [x] RN2.5G 生产：真实 GeoLite2 City bootstrap/verifier/no-op、`nginx -t`、17KB→413、自定义 weekly timer、Cloudflare/direct/spoof/mapped-IP、Chrome/Safari/Firefox、管理员 HTML/API 均通过。命名证据见 `evidence/production-deployment-2026-07-17.md` 与远端 root-only evidence 目录。

review 第 5/6 节已逐条复核；本地代码风险与生产 release-core 证据均已闭合。

## 4. 术语一致性

- “访问事件 / event_id / metric_id”在 design、repository、query、API 中语义一致。
- “可信客户端地址”只来自规范化后的 `req.ip`，没有读取任意 XFF fallback。
- “原始路径 / 展示路径”分别使用 `requestPath/path` 与 `displayPath/displayPathStatus`，存储/筛选 identity 未混用。
- “浏览器设备上下文”与“服务端客户端信息”在 sources/contextSource 中分离。
- “近似地区 / GeoResolver / updater status”在 adapter、overview 和 UI 中一致。
- “小时预聚合”仅是 overview 加速结构，事实来源仍是 metric/detail。
- 禁用边界 grep 未发现新增长期 visitor/session identity、在线 GeoIP 或第三方 analytics SDK。

## 5. 领域影响盘点（提示而非代写）

- [x] 术语候选：访问事件、浏览器设备上下文、近似地区、原始路径/展示路径。已登记为后续 `cs-domain` 候选；当前仓库没有 CONTEXT.md，不阻塞本 feature。
- [x] ADR 候选：metric/detail 一对一 + 小时维度预聚合、短期单事件 HMAC context、独立 systemd GeoIP update + app-owned reload。已登记为后续 `cs-domain` 候选，不在 acceptance 内越权创建 ADR。
- [x] acceptance 未直接创建 CONTEXT/ADR，符合流程边界。

## 6. requirement delta / clarification 回写

- [x] 方案指向 draft requirement `detailed-visitor-analytics`。
- [x] 已把用户确认过的设计能力边界落为 owner-approved feature-local delta：`detailed-visitor-analytics-req-delta.md`。
- [x] 生产 smoke 通过后已用 spec-governance `apply-delta` 机械应用 approved delta；requirement 升级为 `current`、记录 `implemented_by`，VISION 从 Draft 移入 Current。

## 7. roadmap 回写

- [x] design frontmatter 没有 `roadmap` / `roadmap_item`，本 feature 非 roadmap 起头；无需回写。

## 8. attention.md 候选盘点

- 候选：Windows 验收 Linux-only systemd/updater 时，WSL 可能只有 Windows npm shim 而没有 Linux `node`；本轮用 `/tmp` 中的 Node 24 Linux runtime 执行。是否写入 attention.md 由用户后续决定。
- 其他知识出口：file-handle atomic snapshot、generation 防异步复活、小时预聚合是 `cs-keep`/ADR 候选；部署步骤已更新 README/DEPLOY，无新增公开库 API 参考需求。

## 9. 遗留

- **阻塞项**：none。真实 GeoLite2 bootstrap/no-op、app reload、`nginx -t`、timer、Nginx/Cloudflare cache/IP/16 KiB、Chrome/Safari/Firefox production smoke 与命名 artifacts 均已完成。
- **review nits**：仅影响运行过未发布中间 schema 的 `device_model_normalized` ALTER/backfill crash-idempotency；GeoIP status timestamp 尚未拒绝会被 JS 归一化的日历无效日期。
- **扩展性建议**：365 天/百万级高基数预聚合表体积、写放大、rebuild 时长和索引形态；module 未来热重载时的 stop-during-start；updater 真实 I/O 阶段错误分类精度。
- 未创建 commit，未修改/清理既有 `.codestable/reference/*` 工作区噪音。

## 10. 最终审计

- 验证证据来源：accept-inline verification；review round 2 `status=passed`、reviewer=`subagent`。
- Evidence sources：feature evidence screenshots、命令输出、API/DB/DOM tests、WSL Linux updater、systemd verify；无 Goal gate/DoD JSON 产物。
- Inline Verification Matrix：见第 3 节；49 checks passed，0 failed，0 pending。
- 聚合命令：analytics 30/31（Windows skip 1）、全仓 78/79（Windows skip 1）、Linux updater 3/3、audit 0、systemd verify/calendar 0、syntax/diff/spec governance 0；生产 bootstrap/no-op/timer/Nginx/Cloudflare/context/admin/trusted-IP smoke 全部 exit/status 符合预期。
- 场景复核：re-verified 21 组 / trust-prior-verify 2 组（Chromium screenshots、先前实际页面 walkthrough）；生产 release-core 项均有本轮运行证据。
- 交付物复核：代码、配置、schema、路由、UI、测试、systemd、updater/verifier、Nginx、README/DEPLOY、requirement delta 均落盘；architecture/roadmap 无要求。
- 完整工作区复核：已检查 tracked diff 与 untracked files；本功能改动未 staged，既有 CodeStable reference/scaffold 噪音已明确排除。
- diff 清洁度：`git diff --check` 通过；功能源码无新增 debug/TODO/FIXME、无 MMDB/凭据/真实访客 fixture。
- 知识沉淀出口：第 5/8/9 节已分流到 cs-domain/cs-keep/attention/guide；未擅自写长期 ADR/attention。
- 结论：**passed**。代码实现、独立 review、本地/WSL 验证、真实生产部署与 release-core smoke 均通过；C18/C33/C45 已闭合，approved requirement delta 已应用，能力状态已升级为 current。
