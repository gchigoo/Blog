---
doc_type: refactor-design
refactor: 2026-07-16-ejs6-visual-equivalence
status: approved
approved_at: 2026-07-17
approval_basis: 用户明确要求“帮我升级”
scope: 在不改变任何页面 HTML、布局、样式和可见行为的前提下，将 EJS 3.1.10 升级到 6.0.1
summary: 先冻结 17 个 HTML 场景、102 份布局/计算样式快照和 6 档设备的 102 张视觉基线，再单独升级依赖，以 HTML/布局零容差、抗锯齿受限图片比较和人工目视三重放行
---

# EJS 6 零视觉变化升级 refactor design

## 1. 本次范围

### 已选择的 scan 条目

- #1 建立全部渲染路由的 HTML 刻画快照。
- #2 建立六档设备的布局精确视觉基线。
- #3 将 EJS 锁定升级到 6.0.1。
- #4 固化零样式改动和人工放行门禁。

### 明确不做

- 不修改 `views/**/*.ejs`、`public/css/custom.css`、页面文案、DOM 顺序、class、内联样式或生产静态资源地址。
- 不把 Google 登录评论功能、页面重设计、响应式优化、可访问性修复或其他 bug 修复夹带进本次升级。
- 不使用 `unsafePrototypeLocals: true` 规避 v6 安全默认值；当前所有顶层 locals 都由 `res.render(..., { ... })` 的普通对象提供。
- 不使用 `client: true`、EJS 深层导入或 ESM 命名导入。
- 不在升级后自动接受截图；若有差异，先回滚依赖并分析根因。
- 不改变 Node `>=24 <25` 契约。

### 时序与隔离

- `2026-07-16-google-auth-comments` 已于 2026-07-17 验收完成；其文章评论区和后台审核页已纳入本 refactor 的冻结面。
- 本次以当前已验收生产页面重新生成 EJS 3 基线，不复用 comments feature 合入前的场景计数或截图。
- baseline 生成到最终 HUMAN 放行期间，禁止其他分支修改 `views/` 或 `public/css/custom.css`。
- 当前仓库生产源码无 diff，适合先执行本 refactor；现有 `.codestable/` 用户改动不纳入本次 scope。

### 风险与工作量

- 总风险：高。EJS 调用点风险低，但“视觉必须零变化”的证明成本高。
- 预计新增：1 个 Playwright 配置、视觉 fixture/test 文件、17 份 HTML snapshot、102 份逐元素布局/计算样式 snapshot、102 张全页 PNG snapshot，以及必要的测试资源缓存。
- 新依赖理由：现有 `node:test` 无真实浏览器布局和像素比较能力；`@playwright/test` 只进入 `devDependencies`，不进入生产依赖树。

## 2. 前置依赖与验收矩阵

### 2.1 运行环境

- 使用 Node 24，与项目 `engines` 和 `.nvmrc` 一致。
- 使用 lockfile 固定 `@playwright/test@1.61.0` 及对应浏览器 revision。
- 选择一套 canonical baseline 主机；第一版固定 Windows + Playwright bundled browsers。其他操作系统不得复用该 baseline，未来需要 CI 时按平台建立独立 baseline。
- `locale: zh-CN`、`timezoneId: Asia/Shanghai`、`colorScheme: light`、`reducedMotion: reduce`、`serviceWorkers: block`。
- 截图时禁用动画、隐藏 caret，使用 device scale；不 mask 页面内容，因为 mask 会掩盖真实变化。

### 2.2 桌面项目

| 项目 | 浏览器 | CSS viewport | DPR | 输出宽高 |
|---|---|---:|---:|---:|
| desktop-1080p | Chromium | 1920×1080 | 1 | 1920×1080 首屏；全页图宽 1920 |
| desktop-2k | Chromium | 2560×1440 | 1 | 2560×1440 首屏；全页图宽 2560 |
| desktop-4k | Chromium | 3840×2160 | 1 | 3840×2160 首屏；全页图宽 3840 |

这里将用户所说的“2K”固定解释为主流 QHD `2560×1440`，避免和影院 DCI 2K 混淆。

### 2.3 移动项目

| 项目 | 浏览器 | CSS viewport | DPR | 物理像素 |
|---|---|---:|---:|---:|
| iphone-17 | WebKit | 402×874 | 3 | 1206×2622 |
| iphone-air | WebKit | 420×912 | 3 | 1260×2736 |
| iphone-17-pro-max | WebKit | 440×956 | 3 | 1320×2868 |

- 三款设备均固定 `isMobile: true`、`hasTouch: true` 和一个版本固定的 Mobile Safari user agent。
- 使用自定义项目，不依赖 Playwright 内置设备名称，避免内置描述符未来变化。
- 设备尺寸依据 Apple Human Interface Guidelines；WebKit 模拟用于可重复的网页布局回归，不宣称替代真机 Safari 验收。

### 2.4 页面场景

每个设备项目覆盖以下 17 个场景，共 `6 × 17 = 102` 张全页 PNG：

1. 匿名首页 `/`
2. 已登录首页 `/`
3. 评论关闭的文章详情 `/article/comments-disabled`
4. 评论开启、已存在公开评论且访客未登录的文章详情 `/article/comments-browser-smoke`
5. 评论开启、评论者已登录的文章详情 `/article/comments-browser-smoke`
6. 评论开启但暂无公开评论的文章详情 `/article/comments-empty`
7. 归档 `/archive`
8. 标签云 `/tags`
9. 标签文章 `/tag/upgrade`
10. About `/about`
11. 404 `/visual-not-found`
12. 后台登录 `/admin/login`
13. 后台上传 `/admin/upload`
14. 后台文章列表 `/admin/articles`
15. 后台统计 `/admin/analytics`
16. 后台待审核评论 `/admin/comments?status=pending`
17. 后台已通过评论 `/admin/comments?status=approved`

后台页面使用测试 JWT Cookie；数据库固定文章、标签、日期和统计数据。服务端时间通过 test-only Node preload 固定，不向生产代码加入 test mode。

### 2.5 截图确定性

- Playwright 对每个场景/设备保存逐元素 DOM rect、scroll/client 尺寸和关键 computed styles，升级前后 JSON 必须字节级零差异；这是一条独立于图片抗锯齿的布局/样式硬门禁。
- Playwright `toHaveScreenshot` 配置：`threshold: 0.2`、`maxDiffPixelRatio: 0.01`、`animations: 'disabled'`、`scale: 'device'`、`fullPage: true`，不设 mask。允许项仅用于过滤 Windows DirectWrite/WebKit 对中文回退字体的跨进程字形边缘抖动；任何超过 1% 的视觉差异仍阻断。
- EJS 3 基线首次生成只允许显式 `--update-snapshots=missing`；基线批准后配置和 CI 一律 `updateSnapshots: 'none'`。
- Inter 字体和 `new.css@1.1.2` 在测试中由固定字节的本地 fixture 响应，记录 SHA-256 与上游来源；生产模板继续使用原 URL。
- 每张截图前等待字体 ready、网络空闲和页面稳定；禁止依赖任意 sleep。
- EJS 3 基线连续运行两次必须 17/17 HTML、102/102 layout/style 和 102/102 visual 全部通过后才能批准。

## 3. 执行顺序

### 步骤 1：冻结工作区和当前运行基线

- **引用方法**：M-L1-04 Characterization Test
- **具体操作**：确认 comments feature 已验收且当前生产源码无并发页面 diff；执行 `npm ci`、`npm test`，记录 EJS 3.1.10、Node 24、lockfile 和生产视图/CSS 的 hash。
- **退出信号**：依赖完整；既有测试全绿；`npm ls ejs --depth=0` 为 3.1.10；视图/CSS scope hash 已记录。
- **验证责任**：AI 自证。
- **回滚**：本步只安装依赖和记录证据，不改生产代码；失败则不进入测试基线建设。

### 步骤 2：建立确定性浏览器测试基座

- **引用方法**：M-L1-04 Characterization Test
- **具体操作**：固定 `@playwright/test@1.61.0`；建立仅测试使用的内存 SQLite/JWT/固定时钟 harness，固定外部样式与字体响应；定义 6 个视觉 projects 和 1 个 HTML snapshot project。
- **退出信号**：测试不会读写仓库根 `blog.db`；17 个场景在全部视觉 projects 可访问；测试资源无外部网络漂移；现有 `npm test` 不受影响。
- **验证责任**：AI 自证。
- **回滚**：删除新增 devDependency、配置和 test-only 文件即可，不触碰生产模板。

### 步骤 3：生成并批准 EJS 3 基线

- **引用方法**：M-L1-04 Characterization Test
- **具体操作**：在 EJS 3.1.10 下生成 17 份原始 HTML snapshot、102 份 layout/style snapshot 和 102 张全页 PNG；重新干净运行两次；输出按页面和设备分组的索引。
- **退出信号**：两次运行 HTML 与 layout/style 全部零差异、图片全部在抗锯齿硬上限内；没有 missing、flaky 或重试后才通过的 snapshot。
- **验证责任**：AI 自证 + HUMAN。
- **人工 checkpoint**：用户必须确认 EJS 3 基线代表当前正确页面，未确认不进入升级。
- **回滚**：删除未批准的 snapshot，修正 fixture 后重新生成；不修改生产页面来迎合测试。

### 步骤 4：仅升级 EJS 依赖

- **引用方法**：M-L1-01 Parallel Change
- **具体操作**：在基线切片独立保存后，把 `ejs` 固定到 `6.0.1`，重建 `package-lock.json`；不修改任何生产 JS、EJS 或 CSS。
- **退出信号**：`npm ci` 成功；`npm ls ejs --depth=0` 唯一为 6.0.1；升级 diff 只包含允许的依赖清单文件。
- **验证责任**：AI 自证。
- **回滚**：恢复升级前 `package.json` 和 `package-lock.json`；不得通过打开 `unsafePrototypeLocals` 或调整 CSS 继续推进。

### 步骤 5：执行布局零容差自动等价验证

- **引用方法**：M-L1-04 Characterization Test
- **具体操作**：依次运行现有测试、17 份 HTML snapshot、102 份 layout/style snapshot、102 张视觉 snapshot、模板/CSS 零 diff gate 和依赖审计；显式禁止 snapshot update。
- **退出信号**：全部测试一次通过；HTML 0 diff；layout/style 0 diff；图片无超过抗锯齿上限的差异；`views/**/*.ejs` 和 `public/css/custom.css` 0 diff；无新增生产依赖。
- **验证责任**：AI 自证。
- **回滚**：任一差异立即停止并回滚步骤 4；保存 actual/diff 图用于根因分析，不覆盖 expected。

### 步骤 6：人工跨设备验收与独立审查

- **引用方法**：M-L1-01 Parallel Change
- **具体操作**：展示按 17 场景 × 6 项目组织的结果索引，人工重点检查导航、正文宽度、评论区、标签换行、表单、列表、统计页、审核页和 404；然后进入 `cs-code-review` 独立检查 diff、snapshot 更新纪律和范围。
- **退出信号**：用户明确确认布局和样式无变化；code review 无 Critical/Important；apply notes 记录全部证据。
- **验证责任**：HUMAN + 独立 review。
- **回滚**：人工发现任何异常时回滚 EJS 依赖切片，保留已批准的 EJS 3 基线作为诊断依据。

## 4. 风险与看点

- **基线失效风险**：comments feature 或其他任务并发修改页面会让结果不可归因；必须串行执行。
- **字体/平台噪声**：必须固定 Windows、浏览器 revision、测试字体资源和 DPR；中文由系统回退字体渲染，跨进程存在已实测的字形边缘抗锯齿噪声，因此以零容差 layout/style snapshot 防止图片容差掩盖布局变化；跨平台截图不能混用。
- **动态内容噪声**：统计时间、JWT 过期、数据库自增 ID 和文章日期全部固定。
- **EJS v6 locals 风险**：v6 只复制顶层 own enumerable locals；当前路由均传普通对象，nested article/user 对象引用不会被深拷贝。仍需 HTML snapshot 证明。
- **快照滥用风险**：升级后禁止运行 update snapshots；expected PNG 的任何改动都视为阻断项。
- **存储成本**：4K 与 @3x 全页 PNG 体积较大，但这是用户要求的零视觉变化证据；不以降低分辨率换取体积。
- **真机边界**：WebKit emulation 可证明固定渲染环境前后等价，但不等于真实 iOS Safari；如果要求发布级真机保证，应在最后追加三台真机人工 smoke，不替代本自动基线。

## 5. 提交与回滚边界

建议两个独立提交，但只有用户明确授权后才提交：

1. `test: establish EJS 3 visual baselines`：仅测试基座、测试依赖和 EJS 3 expected snapshots。
2. `build(deps): upgrade ejs to 6.0.1`：仅 EJS 版本和 lockfile；expected snapshots、views、CSS 不得变化。

回滚只需撤销第二个切片；第一个切片继续作为旧行为刻画证据。

## 6. 规格依据

- Apple HIG 设备尺寸：https://developer.apple.com/design/human-interface-guidelines/layout
- Playwright projects：https://playwright.dev/docs/test-projects
- Playwright visual comparisons：https://playwright.dev/docs/test-snapshots
- EJS v4 release notes：https://github.com/mde/ejs/blob/main/RELEASE_NOTES_v4.md
- EJS v5 release notes：https://github.com/mde/ejs/blob/main/RELEASE_NOTES_v5.md
- EJS v6 compatibility：https://github.com/mde/ejs/blob/v6.0.1/README.md
