---
doc_type: architecture
status: current
last_reviewed: 2026-07-17
---

# Blog 架构总入口

## 1. 项目简介

Blog 是一个由 Node.js / Express 提供页面、管理接口和静态资源的 Markdown 博客。文章正文在服务端解析并保存为 HTML；公开页面从 SQLite 读取文章，静态文件统一由 `public/` 提供。（证据：`server/index.js:10`、`server/index.js:76`）

文章发布管线支持单独 Markdown，或包含一份 Markdown、可选图片和可选文章专属音频的 ZIP。管理员仍通过 `POST /api/admin/upload` 上传；音频能力没有独立后台入口、数据库实体或媒体服务。（证据：`server/routes/admin.js:172`、`server/routes/admin.js:180`、`server/routes/admin.js:200`）

## 2. 核心概念 / 术语表

| 术语 | 当前含义 | 代码锚点 |
|---|---|---|
| 文章音频块（Article Audio Block） | Markdown 中受控的 `:::audio` 作者契约，只接受 `title`、`artist`、`src`、`caption`；它不是任意 HTML 扩展。 | `server/article-audio/markdown.js:4`、`server/article-audio/markdown.js:6`、`server/article-audio/markdown.js:74` |
| 音频格式描述（Audio Format Descriptor） | 由 `.mp3`、`.aac`、`.m4a`、`.flac` 的扩展名、canonical MIME、单文件上限和结构 validator 组成的唯一只读 registry。 | `server/article-audio/formats.js:931`、`server/article-audio/formats.js:934`、`server/article-audio/formats.js:959` |
| 文章音频资产（Article Audio Asset） | 被音频块引用、随 ZIP 上传并归属于单篇文章的文件；发布时按 `(SHA-256, extension)` 命名，不跨扩展名合并。 | `server/article-audio/assets.js:85`、`server/article-audio/assets.js:161`、`server/article-audio/assets.js:167` |
| 发布音频路径 | `/audio/{article-slug}/{64-hex-sha256}.{mp3|aac|m4a|flac}` 形式的公开只读路径；作者态相对路径不会直接进入最终 HTML。 | `server/article-audio/markdown.js:7`、`server/article-audio/assets.js:190`、`server/index.js:15` |

## 3. 子系统 / 模块索引

### 3.1 Markdown 解析与安全渲染

- `server/utils/markdown.js` 安装文章音频 Markdown 扩展，同时保持 markdown-it 原始 HTML 禁用；解析阶段收集作者态块，渲染阶段只消费已经解析到发布路径的资产。
- `server/article-audio/markdown.js` 校验块结构和字段，只接受 registry 中的发布扩展名和匹配 MIME，输出固定、转义后的 `<figure>`、带 `type` 的 `<source>`、无 autoplay 的原生控件和始终可见文件入口。（证据：`server/article-audio/markdown.js:100`、`server/article-audio/markdown.js:107`、`server/article-audio/markdown.js:132`、`server/article-audio/markdown.js:136`）

### 3.2 ZIP 与多格式音频资产

- `server/article-audio/formats.js` 是格式事实源：MP3/AAC/M4A 上限 20 MiB，FLAC 上限 50 MiB；MP3 按连续 MPEG frame、AAC 按 strict ID3v2 后连续 AAC-LC ADTS frame、M4A 按有界 ISO BMFF/AAC-LC 结构、FLAC 按 STREAMINFO/metadata/首 frame-header CRC-8 校验。（证据：`server/article-audio/formats.js:3`、`server/article-audio/formats.js:4`、`server/article-audio/formats.js:209`、`server/article-audio/formats.js:709`、`server/article-audio/formats.js:893`）
- `server/article-audio/assets.js` 负责 ZIP entry 索引、相对 Markdown entry 的安全路径解析、100 MiB 声明展开总量、registry 分派、逐 entry stage、hash 去重、promotion 和 ownership-aware rollback。（证据：`server/article-audio/assets.js:33`、`server/article-audio/assets.js:57`、`server/article-audio/assets.js:124`、`server/article-audio/assets.js:209`）
- 音频最终落在 `public/audio/{article-slug}/`；配置只记录该根目录，不新增数据库表或迁移。（证据：`server/config.js:11`、`server/article-audio/assets.js:202`）

### 3.3 文章发布与删除生命周期

- `server/routes/admin.js` 在同一个进程内串行完成 slug 选择、音频准备、图片处理、HTML 渲染和发布；成功响应以 `audioPublished` 返回实际发布的唯一音频数。（证据：`server/routes/admin.js:200`、`server/routes/admin.js:211`、`server/routes/admin.js:254`、`server/routes/admin.js:290`）
- `server/article-audio/publication.js` 先发布 Markdown 和音频，最后提交 SQLite；异常时只补偿本次拥有的资源，补偿失败返回稳定脱敏错误。（证据：`server/article-audio/publication.js:110`、`server/article-audio/publication.js:127`、`server/article-audio/publication.js:131`、`server/article-audio/publication.js:133`）
- 删除也进入同一 serializer：先把 Markdown 与音频目录移动到固定长度 tombstone，数据库最后提交；失败逆序恢复，提交后再清理 tombstone。（证据：`server/routes/admin.js:375`、`server/article-audio/publication.js:48`、`server/article-audio/publication.js:77`、`server/article-audio/publication.js:84`、`server/article-audio/publication.js:101`）

### 3.4 显式 `/audio` 静态命名空间

- `server/index.js` 在通用 `public/` 静态服务前挂载 `/audio`，只允许安全 slug、64 位 hash 和 registry 扩展名，并按 registry 固定 `audio/mpeg`、`audio/aac`、`audio/mp4`、`audio/flac`。Express static 承接 GET、HEAD、Range 与 416 语义。（证据：`server/index.js:15`、`server/index.js:20`、`server/index.js:68`、`server/index.js:76`）
- `/audio` 不进入公开访问统计。（证据：`server/analytics/middleware.js:6`）

## 4. 关键架构决定

1. **音频是文章资产，不是歌曲领域实体。** 当前没有歌曲表、播放列表、独立音频 API 或音乐子系统；音频随文章发布和删除。（证据：`server/config.js:11`、`server/routes/admin.js:211`、`server/routes/admin.js:380`）
2. **格式 registry 是单一事实源。** validator、资产上限、renderer MIME 和静态 Content-Type 都从 `AUDIO_FORMATS` 读取；新增格式不能只改一个分支。（证据：`server/article-audio/formats.js:931`、`server/article-audio/assets.js:7`、`server/article-audio/markdown.js:2`、`server/index.js:7`）
3. **作者契约与发布路径分离。** `src` 只能在 ZIP 内按 Markdown entry 目录解析；最终 HTML 只接受固定 slug/hash/扩展名 URL 和匹配 MIME。（证据：`server/article-audio/assets.js:57`、`server/article-audio/assets.js:190`、`server/article-audio/markdown.js:107`）
4. **播放器交互委托给浏览器原生控件。** 服务端不转码、不自动播放、不维护播放状态；浏览器不能解码时由显式文件链接降级。（证据：`server/article-audio/markdown.js:132`、`server/article-audio/markdown.js:136`、`public/css/article-audio.css:1`）
5. **文件系统与 SQLite 使用可补偿、数据库最后提交协议。** 发布和删除都在进程内 serializer 中执行；资源先进入可回滚状态，SQLite 最后提交。（证据：`server/article-audio/publication.js:8`、`server/article-audio/publication.js:10`、`server/article-audio/publication.js:84`、`server/article-audio/publication.js:131`）

## 5. 已知约束 / 硬边界

- 只接受小写 `.mp3`、`.aac`、`.m4a`、`.flac`；MP3/AAC/M4A 单文件最多 20 MiB，FLAC 最多 50 MiB，压缩上传与 ZIP 声明展开总量最多 100 MiB；服务端不转码。（证据：`server/article-audio/assets.js:85`、`server/article-audio/formats.js:931`、`server/routes/admin.js:34`、`server/article-audio/assets.js:9`）
- M4A 只接受 AAC-LC；FLAC 是 metadata 与首 frame-header 的结构校验，不验证完整 payload、footer CRC-16 或 STREAMINFO MD5。
- 含音频块的文章必须用 ZIP 上传；单独 `.md` 没有资产上下文时返回 `audio_archive_required`。（证据：`server/routes/admin.js:183`、`server/article-audio/markdown.js:104`）
- 发布串行化只覆盖当前单 Node.js 进程；多写入实例需要数据库锁或分布式协调。（证据：`server/article-audio/publication.js:8`、`server/article-audio/publication.js:10`）
- 删除成功后 tombstone 清理失败只记录 cleanup debt，没有启动 reaper；运维需监控 `.deleting-*`。（证据：`server/article-audio/publication.js:101`、`server/routes/admin.js:399`）
- 浏览器 codec 能力取决于运行时；当前自动化允许 WebKit 的 FLAC 播放失败后使用文件入口，其余格式必须实播。

## 6. 变更日志

- 2026-07-17：文章音频扩展为 MP3、ADTS AAC、AAC-LC M4A 和 FLAC；同步格式 registry、typed source、显式 `/audio` MIME/Range、大小边界与发布/删除补偿语义。
- 2026-07-17：同步文章内音频播放的首版发布、渲染、静态读取和删除生命周期。
