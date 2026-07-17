---
doc_type: refactor-review
refactor: 2026-07-16-ejs6-visual-equivalence
status: passed
reviewer: subagent
reviewed: 2026-07-17
round: 1
---

# EJS 6 零视觉变化升级代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/refactors/2026-07-16-ejs6-visual-equivalence/ejs6-visual-equivalence-refactor-design.md`
- Checklist: `.codestable/refactors/2026-07-16-ejs6-visual-equivalence/ejs6-visual-equivalence-checklist.yaml`
- Evidence pack: none
- Gate results: none
- DoD results: checklist commands + apply notes
- Implementation evidence: `ejs6-visual-equivalence-apply-notes.md` 与本轮命令输出
- Diff basis: 当前 unstaged/untracked 工作区；仅审 `package*.json`、`playwright.config.js`、`test/comments-security.test.js`、`test/helpers/ejs-visual-harness.js`、`test/visual/**`
- Review mode: initial
- Baseline dirty files: 工作区存在其他 `.codestable/` 历史 dirty/untracked 项；已从本轮 scope 排除

### Independent Review

- Detection: 原生 Task agent 可用；OCR CLI 已安装但 `ocr llm test` 因没有有效 LLM endpoint 配置而失败
- 环节 A 独立隔离 Task agent: native-agent + completed
- 环节 B OCR CLI: failed
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: Task agent 结果已由主 agent用仓库事实逐条核验；OCR 未产生 findings
- Gate effect: Task agent gate 已满足；3 个 important 已由主 agent 完成 focused closure 并通过完整只读门禁

## 2. Diff Summary

- 新增：Playwright 配置、测试 harness、固定浏览器资源、17 HTML + 102 layout/style + 102 PNG 基线及其 manifest/index
- 修改：`package.json`、`package-lock.json`、`test/comments-security.test.js`
- 删除：EJS 3 的 lockfile 传递依赖条目
- 未跟踪 / staged：本轮新增测试与 refactor 文档未跟踪；无 staged 文件
- 风险热点：EJS major 兼容、快照假阳性、测试资源确定性、批准后 snapshot 更新纪律

## 3. Adversarial Pass

- 假设的生产 bug：EJS 6 locals/Express 集成改变输出，或测试工具允许把升级后的差异重新批准为旧基线
- 主动攻击过的反例：原型 locals、include、评论/统计模块渲染、Express view cache、CDN/字体漂移、snapshot 重写、设备尺寸、生产依赖污染、回滚边界
- 结果：未发现生产集成直接回归；测试资源完整性和基线重写纪律各形成 1 个 important finding

## 4. Findings

### blocking

none

### important

- [x] REV-001 `test/visual/assets/asset-manifest.json:2-8` 浏览器实际消费的 `inter.css` 未纳入固定资源 SHA-256 manifest。
  - Evidence: `browser-assets.js` 会响应该 CSS；校验器只遍历 manifest 条目；当前仅报告 7 个 pinned assets，但实际固定资源为 8 个。
  - Impact: 字体映射或 `font-display` 可变化而资源 hash gate 仍通过，削弱视觉基线确定性。
  - Expected fix scope: 只登记当前 `inter.css` hash，并使校验拒绝未登记的 CSS/WOFF2 资源；不改资源内容或 snapshot。

- [x] REV-002 `test/visual/generate-baseline-evidence.js:69-77,112-117` 批准后的基线可在 EJS 6 下被重新生成，并仍硬编码标记为 EJS 3。
  - Evidence: `test:visual:baseline` 暴露 snapshot update；evidence generator 无环境变量和实际 EJS 版本 guard，且无条件覆盖 manifest。
  - Impact: 误操作可绕过“EJS 升级后不得更新 expected”的核心证据纪律。
  - Expected fix scope: 移除已批准的 baseline update script；generator 只在显式一次性环境变量且实际 EJS 严格为 3.1.10 时运行，并从已验证版本写入 engine；不得更新现有 expected 或 manifest。

- [x] REV-005 `test/helpers/ejs-visual-harness.js:8-10` 只固定了 comments clock，没有固定模板直接调用的全局 `Date`。
  - Evidence: public/admin footer 和登录页使用 `new Date().getFullYear()`；harness 当前会随系统年份变化，design §2.5 要求服务端时间固定。
  - Impact: 跨年后 HTML/layout/PNG baseline 会产生与 EJS 无关的假失败，削弱长期回归能力。
  - Expected fix scope: 只在独立 harness 进程内以 test-only wrapper 固定无参数 `Date`/`Date.now`，保留带参数 Date 行为；不改生产模板或 snapshot。

### nit

- [ ] REV-003 `test/comments-security.test.js:316` EJS 版本契约位于评论安全综合测试中，职责不够集中；本轮沿用既有结构，不阻塞。

### suggestion

- [x] REV-004 已增加单一只读完整 gate script，顺序覆盖 view/assets、baseline manifest、node:test、HTML 和 visual。

### learning

- EJS 6 顶层 locals 只使用 own enumerable properties；当前生产 `res.render` 均传普通对象或 SQLite own-property row，未发现依赖原型链的 locals。

### praise

- EJS 精确锁定为 `6.0.1`，Playwright 仅在 devDependencies；生产模板/CSS/JS 没有 diff。
- 221 个 baseline hash、17 个 HTML、102 个 layout/style 和 102 张 PNG 形成了可审计证据链。

## 5. Test And QA Focus

- QA 必须重点复核：修复后资源 gate 应显示 8 assets；EJS 6 下 generator 默认拒绝；221 baseline 保持不变；HTML/visual 继续通过。
- Evidence pack residual risks / gate warnings：Windows 中文回退字形抗锯齿噪声已由零容差 layout/style + 有界图片比较解释。
- 建议新增或加强的测试：批准后 baseline 写入入口的 fail-closed guard；生产 view cache 双次渲染 smoke。
- 不能靠 review 完全确认的点：Windows WebKit 模拟不等于真实 iOS Safari。

## 6. Residual Risk

- 视觉 harness 使用固定 view model，不是完整 `server/index.js` 中间件顺序；现有 node:test 与评论/统计真实 Express integration 补充覆盖。
- 未覆盖真实 iOS Safari；发布级真机验证仍需人工执行。

## 7. Verdict

- Status: passed
- Next: 等待 HUMAN 对 EJS 6 证据索引做最终目视确认；除非用户明确授权，否则不提交

## 8. Focused Closure

### Closed Findings

- REV-001：将 `inter.css` 加入 asset manifest；校验器现在精确比较目录中的 CSS/WOFF2 文件集合与 manifest，未登记或多余资源都会失败。
- REV-002：移除批准后的 baseline update script；证据生成器同时要求 `ALLOW_EJS3_BASELINE_WRITE=1` 和实际 `ejs@3.1.10`，engine 版本来自已解析的实际包版本；baseline manifest 校验器精确比较 221 个文件集合与 hash。
- REV-005：在独立测试 harness 进程内固定无参数 `Date` 与 `Date.now()`，保留带参数 `Date` 的原生语义；生产模板未修改。
- REV-004：新增 `npm run test:ejs-upgrade-gate` 作为单一只读升级门禁。

### Attributed Delta

- `package.json`
- `.gitattributes`
- `.gitignore`
- `test/helpers/ejs-visual-harness.js`
- `test/visual/assets/asset-manifest.json`
- `test/visual/assets/README.md`
- `test/visual/generate-baseline-evidence.js`
- `test/visual/verify-baseline-manifest.js`
- `test/visual/verify-view-hashes.js`

以上均为测试与证据纪律变更；`.gitattributes` 仅允许 HTML 快照原样保留 EJS 输出空白，`.gitignore` 仅排除 Playwright 临时报告目录；未改变生产行为、公开契约、数据、安全边界或系统架构。

### Verification

- `npm run test:view-hashes`：17 个生产 view/style 与 8 个 pinned assets 全部通过。
- `npm run test:baseline-manifest`：221 个不可变 EJS 3.1.10 baseline 文件全部通过。
- `npm run visual:evidence`：无写入开关时 fail-closed；显式开关在 EJS 6.0.1 下仍因版本不匹配 fail-closed。
- `npm run test:ejs-upgrade-gate`：Node tests 80 pass、1 个 Linux-only skip、0 fail；HTML 17/17；layout/style 与 visual 102/102；无 snapshot update。
- Focused closure verdict：passed；无未解决 blocking/important finding。
