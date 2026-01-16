# 极简博客 Minimalist Blog

> 基于 Node.js + Markdown 的极简个人博客系统

## ✨ 特性

- 📝 Markdown 写作，支持 Front Matter 元数据
- 🖼️ 自动图片转 WebP，减少 25-35% 体积
- 🏷️ 标签分类 + 按月归档
- 🔐 JWT 认证，安全后台管理
- 🎨 极简 new.css 风格，响应式布局
- 💾 SQLite 轻量存储，单文件数据库
- ⚡ Express 5 + 14 个依赖，简洁高效

## 🚀 快速开始（3 步）

```bash
# 1. 安装依赖
npm install

# 2. 初始化数据库（创建管理员: admin/admin123）
npm run init-db

# 3. 启动服务器
npm start
```

访问地址：
- 📱 前台：http://localhost:3000
- ⚙️ 后台：http://localhost:3000/admin

**⚠️ 首次登录后请立即修改密码！**

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

## 📁 项目结构

```
blog/
├── server/           # 后端代码
│   ├── routes/       # 路由 (首页/文章/后台)
│   ├── utils/        # 工具 (Markdown/图片处理)
│   └── middleware/   # 中间件 (JWT 认证)
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
npm run init-db
```

## 🌐 生产部署

详见 [DEPLOY.md](./DEPLOY.md) - 包含：
- PM2 进程管理
- Nginx 反向代理
- HTTPS 证书配置
- 备份与维护

## 📦 核心依赖

| 包名 | 用途 |
|------|------|
| express 5.0 | Web 框架 |
| markdown-it 14.1 | Markdown 解析 |
| sharp 0.33 | 图片转 WebP |
| better-sqlite3 11.8 | SQLite 数据库 |
| bcrypt 6.0 | 密码加密 |

完整清单：[依赖说明](./DEPLOY.md#依赖说明)

## ⚡ 技术栈

- **后端**: Node.js + Express 5
- **模板**: EJS
- **数据库**: SQLite (better-sqlite3)
- **样式**: new.css (classless)
- **图片**: Sharp (WebP 转换)
- **认证**: JWT + bcrypt

## 📄 License

MIT

---

**Powered by Gchigoo Minimalist Blog** | [GitHub](https://github.com/gchigoo)
