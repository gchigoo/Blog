---
doc_type: feature-ff-note
feature: display-publish-time
date: 2026-07-15
requirement:
tags: [blog, articles, timezone]
---

## 做了什么
文章详情页现在显示精确发布时间，并固定按北京时间渲染，和历史公众号截图的时间一致。

## 改了哪些
- `views/article.ejs:10` — 日期展示改为 Asia/Shanghai 的年月日与 24 小时时分。

## 怎么验证的
运行 `npm test`，17 个测试全部通过；以 2021-04-07T05:42:00.000Z 验证渲染为 `2021年4月7日 13:42`。
