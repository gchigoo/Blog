# 极简博客 Minimalist Blog

> 基于 Node.js + Markdown 的极简个人博客系统

## ✨ 特性

- 📝 Markdown 写作，支持 Front Matter 元数据
- 🖼️ 自动图片转 WebP，减少 25-35% 体积
- 🎵 随文章发布 MP3、AAC/M4A 或 FLAC，在正文指定位置显示原生音频作品卡片
- 🏷️ 标签分类 + 按月归档 + SQLite FTS5 全文搜索
- ✍️ 草稿、服务端预览与按原 slug 安全替换发布
- 📡 RSS、sitemap、SEO/Open Graph、上下篇与相关文章
- 🔐 JWT 认证，安全后台管理
- 💬 Google 登录评论，管理员审核后公开
- 🎨 自托管 Inter/new.css，响应式布局与代码高亮
- 💾 SQLite 轻量存储，单文件数据库
- 📊 可选的逐次访问明细、原始 IP、GeoLite2 City 地区与完整浏览器/设备上下文
- ⚡ Express 5 + 17 个生产依赖，简洁高效

## 🚀 快速开始（3 步）

```bash
# 1. 使用 Node.js 24 LTS 安装锁定依赖
npm ci

# 2. 初始化数据库（避免把密码写入 shell history）
read -rsp 'Initial admin password: ' INITIAL_ADMIN_PASSWORD; echo
export INITIAL_ADMIN_PASSWORD
npm run init-db
unset INITIAL_ADMIN_PASSWORD

# 3. 启动服务器（生产环境请把两个密钥持久化到 secret manager）
export JWT_SECRET="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
export ANALYTICS_HMAC_SECRET="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
export BLOG_PUBLIC_ORIGIN='http://localhost:3000'
# 默认仅监听 127.0.0.1；也可显式设置 BLOG_LISTEN_HOST=127.0.0.1
npm start
```

访问地址：
- 📱 前台：http://localhost:3000
- ⚙️ 后台：http://localhost:3000/admin

初始管理员用户名为 `admin`；密码仅来自初始化时的 `INITIAL_ADMIN_PASSWORD`，项目不会提供默认密码。

## 📖 使用说明

### 上传文章

1. 登录后台 → 上传文章
2. 支持两种方式：
   - **单个 .md 文件**：纯文本文章
   - **ZIP 压缩包**：包含 Markdown + 图片，也可包含文章引用的音频文件
3. 可先点“预览”；从文章列表进入“替换”时会保持原 slug、文章 ID 和评论关系

### 文章格式

```markdown
---
title: Example Post
slug: example-post
locale: en
translationKey: example-post
description: English summary
tags: [other] # replace with IDs defined in content/taxonomy.json
status: published
date: 2026-08-01
---
```

关键字段说明：

- `slug`：该语言下唯一的安全 slug（URL 标识）；中文与英文文章可以各自使用相同或不同的 slug。
- `locale`：`zh` 或 `en`；缺省按 `zh` 处理（向后兼容）。
- `translationKey`：同一篇逻辑文章跨语言共享的身份键；**双语文章必须显式提供**（见下文“双语写作与翻译发布”）。
- `tags`：必须是 `content/taxonomy.json` 中定义的稳定标签 ID（如 `nodejs`、`other`），不再是自由文本标签。
- `status: draft` 不会进入公开页面、API、搜索、RSS 或 sitemap。
- `date`：推荐使用 ISO 8601 日期；日期参与归档与按时间排序。

### 在文章中发布音乐

含音乐的文章必须使用 ZIP 上传。音频文件路径以 ZIP 中 Markdown 文件所在目录为基准，例如：

```text
ai-song-article.zip
└── posts/
    ├── article.md
    ├── images/
    │   └── cover.png
    └── audio/
        └── final.mp3
```

在 `posts/article.md` 中，把音频块放到希望出现播放器的位置：

```markdown
---
title: 一次 AI 歌曲实验
slug: ai-song-experiment
tags: [AI, 音乐]
---

# 创作过程

这里记录歌词、旋律和声音实验的过程。

![歌曲封面](./images/cover.png)

:::audio
title: Stay Until Tomorrow
artist: AI Voice Experiment
src: ./audio/final.mp3
caption: 最终混音版
:::
```

- `title`、`src` 必填，`artist`、`caption` 可选；只接受这四个字段。
- 支持小写 `.mp3`、`.aac`、`.m4a`、`.flac`；`.aac` 是连续 ADTS AAC-LC，`.m4a` 是 AAC-LC（AOT 2）容器。不接受大写扩展名、绝对路径、外部 URL、查询参数或片段。
- MP3/AAC/M4A 单文件不得超过 20 MiB，FLAC 不得超过 50 MiB；ZIP 上传文件和声明展开总量均不得超过 100 MiB。
- 服务端不会转码或生成兼容副本；浏览器无法解码时，可以使用播放器下方的“无法播放时打开音频文件”链接。
- 同一音频被多次引用时只发布一份；页面不会自动播放。
- 单独上传含 `:::audio` 块的 `.md` 会失败，因为它没有可验证的音频资产上下文。

### 🌐 双语写作与翻译发布

本站支持 `zh`（中文）与 `en`（英文）两种语言。文章按语言归档在 `articles/zh/` 与 `articles/en/`，公开页面使用 `/zh/...` 与 `/en/...` 前缀；关于页、归档、标签/分类、搜索、RSS、sitemap 与语言切换均按语言提供。

#### 发布英文版本前的人工审查清单

1. 把中文 Markdown 文件复制到英文 locale 目录/来源工作流中。
2. 逐项翻译：标题、描述、各级标题、段落、列表文本、表格行文、图片 alt 文本、音频 title/artist/caption，以及链接标签。
3. 保持 Front Matter 键、`translationKey`、标签 ID、标题层级/顺序、围栏代码语言标记与内容、图片/音频目标路径、表格列数、引用/列表嵌套，以及链接目标不变（除非目标本身存在对应的英文页面）。
4. 逐节对比中英文文档：不得遗漏主张、不得新增主张、不得改动数字/日期/名称，不得改变技术含义。
5. 预览英文文章，逐一验证链接、代码高亮、图片、音频、分类、SEO 描述与语言切换。
6. 只有经第二位人工复核确认语义保真与结构一致后，才能发布。

#### 翻译身份行为（translation identity）

- 翻译文章应始终提供共享的 `translationKey`；显式指定重复 locale 会被拒绝（409），绝不会被自动加后缀。
- `translationKey` 缺省仅为向后兼容保留：同一 locale 内发生 slug 冲突时，会分配一个带时间戳后缀的独立文章键；不带后缀的不同 locale 上传，在 slug 恰好匹配既有逻辑文章键且该语言尚无文章时，会挂接到该既有默认键。
- 本发布版本不会调用任何 LLM API，也不要求任何 API 密钥；外部 LLM 仅作为写作辅助，其输出必须通过同样的人工审查清单。
- `articles/zh/` 与 `articles/en/` 是后台发布流程写出的发布归档，不是被监听改动的源目录：翻译后的 Markdown 文件只有在“预览/上传（或替换）”写入其 SQLite 文章行与规范化分类/搜索记录后才会对外可见。

### 🏷️ 分类目录维护（Taxonomy）

`content/taxonomy.json` 是分类维护源，SQLite 规范化分类是运行时真相：

- `categories`：分类列表，每个分类有稳定的 `id`、`sortOrder` 与 `zh`/`en` 双语 `name`/`slug`。
- `tags`：每个分类下的标签，同样拥有稳定 `id`、`sortOrder`、双语 `name`/`slug` 与可选的 `legacyNames`（迁移期旧名称集合）。
- 一个标签只能属于一个分类（one-parent rule）；标签 ID 一旦发布即保持稳定，文章 Front Matter 的 `tags` 引用这些稳定 ID。

同步命令：

```bash
npm run sync-taxonomy -- --dry-run   # 只读预览：输出精确排序的计划，严格零写入
npm run sync-taxonomy                # 在维护窗口内事务性应用
```

应用前必须审查干跑计划中的 `unmappedLegacyTags`、`legacyRewires`、`markdownRewrites`、`blockedSlugChanges`、`blockedDeletions`、`conflicts` 与受影响文章数量。任何能够重接线别名的 apply 都是一次协调的 Markdown/SQLite 写入：必须停止应用写入，并使用同一时点的全新备份后执行。存在不完整操作清单或过期锁时会拒绝执行；中断后先检查操作 ID，再运行 `npm run sync-taxonomy -- --recover <operation-id>` 恢复。应用/恢复后运行 `npm run audit-localized-content`，证明 Markdown 标签 ID 与 `article_tags` 一致且 FTS 内容新鲜。

### 功能页面

- 📄 首页：最新文章列表
- 🏷️ 标签：按标签筛选
- 📅 归档：按月份归档
- 🔎 搜索：SQLite FTS5 全文检索
- 📡 RSS / sitemap / robots：订阅与搜索引擎发现
- ℹ️ 关于：内容来自 `content/zh/about.md` 与 `content/en/about.md`，无需修改模板
- 💬 评论：Google 登录后提交，后台批准、拒绝或删除
- 📊 访问统计：管理员查看聚合趋势；启用明细后可筛选每次访问并查看原始 IP、地区、浏览器版本和设备上下文

### 启用 Google 评论

评论功能默认关闭。必须一次性提供以下四个环境变量；如果只配置其中一部分，应用会拒绝启动：

```bash
export GOOGLE_CLIENT_ID='your-web-client-id.apps.googleusercontent.com'
export GOOGLE_CLIENT_SECRET='从密钥管理服务注入'
export GOOGLE_REDIRECT_URI='https://blog.cokedaily.space/auth/google/callback'
export COMMENT_SESSION_SECRET='至少 32 字节的独立随机密钥'
npm start
```

Google Cloud 中的 OAuth client 类型必须是 **Web application**，Authorized redirect URI 必须与 `GOOGLE_REDIRECT_URI` 完全一致。评论只请求 `openid profile`，本地仅保存 Google `sub` 与公开展示名称，不保存邮箱、头像或 Google token。完整配置、验收与回滚步骤见 [DEPLOY.md](./DEPLOY.md#google-登录评论配置)。

### 启用访问明细

`ANALYTICS_HMAC_SECRET` 始终必填；访问明细默认关闭。生产环境需要先由每周 systemd updater 成功安装 GeoLite2 City，再设置 `ANALYTICS_DETAILS_ENABLED=true`。启用后会记录每次成功公开 HTML 访问的原始 IP、公开 URL/来源、近似地区、原始 User-Agent、浏览器/系统/设备解析结果，以及浏览器实际提供的屏幕、时区、语言和高熵 Client Hints。后台会把 `/tag/%E5%B7%A5%E5%85%B7` 等所有合法编码路径显示为可读 Unicode，事件详情/API 仍保留原始编码值。loopback 地址始终不采集；生产主机自身的公网地址可通过 `ANALYTICS_INTERNAL_IPS` 排除。

已知爬虫也会被保留并标注，但不会计入今日活跃访客、独立 IP、真人访问量、真人热门页面或真人设备维度。所选近 N 天聚合继续按小时 bucket 统计，不表示小时以内的精确范围；如果范围内包含只有聚合指标、没有逐次明细的历史，独立 IP 会显示“至少 N 个”。当 `ANALYTICS_DETAILS_ENABLED=false` 时，逐次访问列表、单条详情 UI 和对应管理员 API 均不可用，但真人/爬虫聚合访问量仍可查看。

升级已有实例时必须先备份并运行 `npm run migrate-db`，再重启应用。开始采集爬虫后，如需回滚到不认识 `traffic_kind` 的旧应用代码，必须恢复发布前数据库备份，或先部署显式过滤 `traffic_kind` 的兼容补丁。匿名访客 HMAC 在发布时从 UTC 日期切换为北京时间日期；切换影响最多一个北京时间自然日，不会回填或重算历史 HMAC。

完整的首次安装、每周日 03:30 更新、原子回滚、保留周期和排障步骤见 [DEPLOY.md](./DEPLOY.md#访问明细与-geolite2-city)。

## 📁 项目结构

```
blog/
├── server/           # 后端代码
│   ├── routes/       # API、SSR 页面与后台路由
│   ├── services/     # 文章查询与发现服务
│   ├── comments/     # Google 身份、评论会话、存储与审核
│   ├── analytics/    # 聚合/明细采集、查询、GeoIP 与设备上下文
│   ├── article-audio/# 文章音频解析、校验与发布
│   ├── articles/     # 文章 schema 与搜索索引
│   ├── taxonomy/     # 分类目录加载与同步
│   ├── i18n/         # 语言、文案与请求 locale
│   ├── operations/   # 分类同步/内容迁移操作日志
│   ├── utils/        # Markdown/图片/路径工具
│   ├── middleware/   # JWT 认证
│   └── migrations.js # 版本化、可重复执行的数据库迁移
├── deploy/           # Nginx 与 systemd 生产配置
├── scripts/          # 运维、备份与 GeoIP 校验/更新脚本
├── views/            # EJS 模板
├── public/           # 自托管 CSS、字体、脚本与图片
├── content/          # 关于页、taxonomy 与发布清单
├── articles/         # 按 zh/en 归档的 Markdown
└── blog.db           # SQLite 数据库（本地生成，不入库）
```

## 🛠️ 开发

```bash
# 开发模式（自动重启）
npm run dev

# 重新初始化数据库
read -rsp 'Initial admin password: ' INITIAL_ADMIN_PASSWORD; echo
export INITIAL_ADMIN_PASSWORD
npm run init-db
unset INITIAL_ADMIN_PASSWORD

# 对已有数据库显式执行幂等迁移
npm run migrate-db

# 质量门禁
npm run typecheck
npm run lint
npm test
```

## 🌐 生产部署

详见 [DEPLOY.md](./DEPLOY.md) - 包含：
- PM2 进程管理
- Nginx 反向代理
- HTTPS 证书配置
- GeoLite2 City 每周更新与访问明细配置
- 备份与维护

## 📦 核心依赖

| 包名 | 用途 |
|------|------|
| express 5.2 | Web 框架 |
| markdown-it 14.3 | Markdown 解析 |
| sharp 0.35 | 图片转 WebP |
| better-sqlite3 12.11 | SQLite 数据库 |
| bcrypt 6.0 | 密码加密 |
| google-auth-library 10.9 | Google OAuth code exchange 与 ID token 验证 |
| @maxmind/geoip2-node 7.1 | 本地 GeoLite2 City 查询 |
| bowser 2.14 | 浏览器、系统与设备解析 |
| highlight.js 11.11 | 服务端代码高亮 |

完整清单：[依赖说明](./DEPLOY.md#依赖说明)

## ⚡ 技术栈

- **后端**: Node.js + Express 5
- **模板**: EJS
- **数据库**: SQLite (better-sqlite3)
- **样式**: new.css (classless)
- **图片**: Sharp (WebP 转换)
- **认证**: 管理员 JWT + 独立 Google 评论会话

## 📄 License

MIT

---

**Powered by Gchigoo Minimalist Blog** | [GitHub](https://github.com/gchigoo)
