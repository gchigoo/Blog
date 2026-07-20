---
doc_type: feature-acceptance
feature: 2026-07-17-article-audio-multi-format
status: passed
accepted: 2026-07-17
round: 1
---

# 文章音频多格式支持验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-17
> 关联方案 doc：`.codestable/features/2026-07-17-article-audio-multi-format/article-audio-multi-format-design.md`

## 1. 接口契约核对

对照方案第 2.1 节逐项核查：

- [x] `AudioFormatDescriptor`：`server/article-audio/formats.js:931-956` 以唯一只读 `AUDIO_FORMATS` 提供 `.mp3/.aac/.m4a/.flac`、canonical MIME、单文件上限和 validator。
- [x] `ResolvedArticleAudioBlock`：`server/article-audio/assets.js:190-194` 把作者态块解析为 `/audio/{slug}/{sha256}.{extension}` 与 `mimeType`；`server/article-audio/markdown.js:107-110` 再次校验 URL 扩展名和 MIME 一致。
- [x] FLAC 示例：相对路径按 Markdown entry 解析，合法 FLAC 生成 `.flac` URL/`audio/flac`；MP3 bytes 伪装为 `.flac` 由格式 validator 返回 `audio_content_invalid`。
- [x] 格式 invariant：MP3/AAC/M4A 为 20 MiB，FLAC 为 50 MiB；四种 validator 分别落在 `server/article-audio/formats.js`。
- [x] 编排流程：作者块 → ZIP exact entry → registry → size/结构验证 → SHA-256+原扩展名 stage → typed source/文件链接 → promotion → SQLite-last → 显式 `/audio`，每个节点均有代码落点。

名词层“现状 → 变化”一致：资产不再隐含为 MP3，但仍是 Article Audio Asset，不新增歌曲或媒体领域实体；`assets.js` 继续 re-export `MAX_AUDIO_BYTES` 与 `validateMp3Buffer`，兼容旧 seam。

## 2. 行为与决策核对

### 需求摘要与明确不做

- [x] 同一个 `:::audio` 块、ZIP 上传入口和原生播放器支持 MP3、ADTS AAC、AAC-LC M4A、FLAC。
- [x] 最终路径保留真实扩展名并按 `(sha256, extension)` 去重；不跨扩展名合并。
- [x] 未新增 `.wav/.ogg/.opus/.alac/.mp4` 支持、转码、兼容副本、码率规范化、歌曲表、播放统计、全站播放器、自定义播放内核或格式字段。
- [x] `package.json` 只新增浏览器测试脚本，没有媒体 parser/decoder 运行依赖；feature scope 无 ffmpeg 调用。
- [x] 冻结 EJS、`custom.css`、历史 snapshots 与 baseline manifest 未修改。

### 关键决策与流程级约束

- [x] D1 集中 registry：assets、renderer、static MIME 均读取 `AUDIO_FORMATS`。
- [x] D2 有界结构 gate：AAC strict ID3/ADTS、M4A depth/count/descriptor/AAC-LC、FLAC metadata/header CRC 均 fail closed；不宣称全媒体解码。
- [x] D3 保留扩展名：stage、published URL 与静态响应均使用原受控扩展名。
- [x] D4 诚实降级：typed native audio 始终配套可见文件链接，浏览器矩阵记录 `played|fallback`。
- [x] D5 无媒体依赖：未增加 parser/ffmpeg 依赖。
- [x] 大小 gate 顺序与稳定 code 已由 100 MiB 上传、100 MiB 展开、20/50 MiB 资产边界测试覆盖。
- [x] 发布和删除均进入 `serializeArticlePublication`；文件资源先进入可补偿状态，SQLite 最后提交，失败逆序/ownership-aware rollback。

### 挂载点反向核对与拔除沙盘

- [x] M1 `server/article-audio/formats.js`：格式 registry/validators。
- [x] M2 `server/article-audio/assets.js` + `server/routes/admin.js`：ZIP 资产准备、stage/promotion 与发布接线。
- [x] M3 `server/article-audio/markdown.js` + `public/css/article-audio.css`：typed source、原生播放器和 fallback。
- [x] M4 `server/index.js` + `server/analytics/middleware.js`：显式 `/audio`、canonical MIME 和统计排除。
- [x] M5 `README.md`、Playwright 配置/fixture/harness/tests：作者说明和浏览器矩阵。
- [x] 反向 grep 覆盖了 `AUDIO_FORMATS`、`/audio`、`audioPublished` 和新增测试脚本，未发现清单外的生产挂载点。
- [x] 拔除沙盘：逆向移除 M5→M1，并恢复 `admin.js/index.js/analytics` 接线后，不会留下数据库 schema、环境变量、后台入口或运行依赖；仅需决定是否保留历史已发布多格式文件。

## 3. 验收场景核对

验证证据来源：accept-inline verification；无独立 QA 报告、evidence pack、gate-results 或 dod-results。

| 场景 | 可观察证据 | 结果 |
|---|---|---|
| SC-01/02 四格式发布、URL/MIME、去重 | assets/upload 集成测试真实 stage/publish 四种合成 fixture | 通过 |
| SC-03 MP3/无音频/图片兼容 | 全量 `npm test` 与冻结 EJS gate | 通过 |
| SC-04 未支持/大小写/内容错配 | formats/assets/markdown 负向表驱动测试，稳定 code 且零残留 | 通过 |
| SC-05 AAC | ID3v2.2/2.3/2.4、7/9-byte ADTS、至少两帧、字段/截断/尾部反例 | 通过 |
| SC-06 M4A | box size/depth/count、track shape、direct esds、ASC、AAC+ALAC/H264 fixture | 通过 |
| SC-07 FLAC | STREAMINFO/metadata/header/UTF-8/optional fields/CRC 反例 | 通过 |
| SC-08 20/50/100 MiB 边界 | inclusive limit 与 +1 byte 单测/HTTP 测试 | 通过 |
| SC-09 GET/HEAD/Range/416/删除 | 四格式真实 HTTP headers/bytes、analytics 排除、删除后 404 | 通过 |
| SC-10 failure/rollback/并发 | publication failure injection、同 slug 上传/删除串行测试 | 通过 |
| SC-11 浏览器矩阵 | Chromium 桌面/手机四格式均 `played`；WebKit MP3/AAC/M4A `played`、FLAC `fallback`，链接 focus + HTTP 200/canonical MIME | 通过 |
| SC-12 DOM/XSS | renderer 只接受 published URL/MIME，字段转义，raw HTML 仍禁用 | 通过 |
| SC-13 结构校验深度 | 合成损坏 payload 与浏览器 fallback 契约测试 | 通过（按 approved header-level 边界） |

浏览器 UI 已运行验证：原生控件无 autoplay，可播放/暂停/seek；桌面与手机无横向溢出并生成 runtime screenshot。WebKit layout screenshot 按测试设计跳过，但其真实播放矩阵已执行。

Review 重点已覆盖：REV-012 strict ID3 frame-level 完整性关闭；nested esds、ASC canonical padding、混合 codec/track、删除补偿、MIME/Range 均重验。第 7 轮独立复审为 `passed`，无 unresolved blocking / important。

## 4. 术语一致性

- `Article Audio Block` 仍对应 `:::audio` 作者契约；未引入自由 HTML 音频。
- `Audio Format Descriptor` 仅作为 `server/article-audio/formats.js` 内部 seam，不提升为共享媒体领域实体。
- `.aac` 明确是 ADTS AAC-LC；`.m4a` 明确是 AAC-LC ISO BMFF；`.flac` 使用 `audio/flac`。
- 禁用词/错误边界检查：生产路径无 `audio/x-flac`、`application/octet-stream`、runtime ffmpeg 或把任意 MP4 当 M4A 的分支。

## 5. 领域影响盘点（提示而非代写）

- [x] 新名词候选：Audio Format Descriptor 只服务文章音频内部 registry，architecture 已记录；当前不需要 `CONTEXT.md`。
- [x] 结构性选择候选：无新外部依赖、数据库或跨子系统接口；本次是既有文章资产内部 seam 扩展，不满足新增 ADR 的必要性。
- [x] 流程级约束候选：SQLite-last、ownership rollback 与单进程 serializer 已是既有文章音频决定，本次只扩展覆盖，不新增 ADR。

结论：无需触发 `cs-domain`；若未来 registry 被视频/附件复用，或需要多实例写入协调，再提升共享术语/ADR。

## 6. requirement delta / clarification 回写

方案 frontmatter 指向 current requirement `article-audio-playback`。本 feature 没有改变 pitch、用户故事或能力边界，只扩展内部可接受音频格式，因此按 approved design 第 4 节无需 req delta。

- [x] 保持 requirement 正文、边界、status=current 不变。
- [x] `implemented_by` 追加 `2026-07-17-article-audio-multi-format`。
- [x] 变更日志追加多格式实现记录。

## 7. roadmap 回写

Design frontmatter 没有 `roadmap` / `roadmap_item` 字段。本 feature 非 roadmap 起头，无 items.yaml 或 roadmap 主文档需要回写。

## 8. attention.md 候选盘点

本 feature 未暴露每个后续 feature 都会重复踩到的环境/工具启动规则，无需补 `attention.md`。

知识出口分流：ID3/ISO BMFF fail-closed parser 的 adversarial 经验可在需要时走 `cs-keep`；作者操作方法和格式/大小表已落入 README；没有新增公开库 API 需要 libdoc。

## 9. 遗留

- WebKit 运行时可能无法解码 FLAC，按已批准契约使用文件链接降级。
- FLAC validator 只验证 metadata 与首 frame header，不验证完整 payload/footer CRC-16/MD5。
- serializer 只覆盖单 Node.js 进程；多实例写入需要跨进程协调。
- tombstone cleanup failure 只有日志，没有启动 reaper。
- 独立复审非阻塞项：可补 ID3v2.2/v2.3 逐版本 frame 负例；WebKit fallback 可补真实点击/navigation 证据。
- 部署代理/CDN MIME/Range 与真实 Safari 需上线环境 smoke test；不构成本地实现缺口。

## 10. 最终审计

- 验证证据来源：accept-inline verification。
- Evidence sources：无独立 evidence-pack / dod-results / gate-results；design、checklist、review 与当前工作区是事实源。
- Inline Verification Matrix：SC-01–SC-13 均有 targeted unit、HTTP integration、failure injection、Playwright 或冻结 baseline 运行证据；核心路径没有只靠静态推断放行的项。
- 聚合命令：CMD-001 37/37；`npm test` 138 passed/1 Linux-only skipped；浏览器 5 passed/1 WebKit layout screenshot skipped；EJS gate 17 HTML snapshots + 102 visual；`npm ls --depth=0` exit 0；`git diff --check` exit 0。最终审计第一次 EJS gate 在无具体断言输出的 `comments-auth.test.js` 文件级瞬时失败；该文件立即单跑 8/8，通过后完整原命令复跑全绿，未修改代码或基线。
- 场景复核：re-verified 13 / trust-prior-verify 0。
- 交付物复核：registry/validators、资产生命周期、typed DOM/fallback、显式 `/audio`、README、合成 fixtures、浏览器矩阵、architecture、requirement metadata 均真实落盘；无 schema/新 env/roadmap 动作。
- 完整工作区复核：检查了 tracked diff、全部 feature untracked files 与 git status；无 staged files。`.codestable/reference/**`、`requirements/VISION.md` 和其他历史 CodeStable dirty 产物明确不属于本 feature，未混入结论。
- diff 清洁度：feature scope 无 TODO/FIXME/debugger/console.log/runtime ffmpeg/本地绝对路径；fixtures 为 11–34 KiB 确定性合成媒体，无真实歌曲；package 无新增依赖。
- 知识沉淀出口：architecture/README/requirement 已同步；attention/ADR/libdoc 无候选，parser 经验保留为可选 `cs-keep`。
- 结论：原始契约、运行证据、交付物和知识回写均满足，验收通过。
