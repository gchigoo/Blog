# S8 窄范围修复记录

## 失败的退出信号

S8 要求在真实生产环境完成安全发布与 OAuth smoke。发布前远端基线检查连续两次因 Windows PowerShell 到 SSH 的嵌套引号被剥离而失败；失败发生在只读检查命令中，发布包尚未上传，线上应用未改变。

## 根因

- 第一次：发布包安全正则把合法 `.gitignore` 误判成 `.git` 目录；PM2 状态提取的嵌套双引号破坏远端 shell 命令。
- 第二次：`stat -c` 的格式字符串在 PowerShell/SSH 边界丢失引号，被远端 `stat` 解析为多个路径参数。

## 允许修改的范围

- 只简化本次 S8 的部署编排与只读核验命令，避免嵌套引号。
- 不修改评论业务代码、OAuth 契约、数据库 schema、权限边界或验收标准。
- 不以跳过备份、门禁或真实 OAuth smoke 作为修复方式。

## 必须重跑的验证

1. 远端应用目录、数据库文件、目标文件哈希与 PM2 PID 的只读检查。
2. 隔离发布目录中的 `npm ci --omit=dev`、`npm test`、生产审计与依赖检查。
3. 数据库在线备份、范围化覆盖、PM2 重启、HTTP/HTTPS smoke 与真实 Google OAuth 闭环。

## 第一次生产切换回滚

- 自动回滚已执行：运行文件与旧 `node_modules` 已恢复，PM2 已重启旧版本。
- 根因：smoke 脚本通过现有 `server/db.js` 查询文章 slug；该模块会向 stdout 输出“数据库连接成功”，使 shell 变量同时包含日志与 slug，最终生成 malformed URL。
- 窄修复：smoke 查询改为直接用 `better-sqlite3` 打开指定数据库，不加载带启动日志的项目 DB wrapper；部署文件、OAuth 配置和验收标准均不改变。
- 重试前必须验证 PM2 在线、localhost 首页与 Cloudflare HTTPS 正常；重试后仍执行完整 localhost、OAuth start、schema 和外网检查。

## 评论区排版与缓存修复

- 生产截图显示评论表单仍为浏览器默认的行内排版。线上计算样式确认 `#comments` 没有 `max-width` 和顶部边框，而当前源码已经包含这些规则。
- 根因是文章页长期引用未版本化的 `/css/custom.css`，Nginx 又为 CSS/JS 返回 30 天缓存，浏览器继续使用评论功能上线前的旧样式。
- 窄修复：静态资源 URL 增加 `v=20260716-comments-2`；Nginx 源站 CSS/JS 缓存改为 5 分钟并要求 revalidate；评论编辑器改为卡片式纵向布局，小屏操作区堆叠。
- 评论元信息不再使用语义 `header`，避免被站点的全局 `header` 布局和 new.css 页头样式误伤。
- 浏览器证据：桌面端评论区固定最大宽度 800px；手机端输入框和提交按钮不溢出、操作区纵向排列；长展示名正常换行。

## UI 发布重试与结果

- 第一次 UI 切换因 PM2 重启后立即探测 3000 端口而失败；自动回滚成功。健康检查改为对 connection refused 做最多 15 次、每秒一次的短轮询。
- 第二次 UI 切换通过应用探测，但服务器本机回环 HTTPS 不信任证书链；自动回滚成功。仅本机 `--resolve` 的 Nginx smoke 使用 `--insecure`，外网验收仍使用正常证书校验。
- 第三次切换成功：release `20260716-080805Z-ui`，rollback backup `/root/backups/blog/20260716-080805Z-ui`。
- 外网 HTML 已引用版本化 CSS/JS，公开 CSS 包含新布局规则且要求 revalidate；Cloudflare 当前把公开浏览器 TTL 覆盖为 4 小时，但版本化 URL 已保证本次发布不会命中旧 CSS。

## 独立审查修复

- 首轮独立审查证明原 replay 测试是假阳性：第二次 callback 未携带原 OAuth Cookie；携带同一 Cookie/state 时会再次 exchange 并签发 session。
- 修复后 OAuth token id 只以 SHA-256 哈希持久化在 `comment_oauth_contexts`，callback 在调用 Google 前通过 SQLite 原子 UPDATE 一次性消费；同 Cookie 重放、第二个 code、并发 callback 和 store 重建均已覆盖。
- Google ID token 验证阶段的网络错误和 provider 5xx 现在稳定映射为 502，签名/claims 等身份无效仍为 400。
- 后台审核元信息改用普通 `div`，退出按钮 specificity 修正；桌面与 390px 手机浏览器均无横向溢出。
- 因 CSS 再次变化，最终 GitHub 发布把资产版本提升到 `v=20260716-comments-3`，避免命中上一轮 Cloudflare 缓存。
