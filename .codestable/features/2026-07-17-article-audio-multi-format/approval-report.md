---
doc_type: approval-report
unit: 2026-07-17-article-audio-multi-format
status: approved
reason: design-owner-confirmation
created_at: 2026-07-17
---

# Approval Report

## Decision History

- 2026-07-17：owner 确认希望文章音频支持 AAC、MP3、FLAC，并把 AAC 的主流 MP4 容器 `.m4a` 纳入范围。
- 2026-07-17：design/checklist 完成三轮独立审查；M4A 首版范围按真实浏览器证据收紧为 AAC-LC AOT 2，最终 verdict 为 passed。
- 2026-07-17：owner 整体批准完整 design，授权进入 Standard implementation。

## Decision Needed

完整 design 已获整体批准，授权按 S1-S9 进入 Standard implementation。

## Why Now

设计已经把格式边界、容器校验、大小、资源峰值、MIME/Range、发布补偿、浏览器真实播放与 fallback 写成可执行契约，并通过独立 design review。根据 Standard lane gate，实施前必须由 owner 整体确认。

## Context

- 支持：`.mp3`、ADTS AAC `.aac`、AAC-LC `.m4a`、`.flac`，只接受小写扩展名。
- 不支持：HE-AAC/HE-AACv2 M4A、ALAC、MP3-in-MP4、`.mp4/.wav/.ogg/.opus`。
- 大小：MP3/AAC/M4A 20 MiB，FLAC 50 MiB；ZIP compressed/expanded 100 MiB。
- 运行方式：不转码、不生成兼容副本；使用原生 `<audio>`、typed `<source>` 和始终可见文件链接。
- 校验深度：结构校验，不保证整段 payload 可解码。
- 浏览器：每格先真实播放；仅 WebKit+FLAC 实际失败时允许 fallback。

## Review Evidence

- Design: `article-audio-multi-format-design.md`（status: approved）
- Checklist: `article-audio-multi-format-checklist.yaml`（9 steps / 15 checks，YAML validated，全部 pending）
- Independent review: `article-audio-multi-format-design-review.md`（status: passed，round: 3）
- Local browser spike: Chromium 实播 MP3/AAC/M4A/FLAC；WebKit 实播 MP3/AAC/M4A，当前构建的 FLAC 未进入 metadata-ready

## Options

1. **批准（已选择）**：design 标为 `approved`，进入 Standard implementation。
2. **修改后批准**：指出需要调整的格式、profile、大小、校验深度或 fallback 契约，修订后按风险复审。
3. **暂不实现**：保留 draft design/checklist，不修改代码。

## Recommendation

选择“批准”。四格式目标已保留，同时把 M4A profile 收紧到有实际浏览器证据的 AAC-LC，避免服务器接受但核心播放矩阵漏测。

## Risks And Tradeoffs

- HE-AAC/HE-AACv2 M4A 会被拒绝；未来扩展前必须补 parser 与浏览器实播矩阵。
- 无转码意味着特定浏览器缺少 codec 时无法由服务器自动生成 MP3 fallback。
- 结构校验不能发现所有 payload 损坏，真实播放和文件链接是第二层证据/降级。
- FLAC 与 100 MiB ZIP 提高内存压力；实现必须逐 entry stage 并及时释放 Buffer。

## Non-Automatic Actions

批准后只进入本地实现；不会自动提交 Git、部署博客、上传真实歌曲、安装运行时 ffmpeg 或修改冻结 EJS/custom.css/snapshots。

## After You Answer

按 S1-S9 实现，随后执行独立 code review 与 accept-inline；若实现途中需要改变契约，则返回 design gate 重新确认。
