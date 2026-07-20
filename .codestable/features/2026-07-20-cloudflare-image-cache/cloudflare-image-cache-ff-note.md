---
doc_type: feature-ff-note
feature: cloudflare-image-cache
date: 2026-07-20
requirement:
tags: [cloudflare, cache, images]
---

## 做了什么
保留现有 VPS 图片存储与 `/images/*` URL，通过 Cloudflare Cache Rule 在边缘缓存博客图片，不引入 R2 或付费图片服务。

## 改了哪些
- Cloudflare `cokedaily.space` — 部署 `Cache blog images at Cloudflare edge`，仅匹配 `blog.cokedaily.space/images/*` 并允许缓存；Edge TTL 遵循源站 `Cache-Control`，缺失时使用 Cloudflare 的响应状态码默认 TTL；Tiered Cache 保持 Active。
- `DEPLOY.md` — 记录生产规则、hostname/路径边界、可重复执行的强断言烟测和回滚方式。

## 怎么验证的
Cloudflare 控制台显示规则为 `1 active`，表达式为 `(http.host eq "blog.cokedaily.space" and http.request.uri.path wildcard r"/images/*")`，Edge TTL 已选择“有源站缓存头则遵循，否则按响应状态使用默认 TTL”。真实 WebP 带新查询参数后依次返回 `200 image/webp + MISS`、`200 image/webp + HIT`、`HIT`（Age 从 2 增至 5），并保持 `Cache-Control: public, max-age=2592000`。随机缺失 WebP 返回 `404` 且没有 1 年覆盖值；首页仍返回 `Cache-Control: private, no-store` 与 `cf-cache-status: DYNAMIC`。
