---
doc_type: feature-acceptance
feature: 2026-07-17-article-audio-playback
status: passed
accepted: 2026-07-17
round: 1
---

# 文章内音频播放验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-17
> 关联方案：`.codestable/features/2026-07-17-article-audio-playback/article-audio-playback-design.md`

## 1. 接口契约核对

对照方案第 2.1 节名词层逐项核查：

- [x] `ArticleAudioBlock` 作者示例：`:::audio` 只解析 `title` / `artist` / `src` / `caption`，必填、重复、未知字段、闭合和 Unicode code-point 长度规则落在 `server/article-audio/markdown.js:3-67`；合法块由 `parseMarkdownDocument` 收集。
- [x] 两阶段输入：作者态 `src: ./audio/final.mp3` 只用于 ZIP entry 解析；`renderArticleAudio` 只接受 `/audio/{safe-slug}/{64hex}.mp3`，不把作者路径写入最终 HTML（`server/article-audio/assets.js:73-99,204-233`、`server/article-audio/markdown.js:95-132`）。
- [x] 固定输出：实现生成专用 stylesheet、`figure`、转义后的元数据及 `<audio controls preload="metadata">`；不存在 `autoplay` 或自定义播放脚本。
- [x] ZIP / MP3 契约：区分大小写的 entry 索引、Markdown entry 相对路径、20 MiB 单文件、100 MiB 声明展开量、ID3 后连续两个完整 MPEG frame 与 SHA-256 命名均有代码和表驱动测试。
- [x] 流程图节点均有落点：作者 Markdown → block 收集 → ZIP/MP3 校验与 stage → resolved HTML → Markdown/audio promotion → SQLite commit → 静态读取；失败分支回到 ownership-aware rollback。

名词层“现状 → 变化”与实现一致：文章音频块、文章音频资产、发布音频路径和文章发布包均只存在于文章发布/渲染边界，没有被实现成独立歌曲领域。

## 2. 行为与决策核对

### 需求与关键决策

- [x] 合法 ZIP 可在正文指定位置发布一个或多个 MP3 卡片，普通 Markdown/图片 ZIP 保持兼容。
- [x] 音频路径按 Markdown entry 解析，拒绝绝对路径、反斜杠、外链、查询/片段、越界和规范化重复 entry。
- [x] 最终路径按文章 slug 隔离并用内容哈希命名；相同内容去重，没有新增数据库表或迁移。
- [x] 原始 HTML 仍由 markdown-it `html: false` 转义，音频元数据由 renderer 转义。
- [x] 文件 promotion 先于 SQLite，捕获异常执行幂等补偿；进程内 serializer 与原子 no-clobber Markdown promotion 关闭了同 slug 并发删除 winner 的审查 finding。
- [x] 删除文章后 best-effort 清理 Markdown 和专属音频目录；静态 `/audio` 不进入访问统计。

### 明确不做

- [x] 没有全站播放器、跨页续播、歌曲表、作品集、播放列表、收藏、播放统计、Service Worker 或后台导航入口。
- [x] 没有转码、波形、歌词、音频编辑、站外音频源、封面字段或 `controlsList="nodownload"`。
- [x] 没有开放 Markdown 原始 HTML、没有自定义 JavaScript 播放内核、没有新增运行依赖。
- [x] 冻结 EJS、`custom.css`、历史 baseline manifest 和 snapshots 均未修改。

### 挂载点反向核对与可卸载性

| 挂载点 | 实际落点 | 结论 |
|---|---|---|
| Markdown `:::audio` | `server/utils/markdown.js:6-9,35`、`server/article-audio/markdown.js` | 一致 |
| `POST /api/admin/upload` | `server/routes/admin.js:166-306` | 一致 |
| `/audio/{slug}/{hash}.mp3` | `server/config.js:11`、`server/article-audio/assets.js:192-233`、`server/index.js:53` | 一致 |
| 按需样式 | `server/article-audio/markdown.js:111-113`、`public/css/article-audio.css` | 一致 |

已对 `articleAudio`、`prepareArticleAudioAssets`、`publishArticle`、`/audio`、`article-audio.css` 做全仓反向 grep，生产引用均落在上述挂载点或其内部实现；其余命中为测试/README。拔除沙盘：逆向删除样式链接和 CSS、上传编排与配置、Markdown 插件及 `server/article-audio/` 后，旧 EJS、旧 Markdown 和图片发布路径仍有原入口，需同时删除本 feature 的测试和 README 说明，无额外 schema/路由残留。

## 3. 验收场景核对

本 feature 为功能性前后端改动，采用 Standard accept-inline verification，无独立 QA 报告。

| 场景 | 证据 | 结果 |
|---|---|---|
| SC-01 / SC-02 发布、哈希 URL、重复引用去重 | `npm test` 的资产与真实 HTTP ZIP 上传测试 | 通过 |
| SC-03 普通 Markdown / 图片 ZIP 兼容 | `npm test` 旧 Markdown、图片转换与正常 ZIP 回归 | 通过 |
| SC-04 块结构与稳定错误 | parser 单测 + standalone HTTP 400 | 通过 |
| SC-05 ZIP 相对路径、安全和歧义 | 表驱动路径测试 + traversal HTTP 回归 | 通过 |
| SC-06 MP3/大小边界 | 连续 MPEG frame、伪造/空/ID3/超限/声明展开量测试 | 通过 |
| SC-07 XSS 与作者态路径隔离 | renderer 单测 + raw HTML regression | 通过 |
| SC-08 GET / HEAD / Range / analytics 排除 | 真实发布后的 HTTP 200/206 与 analytics 测试 | 通过 |
| SC-09 promotion、SQLite、rollback、删除与并发 | failure-injection、rollback-failure、同 slug publication/HTTP 并发测试 | 通过 |
| SC-10 桌面/手机、焦点、播放/暂停/seek | Playwright Chromium/WebKit + 临时 2 秒可解码合成 MP3 正式上传运行验收 | 通过 |
| SC-11 单 `.md` 无资产上下文 | 真实 HTTP 400 `audio_archive_required` 与零残留断言 | 通过 |

### UI 与真实播放证据

- [x] `npm run test:article-audio-browser` 在 1440×900 Chromium 和 390×844 WebKit 验证卡片、样式、无溢出、焦点、无 autoplay 和 `preload="metadata"`。运行期截图：`test-results/ejs-visual/article-audio-browser-arti-144be--desktop-or-mobile-overflow-article-audio-desktop/article-audio-runtime.png`、`test-results/ejs-visual/article-audio-browser-arti-144be--desktop-or-mobile-overflow-article-audio-mobile/article-audio-runtime.png`。
- [x] accept-inline 临时运行验收使用 ffmpeg 生成 2 秒合成 MP3，经正式 ZIP 上传接口发布；Chromium 解码时长 2.00 秒、WebKit 2.06 秒，两者均实际播放、暂停并 seek 到 1.00 秒。临时项目、脚本和音频已清理，仓库不含真实歌曲 fixture。
- [x] review 的两个 blocking 并发 finding 已关闭；实际播放关注项已由本次运行验收关闭。

### Inline Verification Matrix

| ID | 来源 | 核心性 | 命令 / 动作 | 结果 |
|---|---|---|---|---|
| IV-01 | SC-01–SC-09、SC-11 | core | `npm test` | 105 tests：104 passed / 1 Linux-only skipped / 0 failed |
| IV-02 | SC-10 | core | `npm run test:article-audio-browser` | desktop Chromium + mobile WebKit 2/2 passed |
| IV-03 | SC-10 / REV-002 | core | 正式 ZIP 上传 + 可解码临时 MP3 + Chromium/WebKit 实际交互 | 200；audioPublished=1；两浏览器播放/暂停/seek 通过 |
| IV-04 | 冻结历史证据 | core | `npm run test:ejs-upgrade-gate` | 17 frozen + 8 assets、221 baseline、17 HTML、102 visual 全通过 |
| IV-05 | 依赖/范围 | supporting | `npm ls --depth=0` + package/schema/diff grep | exit 0；无新依赖、schema、EJS/custom.css/expected diff |

Evidence pack、DoD Results、Gate Results：Standard lane 不生成独立 goal artifacts；blocking DoD 均由上述 accept-inline 证据覆盖，无 failed / blocked 项。

## 4. 术语一致性

- `ArticleAudioBlock` / `articleAudio` 只表达受控 Markdown 块；代码、design、README 和架构文档一致。
- `ArticleAudioAsset` 对应 `prepareArticleAudioAssets` 和文章专属目录，不出现 `Song` 实体或通用媒体仓库。
- `audioPublished` 仅是本次上传成功发布的去重资产数，不是播放统计。
- 禁用概念 grep 未发现全站播放器、播放列表、转码或站外音频实现；测试中的 hostile URL 仅用于拒绝断言。

## 5. 领域影响盘点

- [x] 新术语候选：文章音频块 / 文章音频资产。结论：它们是单一文章入口的作者/实现契约，已归并到 `.codestable/architecture/ARCHITECTURE.md`，当前不提升为共享领域术语，不新增 `requirements/CONTEXT.md`。
- [x] 结构性选择候选：文章资产而非歌曲实体、文件系统 + SQLite 补偿发布。结论：已在批准 design 和当前 architecture 中记录；目前只有一个内容入口，不单独新增 ADR。
- [x] 流程约束候选：MP3-only、slug/hash URL、进程内串行 ownership。结论：属于当前文章发布管线的硬边界，已写入 architecture；若未来第二个入口复用资产或多实例写入，再进入 `cs-domain` / ADR 流程。

## 6. requirement delta / clarification 回写

- Design frontmatter 指向 `article-audio-playback` draft requirement。
- `.codestable/features/2026-07-17-article-audio-playback/approval-report.md` 已记录 owner 对 Requirement Preview、能力边界和验收后升级规则的批准；本次没有改变 pitch、用户故事或边界。
- 已机械执行：requirement `draft → current`、`implemented_by` 追加本 feature、保留原愿景并追加变更日志；`.codestable/requirements/VISION.md` 同步从 Draft 移至 Current。

## 7. roadmap 回写

Design frontmatter 没有 `roadmap` / `roadmap_item`，本 feature 非 roadmap 起头，跳过 items.yaml 和主 roadmap 回写。

## 8. attention.md 候选盘点

- 候选：`100k event fixture` 性能预算在机器繁忙时曾出现 p95 抖动，最终工作区的独立 `npm test` 与完整 gate 分别以 292.88 ms / 458.23 ms 通过 500 ms 预算。该现象属于已有 analytics 性能测试的环境敏感性，不是音频实现知识；本轮不直接写 `attention.md`，可由 owner 决定是否后续用 `cs-note` 记录“在机器空闲时复验性能门禁”。
- 候选：最终完整视觉 gate 结束后，测试 harness 曾残留一个 `node test/helpers/ejs-visual-harness.js` 进程占用 4173；按 PID/命令行确认并终止后重跑 2/2 通过，端口最终为空。可由 owner 决定是否后续用 `cs-note` 记录“Playwright 报 4173 已占用时先核对 harness 残留”。
- 作者操作指南已在 README 补齐；没有新增库公开 API 或 CLI 表面，不需要 libdoc。

## 9. 遗留

- 已知部署边界：serializer 只覆盖单 Node.js 进程；多写入实例需要跨进程协调。
- 已知补偿边界：进程在文件 promotion 后、SQLite commit 前不可恢复崩溃时仍可能留下孤儿文件；当前补偿覆盖可捕获异常。
- 加强项：可继续扩展逐项 HTTP 错误矩阵和恶意 ZIP size/CRC 内存压测，但模块/HTTP 的现有证据已覆盖设计中的稳定 code、大小边界与零残留核心契约。
- 可访问性加强项：固定 `article-audio-title-N` 理论上可能与作者标题生成的 anchor ID 重名；当前原生控件焦点与标注已通过，后续可单独 issue 评估无冲突 ID 策略。
- 未执行 Git commit、部署或上传用户的真实歌曲；博主仍需按 README 准备最终文章 ZIP。

## 10. 最终审计

- 验证证据来源：accept-inline verification；无独立 QA 报告。
- Evidence sources：design、checklist、三轮独立 code review、最终工作区、Node/HTTP/Playwright/冻结基线命令输出。
- Inline Verification Matrix：见第 3 节 IV-01–IV-05，核心性和真实运行路径均已覆盖。
- 聚合命令：
  - `npm test` → exit 0；105 tests，104 passed / 1 Linux-only skipped。
  - `npm run test:article-audio-browser` → exit 0；2/2 passed。
  - 临时可解码 MP3 正式上传与浏览器交互 → exit 0；Chromium/WebKit 播放、暂停、seek 通过。
  - `npm run test:ejs-upgrade-gate` → exit 0；17 frozen views/styles + 8 assets、221 baseline、105 Node、17 HTML、102 visual 全通过。
  - `npm ls --depth=0` → exit 0；无 package 依赖变化；本机既有 `@emnapi/runtime`、`@img/sharp-wasm32`、`tslib` extraneous 不属于本 feature。
- 最终命令恢复记录：完整 gate 后一次音频 Playwright 启动因 4173 被同一测试 harness 残留进程占用而失败；确认 `PID 13628` 的命令行为 `node test/helpers/ejs-visual-harness.js` 后仅停止该进程，再次运行 2/2 passed，最终端口为空、截图重新生成。
- 场景复核：re-verified 11 / trust-prior-verify 0。
- 交付物复核：代码、配置、静态路由、README、测试、architecture、requirement 均落盘；无 schema / roadmap 交付物。
- 完整工作区复核：已检查 tracked diff、untracked feature 文件和 git status；`.codestable/reference/*` 及 CodeStable 骨架残留是本 feature 之前/之外的 dirty scope，未改写、未纳入本 feature 结论。
- diff 清洁度：未发现临时验收脚本/音频、debugger、TODO/FIXME、注释掉的 feature 代码、新运行依赖、真实歌曲、绝对本地路径、EJS/custom.css/旧 expected 改动。
- 知识沉淀出口：当前架构边界已归并；attention 候选已登记；README 已更新；无 libdoc/ADR/CONTEXT 硬前置。
- Owner 终审：2026-07-17 收到“确认”，授权完成本轮验收收尾。
- 结论：通过。
