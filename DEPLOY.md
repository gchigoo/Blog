# 生产部署与维护指南

> 完整的部署、配置、维护和故障排除文档

## 📋 目录

1. [环境要求](#环境要求)
2. [快速部署](#快速部署)
3. [Google 登录评论配置](#google-登录评论配置)
4. [PM2 进程管理](#pm2-进程管理)
5. [Nginx 反向代理](#nginx-反向代理)
6. [访问明细与 GeoLite2 City](#访问明细与-geolite2-city)
7. [HTTPS 配置](#https-配置)
8. [日常维护](#日常维护)
9. [故障排除](#故障排除)
10. [依赖说明](#依赖说明)

---

## 环境要求

- **Node.js**: 24.x LTS（`package.json` 限制为 `>=24 <25`）
- **Git**: 代码管理
- **PM2**: 进程守护（生产环境）
- **Nginx**: 反向代理（可选但推荐）
- **系统**: 应用可在 Linux / macOS / Windows 开发；GeoLite2 自动更新仅支持 Linux + systemd

---

## 快速部署

```bash
# 1. 克隆代码
git clone <your-repo-url> blog
cd blog

# 2. 安装锁定依赖
npm ci

# 3. 初始化数据库（避免将初始密码写入 shell history 或仓库）
read -rsp 'Initial admin password: ' INITIAL_ADMIN_PASSWORD; echo
export INITIAL_ADMIN_PASSWORD
npm run init-db
unset INITIAL_ADMIN_PASSWORD

# 4. 启动测试
export ANALYTICS_HMAC_SECRET="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
npm start
```

访问 http://localhost:3000 确认正常运行后，继续配置生产环境。

管理员用户名固定为 `admin`，但系统不生成默认密码。请用受保护的环境变量提供初始密码。

### 配置文件（可选）

通过环境变量设置端口和密钥；生产环境必须设置稳定、足够长的 `JWT_SECRET`，并提供独立、canonical unpadded base64url 格式的 `ANALYTICS_HMAC_SECRET`：

```javascript
module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET,
  // ...
};
```

```bash
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

把输出写入主机或部署平台的 secret manager，不要写入 `ecosystem.config.js`、`.env`、脚本、日志或 Git 历史。轮换该密钥会使尚未提交的短期 analytics event token 失效，不影响已保存的数据。

## Google 登录评论配置

### 配置契约

评论功能默认关闭。应用启动时会对下面四项去除首尾空白，并按三态处理：

- 四项全部缺失：评论路由、文章评论区和后台评论导航均不启用，既有博客行为不变。
- 四项全部存在且有效：启用 Google 登录、评论提交与后台审核。
- 只配置一部分或存在无效值：应用拒绝启动，错误只列出配置项和原因，不输出配置值。

| 环境变量 | 要求 |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud Web OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud client secret，只从受保护的运行时环境注入 |
| `GOOGLE_REDIRECT_URI` | 绝对 URL，路径必须精确为 `/auth/google/callback`，不能包含 credentials、query 或 fragment；生产环境必须 HTTPS |
| `COMMENT_SESSION_SECRET` | 至少 32 个 UTF-8 字节，必须与管理员 `JWT_SECRET` 独立 |

本地开发仅允许 `http://localhost:<port>/auth/google/callback` 或 `http://127.0.0.1:<port>/auth/google/callback`。当前生产博客入口是 `https://blog.cokedaily.space`，配置示例：

```bash
export GOOGLE_CLIENT_ID='your-web-client-id.apps.googleusercontent.com'
export GOOGLE_CLIENT_SECRET='从密钥管理服务注入'
export GOOGLE_REDIRECT_URI='https://blog.cokedaily.space/auth/google/callback'
export COMMENT_SESSION_SECRET="$(openssl rand -base64 48)"
pm2 restart blog --update-env
```

不要把真实值写入 `ecosystem.config.js`、`.env`、shell 脚本、日志、Issue 或 Git 历史。示例命令只说明变量名；生产环境应优先使用主机或部署平台的 secret manager。

### Google Cloud 设置

1. 在 Google Cloud Console 配置 OAuth consent screen；第一版只需要 `openid` 与 `profile`。
2. 创建 **OAuth client ID → Web application**。
3. 在 **Authorized redirect URIs** 添加与生产环境完全一致的地址：`https://blog.cokedaily.space/auth/google/callback`。
4. 将 client ID 与 client secret 注入运行环境，设置独立的 `COMMENT_SESSION_SECRET` 后重启应用。
5. 如果应用仍处于 Google OAuth 测试状态，把验收账号加入 Test users。

### 发布前真实 OAuth smoke

必须使用真实测试 client 和实际 HTTPS 域名完成以下闭环，fake adapter 自动测试不能替代该步骤：

1. 未登录打开一篇文章，确认出现隐私告知和 Google 登录入口。
2. 完成 Google 授权并返回原文章，确认页面只显示 Google 展示名称，不显示邮箱或头像。
3. 提交一条评论，确认收到“等待审核”，且公开页面尚不可见。
4. 使用现有管理员账号访问 `/admin/comments`，批准后确认评论公开；拒绝后确认立即隐藏。
5. 删除测试评论，确认审核页与公开页均不再出现。
6. 检查应用日志不包含 authorization code、Google `sub`、token、secret 或评论正文。

### 数据、会话与回滚

- 评论者和评论保存在现有 `blog.db` 的 `comment_users` / `comments` 表中；短期 OAuth 一次性上下文只以哈希保存在 `comment_oauth_contexts`。常规数据库备份已覆盖这些表。
- 管理员 `token` 与评论者 `comment_session` 是两个独立身份域。评论会话固定 7 天；轮换 `COMMENT_SESSION_SECRET` 会使全部评论会话失效。
- 回滚前先备份 `blog.db`。若只需紧急关闭评论，清除四个评论环境变量并重启即可；数据表会保留，旧版应用会忽略它们。
- 回退代码和 lockfile 时执行与目标版本匹配的 `npm ci`。不要为了回滚手工删除评论表；只有在确认不再需要评论数据且已有备份时才执行数据清理。

---

## PM2 进程管理

### 安装 PM2

```bash
npm install -g pm2
```

### 启动应用

```bash
# 使用配置文件启动
pm2 start ecosystem.config.js

# 查看状态
pm2 status

# 查看日志
pm2 logs blog

# 重启
pm2 restart blog

# 停止
pm2 stop blog
```

### 开机自启

```bash
# 生成启动脚本
pm2 startup

# 保存当前进程列表
pm2 save
```

### 常用命令

```bash
pm2 list              # 列出所有进程
pm2 monit             # 监控面板
pm2 logs blog --lines 100   # 查看最近 100 行日志
pm2 flush blog        # 清空日志
pm2 delete blog       # 删除进程
```

---

## Nginx 反向代理

### 配置步骤

```bash
# 1. 复制配置文件
sudo cp nginx.conf.example /etc/nginx/sites-available/blog

# 2. 编辑配置（修改域名）
sudo nano /etc/nginx/sites-available/blog

# 3. 启用站点
sudo ln -s /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/

# 4. 测试配置
sudo nginx -t

# 5. 重启 Nginx
sudo systemctl restart nginx
```

### 配置说明

参考 `nginx.conf.example`，主要配置项：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    # 反向代理到 Node.js
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
    
    # 静态文件直接服务
    location /images/ {
        alias /path/to/blog/public/images/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### Nginx 常用命令

```bash
sudo systemctl start nginx      # 启动
sudo systemctl stop nginx       # 停止
sudo systemctl restart nginx    # 重启
sudo systemctl reload nginx     # 重新加载配置
sudo systemctl status nginx     # 查看状态
sudo nginx -t                   # 测试配置
```

---

## 访问明细与 GeoLite2 City

### 数据边界与应用配置

访问明细默认关闭。启用后，成功的公开 HTML 页面访问会在 `blog.db` 中保存原始 IP、请求时间、公开 URL/查询、Referrer、原始 User-Agent、允许的 Client Hints、GeoLite2 City 近似地区、浏览器/系统/设备解析结果和浏览器实际提供的设备上下文。Cookie、Authorization、OAuth code/state 和凭据参数值不会进入 analytics 数据。默认保留 30 天，每 6 小时清理一次；数据库备份也会包含这些明细。

| 环境变量 | 生产值/约束 |
|---|---|
| `ANALYTICS_HMAC_SECRET` | 始终必填；canonical unpadded base64url，解码后至少 32 bytes，必须从 secret manager 注入 |
| `ANALYTICS_DETAILS_ENABLED` | 首次 GeoIP bootstrap 验证成功后才设置为 `true`；仅接受 `true`/`false` |
| `ANALYTICS_RETENTION_DAYS` | 可选，默认 `30`，整数 `1`–`365` |
| `ANALYTICS_INTERNAL_IPS` | 可选，逗号分隔的精确 IP；排除生产主机自身访问，并把指向这些 IP 的 Referrer 视为内部来源；loopback 始终排除 |
| `ANALYTICS_GEOIP_CITY_DB_PATH` | `/var/lib/blog/geoip/GeoLite2-City.mmdb` |
| `ANALYTICS_GEOIP_UPDATE_STATUS_PATH` | `/var/lib/blog/geoip/update-status.json` |
| `ANALYTICS_PUBLIC_ORIGIN` | `https://blog.cokedaily.space`，只能是 HTTPS origin，不能带 path/query/credentials |

生产配置示例只展示固定路径，不包含密钥值：

```bash
export ANALYTICS_DETAILS_ENABLED=true
export ANALYTICS_RETENTION_DAYS=30
export ANALYTICS_INTERNAL_IPS=23.254.158.109
export ANALYTICS_GEOIP_CITY_DB_PATH=/var/lib/blog/geoip/GeoLite2-City.mmdb
export ANALYTICS_GEOIP_UPDATE_STATUS_PATH=/var/lib/blog/geoip/update-status.json
export ANALYTICS_PUBLIC_ORIGIN=https://blog.cokedaily.space
pm2 restart blog --update-env
```

应用启动时会把 MMDB 完整读入内存并验证 City metadata 与固定 lookup；首个 reader 无法建立时拒绝监听。运行中每 60 秒检测一次原子替换，候选损坏时继续使用旧 reader。数据集 build epoch 超过 14 天时，管理员访问统计页显示 stale，但事件写入不会停止。

### 首次安装 GeoLite2 City updater

需要官方 `geoipupdate`、`flock`（通常来自 `util-linux`）、Node.js 24 和 systemd。canonical 生产路径固定为 `/root/Blog` 与 `/var/lib/blog/geoip`。

```bash
# 1. 安装操作系统依赖（包名按发行版调整）
sudo apt update
sudo apt install geoipupdate util-linux

# 2. 创建数据目录；wrapper 必须由 root 拥有且可执行
sudo install -d -o root -g root -m 0755 /var/lib/blog/geoip
sudo install -d -o root -g root -m 0755 /var/lib/blog/geoip/staging
sudo chown root:root /root/Blog/scripts/update-geoip.sh
sudo chmod 0755 /root/Blog/scripts/update-geoip.sh
test "$(stat -c '%U:%G %a' /root/Blog/scripts/update-geoip.sh)" = 'root:root 755'

# 3. 创建只允许 root 读取的 MaxMind 配置，再用编辑器填入账号和 License Key
sudo install -o root -g root -m 0600 /dev/null /etc/GeoIP.conf
sudoedit /etc/GeoIP.conf
sudo test "$(stat -c '%U:%G %a' /etc/GeoIP.conf)" = 'root:root 600'
sudo grep -Eq '^EditionIDs[[:space:]]+GeoLite2-City([[:space:]]|$)' /etc/GeoIP.conf

# 4. 安装并静态验证 units
sudo install -o root -g root -m 0644 deploy/systemd/blog-geoip-update.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/blog-geoip-update.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/blog-geoip-update.service /etc/systemd/system/blog-geoip-update.timer
sudo systemctl daemon-reload

# 5. 在启用访问明细和启动应用之前完成 bootstrap
sudo systemctl start blog-geoip-update.service
sudo systemctl status blog-geoip-update.service
sudo node /root/Blog/scripts/verify-geoip-db.js /var/lib/blog/geoip/GeoLite2-City.mmdb
sudo test "$(stat -c '%U:%G %a' /var/lib/blog/geoip/GeoLite2-City.mmdb)" = 'root:root 644'
sudo -u "$(stat -c '%U' /root/Blog/blog.db)" test -r /var/lib/blog/geoip/GeoLite2-City.mmdb

# 6. 注入上表 analytics 环境变量、启动应用，最后启用每周 timer
sudo systemctl enable --now blog-geoip-update.timer
systemctl list-timers blog-geoip-update.timer
```

`/etc/GeoIP.conf` 必须包含 `EditionIDs GeoLite2-City`。MaxMind Account ID 与 License Key 只能保存在这个 root-owned `0600` 文件内；不要把值放进环境变量、仓库、命令行、Issue 或日志。bootstrap 失败时不要设置 `ANALYTICS_DETAILS_ENABLED=true`，修复凭据或网络后直接重跑同一 service。

### 每周更新、状态与原子性

timer 按服务器本地时区每周日 03:30 运行，最多随机延迟 30 分钟，调度精度 5 分钟，并通过 `Persistent=true` 在关机错过后补跑。wrapper 使用非阻塞 `flock`；并发运行立即以 exit 75 和 `already_running` 退出。

正常状态机为：同盘 `0700` staging 下载 → Buffer reader 校验 City metadata/build epoch/固定 lookup → checksum/epoch no-op 判断 → fsync 并原子保存 previous → fsync 并单次 rename live → fsync parent → 原子写 `update-status.json`。下载或候选校验失败不会触碰 live；应用最迟 60 秒后切换到新 reader。

```bash
# 手动更新及查看安全状态（只含时间、结果、错误类别和 dataset epoch）
sudo systemctl start blog-geoip-update.service
systemctl status blog-geoip-update.service
journalctl -u blog-geoip-update.service --since today
cat /var/lib/blog/geoip/update-status.json

# 确认 timer 和下次计划执行时间
systemctl list-timers blog-geoip-update.timer
systemctl show blog-geoip-update.timer -p LastTriggerUSec -p NextElapseUSecRealtime

# 原子回滚到 previous；previous 本身会保留
sudo /root/Blog/scripts/update-geoip.sh --rollback
sudo node /root/Blog/scripts/verify-geoip-db.js /var/lib/blog/geoip/GeoLite2-City.mmdb
```

发布证据至少保存：命令与 exit code、更新前后 SHA-256、verifier 的 dataset epoch、固定 lookup、`update-status.json`、`systemctl list-timers`、应用 60 秒内 reader 切换，以及 journal/进程环境/仓库扫描未出现 MaxMind 凭据。覆盖 bootstrap、no-op、正常更新、锁冲突、下载失败保旧、校验失败保旧、回滚和 missed-run 补跑。

### Nginx 与 Cloudflare 验证

使用仓库中的 `deploy/nginx/blog.conf`。其中精确 `location = /api/analytics/client-context` 把请求体限制为 16 KiB；应用的 route-local JSON parser 仍是最终校验边界。Cloudflare 只向源站提供可信地址，Nginx 会覆盖而不是追加客户端传入的 X-Forwarded-For。

```bash
sudo nginx -t
sudo systemctl reload nginx

# 生产 smoke：页面不得进入共享缓存；oversize context 应由 Nginx 返回 413
curl -sSI https://blog.cokedaily.space/ | grep -i '^cache-control:.*private.*no-store'
head -c 17000 /dev/zero | curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' --data-binary @- \
  https://blog.cokedaily.space/api/analytics/client-context
```

Cloudflare 不得对公开 HTML、`/admin/*`、`/api/admin/analytics*` 或 `/api/analytics/client-context` 建立 Cache Everything 规则，也不得覆盖源站 `private, no-store`。线上 smoke 还应分别验证直达源站、Cloudflare、伪造 XFF 和 IPv4-mapped IPv6 的最终 `req.ip` 记录。

文章图片继续由 VPS 的 `/images/*` 提供，并通过 Cloudflare Cache Rule 缓存在边缘：

- 规则名：`Cache blog images at Cloudflare edge`
- 匹配表达式：`(http.host eq "blog.cokedaily.space" and http.request.uri.path wildcard r"/images/*")`
- Cache eligibility：`Eligible for cache`
- Edge TTL：存在 `Cache-Control` 时遵循源站；缺少时使用 Cloudflare 对响应状态码的默认 TTL。成功 WebP 继续使用 Nginx 返回的 30 天，404 等错误响应不再套用 1 年覆盖值
- Tiered Cache：保持 `Active`

图片文件名由当前发布链路生成且不会原地覆盖。不要把规则扩大到其他 hostname、HTML、管理端或 API。发布后传入一个真实存在的 WebP URL 做烟测；脚本同时断言 HTTP 200、图片类型、`MISS → HIT`，并确认首页仍为 `DYNAMIC`：

```bash
set -euo pipefail
IMAGE_URL="${1:?usage: $0 https://blog.cokedaily.space/images/existing.webp}"
SMOKE_URL="${IMAGE_URL}?cf-cache-smoke=$(date +%s)"
FIRST_HEADERS="$(mktemp)"
SECOND_HEADERS="$(mktemp)"
HOME_HEADERS="$(mktemp)"
trap 'rm -f "$FIRST_HEADERS" "$SECOND_HEADERS" "$HOME_HEADERS"' EXIT

FIRST_STATUS="$(curl -sS --max-time 30 -D "$FIRST_HEADERS" -o /dev/null -w '%{http_code}' "$SMOKE_URL")"
sleep 1
SECOND_STATUS="$(curl -sS --max-time 30 -D "$SECOND_HEADERS" -o /dev/null -w '%{http_code}' "$SMOKE_URL")"
HOME_STATUS="$(curl -sS --max-time 30 -D "$HOME_HEADERS" -o /dev/null -w '%{http_code}' https://blog.cokedaily.space/)"

test "$FIRST_STATUS" = 200
test "$SECOND_STATUS" = 200
test "$HOME_STATUS" = 200
grep -qi '^content-type: image/webp' "$FIRST_HEADERS"
grep -qi '^cache-control: public, max-age=2592000' "$FIRST_HEADERS"
grep -qi '^cf-cache-status: MISS' "$FIRST_HEADERS"
grep -qi '^cf-cache-status: HIT' "$SECOND_HEADERS"
grep -qi '^cache-control: private, no-store' "$HOME_HEADERS"
grep -qi '^cf-cache-status: DYNAMIC' "$HOME_HEADERS"
```

回滚时在 Cloudflare Cache Rules 中禁用该规则。若未来允许图片在同一路径原地更新，发布后还必须 purge 对应 URL，或继续改用带版本的新文件名。

---

## HTTPS 配置

### 使用 Let's Encrypt 免费证书

```bash
# 1. 安装 Certbot
sudo apt update
sudo apt install certbot python3-certbot-nginx

# 2. 获取证书（自动配置 Nginx）
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# 3. 测试自动续期
sudo certbot renew --dry-run
```

### 手动续期

```bash
sudo certbot renew
```

证书有效期 90 天，Certbot 会自动在到期前 30 天尝试续期。

---

## 访问地址

配置完成后，可通过以下地址访问：

- **前台**: `https://your-domain.com`
- **后台**: `https://your-domain.com/admin`
- **登录**: 使用初始化时为 `admin` 设置的密码

---

## 日常维护

### 数据备份

**自动备份脚本** (`backup.sh`):

```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups/$DATE"

mkdir -p $BACKUP_DIR

# 备份数据库
cp blog.db $BACKUP_DIR/

# 备份文章
tar -czf $BACKUP_DIR/articles.tar.gz articles/

# 备份图片
tar -czf $BACKUP_DIR/images.tar.gz public/images/

echo "备份完成: $BACKUP_DIR"
```

**定时备份**（使用 cron）:

```bash
# 每天凌晨 2 点备份
0 2 * * * /path/to/blog/backup.sh
```

### 更新应用

```bash
# 1. 拉取最新代码
git pull

# 2. 安装新锁定依赖
npm ci

# 3. 重启应用（PM2 会优雅重启，无停机）
pm2 restart blog
```

### 查看日志

```bash
# 应用日志（实时）
pm2 logs blog --lines 50

# Nginx 访问日志
sudo tail -f /var/log/nginx/blog_access.log

# Nginx 错误日志
sudo tail -f /var/log/nginx/blog_error.log
```

### 清理临时文件

```bash
# 清理上传临时文件
rm -rf uploads/temp/*

# 清理日志（可选）
pm2 flush blog
```

---

## 故障排除

### 问题 1: 端口被占用

**症状**: `Error: listen EADDRINUSE: address already in use :::3000`

**解决**:

```bash
# Linux/Mac
lsof -i :3000
kill -9 <PID>

# Windows
netstat -ano | findstr :3000
taskkill /F /PID <PID>
```

### 问题 2: 数据库锁定

**症状**: `database is locked` 错误

**解决**:

```bash
# 停止所有进程
pm2 stop blog

# 检查数据库完整性
sqlite3 blog.db "PRAGMA integrity_check;"

# 重启
pm2 start blog
```

### 问题 3: 图片上传失败

**症状**: 上传返回 500 错误

**解决**:

```bash
# 检查目录是否存在
ls -la uploads/temp
ls -la public/images

# 修正权限
chmod 755 uploads/temp
chmod 755 public/images

# 检查磁盘空间
df -h
```

### 问题 4: Nginx 502 Bad Gateway

**原因**: Node.js 应用未运行

**解决**:

```bash
# 检查应用状态
pm2 status

# 重启应用
pm2 restart blog

# 检查端口监听
netstat -tlnp | grep 3000
```

### 问题 5: 忘记管理员密码

**解决**:

```bash
# ⚠️ 会删除所有数据！
# 4. 仅在空数据库上初始化；必须提供强初始密码
read -rsp 'Initial admin password: ' INITIAL_ADMIN_PASSWORD; echo
export INITIAL_ADMIN_PASSWORD
npm run init-db
unset INITIAL_ADMIN_PASSWORD
```

或者修改数据库中的密码（需要生成 bcrypt hash）。

---

## 性能优化

### 1. Nginx 配置

```nginx
# 启用 Gzip 压缩
gzip on;
gzip_types text/css application/javascript application/json;
gzip_min_length 1000;

# 静态文件缓存
location ~* \.(jpg|jpeg|png|gif|webp|css|js)$ {
    expires 30d;
    add_header Cache-Control "public, immutable";
}
```

### 2. 应用优化

- 定期清理临时文件
- 使用 CDN 加速静态资源
- 数据库定期 VACUUM（SQLite）

```bash
sqlite3 blog.db "VACUUM;"
```

### 3. 监控

```bash
# PM2 监控面板
pm2 monit

# 系统资源
htop
```

---

## 安全清单

- [x] 初始化不提供默认管理员密码；强 `INITIAL_ADMIN_PASSWORD` 为必填项
- [x] 使用强 JWT_SECRET（至少 32 位随机字符）
- [x] 启用 HTTPS（Let's Encrypt）
- [x] 配置防火墙
  ```bash
  sudo ufw allow 22    # SSH
  sudo ufw allow 80    # HTTP
  sudo ufw allow 443   # HTTPS
  sudo ufw enable
  ```
- [x] 定期备份数据
- [x] 定期更新依赖
  ```bash
  npm outdated
  npm update
  ```
- [x] 限制文件上传大小（当前 50MB）
- [x] 监控日志异常访问

---

## 依赖说明

### 核心功能包 (16 个生产依赖)

#### Web 框架
- **express** (5.2.1): HTTP 服务器和路由
- **ejs** (6.0.1): HTML 模板引擎

#### 数据存储
- **better-sqlite3** (12.11.1): SQLite 同步驱动，支持 Node.js 24

#### Markdown 处理
- **markdown-it** (14.3.0): Markdown → HTML 解析器（原始 HTML 默认作为文本处理）
- **markdown-it-anchor** (9.2.1): 为标题生成锚点 id
- **gray-matter** (4.0.3): 解析 Front Matter 元数据

#### 文件处理
- **sharp** (0.35.3): 图片处理，转 WebP
- **multer** (2.2.0): 文件上传 (multipart/form-data)
- **adm-zip** (0.6.0): ZIP 压缩包解压

#### 安全认证
- **bcrypt** (6.0.0): 密码加密 (hash + salt)
- **jsonwebtoken** (9.0.2): JWT 生成和验证
- **cookie-parser** (1.4.7): Cookie 解析
- **google-auth-library** (10.9.0): Google OAuth authorization-code exchange 与 ID token audience 验证

#### 工具库
- **slugify** (1.6.9): 生成 URL 友好 slug
- **@maxmind/geoip2-node** (7.1.x): 从本地 GeoLite2 City 数据库查询近似地区
- **bowser** (2.14.x): 解析浏览器、系统、引擎和设备信息

### 开发依赖 (2 个)
- **nodemon** (3.1.14): 开发环境自动重启
- **@playwright/test** (1.61.0): EJS 升级的 HTML、布局与跨设备视觉回归门禁

### 主要功能流程

**文章上传**:  
multer → adm-zip → gray-matter → markdown-it → sharp → SQLite

**页面渲染**:  
SQLite → EJS → HTML

**用户认证**:  
bcrypt → JWT → cookie-parser

**访问明细**:
Express request → GeoLite2 City / Bowser → SQLite → 管理员 analytics API/UI

### 为什么选择这些包？

1. ✅ **极简原则**: 仅 16 个生产依赖，避免过度依赖
2. ✅ **性能优先**: better-sqlite3 比 sqlite3 快，Sharp 比 imagemagick 快
3. ✅ **安全第一**: 生产锁文件经 `npm audit --omit=dev` 验证；Google token 不写入数据库
4. ✅ **易于维护**: 依赖少，升级简单

### 最近更新 (2026-07-16)

| 包名 | 升级 | 改进 |
|------|------|------|
| Node.js | 18+ → 24 LTS | 固定生产运行时基线 |
| better-sqlite3 | 11.x → 12.11 | 支持 Node.js 24 |
| sharp | 0.33 → 0.35 | 支持 Node.js 24 |
| multer / adm-zip | 2.0 / 0.5 → 2.2 / 0.6 | 更新上传依赖 |
| google-auth-library | 新增 10.9 | Google OAuth code exchange 与 ID token 验证 |
| @maxmind/geoip2-node / bowser | 新增 7.1 / 2.14 | 本地地区解析与客户端解析 |

---

## 技术支持

如有问题，请提交 Issue 或查看：
- [README.md](./README.md) - 项目说明
- [GitHub](https://github.com/gchigoo)
