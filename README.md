# 极简博客 Minimalist Blog

> 基于 Node.js + Markdown 的极简个人博客系统

## ✨ 特性

- 📝 Markdown 写作，支持 Front Matter 元数据
- 🖼️ 自动图片转 WebP，减少 25-35% 体积
- 🏷️ 标签分类 + 按月归档
- 🔐 JWT 认证，安全后台管理
- 💬 Google 登录评论，管理员审核后公开
- 🎨 极简 new.css 风格，响应式布局
- 💾 SQLite 轻量存储，单文件数据库
- 📊 可选的逐次访问明细、原始 IP、GeoLite2 City 地区与完整浏览器/设备上下文
- ⚡ Express 5 + 16 个生产依赖，简洁高效

## 🚀 快速开始（3 步）

```bash
# 1. 使用 Node.js 24 LTS 安装锁定依赖
npm ci

# 2. 初始化数据库（避免把密码写入 shell history）
read -rsp 'Initial admin password: ' INITIAL_ADMIN_PASSWORD; echo
export INITIAL_ADMIN_PASSWORD
npm run init-db
unset INITIAL_ADMIN_PASSWORD

# 3. 启动服务器
export ANALYTICS_HMAC_SECRET="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
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
   - **ZIP 压缩包**：包含 Markdown + 图片

### 文章格式

```markdown
---
title: 我的第一篇文章
tags: [技术, 教程]
date: 2026-01-16
---

# 标题

正文内容，支持 Markdown 语法...

![图片](./images/pic.jpg)
```

### 功能页面

- 📄 首页：最新文章列表
- 🏷️ 标签：按标签筛选
- 📅 归档：按月份归档
- ℹ️ 关于：个人信息
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

`ANALYTICS_HMAC_SECRET` 始终必填；访问明细默认关闭。生产环境需要先由每周 systemd updater 成功安装 GeoLite2 City，再设置 `ANALYTICS_DETAILS_ENABLED=true`。启用后会记录每次成功公开 HTML 访问的原始 IP、公开 URL/来源、近似地区、原始 User-Agent、浏览器/系统/设备解析结果，以及浏览器实际提供的屏幕、时区、语言和高熵 Client Hints。后台会把 `/tag/%E5%B7%A5%E5%85%B7` 等所有合法编码路径显示为可读 Unicode，同时保留原始编码值。

完整的首次安装、每周日 03:30 更新、原子回滚、保留周期和排障步骤见 [DEPLOY.md](./DEPLOY.md#访问明细与-geolite2-city)。

## 📁 项目结构

```
blog/
├── server/           # 后端代码
│   ├── routes/       # 路由 (首页/文章/后台)
│   ├── comments/     # Google 身份、评论会话、存储与审核
│   ├── analytics/    # 聚合/明细采集、查询、GeoIP 与设备上下文
│   ├── utils/        # 工具 (Markdown/图片处理)
│   └── middleware/   # 中间件 (JWT 认证)
├── deploy/           # Nginx 与 systemd 生产配置
├── scripts/          # 运维、备份与 GeoIP 校验/更新脚本
├── views/            # EJS 模板
├── public/           # 静态资源 (CSS/图片)
├── articles/         # Markdown 原文
└── blog.db           # SQLite 数据库
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
