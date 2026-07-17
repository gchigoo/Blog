---
doc_type: refactor-apply-notes
refactor: 2026-07-16-ejs6-visual-equivalence
status: completed
started_at: 2026-07-17
---

# EJS 6 零视觉变化升级 apply notes

## 步骤 1：冻结工作区和当前运行基线

- 状态：完成。
- 用户批准依据：2026-07-17 明确要求“帮我升级”。
- 环境：Windows，Node `v24.15.0`，EJS `3.1.10`。
- 既有测试：`npm test` 通过；78 pass、1 个 Linux-only skip、0 fail，共 79 tests。
- 生产页面冻结面：16 个 `views/**/*.ejs` 与 `public/css/custom.css`；当前生产源码 git diff 为空。
- 时序偏差：原设计时 comments feature 尚待实施；执行前该 feature 已完成验收，因此按设计中的预案重新扩大基线，纳入文章评论状态与后台评论审核页。场景由 12 个调整为 17 个，视觉基线由 72 张调整为 102 张。
- 页面与 CSS SHA-256：
  - `public/css/custom.css`: `dcca63d95e4f8db180b167fb40d896a898cc073d6daff47091be7210bb69ee8c`
  - `views/404.ejs`: `412137cb50f76e46ef1bc696b1b673218e8fedd7b6d1baa467cf3b0a7348d38c`
  - `views/about.ejs`: `d3feca8dbfaf0df376d34e7f87d6b6f499826d864a64d7d2566afe46b5ca6f49`
  - `views/admin/analytics.ejs`: `cba6f06665b728aec4fb71d8041ed64e59d439e6540117030ae39e6378ee2ef8`
  - `views/admin/articles.ejs`: `9afe20322da68f0ef871135f9ed92cbac3a3c9251fd9e53604c54dc9a888e78d`
  - `views/admin/comments.ejs`: `498d0927e7c7cc5c5eb3e8ffa86607b5e48841df7a369761d548c47226988bd7`
  - `views/admin/login.ejs`: `657ba0ef1b2e186ccfa2dafa57757de62407b5f1bdccf7674d15aa7a678b6699`
  - `views/admin/upload.ejs`: `86014408ace790b4e8d5191be4d339acc9a0d07603e9e98298b63884880cf0c4`
  - `views/archive.ejs`: `499245eb750cd3c60f7d1cace4fb18de2bbaed98a8c343198b52f3026dd9702c`
  - `views/article.ejs`: `0a3d3ca40e4b7edac42b80db07d145ed3dab94dc80fb9fcd6caca527b10230f3`
  - `views/index.ejs`: `80a6544e8e759d0a32a116b77484e59c94d728e9b4a70076ad97e82c9ea45cc3`
  - `views/partials/admin-footer.ejs`: `7c743a5917bb0dc17ab7693e19dadd8eaa85661b912f272a8a366a82e0e6b46c`
  - `views/partials/admin-header.ejs`: `8cbc10599705d70cd6231e4991113f98892e23c51815e3e8b983b7952667d6f7`
  - `views/partials/footer.ejs`: `1efa83dd82b306e8a8d39c3c4f5e0b43fa7d142e0eafa404ef6bd3d82f7e74d9`
  - `views/partials/header.ejs`: `4af059dd0fe9633cb43db3015a652d545f4dc96ea45deab272e770d86298f2dc`
  - `views/tag.ejs`: `b2bc7c1d549b7fbb13409e01b2374f3a668138ff424f7134256a92785447a209`
  - `views/tags.ejs`: `1a0a37c560bbc8f449199b5c0a9564a47a42e6d5aa171f8bd4ee5590f31c36fd`

## 步骤 2：建立确定性浏览器测试基座

- 状态：完成。
- 经验偏差：Windows 上 Inter 不包含的中文字形会走系统回退字体。实测即使固定 Playwright browser revision、CDN 字节、DPR、字体加载状态并禁用 Chromium LCD/subpixel text，不同浏览器进程间仍有少量 DirectWrite/WebKit 字形边缘色差；页面 DOM 和几何位置不变。
- 调整：不使用 mask，不删除原始截图；新增每场景/设备逐元素 DOM rect、scroll/client 尺寸和关键 computed styles 的零容差 JSON 门禁。PNG 比较仅允许 `threshold=0.2`、`maxDiffPixelRatio=0.01` 的抗锯齿噪声，最终仍由 HUMAN 检查原始全页图。
- 测试依赖：`@playwright/test@1.61.0` 精确锁定为 devDependency；安装 Chromium 149 revision 1228 与 WebKit 26.5 revision 2311。
- 确定性资源：本地固定 `new.css@1.1.2` 与 Inter 400/italic/500/600/700/800 WOFF2，SHA-256 由 asset manifest 验证；测试显式等待全部字体和两个 animation frames。
- 隔离：harness 使用内存 SQLite、固定文章/评论/统计数据、固定评论时钟与 test-only Cookie；不读写根 `blog.db`，不修改生产路由、模板或 CSS。
- 设备：Chromium 1920×1080、2560×1440、3840×2160 @1x；WebKit iPhone 17 402×874、iPhone Air 420×912、iPhone 17 Pro Max 440×956 @3x。

## 步骤 3：生成并批准 EJS 3 基线

- 状态：完成。
- HTML：17 份原始 HTML snapshot；禁止更新模式连续运行通过。
- Layout/style：17 场景 × 6 项目 = 102 份逐元素零容差 JSON snapshot。
- Visual：17 场景 × 6 项目 = 102 张 full-page PNG；两次全矩阵禁止更新运行分别 `102 passed (3.3m)`、`102 passed (3.2m)`，0 retry、0 fail。
- 既有测试：最新 `npm test` 为 80 pass、1 个 Linux-only skip、0 fail，共 81 tests。
- 冻结门禁：17 个生产 view/style 文件和 7 个 pinned assets 校验通过；221 个 EJS 3 baseline 文件由 `baseline-manifest.json` 的 SHA-256 锁定。
- 依赖状态：`ejs@3.1.10`，尚未升级；`@playwright/test@1.61.0`。
- 证据索引：`test/visual/baseline-index.html`。
- 存储：17 HTML + 102 layout JSON + 102 PNG，共约 29.5 MiB。
- 生产冻结面：`git diff -- views public/css/custom.css` 为空。
- HUMAN checkpoint：用户于 2026-07-17 明确回复“确认基线，继续升级”。

## 步骤 4：仅升级 EJS 依赖

- 状态：完成。
- 升级前 manifest SHA-256：`package.json=62436123304cb751f35d5fc162b8ac6de0959abd28335822f5361b30aeb05944`；`package-lock.json=201646ce707bcacaa9eee5f630275c28640abd64638807408810d5df778643ea`。
- 依赖变化：`ejs: ^3.1.10 → 6.0.1`；lockfile 更新 EJS tarball/integrity，并移除 EJS 3 的 `jake`、`async`、`filelist` 等传递依赖。
- 升级后依赖切片 SHA-256：`package.json=f50baa167c7b75ff14ac1dda1e95c190add05e9ee0ff75eda37dfb9c58e9932b`；`package-lock.json=a4471f2c0343947646248dfb0107f375ef750cbb6bca6a6744bff1fccee2d838`。独立审查补充只读 gate script 后，最终 `package.json=21dd8140f95d2a519a1ffb3ab76a1022596576c017643b5914274c0020b81575`；lockfile 未再变化。
- `npm ci` 成功；`npm ls ejs @playwright/test --depth=0` 为 `ejs@6.0.1` 与 `@playwright/test@1.61.0`。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- 测试契约同步：`test/comments-security.test.js` 原先硬编码 `^3.x`，现改为精确断言 `6.0.1`。这是唯一非 manifest 的迁移适配，不改变生产代码或页面。

## 步骤 5：执行布局零容差自动等价验证

- 状态：完成。
- 生产 view/style hash：17/17 通过；8 个 pinned assets 通过；`views/` 与 `public/css/custom.css` 没有 diff。
- EJS 3 baseline manifest：221/221 SHA-256 通过，升级后没有更新 expected snapshot。
- 现有测试：80 pass、1 个 Linux-only skip、0 fail，共 81 tests。
- 性能波动：第一次全套运行的 100k analytics p95 为 555.50ms，超过 500ms；该代码路径不使用 EJS。单独复跑为 456.68ms，全套复跑为 409.70ms，因此归类为环境波动，未修改业务代码或阈值。
- HTML：17/17 与 EJS 3 原始 HTML 完全一致。
- Layout/style：102/102 零差异。
- Visual：102/102 通过，`threshold=0.2`、`maxDiffPixelRatio=0.01` 仅过滤已记录的中文字形抗锯齿噪声；无 retry、无 expected update。

## 步骤 6：人工跨设备验收与独立审查

- 状态：完成。
- 独立审查：原生隔离 subagent 已完成 round 1；初审发现 3 个 important（资源 manifest 完整性、基线重写 fail-closed、全局时间固定），均已按最小测试范围修复。
- Focused closure：`npm run test:view-hashes` 验证 17 个 view/style 与 8 个固定资源；`npm run test:baseline-manifest` 验证 221 个 baseline；证据生成器在无开关和 EJS 6 + 显式开关两种情况下均 fail-closed。
- 单一完整门禁：`npm run test:ejs-upgrade-gate` 一次通过；Node tests 80 pass、1 skip、0 fail，HTML 17/17，layout/style 与 visual 102/102；analytics 100k p95 为 442.09ms。
- 工作区卫生：根 `.gitignore` 增加 `/test-results/`，避免 Playwright 临时运行报告进入升级提交；`.gitattributes` 仅对 HTML 快照关闭 whitespace 告警，确保已批准的 EJS 原始输出字节和 hash 不被清洗；可审计基线仍保存在 `test/visual/`。
- Code review verdict：passed；0 blocking、0 未解决 important。
- HUMAN checkpoint：用户于 2026-07-17 回复“好，帮我提交并推送至 GitHub”，确认最终视觉验收并明确授权提交、推送和生产更新。
