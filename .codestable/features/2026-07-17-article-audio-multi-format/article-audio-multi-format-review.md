---
doc_type: feature-review
feature: 2026-07-17-article-audio-multi-format
status: passed
reviewer: subagent
reviewed: 2026-07-17
round: 7
---

# article-audio-multi-format 代码审查报告

## 1. Scope And Inputs

- Design: `.codestable/features/2026-07-17-article-audio-multi-format/article-audio-multi-format-design.md`
- Checklist: `.codestable/features/2026-07-17-article-audio-multi-format/article-audio-multi-format-checklist.yaml`
- Evidence pack / gate / DoD results: none（Standard lane accept-inline）
- Implementation evidence: CMD-001 37/37；`npm test` 138 passed/1 skipped；浏览器 5 passed/1 skipped；EJS gate 的 17 HTML snapshots 与 102 visual 全绿；`npm ls --depth=0` 和 `git diff --check` exit 0
- Diff basis: 当前 `git status --short`、tracked diff 和全部 article-audio 未跟踪实现/测试
- Review mode: full-rereview
- Baseline dirty files: `.codestable/reference/**`、`VISION.md` 与其他历史 CodeStable 产物不归入本 feature finding

### Independent Review

- Detection: 原生 Codex Task agent 可用；`ocr` CLI 已安装但未配置 LLM endpoint
- 环节 A 独立隔离 Task agent: native-agent + completed
- 环节 B OCR CLI: failed (`no valid LLM endpoint configured`)
- OCR severity mapping: High→blocking/important, Medium→nit/suggestion, Low→discarded
- Merge policy: Task agent 结果已由主 agent按 design、源码、测试与可复现路径逐条核验后合并
- Gate effect: 无 blocking / important；允许进入 acceptance

## 2. Diff Summary

- 新增：`server/article-audio/**`、`public/css/article-audio.css`、`test/article-audio-*.test.js`、合成音频 fixtures、浏览器测试
- 修改：上传/删除路由、Markdown renderer、显式 `/audio`、analytics 排除、配置、测试 harness、Playwright、README
- 删除：none
- 未跟踪 / staged：article-audio 新文件未跟踪；无 staged diff
- 风险热点：不可信 ISO BMFF 解析、ZIP/文件系统边界、SQLite-last 发布/删除补偿、同 slug 并发、浏览器 codec 降级

## 3. Adversarial Pass

- 假设的生产 bug：AAC strict ID3 的版本分支可能错误接受 header-only、padding-only、截断/越界/零数据 frame，或让 v2.4 footer+padding 绕过
- 主动攻击过的反例：ID3v2.2/2.3/2.4 最小合法 frame、padding、坏 ID、零长度、越界、footer+padding，以及 MP3 lax ID3 兼容路径
- 结果：REV-012 已关闭；M4A、发布/删除、静态 MIME/Range 的既有 fail-closed 边界未回退

## 4. Findings

### blocking

none

### important

none

### nit

- [ ] REV-013 `test/article-audio-formats.test.js:339-351` ID3 负向测试对坏 frame ID、零长度、越界 size 和 flags 的逐版本覆盖仍偏重 v2.4
  - Impact: 当前实现正确且独立构造矩阵通过；未来修改 v2.2 24-bit size 或 v2.3 32-bit size/flags 分支时，回归定位不够直接
  - Follow-up: 可补 v2.2/v2.3 表驱动负例，不阻塞本 feature

### suggestion

- [ ] REV-005 `test/visual/article-audio-browser.spec.js:161-166` WebKit FLAC fallback 可在失败分支执行真实点击并等待 download/navigation；当前 focus + 独立 HTTP 200/MIME 已证明基础降级入口，本轮不阻塞

### learning

- ISO BMFF 的结构预算与 codec 语义必须共享 fail-closed 边界；“存在一个合法音轨”不等于“整个容器是允许发布的 AAC-LC M4A”。

### praise

- 同一音频 `stsd` 已收紧为全量 AAC-LC `mp4a`；AAC+ALAC/MP3-in-MP4 不再因首个合法 entry 绕过。
- rename 伪 `ENOENT` 通过 `lstat(source)` 区分，固定长度 UUID tombstone 消除了长 slug component 溢出。
- 删除保持资源先隔离、DB-last、失败逆序补偿；生产上传测试复用真实合成四格式 fixtures。

## 5. Test And QA Focus

- QA 已复核：ID3v2.2/2.3/v2.4 最小真实 frame、header-only/padding-only/截断/越界/zero-data/footer+padding；并保留 nested esds、ASC padding、混合 track、删除回归
- Evidence pack residual risks / gate warnings：OCR endpoint 缺失；Linux-only updater skip 与本 feature 无关
- 建议新增或加强的测试：REV-013 的 v2.2/v2.3 逐版本 frame 负例；REV-005 的真实 fallback 点击
- 不能靠 review 完全确认的点：部署代理/CDN MIME/Range；真实 Safari codec；多实例互斥

## 6. Residual Risk

- tombstone cleanup debt 只有日志、无启动 reaper；上线后需监控 `.deleting-*`。
- serializer 是单进程锁；多进程/多副本需要数据库锁或分布式协调。
- FLAC 是 header-level 校验，不验证完整 payload/footer/MD5；这是 approved design 边界。

## 7. Verdict

- Status: passed
- Next: 进入 `cs-feat` accept-inline verification / acceptance

## 8. Focused Closure（无则写 none）

none

## 9. Full Re-review History

- Round 1：REV-001 M4A `udta/meta` count/depth 绕过、REV-002 删除时序、REV-003/004 生产 fixture/测试命名。
- Round 2：REV-001/002/003/004 已关闭；新增 AAC+ALAC/unsupported entry 盲区和长 slug/伪 ENOENT 阻塞。
- Round 3：AAC+ALAC/MP3 与 unsupported entry count/depth、长 slug/伪 ENOENT 均由 RED→GREEN 关闭；新发现 REV-006 AAC+非音频 track 绕过。
- Round 4：REV-006 由真实 AAC+H.264 及 track-shape RED→GREEN 关闭；新发现 REV-007 ASC/descriptor 歧义与 REV-008 strict ID3 header 缺口。
- Round 5：REV-007/008 由 bit reader、descriptor 唯一性和 strict ID3 RED→GREEN 关闭；新发现 REV-009 nested esds、REV-010 structural flags、REV-011 padding/CPU。
- Round 6：REV-009/010/011 由 codec-container fail-closed、structural flag 拒绝与 O(1) canonical padding RED→GREEN 关闭；无 blocking，新发现 REV-012 ID3 frame-level 完整性 important。
- Round 7：REV-012 由 v2.2/v2.3/v2.4 frame parser 与 RED→GREEN 负例关闭；独立复核无 blocking / important，REV-013 与 REV-005 均为非阻塞强化项，verdict passed。
