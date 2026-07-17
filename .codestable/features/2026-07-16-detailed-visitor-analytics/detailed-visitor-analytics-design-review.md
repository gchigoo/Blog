---
doc_type: feature-design-review
feature: 2026-07-16-detailed-visitor-analytics
status: passed
reviewed: 2026-07-17
round: 7
---

# detailed-visitor-analytics feature design 审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-16-detailed-visitor-analytics/detailed-visitor-analytics-design.md`
- Checklist: `.codestable/features/2026-07-16-detailed-visitor-analytics/detailed-visitor-analytics-checklist.yaml`
- Intent / brainstorm: none
- Roadmap: none
- Related requirements: `.codestable/requirements/detailed-visitor-analytics.md`、`.codestable/requirements/anonymous-access-analytics.md`、`.codestable/requirements/VISION.md`
- Code facts checked: `server/analytics/middleware.js`、`server/analytics/store.js`、`server/index.js`、`server/comments/module.js`、`server/middleware/auth.js`、`views/admin/analytics.ejs`、`deploy/nginx/blog.conf`
- Runtime facts: Node 24、Express 5、better-sqlite3；当前 HEAD `38b41939a6656b0b55e6fc935ed85719c6304fe0`

### Independent Review

- Status: completed
- Detection: native-agent
- Provider / agent: `/root/analytics_path_display_review`（本轮）；`/root/geoip_weekly_design_review`、`/root/visitor_analytics_gate_review`（前序 gates）
- Raw output: 中文 percent-encoded path 展示实质变更的完整复审 verdict 为 `passed`；blocking=0、important=0、nit=2（报告元数据与 helper 顺序，均已 focused closure）；后续“全部路径、无标签/路由白名单”仅显式化已审共享 helper 的适用范围
- Merge policy: 主 agent 已逐条核验独立 reviewer 的结论，并用 design/checklist/requirement/实际代码和命令输出闭环
- Gate effect: none

当前 raw-data scope 共经历 7 轮实质审查。早期 findings 覆盖 OAuth code/state 泄漏、存储型 XSS、两阶段竞态、旧数据 cursor 冲突、public body abuse、event identity/idempotency、GeoIP/config lifecycle、共享缓存、SQLite 查询、解析失败、requirement 冲突、证据占位、基线过期、Referrer 失败回退、限流 Map、精确保留、city 索引、日志边界及 overview 高基数。第 6 轮闭合 GeoLite2 每周 systemd 调度、首装 bootstrap、atomic promote/rollback、app-owned reader reload、status provider 和 Linux evidence matrix；第 7 轮确认 raw path identity 不变、旧数据免迁移、中文 displayPath、reserved/invalid/control/XSS 语义和 API additive compatibility。

## 2. Design Summary

- Goal: 在保留旧 overview 的同时，为每个成功公开 HTML 请求记录原始 IP、近似地区、原始/解析客户端信息和浏览器可提供的设备上下文，并提供管理员事件 list/detail。
- Key contracts: `access_event_details` 一对一侧表；128-bit `event_id`；raw path identity + Unicode `displayPath` view model；本地 GeoLite2 City + 每周 systemd timer + app-owned reload/status provider；Bowser；10 分钟 HKDF/HMAC event token；425 有界重试；canonical context hash 原子幂等；管理员 JWT 隔离；统一保留期。
- Security/data boundary: owner 允许分析字段明文；`/auth`、OAuth/credential、Cookie/Authorization 排除；raw 只作文本渲染；tracked HTML `private,no-store`；public context route 有 Origin、parser、body、限流容量和生命周期约束。
- Query contract: detail-only cursor event list；旧行 overview-only；normalized filter/索引；新增 overview 维度 top 50 + distinct/truncated/other；100k list/overview 性能和 body 预算。
- Steps: 7 个，按 config/编排、计算安全、持久化、公共采集、管理查询、管理 UI、发布验证推进。
- Checks: 49 个，覆盖 requirement、schema/API、OAuth/XSS/abuse/cache、lifecycle/retention、query/performance、GeoIP weekly bootstrap/update/reload/status、中文路径 display、安全 UI 和生产 smoke。
- Baseline / validation: checklist YAML 解析通过；既有代码基线 `node --test test/analytics*.test.js` 3/3、`npm test` 51/51、audit 0 vulnerabilities；这些不代表尚未实现的 SC-21 已通过，SC-21 必须由新增 query/security tests 证明。

## 3. Findings

### blocking

none

### important

none

### nit

- [ ] FDR-036 `design#Overview` 可把 `truncated` 再显式写成 `distinctCount > 50`；当前已可由 top-51 规则唯一推导，不影响实现。
- [ ] FDR-037 `checklist.dod.evidence_required` 可单列 `response_size_report`；当前 `performance_report`、C26、C38 与 CMD-005 已覆盖该证据。

### suggestion

none

### learning

- 允许记录原始访问数据不等于认证凭据可以进入 analytics；OAuth 路由、Cookie/Authorization 和 credential query 仍属于信任链边界。
- 两阶段 event token 只约束“可以补哪条事件”，不能证明浏览器自报设备信息真实。
- 明细查询有界并不代表 overview 自动有界；高基数聚合也必须定义 top-N、other、响应大小和性能证据。

### praise

- requirement supersession 已在 design review 阶段完成，没有把相反 source of truth 留到实现阶段。
- API、schema、parser 顺序、幂等、生命周期、缓存和查询计划均形成可证伪契约。
- 每个核心风险都有命名测试文件、命令或生产 smoke，checklist 可供 implementation/QA/acceptance 直接消费。

## 4. User Review Focus

- 用户需要重点拍板：默认保留 30 天（可配 1–365）；GeoLite2 每周日 03:30（服务器本地时区，最多 30 分钟 jitter）更新；details 默认关闭、首装 MMDB bootstrap 后生产显式开启；被跟踪 HTML 因 event token 使用 `private,no-store`；不创建长期 visitor/session Cookie。
- 用户需要确认范围：保存原始 IP/UA/公开 URL/Referrer/设备 context；不采集点击/滚动/表单/键盘/正文；不做实时、地图、热力图或导出。
- 用户新增展示决策：所有合法 UTF-8 percent-encoded 路径统一显示可读 Unicode，不按 `/tag/工具`、标签名或路由建立特例/白名单；例如 `/tag/%E5%B7%A5%E5%85%B7` 显示 `/tag/工具`、`/tag/%E7%BC%96%E7%A8%8B` 显示 `/tag/编程`，但 raw path 仍保留用于聚合、筛选和核对，历史数据无需迁移。
- implement 需要重点遵守：`/auth` 与 credential 排除、纯文本 raw/display 渲染、decode/fallback→NFC→control/bidi visible escape 顺序、425 重试、context parser/限流顺序、exact/legacy retention、detail-only event list、overview top-50 边界。
- code review / QA / acceptance 需要重点复核：Cloudflare/Nginx 可信 IP、最终 no-store、中文/emoji/reserved/invalid/encoded-XSS path matrix、Linux systemd timer/Persistent、GeoIP bootstrap/update/rollback/app reload/status、SIGTERM drain、多浏览器 context、100k query/overview 性能与响应大小。

## 5. Evidence Confidence Ledger

| Check | Verdict | Evidence Class | Basis | Follow-up |
|---|---|---|---|---|
| Acceptance Coverage Matrix | pass | E | design SC-01–SC-21 与 Coverage Matrix 直接映射 | implementation 后补真实证据 |
| DoD Contract | pass | E | Design/Implementation/Review/QA/Acceptance DoD、CMD-001–007、artifacts 完整 | none |
| Steps and checks traceability | pass | E | checklist S1–S7、C01–C49 均有 design/SC 来源与 exit signal | none |
| Roadmap contract compliance | pass | E | 本 feature 无 roadmap/frontmatter roadmap item | none |
| Module interface design | pass | C | deep factory/lifecycle、adapter seam 与现有 Express/analytics/store 代码事实一致 | implementation 验证装配 |
| Validation and artifacts | pass | E | 六个命名 test files、CMD-001–007、100k report、DOM/browser/Nginx、GeoIP bootstrap/timer/update/rollback/reload/status artifacts 明确 | Linux/生产 smoke 后闭环 |

Summary: E=5, C=1, H=0, H-only core checks=none。

## 6. Residual Risk

- 浏览器 Client Hints/context 可缺失或伪造，UI 必须持续标明来源，不能用于身份或授权判断。
- GeoLite2 是网络出口近似值；更新或 candidate reload 失败时继续使用旧 reader，会产生在后台可见的数据陈旧。
- Cloudflare CIDR snippet、真实来源 IP、最终缓存头，以及 systemd Persistent、fsync/rename、MMDB 原子更新只能在目标 Linux/生产 smoke 中闭环。
- SQLite foreign-key enforcement、同步写入突发延迟、shutdown drain 和 100k 性能预算需要 implementation/QA 实测；250/500 ms 预算不是跨硬件 SLO。
- Nginx/Cloudflare 运维日志按 owner 的原始数据边界保留，不受 analytics 统一 retention 管理。
- NFC 或安全可见转义可能让不同 raw path 呈现相同/相近 display text；聚合、排序、筛选必须继续使用 raw identity，UI 保留 raw 核对入口。

## 7. Verdict

- Status: passed
- Next: 交给用户整体 review；用户明确确认前，design 保持 `draft`，不得进入实现。

## 8. Focused Closure

- Closed findings: `FDR-GEO-NIT`、`FDR-PATH-NIT-001`（review 摘要过期）、`FDR-PATH-NIT-002`（invalid fallback 后 control/bidi 顺序歧义）
- Attributed delta: 更新 review round/SC-21/C01–C49 摘要；把 helper 顺序明确为 decode-or-fallback → NFC → Cc/Cf visible escape，并补非法 percent + 原始 control/bidi fixture；进一步明确共享 helper 对全部 overview/list/detail 路径生效、没有标签/路由白名单，并补多中文标签 fixture
- Verification: checklist YAML 解析通过；7 steps、49 checks、7 commands，ID 唯一且全为 pending；SC-21/C48/C49 对“全部路径统一处理”的映射完整
- Classification: report 元数据、原有安全要求顺序及共享 helper 适用范围的澄清；原设计已经对 `rawPath` 通用处理，本次不改变 raw identity、API compatibility、架构边界、范围或已通过的主要行为契约；路径展示本体已完成完整独立复审
