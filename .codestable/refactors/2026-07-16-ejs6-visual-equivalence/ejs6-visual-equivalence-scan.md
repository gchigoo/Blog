---
doc_type: refactor-scan
refactor: 2026-07-16-ejs6-visual-equivalence
status: user-reviewed
scope: package.json/package-lock.json、Express EJS 渲染入口、测试基座；views/**/*.ejs 与 public/css/custom.css 仅作为只读验收面
summary: 4 条已由用户确认的行为等价工作项；结构 4 条；低风险 1、中风险 2、高风险 1
---

# EJS 6 零视觉变化升级 scan

## 总览

- 扫描范围：`package.json`、`package-lock.json`、`server/index.js`、`server/comments/`、`server/analytics/`、`test/`；16 个 `views/**/*.ejs` 模板和 `public/css/custom.css` 只参与对比，禁止因升级而修改。
- 发现 4 条工作项：结构 4 / 架构 0 / 性能 0 / 可读性 0。
- 按风险：低 1 / 中 2 / 高 1。
- 建议顺序：#1 → #2 → #3 → #4；#3 不得在 #1、#2 的基线完成前启动。
- 建议慎做：#2 需要 6 档设备、102 张全页截图和人工目视；#3 只允许依赖清单变化。
- 前置检查：第 1、3–7 条通过；第 2 条最初因关键页面无视觉测试而命中。用户于 2026-07-16 明确确认先按 M-L1-04 建立基线，并补充桌面 1080p/2K/4K 与 iPhone 17/Air/17 Pro Max 矩阵，因此把测试覆盖作为 #1、#2 的硬前置，而不是跳过。
- 时序约束：不得与 `2026-07-16-google-auth-comments` 的页面实现交错。该功能已于 2026-07-17 验收完成，因此本 refactor 以包含评论页、评论状态和统计页的当前生产页面为新基线；baseline 冻结后不得再并发修改 `views/` 或 `public/css/custom.css`。
- 用户选择依据：用户先确认“建立 EJS 3 页面与视觉基线”，随后确认扩大到上述 6 档设备，所以下列条目均按用户原话标记为 ✓。

## 条目

### [#1] 建立全部渲染路由的 HTML 刻画快照 ✓

- **位置**：`server/index.js:39-263`、`test/admin-view-security.test.js:1-32`
- **分类**：结构
- **现状**：服务端与评论/统计模块共有 16 个 EJS 模板；直接渲染测试只覆盖少数后台模板，缺少全部页面状态的统一输出基线。
- **问题**：公开页、404、登录页和统计页均没有可重复的 HTML 输出基线；EJS major 升级后无法自动判断输出是否发生变化。
- **建议**：为 17 个稳定页面状态准备确定性内存 SQLite/JWT/时钟 fixture，保存 17 份原始 HTML snapshot；先在 EJS 3.1.10 下连续运行两次确认一致。
- **建议映射的方法**：M-L1-04 Characterization Test
- **风险**：中（动态时间、认证 Cookie 和数据库顺序必须固定，否则产生假差异）。
- **验证**：AI 自证（EJS 3 下连续两次 snapshot 零变化；现有 `npm test` 全绿）。
- **范围**：约 3–5 个测试文件 / 不修改生产模板。

### [#2] 建立六档设备的布局精确视觉基线 ✓

- **位置**：`views/**/*.ejs`、`public/css/custom.css`、新增 `playwright.config.js` 与 `test/visual/`
- **分类**：结构
- **现状**：页面加载 Inter 字体、`new.css@1.1.2` 和本地 `custom.css`，仓库没有浏览器截图测试或固定设备矩阵；已验收的评论功能新增了公开文章状态和后台审核页。
- **问题**：16 个模板没有统一的像素级证据；仅靠 HTML snapshot 和人工抽查不能证明响应式布局、字体度量和样式在升级后完全不变。
- **建议**：引入仅开发期使用的 `@playwright/test@1.61.0`，固定 3 个 Chromium 桌面项目和 3 个 WebKit iPhone 项目，对 17 个页面状态生成 102 份零容差布局/计算样式快照和 102 张全页基线截图；图片仅过滤实测的中文系统回退字形抗锯齿噪声。
- **建议映射的方法**：M-L1-04 Characterization Test
- **风险**：高（截图对浏览器 revision、字体、外部 CDN、DPR、时钟和操作系统敏感，必须全部固定并由 HUMAN 首次目视批准）。
- **验证**：AI 自证（同环境连续两次 102/102 layout/style 零差异且 102/102 图片比较通过）｜ HUMAN（逐页抽查桌面三档与三款 iPhone，确认基线就是当前页面）。
- **范围**：约 4–7 个测试/配置文件 + 102 份 layout/style snapshot + 102 张基线图片 / 生产视图和 CSS 只读。

### [#3] 将 EJS 锁定升级到 6.0.1 ✓

- **位置**：`package.json:27-41`、`package-lock.json:1-2819`
- **分类**：结构
- **现状**：项目声明 `ejs@^3.1.10`，使用 Express 的标准 `view engine` 与 `res.render`，未发现 `client: true`、深层导入、命名 ESM 导入、`ejs.VERSION` 或原型 locals。
- **问题**：当前依赖停留在 EJS 3；但直接升级跨越 v4 包入口、v5 client 删除和 v6 locals 原型隔离，必须以已冻结输出为边界控制风险。
- **建议**：在独立切片中把 EJS 固定到 `6.0.1` 并重建 lockfile；不修改 `views/`、`public/css/custom.css`、路由数据结构或可见文案。
- **建议映射的方法**：M-L1-01 Parallel Change
- **风险**：中（当前调用形态低风险，但跨 3 个 major；任何输出差异都必须回滚而非调整样式）。
- **验证**：AI 自证（`npm ls ejs` 唯一为 6.0.1；既有测试、17 份 HTML snapshot、102 份 layout/style snapshot、102 张视觉 snapshot 全绿；模板/CSS diff 为 0）。
- **范围**：2 个依赖清单文件。

### [#4] 固化零样式改动和人工放行门禁 ✓

- **位置**：新增视觉测试脚本、refactor checklist/apply notes；`views/` 与 `public/css/custom.css` 作为 scope gate
- **分类**：结构
- **现状**：当前没有规则阻止升级时顺手更新截图、模板或 CSS，也没有 baseline commit 与 dependency commit 的边界。
- **问题**：如果升级后自动更新 snapshot 或调整 CSS 来消除 diff，就会失去“升级前后无变化”的可审计证据。
- **建议**：基线与依赖升级分成两个独立切片；EJS 升级后强制 `updateSnapshots: none`、模板/CSS 零 diff、HUMAN 最终目视确认，任一失败立即回滚依赖切片。
- **建议映射的方法**：M-L1-01 Parallel Change
- **风险**：低（只增加验证和回滚约束，不改变运行时页面）。
- **验证**：AI 自证（缺失或变化的 snapshot 均失败；升级 diff 不含视图/CSS）｜ HUMAN（确认最终视觉报告并明确放行）。
- **范围**：约 1–3 个配置/记录文件。
