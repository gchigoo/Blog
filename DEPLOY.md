# 生产部署与维护指南

> 完整的部署、配置、维护和故障排除文档

## 📋 目录

1. [环境要求](#环境要求)
2. [快速部署](#快速部署)
3. [PM2 进程管理](#pm2-进程管理)
4. [Nginx 反向代理](#nginx-反向代理)
5. [HTTPS 配置](#https-配置)
6. [日常维护](#日常维护)
7. [故障排除](#故障排除)
8. [依赖说明](#依赖说明)

---

## 环境要求

- **Node.js**: 18+ (推荐 LTS)
- **Git**: 代码管理
- **PM2**: 进程守护（生产环境）
- **Nginx**: 反向代理（可选但推荐）
- **系统**: Linux / macOS / Windows

---

## 快速部署

```bash
# 1. 克隆代码
git clone <your-repo-url> blog
cd blog

# 2. 安装依赖
npm install

# 3. 初始化数据库（生成默认管理员 admin/admin123）
npm run init-db

# 4. 启动测试
npm start
```

访问 http://localhost:3000 确认正常运行后，继续配置生产环境。

**⚠️ 重要：首次登录后请立即修改密码！**

### 配置文件（可选）

编辑 `server/config.js` 修改端口和 JWT 密钥：

```javascript
module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'your-random-secret-key-here',
  // ...
};
```

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
- **登录**: 使用默认账号 `admin` / `admin123`

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

# 2. 安装新依赖
npm install

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
rm blog.db
npm run init-db
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

- [x] 修改默认管理员密码
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

### 核心功能包 (13 个生产依赖)

#### Web 框架
- **express** (5.0.1): HTTP 服务器和路由
- **ejs** (3.1.10): HTML 模板引擎

#### 数据存储
- **better-sqlite3** (11.8.1): SQLite 同步驱动，Windows 兼容性好

#### Markdown 处理
- **markdown-it** (14.1.0): Markdown → HTML 解析器
- **markdown-it-anchor** (9.2.0): 为标题生成锚点 id
- **gray-matter** (4.0.3): 解析 Front Matter 元数据

#### 文件处理
- **sharp** (0.33.5): 图片处理，转 WebP
- **multer** (2.0.2): 文件上传 (multipart/form-data)
- **adm-zip** (0.5.16): ZIP 压缩包解压

#### 安全认证
- **bcrypt** (6.0.0): 密码加密 (hash + salt)
- **jsonwebtoken** (9.0.2): JWT 生成和验证
- **cookie-parser** (1.4.7): Cookie 解析

#### 工具库
- **slugify** (1.6.6): 生成 URL 友好 slug

### 开发依赖 (1 个)
- **nodemon** (3.1.7): 开发环境自动重启

### 主要功能流程

**文章上传**:  
multer → adm-zip → gray-matter → markdown-it → sharp → SQLite

**页面渲染**:  
SQLite → EJS → HTML

**用户认证**:  
bcrypt → JWT → cookie-parser

### 为什么选择这些包？

1. ✅ **极简原则**: 仅 14 个依赖，避免过度依赖
2. ✅ **性能优先**: better-sqlite3 比 sqlite3 快，Sharp 比 imagemagick 快
3. ✅ **安全第一**: 使用最新稳定版本 (2026-01)
4. ✅ **易于维护**: 依赖少，升级简单

### 最近更新 (2026-01-16)

| 包名 | 升级 | 改进 |
|------|------|------|
| express | 4.x → 5.0.1 | 性能提升 |
| bcrypt | 5.x → 6.0.0 | 减少 43 个依赖 |
| multer | 1.x → 2.0.2 | 修复安全漏洞 |
| markdown-it-anchor | 8.x → 9.2.0 | API 优化 |

---

## 技术支持

如有问题，请提交 Issue 或查看：
- [README.md](./README.md) - 项目说明
- [GitHub](https://github.com/gchigoo)
