---
doc_type: issue-fix
issue: windows-image-paths
date: 2026-07-16
severity: medium
tags: [blog, upload, images, markdown]
---

## 问题与根因
`9102` 文章的两张本地图片在 HTML 中仍是 markdown-it 编码后的 Windows `C:%5C...` 路径；图片已转换并存在于 `/images/`，但 `replaceHtmlImagePaths` 只匹配未编码源路径，导致替换失败。

## 修复
- `server/utils/markdown.js` 同时匹配原始路径与 `encodeURI()` 后的渲染路径。
- 为既有文章定点修复两条 HTML 图片地址；未改动正文或其他文章。

## 验证
`npm test`：18/18 通过；线上两张 WebP 都返回 HTTP 200，浏览器确认均加载完成（525×45、702×58），且数据库中不再有旧 Windows 图片地址。

## 回滚
生产数据库与旧 Markdown 工具已备份到 `/root/blog-image-repair-20260716-010217/`。
