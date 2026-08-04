# 现有文章英文翻译与生产发布设计

日期：2026-08-04

## 1. 目标

为生产环境当前存在的 4 篇中文文章创建完整英文版本，并安全发布到 `https://blog.cokedaily.space/en/...`。

发布完成后，每个逻辑 post 都必须同时拥有一个已发布的中文 article 和一个已发布的英文 article。两种语言通过同一 `translationKey` 关联，但使用各自可读的 slug。英文首页、归档、搜索、标签、RSS、sitemap、canonical、`hreflang` 和语言切换都必须只使用真实英文内容，不允许回退显示中文正文。

本次同时把现有文章引用的 18 个 legacy 标签升级为配置管理的双语稳定标签，使中文原文和英文译文共享相同标签 ID。

## 2. 已确认的产品决策

- 翻译范围：生产环境全部 4 篇中文文章。
- 翻译方式：自然英文，保留原文语气、幽默、第一人称和结构。
- 历史内容：完全忠实翻译，不新增时效提示，不更新旧版本、链接、参数或结论。
- 英文 URL：使用自然、可读的英文 slug。
- 分类标签：全部 18 个 legacy 标签升级为有中英文标签的稳定配置 taxonomy。
- 媒体：复用现有 `/images/*.webp`；不复制、不改名、不重新编码图片。
- 发布方式：复用现有 taxonomy sync 和受保护的文章发布链路，不直接编辑生产 SQLite。
- 发布安全：生产维护窗口、一致性备份、候选审计、失败回滚和独立安全/发布审查。

## 3. 非目标

- 不修改中文文章正文内容；仅允许 taxonomy sync 重写 front matter 中的标签 ID。
- 不更新 2019 年文章中的软件版本、服务政策、下载链接、充电协议或产品状态。
- 不新增图片、音频或其他媒体。
- 不引入运行时翻译服务、LLM 调用或第三方翻译 API。
- 不改变双语路由、评论隔离、OAuth、Analytics 或 Cloudflare 缓存架构。
- 不把 `articles/*` 改成 Git 跟踪内容；继续遵循现有生产内容存储模型。

## 4. 源文章清单与英文身份

| translationKey | 中文标题 | 英文标题 | 英文 slug |
|---|---|---|---|
| `9102` | 9102年的你还在用五福一安？ | It’s 2019—Are You Still Using Apple’s 5V/1A Charger? | `understanding-fast-charging` |
| `baiduyun-speed-limit` | 被网盘限速？是你的使用姿势不对哦！ | Baidu Netdisk Throttling You? You May Be Downloading the Wrong Way! | `baidu-netdisk-speed-limit-guide` |
| `apps-in-my-iphone-1784032269347` | Apps in my iPhone | Apps on My iPhone | `my-essential-iphone-apps` |
| `home-assistant-nuc9-to-mac-mini-homekit` | 我把 Home Assistant 从 NUC9 迁到 Mac mini，结果被 HomeKit 上了一课 | I Moved Home Assistant from a NUC9 to a Mac mini—and HomeKit Taught Me a Lesson | `migrating-home-assistant-from-nuc9-to-mac-mini` |

每篇英文 Markdown 必须显式包含：

- `locale: en`
- 与中文 sibling 完全相同的 `translationKey`
- 表中指定的英文 slug 和标题
- 与中文原文完全相同的 ISO `date`
- `status: published`
- 迁移后的稳定标签 ID

`description` 使用对应英文正文的简洁摘要，不引入原文之外的新事实。

## 5. 翻译规则

### 5.1 必须翻译

- 标题、章节标题、段落、引用、列表和表格表头。
- 图片 alt 文本。
- 面向读者显示的安装说明、操作步骤和说明文字。
- 原文中的网络梗和口语表达，以自然英语表达相同含义。例如“五福一安”解释为 Apple 长期附送的 5V/1A 充电器，而不是机械音译。

### 5.2 必须保持不变

- `translationKey`、日期、发布状态和技术事实范围。
- 图片路径及其出现顺序。
- 外部链接 URL。
- 代码块、User-Agent 字符串、端口、协议名、产品名、版本号、功率、电压和电流数值。
- Markdown 的章节层级、表格结构、引用结构和主要段落顺序。

### 5.3 禁止的翻译变化

- 不删除原文中过时、主观或可能失效的步骤。
- 不增加“历史说明”、事实核查结论或 2026 年更新。
- 不把第三方品牌、协议或应用替换为现代替代品。
- 不改写为正式白皮书语气；保留原作者的个人博客风格。

## 6. 双语 taxonomy 设计

### 6.1 Technology 分类

| 稳定 ID | 中文名称 | 英文名称 | legacyNames |
|---|---|---|---|
| `app` | App | App | `App` |
| `utm` | UTM | UTM | `UTM` |
| `smart-home` | 智能家居 | Smart Home | `智能家居` |
| `home-assistant` | Home Assistant | Home Assistant | `Home Assistant` |
| `ios` | iOS | iOS | `iOS` |
| `iphone` | iPhone | iPhone | `iPhone` |
| `apple` | 苹果 | Apple | `苹果` |
| `tools` | 工具 | Tools | `工具` |
| `tampermonkey` | Tampermonkey | Tampermonkey | `Tampermonkey` |
| `tutorials` | 教程 | Tutorials | `教程` |
| `charging` | 充电 | Charging | `充电` |
| `explainers` | 科普 | Explainers | `科普` |
| `baidu-netdisk` | 百度网盘 | Baidu Netdisk | `百度网盘` |
| `mac-mini` | Mac mini | Mac mini | `Mac mini` |
| `idm` | IDM | IDM | `IDM` |
| `consumer-electronics` | 数码 | Consumer Electronics | `数码` |
| `homekit` | HomeKit | HomeKit | `HomeKit` |

### 6.2 Life 分类

| 稳定 ID | 中文名称 | 英文名称 | legacyNames |
|---|---|---|---|
| `productivity` | 效率 | Productivity | `效率` |

中英文 slug 使用安全、唯一的本地化路径值。taxonomy sync 必须通过 `legacyNames` 把现有 legacy 标签重连到稳定 ID，重写 4 篇中文 Markdown 的 `tags`，更新 `article_tags` 和 FTS，并删除不再被引用的 legacy 行。

### 6.3 每篇文章标签

- `9102`：`consumer-electronics`、`explainers`、`charging`、`apple`
- `baiduyun-speed-limit`：`tutorials`、`tools`、`baidu-netdisk`、`idm`、`tampermonkey`
- `apps-in-my-iphone-1784032269347`：`app`、`iphone`、`ios`、`tools`、`productivity`
- `home-assistant-nuc9-to-mac-mini-homekit`：`home-assistant`、`homekit`、`mac-mini`、`utm`、`smart-home`

## 7. 内容工件与数据流

由于 `articles/zh/*` 和 `articles/en/*` 按现有 `.gitignore` 不进入 Git，发布分为两个工件：

1. **Git 工件**：taxonomy 配置、设计、实施计划、必要的自动化验证和发布文档。
2. **翻译内容包**：4 个英文 Markdown 文件与 SHA-256 清单，只存在于受控本地临时目录和生产临时目录。

内容包不包含图片，因为全部使用现有绝对 `/images/*.webp` 路径。内容包传输后先验证清单，再进入发布链路；发布结束或回滚完成后删除生产临时包。

生产文章写入必须经过现有受保护发布逻辑，使其统一执行：

- Markdown/front matter 校验；
- translation sibling 和 locale slug 冲突检查；
- taxonomy ID 校验；
- Markdown 渲染；
- 文章文件发布；
- `posts`/`articles`/`article_tags` 更新；
- FTS 更新；
- 失败补偿和临时文件清理。

不得使用手写 SQL 直接插入英文文章。

## 8. 本地候选验证

使用生产数据库、文章目录和图片目录的一致性副本创建隔离候选，不覆盖当前本地 ignored 数据。

验证顺序：

1. 加载并校验扩展后的 `content/taxonomy.json`。
2. 运行 taxonomy sync dry-run，确认恰好覆盖预期 18 个 legacy 标签和 4 篇中文文章。
3. apply taxonomy sync，验证操作日志清理、Markdown 重写、数据库重连和 FTS 更新。
4. 导入 4 篇英文 Markdown。
5. 运行 `audit-localized-content`，要求全部检查通过，posts/articles/FTS 计数为 `4/8/8`。
6. 运行受影响测试、完整测试、typecheck 和 lint。
7. 启动隔离候选服务并验证公共行为。

### 8.1 自动内容一致性检查

- 4 个中文 translation key 均有且只有一个英文 sibling。
- 每篇中英文文章的图片 URL 多重集合完全相同。
- 英文文件不存在未翻译中文正文；允许值仅限既定代码、URL 或专有原文引用，并必须显式列入检查豁免。
- 所有英文标签都是 catalog 中的稳定 ID，不能出现 `legacy-*`。
- 外部 URL、代码块和表格中的技术数值与中文原文一致。
- Markdown 渲染结果不包含原始可执行 HTML。

### 8.2 候选 HTTP 检查

- `/en/` 显示 4 篇英文文章。
- 4 个英文详情 URL 都返回 200。
- 每个详情页的语言切换准确指向对应中文 sibling，中文页也准确指回英文 sibling。
- canonical 与 `hreflang` 使用真实双语 URL。
- 英文归档、标签页、分类页、搜索、RSS 和 sitemap 包含对应英文文章。
- 英文搜索可通过标题词和 taxonomy 词找到文章。
- 文章引用的全部 WebP 均返回 200 且 MIME 正确。
- 不存在英文缺失时回退中文正文的行为变化。

## 9. 生产部署

### 9.1 发布前门禁

- 本地 Git 工作区干净。
- 所有本地验证通过。
- 独立内容审查无 Important/Critical 翻译问题。
- 独立候选安全审查和候选发布审查通过；生产开放后还要取得新的生产安全与最终发布 PASS。
- 生产当前 commit、PM2、Nginx、数据库完整性、操作锁和磁盘空间正常。
- 记录生产前一 commit、数据库计数、文章文件清单和哈希。

### 9.2 维护窗口步骤

1. 开启 Nginx 维护门并验证公网返回 503、Cloudflare 不缓存维护响应。
2. 停止 PM2 写入进程。
3. 创建事务一致的数据库备份，并备份 `articles/`、taxonomy、操作日志状态和生产本地 `ecosystem.config.js`。
4. 快进生产 Git 到已推送 commit，继续保留生产本地 `ecosystem.config.js`。
5. 校验并 apply taxonomy sync。
6. 校验翻译内容包 SHA-256。
7. 通过 loopback 管理发布接口依次导入 4 篇英文文章。认证令牌只在生产内存中短时生成，不打印、不写入命令历史、文件、PM2 环境或 Git。
8. 运行数据库迁移、taxonomy/content audit、计数、FTS 和操作残留检查。
9. 启动 PM2，检查错误日志、PID、重启次数和仅 loopback 监听。
10. 在维护窗口内完成 Express 和 Nginx localhost 冒烟。
11. 删除生产临时翻译包和任何临时认证材料。
12. 开放维护门并立即执行公网验证。

### 9.3 公网验收

- `/` 本地化协商行为不变。
- `/en/` 返回 200 并列出 4 篇文章。
- 所有英文详情页、对应中文页和双向语言切换正常。
- HTML 继续为 `private, no-store`、Cloudflare `DYNAMIC`、无 `Age`。
- sitemap 和 RSS 包含正确英文 URL。
- 英文搜索和 taxonomy 页面正常。
- 所有文章图片可用；现有图片 Cloudflare 缓存仍保持预期 `MISS → HIT`。
- 缺失图片和静态扩展错误继续 no-store，不出现 `HIT` 或 `Age`。

## 10. 失败处理与回滚

任何 taxonomy sync、内容导入、审计、启动或冒烟失败都必须保持维护门关闭，并按以下顺序恢复：

1. 停止候选 PM2 进程。
2. 如有未完成 operation journal，先依据现有 recovery 语义恢复或完成补偿。
3. 恢复数据库备份和 `articles/` 备份。
4. 回到发布前 Git commit，同时恢复生产本地 `ecosystem.config.js`。
5. 运行数据库完整性、外键、文章文件、FTS 和操作残留审计。
6. 启动旧版本并完成 localhost 冒烟。
7. 确认旧版本正常后才开放维护门。

由于 HTML 不进入共享缓存，本次内容发布不要求 Cloudflare HTML purge。图片文件没有变化，也不改变图片 Cache Rule。若公网图片行为意外异常，使用现有紧急图片 Bypass + prefix purge 回滚流程。

## 11. 审查职责

- **内容审查者**：逐篇双语对照，检查完整性、误译、术语、语气、链接、代码和媒体引用。
- **安全审查者**：检查上传包路径安全、Markdown 安全、临时认证材料、生产备份、操作锁和无直接数据库绕过。
- **最终发布审查者**：基于实际 diff、测试、生产 readback 和公网 smoke 作出最终 PASS/FAIL。

内容审查、安全审查和最终发布审查必须使用相互独立的 reviewer 上下文；Critical 或 Important 发现阻塞生产开放。

## 12. 完成条件

只有以下条件全部成立，任务才算完成：

- 4 篇中文文章均有已发布英文 sibling，生产 articles 总数为 8。
- 18 个 legacy 标签全部迁移到批准的双语稳定 taxonomy，英文文章不引用 legacy 标签。
- 翻译内容、媒体、链接、代码、表格和技术数值通过自动检查与独立人工审查。
- 本地和生产 audit、测试、运行时检查及公网验收通过。
- 生产维护门已开放，PM2 在线且只监听 loopback。
- 临时翻译包和认证材料已删除。
- 独立安全审查与最终发布审查均为 PASS。
