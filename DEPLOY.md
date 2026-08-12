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
export JWT_SECRET="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
export ANALYTICS_HMAC_SECRET="$(node -p "require('node:crypto').randomBytes(32).toString('base64url')")"
export BLOG_PUBLIC_ORIGIN='http://localhost:3000'
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

SEO、RSS、sitemap 使用 `BLOG_PUBLIC_ORIGIN` 生成绝对 URL。生产环境应设置为不带路径的 HTTPS origin，例如 `https://blog.cokedaily.space`。可用 `BLOG_TITLE` 和 `BLOG_DESCRIPTION` 覆盖站点名称与默认摘要。

应用默认仅监听 `127.0.0.1`，适合由同机 Nginx 反向代理。`BLOG_LISTEN_HOST` 只接受 `127.0.0.1` 或 `::1`；不要把应用直接绑定到 `0.0.0.0`。

### 数据库迁移

升级已有实例时，必须先备份并执行幂等迁移，再重启应用；不要依赖重启隐式完成迁移：

```bash
npm run backup-db
npm run migrate-db
npm test
pm2 restart blog --update-env
```

迁移会增加文章发布状态、摘要、规范化标签表、FTS5 索引，以及 analytics 的 `traffic_kind` / `bot_name` 字段、索引和一致性约束；现有文章会回填为 `published`，既有 analytics 行会回填为 `human`。迁移只在本机数据库上执行，不会连接外部服务。

回滚到不认识 `status` 的旧版本前必须恢复升级前备份，或先删除/发布所有草稿；否则旧版本可能把草稿当作普通文章公开。开始采集爬虫后，回滚到不认识 `traffic_kind` 的发布前应用代码还必须恢复发布前数据库备份，或者部署显式过滤 `traffic_kind` 的兼容补丁；仅回退代码和 lockfile 不足以保证旧查询口径正确。

### 分类目录同步（维护窗口）

`content/taxonomy.json` 是分类维护源，SQLite 规范化分类是运行时真相，两者通过 `sync-taxonomy` 事务性同步。执行前后必须停写并做协调备份：

1. 进入维护窗口：停止应用写入（停止发布流程/后台任务），并执行 `npm run backup-db` 创建同一时点的协调备份。
2. 预览：`npm run sync-taxonomy -- --dry-run`。干跑严格零写入，只读打开 SQLite；输出精确排序的计划（新增/更新/删除的分类与标签、`legacyNames` 重映射、Markdown 改写、被阻止的 slug 变更/删除、冲突、受影响文章），存在冲突或阻止项时以非零退出。schema v2 下干跑输出迁移前审计（直接 legacyNames 匹配与迁移 3 将创建的确定性 legacy ID）。
3. 审查：应用前必须逐项审查干跑计划中的 `unmappedLegacyTags`、`legacyRewires`、`markdownRewrites`、`blockedSlugChanges`、`blockedDeletions`、`conflicts` 与受影响文章数量；任何未预期的别名重接线、slug 变更或删除都必须先在目录中修复。
4. 应用：`npm run sync-taxonomy`。先原子获取 `var/operations/active.lock` 独占锁，再在同一事务中应用分类行、重接线 `article_tags`、仅删除已无引用的非系统行，并精确刷新受影响文章的 FTS 行；Markdown `tags` 改写在文件层面按阶段（`lock-acquired → prepared → files-promoted → db-committed → cleanup-complete`）落盘，任何被捕获的提交前失败都会回滚 SQLite 并按逆序恢复原文件。
5. 拒绝与恢复：存在不完整操作清单或过期/活动的 `active.lock` 时，普通 apply 与 dry-run 都会拒绝执行。进程被终止时，直到 `npm run sync-taxonomy -- --recover <operation-id>` 按清单中的前后哈希恢复原状或完成已提交状态；任何第三状态或哈希不一致都会拒绝自动化恢复并要求恢复完整的同时点备份。`var/operations` 是持久的操作登记处，通用 `uploads/temp` 清理不得触碰；分类同步与内容迁移共享同一把锁与登记处，同一时刻只有一个 apply/recovery 持有它。
6. 应用/恢复后：运行 `npm run audit-localized-content` 并保存输出，证明每个 Markdown 文件的标签 ID 与 `article_tags` 完全相等，且 `article_fts` 内容与最新文章内容一致。

### 双语发布协调维护窗口（迁移、切换与回滚）

内容迁移（`migrate-localized-content`）把过渡期文件布局（`articles/<slug>.md`、`public/audio/<slug>/`、`/audio/<slug>/...` HTML URL）改写为本地化布局（`articles/<locale>/<slug>.md`、`public/audio/<locale>/<slug>/`、`/audio/<locale>/<slug>/...`），并与 `sync-taxonomy` 共享 `var/operations` 锁与阶段机。以下是唯一的发布顺序。

#### 维护窗口顺序

```bash
# 1. 无害预检可以在旧应用继续服务流量时执行（新脚本只读检查旧 schema）。
npm run sync-taxonomy -- --dry-run
npm run migrate-localized-content -- --dry-run

# 2. 先启用 Nginx/边缘维护门（见“Nginx 反向代理”），验证外部流量收到 503；
#    然后停止所有应用写入。
pm2 stop blog
# 验证没有其他进程/cron 正在使用 blog.db、articles/ 或 public/audio/。

# 3. 停止状态下创建唯一的发布点备份集。
npm run backup-db
# 紧接着备份 articles/ 与 public/audio/；记录全部三个产物的确切名称、字节数与 SHA-256。

# 4. 针对这份冻结状态重跑并保存两份只读 JSON 计划。
npm run sync-taxonomy -- --dry-run
npm run migrate-localized-content -- --dry-run

# 5. schema 迁移 + 内容迁移。
npm run migrate-db
# 在 apply 前保存/审查精确的内容计划。
npm run migrate-localized-content -- --dry-run
npm run migrate-localized-content
npm run audit-localized-content   # 保存发布后内容审计

# 6. 内容迁移已改变 Markdown 路径/标签 token，因此针对该精确状态重新计算/审查分类。
npm run sync-taxonomy -- --dry-run
npm run sync-taxonomy
npm run audit-localized-content   # 保存发布后分类审计
npm test

# 7. 公共维护保持启用，启动并验证候选应用。
pm2 restart blog --update-env
# 通过 localhost/allowlist 运行 smoke，移除一次性草稿/评论 fixtures，然后再次审计。
npm run audit-localized-content
# 8. 只有所有检查通过后才：关闭维护、reload Nginx，并记录切换时间。
```

要点：

- **同一时点备份**：`npm run backup-db` 生成事务一致的 SQLite 快照；紧接着备份 `articles/` 与 `public/audio/`。三者来自同一个已停止的发布点，逐项记录确切文件名、字节数与 SHA-256（例如 `sha256sum blog.db <backup>.db articles.tar.gz audio.tar.gz`）。
- **无写入者**：`pm2 stop blog` 后必须验证没有其他进程/cron 持有 `blog.db`、`articles/` 或 `public/audio/` 的写入。
- **绝不盲目重跑 apply**：任一 apply 中断时，先检查报告的操作 ID，运行匹配的 `--recover <operation-id>`，再重跑 dry-run/audit。恢复报告歧义的 DB/文件哈希状态时，保持维护启用并先恢复完整备份集再重试。
- **计划必须即时保存**：在每次 apply 前保存确切的 JSON 计划；路径/token 改变后绝不复用预检或内容迁移前的分类计划。
- **清理约束**：`rm -rf uploads/temp/*` 只在共享操作锁 `var/operations/active.lock` 不存在时允许，且任何情况下都不得以 `var/operations` 为目标；清单与锁只能由验证成功的 apply/recovery 删除。
- **审计证据**：`npm run audit-localized-content` 的保存输出必须包含 `integrity_check`、`foreign_key_check`、posts/articles/comments/article-tags/FTS 内容与计数、Markdown↔DB 标签相等性、翻译身份检查、双向 HTML 音频 URL↔SHA-256 文件检查、无遗留 legacy 路径/不完整操作清单/过期锁，以及发布前备份 SHA-256 清单。

#### 流量关闭期间的 smoke 矩阵

公共维护保持启用、流量仍被阻断时，逐项 smoke：`/`、`/zh/`、`/en/`、legacy 301、一篇双语文章、一篇中文独有文章的英文 404、分类/标签页（含 `/zh/tag/Node.js`）、两个关于页、两个 feed、sitemap 的 hreflang alternates、评论 OAuth 通过 allowlist 路径的返回、审核语言身份、一次性管理员草稿上传/替换/删除，以及本地化音频的完整与 Range 响应。smoke 后移除一次性评论/内容并重跑审计，才能开放流量；确认 Analytics 只记录最终本地化 `200` 响应。

#### 恢复演练（发布前必做）

在一次性目录中演练恢复：解包三份匹配备份，验证 SHA-256/字节数，运行 SQLite `integrity_check`/`foreign_key_check`，对比发布前行/文件计数，并仅用一次性路径以只读方式启动旧版本做 smoke。记录演练结果。

#### 回滚截止点

- **维护解除前**：可以恢复精确的发布前 SQLite + `articles/` + `public/audio/` 备份集，验证哈希/完整性/计数，部署旧代码与配置后重新开放流量。
- **公共写入开启后**：绝不盲目恢复发布前备份集（会丢失新评论/上传/Analytics 事件）。先重新启用维护、捕获切换后的 DB/文件，优先前向修复；只有持有经过审查的切换后写入对账/导出计划时才允许回滚。
- 绝不单独恢复某一个组件，也绝不进行原地 schema 降级。

### 英文文章翻译发布

本节是 `english-articles-2026-08-04.json` 四篇英文文章的唯一生产 runbook。生产 checkout 固定为 `/root/Blog`，PM2 进程固定为 `blog`，应用只能监听 loopback。所有会改变生产代码、数据库、taxonomy、文章文件或 PM2 generation 的步骤，都必须在 Nginx maintenance include 已启用且公网 503 已经由非 allowlist 主机确认后执行；temporary bundle 也必须在 maintenance 仍启用时清理，任何失败都保持 maintenance 启用。

禁止直接 SQL INSERT、UPDATE 或逐篇 DELETE；四篇文章只能由受保护的 loopback publisher 顺序写入。发布 token 的值禁止出现在命令行参数、环境变量、文件、shell history、stdout/stderr 或任何应用、PM2、Nginx 日志中。该 token 必须是仅存于内存、算法固定为 HS256、有效期固定为五分钟（`expiresIn: '5m'`）并只经 fd 3 匿名管道传递的一次性凭据。

#### 候选包门禁（维护窗口前，只读）

在批准的候选 checkout 和候选数据库上准备仅含四个已批准 Markdown 文件及 `SHA256SUMS` 的 flat bundle；不得含隐藏文件、目录、symlink 或额外文件。维护窗口前只允许在候选机执行只读审计和记录独立 digest；禁止创建、传输或修改任何生产 bundle 路径。source audit 通过后，对 `SHA256SUMS` 文件本身计算 SHA-256，把 digest 记录到 bundle 目录之外的只读 approval evidence，并由批准者独立保存；bundle 内的 `SHA256SUMS` 不能自证 provenance：

```bash
set -euo pipefail
cd /path/to/approved-candidate-checkout
CANDIDATE_BUNDLE=/private/tmp/blog-english-release-20260804
APPROVED_DIGEST_RECORD=/private/tmp/blog-english-release-20260804.SHA256SUMS.approved
npm run audit-translation-release -- \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle "$CANDIDATE_BUNDLE" \
  --mode source
APPROVED_SHA256SUMS_DIGEST="$(shasum -a 256 "$CANDIDATE_BUNDLE/SHA256SUMS" | awk '{print $1}')"
[[ "$APPROVED_SHA256SUMS_DIGEST" =~ ^[a-f0-9]{64}$ ]]
test ! -e "$APPROVED_DIGEST_RECORD"
printf '%s\n' "$APPROVED_SHA256SUMS_DIGEST" > "$APPROVED_DIGEST_RECORD"
chmod 0444 -- "$APPROVED_DIGEST_RECORD"
printf 'approved SHA256SUMS digest: %s\n' "$APPROVED_SHA256SUMS_DIGEST"
```

此时停止：不得运行 `ssh`/`scp`，不得预建 production incoming/staging 目录。批准者只把 64 位 digest 作为独立证据带入维护窗口；实际 transfer/activation 必须等主生产终端确认 maintenance 公网 503 后，由 operator workstation/second terminal 按生产块暂停点的逐文件命令发起。

下面的生产块必须在同一个 root Bash 会话中从上到下执行，不得跳步或调换。`RELEASE_COMMIT` 必须由 operator 预先设置为已经审查、推送且将要发布的完整 40 位 commit；它不是凭据。maintenance/public 状态码必须来自非 allowlist 主机的独立探测。

```bash
# english-translation-release-runbook
set -Eeuo pipefail
cd /root/Blog

RELEASE_COMMIT="${RELEASE_COMMIT:?set RELEASE_COMMIT to the approved 40-hex release commit}"
[[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
RELEASE_ROOT=/root/blog-english-release-20260804
BUNDLE_STAGING_DIR="$RELEASE_ROOT/incoming.staging"
INCOMING_DIR="$RELEASE_ROOT/incoming"
BACKUP_DIR="$RELEASE_ROOT/coordinated-backup"
NGINX_SITE=/etc/nginx/sites-available/blog.conf
ACTIVE_MAINTENANCE='^[[:space:]]*include[[:space:]]+/etc/nginx/snippets/blog-maintenance[.]conf;$'
POST_OPEN_ACTIVE=0
test ! -e "$BUNDLE_STAGING_DIR"
test ! -e "$INCOMING_DIR"

assert_port_3000_loopback_only() {
  local listener
  local -a listeners=()
  mapfile -t listeners < <(ss -H -ltn 'sport = :3000' | awk '{print $4}')
  test "${#listeners[@]}" -ge 1
  for listener in "${listeners[@]}"; do
    case "$listener" in
      '127.0.0.1:3000'|'[::1]:3000') ;;
      *) printf 'non-loopback port 3000 listener: %s\n' "$listener" >&2; return 1 ;;
    esac
  done
}

wait_for_blog_root() {
  local expected_pid="$1"
  local deadline_ms now_ms remaining_ms request_ms request_timeout status=''
  deadline_ms=$(( $(date +%s%3N) + 30000 ))
  while :; do
    now_ms="$(date +%s%3N)"
    remaining_ms=$(( deadline_ms - now_ms ))
    (( remaining_ms > 0 )) || break
    test "$(pm2 pid blog)" = "$expected_pid" || return 1
    now_ms="$(date +%s%3N)"
    remaining_ms=$(( deadline_ms - now_ms ))
    (( remaining_ms > 0 )) || break
    request_ms="$remaining_ms"
    (( request_ms > 1000 )) && request_ms=1000
    printf -v request_timeout '%d.%03d' $(( request_ms / 1000 )) $(( request_ms % 1000 ))
    status="$(curl -q --proto '=http' --globoff -sS --connect-timeout "$request_timeout" --max-time "$request_timeout" -o /dev/null -w '%{http_code}' -- http://127.0.0.1:3000/ 2>/dev/null || true)"
    test "$(pm2 pid blog)" = "$expected_pid" || return 1
    now_ms="$(date +%s%3N)"
    if [[ "$status" = 302 ]] && (( now_ms <= deadline_ms )); then return 0; fi
    remaining_ms=$(( deadline_ms - now_ms ))
    (( remaining_ms > 200 )) && sleep 0.2
  done
  printf 'blog root readiness timed out for PID %s (last status: %s)\n' "$expected_pid" "$status" >&2
  return 1
}

enable_maintenance() {
  sudo sed -i 's@^[[:space:]]*#[[:space:]]*include[[:space:]]\+/etc/nginx/snippets/blog-maintenance[.]conf;@    include /etc/nginx/snippets/blog-maintenance.conf;@' "$NGINX_SITE" || return 1
  test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1 || return 1
  sudo nginx -t || return 1
  sudo systemctl reload nginx || return 1
}

confirm_public_maintenance_no_cache() {
  local evidence_dir="$1"
  local attempt response status
  local nonce="post-open-recovery-$(date -u +%s%N)"
  for attempt in 1 2; do
    response="$(curl -q --proto '=https' --globoff -sS --max-time 30 -D - -o /dev/null -w $'\n__STATUS__:%{http_code}\n' -- "https://blog.cokedaily.space/$nonce")" || return 1
    status="$(printf '%s\n' "$response" | sed -n 's/^__STATUS__://p' | tail -n 1)"
    test "$status" = 503 || return 1
    ! printf '%s\n' "$response" | grep -Eiq '^CF-Cache-Status:[[:space:]]*(HIT|STALE|UPDATING|REVALIDATED)' || return 1
    ! printf '%s\n' "$response" | grep -Eiq '^Age:' || return 1
    {
      printf 'status=%s\n' "$status"
      printf '%s\n' "$response" | tr -d '\r' | grep -Ei '^(Cache-Control|CF-Cache-Status|Age|Expires):' || true
    } > "$evidence_dir/public-503-$attempt.evidence"
    response=''
  done
}

capture_post_open_state() (
  trap - ERR INT TERM HUP
  set -Eeuo pipefail
  local capture_dir="$1"
  local actual_artifact_list expected_artifact_list manifest_line_count manifest_tmp
  local artifact
  local -a db_snapshots=()
  local -a expected_artifacts=(
    blog.db
    ecosystem.config.js
    git-commit
    operations-state
    post-open-state.tar
    public-503-1.evidence
    public-503-2.evidence
  )

  pm2 stop blog || return 1
  touch "$capture_dir/.backup-start" || return 1
  npm run backup-db || return 1
  find /root/Blog/backups -maxdepth 1 -type f -name 'blog_*.db' -newer "$capture_dir/.backup-start" -print0 > "$capture_dir/.db-snapshots" || return 1
  mapfile -d '' db_snapshots < "$capture_dir/.db-snapshots" || return 1
  rm -f -- "$capture_dir/.db-snapshots" || return 1
  test "${#db_snapshots[@]}" -eq 1 || return 1
  cp --archive -- "${db_snapshots[0]}" "$capture_dir/blog.db" || return 1
  git rev-parse HEAD > "$capture_dir/git-commit" || return 1
  cp --archive -- ecosystem.config.js "$capture_dir/ecosystem.config.js" || return 1
  if [[ -e var/operations ]]; then
    printf 'present\n' > "$capture_dir/operations-state" || return 1
    tar --create --file "$capture_dir/post-open-state.tar" -- articles content/taxonomy.json var/operations || return 1
  else
    printf 'absent\n' > "$capture_dir/operations-state" || return 1
    tar --create --file "$capture_dir/post-open-state.tar" -- articles content/taxonomy.json || return 1
  fi
  rm -f -- "$capture_dir/.backup-start" || return 1

  expected_artifact_list="$(printf '%s\n' "${expected_artifacts[@]}" | LC_ALL=C sort)" || return 1
  actual_artifact_list="$(find "$capture_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)" || return 1
  test "$actual_artifact_list" = "$expected_artifact_list" || return 1
  for artifact in "${expected_artifacts[@]}"; do
    test -f "$capture_dir/$artifact" || return 1
    test ! -L "$capture_dir/$artifact" || return 1
  done

  manifest_tmp="$capture_dir/.SHA256SUMS.tmp.$$"
  test ! -e "$manifest_tmp" || return 1
  cd "$capture_dir" || return 1
  sha256sum "${expected_artifacts[@]}" > "$manifest_tmp" || return 1
  manifest_line_count="$(wc -l < "$manifest_tmp")" || return 1
  test "$manifest_line_count" -eq "${#expected_artifacts[@]}" || return 1
  mv -- "$manifest_tmp" SHA256SUMS || return 1
  sha256sum -c SHA256SUMS || return 1
)

post_open_failure() {
  local exit_code="${1:-1}"
  local maintenance_status=1 stop_status=1 probe_status=1 capture_status=1
  trap - ERR INT TERM HUP
  if [[ "${POST_OPEN_ACTIVE:-0}" = 1 ]]; then
    set +e
    enable_maintenance
    maintenance_status=$?
    pm2 stop blog
    stop_status=$?
    POST_OPEN_CAPTURE_DIR="$RELEASE_ROOT/post-open-failure-$(date -u +%Y%m%dT%H%M%S%N)"
    install -o root -g root -m 0700 -d "$POST_OPEN_CAPTURE_DIR"
    confirm_public_maintenance_no_cache "$POST_OPEN_CAPTURE_DIR"
    probe_status=$?
    if capture_post_open_state "$POST_OPEN_CAPTURE_DIR"; then
      capture_status=0
    else
      capture_status=$?
    fi
    printf 'post-open failure containment results: maintenance=%s stop=%s probe=%s capture=%s evidence=%s\n' \
      "$maintenance_status" "$stop_status" "$probe_status" "$capture_status" "$POST_OPEN_CAPTURE_DIR" >&2
  fi
  exit "$exit_code"
}

trap 'post_open_failure "$?" ERR' ERR
trap 'post_open_failure 130 INT' INT
trap 'post_open_failure 143 TERM' TERM
trap 'post_open_failure 129 HUP' HUP

#### 生产步骤 1：启用 maintenance
enable_maintenance
printf '%s\n' 'From a non-allowlisted host, run: curl -q --proto =https --globoff -sS -o /dev/null -w "%{http_code}" -- https://blog.cokedaily.space/'
read -r -p 'Confirmed maintenance HTTP status: ' MAINTENANCE_STATUS
test "$MAINTENANCE_STATUS" = 503

#### 生产步骤 2：停止 PM2
pm2 stop blog
test "$(pm2 pid blog)" = 0

#### 生产步骤 3：创建协调备份
test ! -e "$BACKUP_DIR"
install -d -m 0700 "$BACKUP_DIR"
touch "$BACKUP_DIR/.backup-start"
printf '%s\n' "$(git rev-parse HEAD)" > "$BACKUP_DIR/git-commit"
cp --archive -- ecosystem.config.js "$BACKUP_DIR/ecosystem.config.js"
stat -c '%a:%u:%g:%s:%Y' ecosystem.config.js > "$BACKUP_DIR/ecosystem.stat"
npm run backup-db
mapfile -d '' DB_SNAPSHOTS < <(find /root/Blog/backups -maxdepth 1 -type f -name 'blog_*.db' -newer "$BACKUP_DIR/.backup-start" -print0)
test "${#DB_SNAPSHOTS[@]}" -eq 1
cp --archive -- "${DB_SNAPSHOTS[0]}" "$BACKUP_DIR/blog.db"
if [[ -e var/operations ]]; then
  printf 'present\n' > "$BACKUP_DIR/operations-state"
  tar --create --file "$BACKUP_DIR/content-state.tar" -- articles content/taxonomy.json var/operations
else
  printf 'absent\n' > "$BACKUP_DIR/operations-state"
  tar --create --file "$BACKUP_DIR/content-state.tar" -- articles content/taxonomy.json
fi
rm -f -- "$BACKUP_DIR/.backup-start"
(
  cd "$BACKUP_DIR"
  sha256sum blog.db content-state.tar ecosystem.config.js ecosystem.stat git-commit operations-state > SHA256SUMS
  sha256sum -c SHA256SUMS
)

#### 生产步骤 4：更新代码并恢复 production-local ecosystem
PRE_RELEASE_COMMIT="$(cat "$BACKUP_DIR/git-commit")"
git diff --quiet -- . ':(exclude)ecosystem.config.js'
git diff --cached --quiet
test -z "$(git ls-files --others --exclude-standard)"
git fetch --prune origin
git cat-file -e "$RELEASE_COMMIT^{commit}"
git merge-base --is-ancestor "$PRE_RELEASE_COMMIT" "$RELEASE_COMMIT"
git reset --hard "$RELEASE_COMMIT"
npm ci --omit=dev
cp --archive --remove-destination -- "$BACKUP_DIR/ecosystem.config.js" ecosystem.config.js
cmp -s -- "$BACKUP_DIR/ecosystem.config.js" ecosystem.config.js
test "$(stat -c '%a:%u:%g:%s:%Y' ecosystem.config.js)" = "$(cat "$BACKUP_DIR/ecosystem.stat")"

#### 生产步骤 4A：在 maintenance 下 staging、activation 并验证 bundle provenance
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
read -r -p 'Paste the independently approved local SHA-256 of SHA256SUMS: ' APPROVED_SHA256SUMS_DIGEST
[[ "$APPROVED_SHA256SUMS_DIGEST" =~ ^[a-f0-9]{64}$ ]]
test ! -e "$BUNDLE_STAGING_DIR"
test ! -e "$INCOMING_DIR"
install -o root -g root -m 0700 -d "$BUNDLE_STAGING_DIR"
cat <<'TRANSFER_INSTRUCTIONS'
Only now, after the main production terminal confirmed maintenance 503, run this exact command in the operator workstation/second terminal:
scp -- \
  /private/tmp/blog-english-release-20260804/understanding-fast-charging.md \
  /private/tmp/blog-english-release-20260804/baidu-netdisk-speed-limit-guide.md \
  /private/tmp/blog-english-release-20260804/my-essential-iphone-apps.md \
  /private/tmp/blog-english-release-20260804/migrating-home-assistant-from-nuc9-to-mac-mini.md \
  /private/tmp/blog-english-release-20260804/SHA256SUMS \
  rn-us-2.5g:/root/blog-english-release-20260804/incoming.staging/
Do not transfer to incoming directly. Return to the paused main production terminal only after scp exits 0.
TRANSFER_INSTRUCTIONS
read -r -p 'Type TRANSFERRED after the second-terminal scp exits 0: ' TRANSFER_STATE
test "$TRANSFER_STATE" = TRANSFERRED
test -d "$BUNDLE_STAGING_DIR"
test ! -L "$BUNDLE_STAGING_DIR"
BUNDLE_FILES=(
  SHA256SUMS
  understanding-fast-charging.md
  baidu-netdisk-speed-limit-guide.md
  my-essential-iphone-apps.md
  migrating-home-assistant-from-nuc9-to-mac-mini.md
)
test "$(find "$BUNDLE_STAGING_DIR" -mindepth 1 -maxdepth 1 -printf x | wc -c)" -eq 5
for bundle_file in "${BUNDLE_FILES[@]}"; do
  bundle_path="$BUNDLE_STAGING_DIR/$bundle_file"
  test -f "$bundle_path"
  test ! -L "$bundle_path"
done
chown root:root -- "$BUNDLE_STAGING_DIR"
for bundle_file in "${BUNDLE_FILES[@]}"; do
  bundle_path="$BUNDLE_STAGING_DIR/$bundle_file"
  chown root:root -- "$bundle_path"
  chmod 0600 -- "$bundle_path"
done
(
  cd "$BUNDLE_STAGING_DIR"
  sha256sum -c SHA256SUMS
)
PRODUCTION_SHA256SUMS_DIGEST="$(sha256sum "$BUNDLE_STAGING_DIR/SHA256SUMS" | awk '{print $1}')"
test "$PRODUCTION_SHA256SUMS_DIGEST" = "$APPROVED_SHA256SUMS_DIGEST"
for bundle_file in "${BUNDLE_FILES[@]}"; do
  chmod 0400 -- "$BUNDLE_STAGING_DIR/$bundle_file"
done
chmod 0500 -- "$BUNDLE_STAGING_DIR"
test "$(stat -c '%u:%g:%a:%F' "$BUNDLE_STAGING_DIR")" = '0:0:500:directory'
for bundle_file in "${BUNDLE_FILES[@]}"; do
  bundle_path="$BUNDLE_STAGING_DIR/$bundle_file"
  test "$(stat -c '%u:%g:%a:%F' "$bundle_path")" = '0:0:400:regular file'
done
mv -- "$BUNDLE_STAGING_DIR" "$INCOMING_DIR"
test -d "$INCOMING_DIR"
test ! -L "$INCOMING_DIR"
test "$(stat -c '%u:%g:%a:%F' "$INCOMING_DIR")" = '0:0:500:directory'

#### 生产步骤 5：执行 migrate-db
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
npm run migrate-db

#### 生产步骤 6：执行 taxonomy dry-run 与 apply
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
npm run sync-taxonomy -- --dry-run
npm run sync-taxonomy
npm run audit-translation-release -- \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle "$INCOMING_DIR" \
  --mode source

#### 生产步骤 7：启动 PM2 candidate
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
pm2 start ecosystem.config.js --only blog --update-env
CANDIDATE_PID="$(pm2 pid blog)"
[[ "$CANDIDATE_PID" =~ ^[1-9][0-9]*$ ]]
wait_for_blog_root "$CANDIDATE_PID"
assert_port_3000_loopback_only

#### 生产步骤 8：通过 anonymous pipe 发布
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
(
  cd "$INCOMING_DIR"
  sha256sum -c SHA256SUMS
)
PRODUCTION_SHA256SUMS_DIGEST="$(sha256sum "$INCOMING_DIR/SHA256SUMS" | awk '{print $1}')"
test "$PRODUCTION_SHA256SUMS_DIGEST" = "$APPROVED_SHA256SUMS_DIGEST"
# 下列 single-quoted here-doc 不做 shell expansion；launcher 与 token 都不落盘。
node <<'NODE'
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const pid = execFileSync('pm2', ['pid', 'blog'], { encoding: 'utf8' }).trim();
if (!/^\d+$/.test(pid)) throw new Error('blog PM2 process is not running');
const entries = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
const env = Object.fromEntries(entries.filter(Boolean).map(entry => {
  const split = entry.indexOf('=');
  return [entry.slice(0, split), entry.slice(split + 1)];
}));
if (!env.JWT_SECRET) throw new Error('JWT_SECRET is unavailable');
let token = jwt.sign(
  { id: 0, username: 'release-operator' },
  env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '5m' }
);
const child = spawn(process.execPath, [
  'scripts/publish-translation-release.js',
  '--release', 'content/releases/english-articles-2026-08-04.json',
  '--bundle', '/root/blog-english-release-20260804/incoming',
  '--base-url', 'http://127.0.0.1:3000',
  '--token-fd', '3'
], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
child.stdio[3].end(token);
token = '';
child.once('exit', code => process.exitCode = code ?? 1);
NODE

#### 生产步骤 9：执行 published 与 localized 两项 audit
npm run audit-translation-release -- \
  --release content/releases/english-articles-2026-08-04.json \
  --bundle "$INCOMING_DIR" \
  --mode published
npm run audit-localized-content

#### 生产步骤 10：重启最终 PM2 worker
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
pm2 restart blog --update-env
FINAL_PID="$(pm2 pid blog)"
[[ "$FINAL_PID" =~ ^[1-9][0-9]*$ ]]
test "$FINAL_PID" != "$CANDIDATE_PID"
wait_for_blog_root "$FINAL_PID"
assert_port_3000_loopback_only

#### 生产步骤 11：执行 localhost smoke
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
LOCAL_ROUTES=(
  /en/
  /en/article/understanding-fast-charging
  /en/article/baidu-netdisk-speed-limit-guide
  /en/article/my-essential-iphone-apps
  /en/article/migrating-home-assistant-from-nuc9-to-mac-mini
)
for route in "${LOCAL_ROUTES[@]}"; do
  test "$(curl -q --proto '=http' --globoff -sS -o /dev/null -w '%{http_code}' -- "http://127.0.0.1:3000$route")" = 200
  test "$(curl -q --insecure --resolve blog.cokedaily.space:443:127.0.0.1 --globoff -sS -o /dev/null -w '%{http_code}' -- "https://blog.cokedaily.space$route")" = 200
done

#### 生产步骤 12：清理 temporary bundle
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
rm -rf -- "$INCOMING_DIR"
test ! -e "$INCOMING_DIR"
test -z "$(find "$RELEASE_ROOT" -maxdepth 1 -type f -iname '*token*' -print -quit)"

POST_OPEN_ACTIVE=1
#### 生产步骤 13：关闭 maintenance
sudo sed -i 's@^[[:space:]]*include[[:space:]]\+/etc/nginx/snippets/blog-maintenance[.]conf;@    # include /etc/nginx/snippets/blog-maintenance.conf;@' "$NGINX_SITE"
test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 0
sudo nginx -t
sudo systemctl reload nginx

#### 生产步骤 14：执行 public smoke
for route in "${LOCAL_ROUTES[@]}"; do
  test "$(curl -q --proto '=https' --globoff -sS --max-time 30 -o /dev/null -w '%{http_code}' -- "https://blog.cokedaily.space$route")" = 200
done
printf '%s\n' 'Run the complete documented root negotiation, localized HTML, real WebP MISS → HIT, and error no-store public smoke now; keep this main shell waiting.'
read -r -p 'Type PASS only after every public smoke check passes; type anything else to trigger containment: ' PUBLIC_SMOKE_RESULT
test "$PUBLIC_SMOKE_RESULT" = PASS
POST_OPEN_ACTIVE=0
trap - ERR INT TERM HUP
```

生产本地 `/root/Blog/ecosystem.config.js` 必须在代码更新前用 `cp --archive` 快照，并在代码更新后与开放前回滚时逐字节、权限、owner/group 和 mtime 原样恢复；不得用仓库版本重建。上面的 localhost `--insecure` 只用于 loopback 命中 Nginx origin 的维护态 smoke，不改变公网 TLS 验收。主生产 shell 的 post-open trap 必须一直保持 armed，直到同一 operator 已执行本文既有的完整 root negotiation、localized HTML、真实 WebP `MISS → HIT` 和 error no-store 检查并在提示符输入 `PASS`；输入其他值、任一命令 ERR、Ctrl-C、TERM 或 HUP 都会自动重新启用 maintenance。

生产主机用于 `confirm_public_maintenance_no_cache` 的公网出口必须不在 maintenance allowlist；若这一点不能在 preflight 证明，则不得开放，必须先准备一个可由主 shell 调用的等价非 allowlist public probe。post-open handler 首先重新启用 include、执行 `nginx -t` 和 reload，并立即停止 PM2 关闭剩余写入口，再用 fresh nonce 连续两次确认公网 503、无缓存态 `CF-Cache-Status` 且无 `Age`；随后把开放后数据库、文章、taxonomy、operation state、Git/config 和仅含 status/cache 字段的脱敏 probe evidence 保存到新的 `post-open-failure-*` 目录供 forward-fix/reconciliation；原始响应头只在 shell 内存中检查并立即清空，不落盘。该 handler 不读取或恢复 pre-open coordinated backup。

下面的 here-doc 必须保持单引号定界（`<<'NODE'`）；launcher 本身只从 shell 标准输入交给 Node，绝不保存到磁盘。它从正在运行的 `blog` 进程读取既有 `JWT_SECRET` 到当前 Node 内存，只在内存中签发五分钟 HS256 token，经 child fd 3 匿名管道发送后立即清空本地引用；不得把 launcher 改成 `node -e` 参数、token 参数、token 环境变量、命名 pipe 或临时文件。

#### 失败边界与恢复

##### 开放前 rollback

如果 publisher 在第 2、3 或 4 篇发生部分发布失败，必须在 maintenance 仍启用时恢复整个协调备份集（数据库、`articles/`、taxonomy、operation state、发布前 Git commit 和 production-local `ecosystem.config.js`），禁止逐篇删除或只恢复其中一个组件。恢复前把失败现场的数据库、`articles/`、taxonomy 和 `var/operations` 移到只读取证目录，不得用通用清理删除 operation journal。任何 migrate、taxonomy、publish、audit、final restart、localhost smoke 或 temporary cleanup 失败都走同一条开放前 rollback；maintenance 只有在旧 generation 的 localhost smoke 通过后才能关闭。

```bash
set -euo pipefail
cd /root/Blog
BACKUP_DIR=/root/blog-english-release-20260804/coordinated-backup
INCOMING_DIR=/root/blog-english-release-20260804/incoming
NGINX_SITE=/etc/nginx/sites-available/blog.conf
ACTIVE_MAINTENANCE='^[[:space:]]*include[[:space:]]+/etc/nginx/snippets/blog-maintenance[.]conf;$'

assert_port_3000_loopback_only() {
  local listener
  local -a listeners=()
  mapfile -t listeners < <(ss -H -ltn 'sport = :3000' | awk '{print $4}')
  test "${#listeners[@]}" -ge 1
  for listener in "${listeners[@]}"; do
    case "$listener" in
      '127.0.0.1:3000'|'[::1]:3000') ;;
      *) printf 'non-loopback port 3000 listener: %s\n' "$listener" >&2; return 1 ;;
    esac
  done
}

wait_for_blog_root() {
  local expected_pid="$1"
  local deadline_ms now_ms remaining_ms request_ms request_timeout status=''
  deadline_ms=$(( $(date +%s%3N) + 30000 ))
  while :; do
    now_ms="$(date +%s%3N)"
    remaining_ms=$(( deadline_ms - now_ms ))
    (( remaining_ms > 0 )) || break
    test "$(pm2 pid blog)" = "$expected_pid" || return 1
    now_ms="$(date +%s%3N)"
    remaining_ms=$(( deadline_ms - now_ms ))
    (( remaining_ms > 0 )) || break
    request_ms="$remaining_ms"
    (( request_ms > 1000 )) && request_ms=1000
    printf -v request_timeout '%d.%03d' $(( request_ms / 1000 )) $(( request_ms % 1000 ))
    status="$(curl -q --proto '=http' --globoff -sS --connect-timeout "$request_timeout" --max-time "$request_timeout" -o /dev/null -w '%{http_code}' -- http://127.0.0.1:3000/ 2>/dev/null || true)"
    test "$(pm2 pid blog)" = "$expected_pid" || return 1
    now_ms="$(date +%s%3N)"
    if [[ "$status" = 302 ]] && (( now_ms <= deadline_ms )); then return 0; fi
    remaining_ms=$(( deadline_ms - now_ms ))
    (( remaining_ms > 200 )) && sleep 0.2
  done
  printf 'blog root readiness timed out for PID %s (last status: %s)\n' "$expected_pid" "$status" >&2
  return 1
}

test "$(grep -Ec "$ACTIVE_MAINTENANCE" "$NGINX_SITE")" -eq 1
pm2 stop blog
(
  cd "$BACKUP_DIR"
  sha256sum -c SHA256SUMS
)
PRE_RELEASE_COMMIT="$(cat "$BACKUP_DIR/git-commit")"
FAILED_STATE_DIR=/root/blog-english-release-20260804/pre-open-failed-state
test ! -e "$FAILED_STATE_DIR"
install -d -m 0700 "$FAILED_STATE_DIR"
cp --archive -- content/taxonomy.json "$FAILED_STATE_DIR/taxonomy.json"
mv -- articles "$FAILED_STATE_DIR/articles"
if [[ -e var/operations ]]; then
  mv -- var/operations "$FAILED_STATE_DIR/operations"
fi
for db_file in blog.db blog.db-wal blog.db-shm; do
  if [[ -e "$db_file" ]]; then mv -- "$db_file" "$FAILED_STATE_DIR/$db_file"; fi
done
git reset --hard "$PRE_RELEASE_COMMIT"
npm ci --omit=dev
cp --archive -- "$BACKUP_DIR/blog.db" blog.db
tar --extract --preserve-permissions --file "$BACKUP_DIR/content-state.tar"
cp --archive --remove-destination -- "$BACKUP_DIR/ecosystem.config.js" ecosystem.config.js
cmp -s -- "$BACKUP_DIR/ecosystem.config.js" ecosystem.config.js
test "$(stat -c '%a:%u:%g:%s:%Y' ecosystem.config.js)" = "$(cat "$BACKUP_DIR/ecosystem.stat")"
if [[ "$(cat "$BACKUP_DIR/operations-state")" = absent ]]; then test ! -e var/operations; fi
npm run audit-localized-content
pm2 start ecosystem.config.js --only blog --update-env
RESTORED_PID="$(pm2 pid blog)"
[[ "$RESTORED_PID" =~ ^[1-9][0-9]*$ ]]
wait_for_blog_root "$RESTORED_PID"
assert_port_3000_loopback_only
rm -rf -- "$INCOMING_DIR"
# 旧版本 localhost smoke 全部通过后，才按生产步骤 13 关闭 maintenance，并重新执行旧版本 public smoke。
```

##### 开放后 forward-fix/reconciliation

maintenance 一旦关闭（包括 public smoke 开始前后的整个 post-open 阶段），绝不能恢复发布前协调备份集；先重新启用 maintenance、冻结并备份开放后状态，优先前向修复（forward-fix）与逐项对账（reconciliation）。只有经过审查的开放后写入导出/重放计划才允许回滚。原因是开放后的评论、上传和 Analytics 写入不在发布前备份中，直接恢复会丢数据；此边界与开放前 whole-backup rollback 不得混用。

本次发布不改变图片文件，HTML 仍为 `private, no-store`；不得 purge 未变化的 HTML 或 `/images/*`，也不得修改现有 Cache Rule。只有另行确认发生真实图片缓存事故时，才进入本文既有的 Emergency bypass + prefix purge 事故流程；该流程不是本次英文内容发布的常规步骤。

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

安装的是测试并锁定的生产契约 `deploy/nginx/blog.conf`（显式静态前缀缓存、精确 favicon、动态代理 catch-all）与两个必需片段，而不是仓库根目录的注释模板 `nginx.conf.example`：

```bash
# 1. 安装必需片段（Cloudflare real-IP 与公共维护门）
sudo install -o root -g root -m 0644 deploy/nginx/cloudflare-real-ip.conf /etc/nginx/snippets/cloudflare-real-ip.conf
sudo install -o root -g root -m 0644 deploy/nginx/blog-maintenance.conf /etc/nginx/snippets/blog-maintenance.conf

# 2. 安装生产反代配置
sudo install -o root -g root -m 0644 deploy/nginx/blog.conf /etc/nginx/sites-available/blog.conf

# 3. 启用站点
sudo ln -sf /etc/nginx/sites-available/blog.conf /etc/nginx/sites-enabled/

# 4. 测试配置（每次 reload 前都必须执行）
sudo nginx -t

# 5. 重载 Nginx
sudo systemctl reload nginx
```

### 配置说明

参考 `deploy/nginx/blog.conf`，主要配置项：

```nginx
map $upstream_status $blog_image_expires {
    ~^(200|206|304)$ 30d;
    default off;
}
map $upstream_status $blog_image_cache_control {
    ~^(200|206|304)$ "public, immutable";
    default "private, no-store";
}

server {
    listen 443 ssl;
    server_name blog.cokedaily.space;
    # ...

    # 动态反向代理（taxonomy HTML 如 /zh/tag/Node.js 必须保持动态）。
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
    }

    # 静态资源只按已知路径前缀缓存，绝不使用扩展名正则。
    location /css/ {
        proxy_pass http://127.0.0.1:3000;
        expires 5m;
        add_header Cache-Control "public, max-age=300, must-revalidate";
    }
    location /js/ {
        proxy_pass http://127.0.0.1:3000;
        expires 5m;
        add_header Cache-Control "public, max-age=300, must-revalidate";
    }
    location /vendor/ {
        proxy_pass http://127.0.0.1:3000;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
    }
    location /fonts/ {
        proxy_pass http://127.0.0.1:3000;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
    }
    location /images/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_hide_header Cache-Control;
        proxy_hide_header Expires;
        expires $blog_image_expires;
        add_header Cache-Control $blog_image_cache_control always;
    }
    location = /favicon.ico {
        proxy_pass http://127.0.0.1:3000;
        expires 1d;
        add_header Cache-Control "public, max-age=86400";
    }
}
```

**静态缓存契约**：只对 `/css/`、`/js/`、`/vendor/`、`/fonts/`、`/images/` 这些已知前缀与精确的 `/favicon.ico` 应用缓存头。禁止扩展名正则缓存（如 `location ~* \.(css|js)$`），否则带点的 taxonomy HTML 路由（如 `/zh/tag/Node.js`）会被错误缓存或误判为静态资源，必须保持动态代理。`/images/` 使用不带 URI 尾斜杠的 `proxy_pass`，因此原始 `/images/*` URI 会原样交给 Express。Nginx 隐藏上游的 `Cache-Control` 与 `Expires` 后按 `$upstream_status` 选择策略：200/206/304 获得 30 天 public immutable；其他状态不生成 `Expires`，并通过 `add_header ... always` 明确返回 `private, no-store`。这样错误响应不会继承成功缓存策略，也不会因隐藏上游头而失去 no-store。

#### 公共维护门（cutover 期间 503）

`deploy/nginx/blog-maintenance.conf` 是公共维护门。`deploy/nginx/blog.conf` 的 **443 HTTPS server 块内** 带有一行默认注释（inert）的启用行；切换窗口期间在该 server 块内去掉 `#` 启用它（该行只在 443 块内有效，绝不能放在顶部或 port-80 跳转块中）：

```nginx
server {
    listen 443 ssl;
    # ...
    # Public maintenance gate（cutover 期间取消注释）
    # include /etc/nginx/snippets/blog-maintenance.conf;
}
```

启用后，公共流量收到 `503`，而 loopback（`127.0.0.1`/`::1`）与文档化的操作员 allowlist（按客户端地址）仍可访问候选应用进行 smoke。**每次 reload 前必须先运行 `sudo nginx -t`**。切换完成并确认所有 smoke/审计通过后，把该行重新注释、再次 `sudo nginx -t`、`sudo systemctl reload nginx`，并记录切换时间。

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

已知爬虫不会再在入口被丢弃：系统保留其聚合和逐次记录，显示可读爬虫名称，但所有真人指标和真人维度都显式排除 `traffic_kind='bot'`。所选近 N 天聚合查询沿用 `access_metrics.bucket_utc` 的小时 bucket 精度，因此范围边界不是小时以内的精确计数。独立 IP 只由保留期内的真人明细去重；当范围内还包含只有聚合指标、没有明细的历史时，后台显示“至少 N 个”，不能把它解释为完整总数。

当 `ANALYTICS_DETAILS_ENABLED=false` 时，逐次访问列表、单条详情 UI、`/api/admin/analytics/events` 和事件详情 API 均不可用，即使数据库中仍保留旧明细；四项聚合概览仍可使用，其中独立 IP 明确显示未启用。

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

本次 analytics 发布把匿名日访客 HMAC 的日期键从 UTC 日切换为 `Asia/Shanghai` 自然日，以匹配“今日活跃访客”口径。部署日的新旧 HMAC 可能在最多一个北京时间自然日内产生轻微重复计数或过度去重；该过渡不会超过一天，历史 HMAC 不回填、不重算。必须保持同一稳定 `ANALYTICS_HMAC_SECRET`，不要用轮换密钥处理这一过渡。

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

图片文件名由当前发布链路生成且不会原地覆盖。不要把规则扩大到其他 hostname、HTML、管理端或 API。发布后传入一个真实存在的 WebP URL 做烟测；脚本同时断言 HTTP 200、图片类型、30 天 public immutable 缓存、没有泄漏上游的 `max-age=0`、`MISS → HIT`，并验证无 Cookie/语言偏好的直达 `/` 默认 302 到 `/zh/` 且正确设置 `Vary`，以及 `/zh/`、`/en/` 均保持 `private, no-store`、`DYNAMIC` 且没有 `Age`：

```bash
set -euo pipefail
IMAGE_URL="${1:?usage: $0 https://blog.cokedaily.space/images/existing.webp}"
if [[ ! "$IMAGE_URL" =~ ^https://blog[.]cokedaily[.]space/images/[A-Za-z0-9][A-Za-z0-9._-]*[.]webp$ ]]; then
  echo 'invalid IMAGE_URL: expected one flat WebP under https://blog.cokedaily.space/images/' >&2
  exit 64
fi
SMOKE_URL="${IMAGE_URL}?cf-cache-smoke=$(date +%s)"
SMOKE_TMP="$(mktemp -d)"
trap 'rm -rf -- "$SMOKE_TMP"' EXIT
FIRST_RAW_HEADERS="$SMOKE_TMP/first.raw.headers"
SECOND_RAW_HEADERS="$SMOKE_TMP/second.raw.headers"
ROOT_RAW_HEADERS="$SMOKE_TMP/root.raw.headers"
ZH_HOME_RAW_HEADERS="$SMOKE_TMP/zh-home.raw.headers"
EN_HOME_RAW_HEADERS="$SMOKE_TMP/en-home.raw.headers"
FIRST_HEADERS="$SMOKE_TMP/first.final.headers"
SECOND_HEADERS="$SMOKE_TMP/second.final.headers"
ROOT_HEADERS="$SMOKE_TMP/root.final.headers"
ZH_HOME_HEADERS="$SMOKE_TMP/zh-home.final.headers"
EN_HOME_HEADERS="$SMOKE_TMP/en-home.final.headers"

extract_final_headers() {
  local raw_headers="$1"
  local final_headers="$2"
  awk '
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^HTTP\/[0-9][0-9.]*[[:space:]]+[0-9][0-9][0-9]([[:space:]]|$)/) {
        block = line ORS
        in_block = 1
        found = 1
        next
      }
      if (in_block) {
        block = block line ORS
        if (line == "") {
          final_block = block
          block = ""
          in_block = 0
        }
      }
    }
    END {
      if (!found) exit 1
      if (in_block) final_block = block
      if (final_block == "") exit 1
      printf "%s", final_block
    }
  ' "$raw_headers" > "$final_headers"
}

require_singleton_header() {
  local headers="$1"
  local target_name="$2"
  local expected_value="$3"
  local fold_case="${4:-true}"
  awk -v target_name="$target_name" -v expected_value="$expected_value" -v fold_case="$fold_case" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    BEGIN {
      target_name = tolower(target_name)
      if (fold_case == "true") expected_value = tolower(expected_value)
    }
    {
      separator = index($0, ":")
      if (!separator) next
      name = tolower(trim(substr($0, 1, separator - 1)))
      if (name != target_name) next
      count++
      value = trim(substr($0, separator + 1))
      if (fold_case == "true") value = tolower(value)
      if (value != expected_value) invalid = 1
    }
    END {
      if (count != 1 || invalid) exit 1
    }
  ' "$headers"
}

forbid_header() {
  local headers="$1"
  local target_name="$2"
  awk -v target_name="$target_name" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    BEGIN { target_name = tolower(target_name) }
    {
      separator = index($0, ":")
      if (!separator) next
      name = tolower(trim(substr($0, 1, separator - 1)))
      if (name == target_name) found = 1
    }
    END {
      if (found) exit 1
    }
  ' "$headers"
}

require_cache_control() {
  local headers="$1"
  local profile="$2"
  awk -v profile="$profile" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    {
      separator = index($0, ":")
      if (!separator) next
      name = tolower(trim(substr($0, 1, separator - 1)))
      if (name != "cache-control") next
      field_count++
      value = substr($0, separator + 1)
      token_count = split(value, tokens, ",")
      for (index_token = 1; index_token <= token_count; index_token++) {
        token = tolower(trim(tokens[index_token]))
        total++
        if (profile == "image") {
          if (token == "public") public_count++
          else if (token == "immutable") immutable_count++
          else if (token == "max-age=2592000") max_age_count++
          else invalid = 1
        } else {
          if (token == "private") private_count++
          else if (token == "no-store") no_store_count++
          else invalid = 1
        }
      }
    }
    END {
      if (!field_count || invalid) exit 1
      if (profile == "image") {
        if (total != 3 || public_count != 1 || immutable_count != 1 || max_age_count != 1) exit 1
      } else {
        if (total != 2 || private_count != 1 || no_store_count != 1) exit 1
      }
    }
  ' "$headers"
}

require_vary() {
  local headers="$1"
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    {
      separator = index($0, ":")
      if (!separator) next
      name = tolower(trim(substr($0, 1, separator - 1)))
      if (name != "vary") next
      field_count++
      value = substr($0, separator + 1)
      token_count = split(value, tokens, ",")
      for (index_token = 1; index_token <= token_count; index_token++) {
        token = tolower(trim(tokens[index_token]))
        if (token == "" || token == "*" || token !~ /^[[:alnum:]-]+$/) invalid = 1
        if (token == "cookie") cookie_count++
        if (token == "accept-language") language_count++
      }
    }
    END {
      if (!field_count || invalid || cookie_count != 1 || language_count != 1) exit 1
    }
  ' "$headers"
}

FIRST_STATUS="$(curl -q --proto '=https' --globoff -sS --max-time 30 -D "$FIRST_RAW_HEADERS" -o /dev/null -w '%{http_code}' -- "$SMOKE_URL")"
extract_final_headers "$FIRST_RAW_HEADERS" "$FIRST_HEADERS"
sleep 1
SECOND_STATUS="$(curl -q --proto '=https' --globoff -sS --max-time 30 -D "$SECOND_RAW_HEADERS" -o /dev/null -w '%{http_code}' -- "$SMOKE_URL")"
extract_final_headers "$SECOND_RAW_HEADERS" "$SECOND_HEADERS"
ROOT_STATUS="$(curl -q --proto '=https' --globoff -sS --max-time 30 -D "$ROOT_RAW_HEADERS" -o /dev/null -w '%{http_code}' -- https://blog.cokedaily.space/)"
extract_final_headers "$ROOT_RAW_HEADERS" "$ROOT_HEADERS"
ZH_HOME_STATUS="$(curl -q --proto '=https' --globoff -sS --max-time 30 -D "$ZH_HOME_RAW_HEADERS" -o /dev/null -w '%{http_code}' -- https://blog.cokedaily.space/zh/)"
extract_final_headers "$ZH_HOME_RAW_HEADERS" "$ZH_HOME_HEADERS"
EN_HOME_STATUS="$(curl -q --proto '=https' --globoff -sS --max-time 30 -D "$EN_HOME_RAW_HEADERS" -o /dev/null -w '%{http_code}' -- https://blog.cokedaily.space/en/)"
extract_final_headers "$EN_HOME_RAW_HEADERS" "$EN_HOME_HEADERS"

test "$FIRST_STATUS" = 200
test "$SECOND_STATUS" = 200
test "$ROOT_STATUS" = 302
test "$ZH_HOME_STATUS" = 200
test "$EN_HOME_STATUS" = 200
for headers in "$FIRST_HEADERS" "$SECOND_HEADERS"; do
  require_singleton_header "$headers" content-type image/webp
  require_cache_control "$headers" image
done
require_singleton_header "$FIRST_HEADERS" cf-cache-status MISS
require_singleton_header "$SECOND_HEADERS" cf-cache-status HIT
require_singleton_header "$ROOT_HEADERS" location /zh/ false
require_vary "$ROOT_HEADERS"
require_cache_control "$ROOT_HEADERS" private
require_singleton_header "$ROOT_HEADERS" cf-cache-status DYNAMIC
forbid_header "$ROOT_HEADERS" age
for headers in "$ZH_HOME_HEADERS" "$EN_HOME_HEADERS"; do
  require_cache_control "$headers" private
  require_singleton_header "$headers" cf-cache-status DYNAMIC
  forbid_header "$headers" age
done
```

若未来允许图片在同一路径原地更新，发布后还必须 purge 对应 URL，或继续改用带版本的新文件名。

#### Cloudflare 错误响应缓存防护

应用必须为所有 HTML 4xx/5xx 设置 `Cache-Control: private, no-store`，为所有 `/api/*` 响应设置 `Cache-Control: no-store`，并移除错误响应上的 `Expires`。这包括静态文件未命中后生成的 HTML 404、audio 404、API 404、真实 HTML/API 500 及请求解析错误，防止 `.webp` 等默认可缓存扩展把错误页面变成共享负缓存。

##### 规则写入契约（不可放宽）

Cloudflare Zone 必须保留以下 Cache Response Rule，作为所有 hostname 的纵深防护；它只影响错误响应，不改变成功 2xx 图片和静态资源的缓存：

- 规则名：`Do not cache error responses`
- Phase：`http_response_cache_settings`
- 状态：`enabled: true`
- 匹配表达式：`(http.response.code ge 400)`
- Action：`set_cache_control`
- Action parameters：

  ```json
  {"no-store":{"operation":"set","cloudflare_only":true}}
  ```

`cloudflare_only: true` 只阻止 Cloudflare 存储错误对象；浏览器看到的 Blog 错误响应仍由应用自己的 `private, no-store` 契约控制。写入现有 phase 时使用单规则 Create/Update API 并保留其他规则；禁止用未包含完整现有规则列表的 entrypoint `PUT`，因为它会替换整个 ruleset。

该规则必须是 phase 的 `.result.rules` 数组中**最后一条 Enabled 的 `set_cache_control` 规则**。Cloudflare 对同一设置采用后置匹配规则覆盖前置规则；只要目标规则之后还存在任何 Enabled 的 `set_cache_control` 规则，就必须停止发布并先重排或审查，不能仅凭目标规则存在便继续。

##### 控制面回读与冲突审计（强制）

每次创建、更新或重排后，都必须重新执行控制面 GET；不得把写入请求的响应当作回读：

```text
GET /zones/$ZONE_ID/rulesets/phases/http_response_cache_settings/entrypoint
```

对新取得的 `.result.rules` 按数组顺序检查，并保留脱敏证据：

1. `Do not cache error responses` 恰好出现一次；
2. 该规则的 `enabled` 严格等于 `true`；
3. `phase`、表达式、Action 和 Action parameters 与上面的契约逐字一致；
4. 该规则的数组下标等于所有 `enabled == true && action == "set_cache_control"` 规则中的最大下标，即它之后没有 Enabled 的 `set_cache_control` 规则；
5. 若回读不存在该 phase、规则重复、规则 Disabled、字段不一致或存在后置冲突，均为发布阻塞项。

##### Cloudflare Trace 终态验证（强制）

控制面回读后，使用 Cloudflare Trace API（或 Dashboard Trace）对 Blog 的全新缺失 URL 发起真实源站响应 Trace；`skip_response` 必须为 `false`，否则无法得到 `http.response.code`：

```text
POST /accounts/$ACCOUNT_ID/request-tracer/trace
{"method":"GET","url":"https://blog.cokedaily.space/<trace-nonce>.webp","skip_response":false}
```

Trace 必须显示 `result.status_code >= 400`，并出现一条 `description == "Do not cache error responses"`、`matched == true`、`action == "set_cache_control"` 且 `action_parameters.no-store.operation == "set"`、`cloudflare_only == true` 的执行记录。Inactive/Disabled 规则不会进入 Trace；若目标规则未匹配，或它之后出现任何 matched 的 `set_cache_control` 记录，则停止发布。若 API Token 没有 Request Tracer Read 权限，必须在 Dashboard 使用同一输入完成 Trace；不能以规则创建成功代替终态验证。

##### Purge 与公网验证

部署该规则后必须 purge 已经观察到的错误 URL；若无法完整枚举 Blog 的旧错误对象，则 purge `blog.cokedaily.space` hostname，再重新预热真实图片。

每次开放后使用全新 nonce 连续请求两次以下路径：

- `https://blog.cokedaily.space/images/<nonce>.webp`
- `https://blog.cokedaily.space/imagesx/<nonce>.webp`
- `https://blog.cokedaily.space/<nonce>.webp`
- 同一 Zone 下的非目标 hostname 上一个全新 `<nonce>.webp`

Blog 的 HTML 404 必须为 `private, no-store`；所有目标连续两次请求都不得出现 `CF-Cache-Status: HIT` 或 `Age`。这组公网请求验证真实边缘效果，但不能替代上面的控制面回读和 Trace。同时重新验证两张真实 WebP 仍为 `MISS → HIT`，证明错误响应防护没有破坏成功图片缓存。

#### Cloudflare 图片缓存确定性回滚

图片缓存必须保留两条范围完全相同、顺序固定的 Cache Rule：

1. `Cache blog images at Cloudflare edge`：`Eligible for cache`，Edge TTL 遵循源站，保持 Enabled。
2. `Emergency bypass blog image cache`：`Bypass cache`，正常状态为 Disabled；Bypass cache 在请求阶段取消缓存资格，因此启用后预期为 `CF-Cache-Status: DYNAMIC`。它必须排在 `Cache blog images at Cloudflare edge` 之后，使后置设置覆盖前面的缓存资格。

两条规则都只能匹配 `(http.host eq "blog.cokedaily.space" and http.request.uri.path wildcard r"/images/*")`。不得通过禁用主缓存规则来回滚，因为已经驻留在边缘的对象可能继续命中；确定性回滚需要后置 Bypass 和前缀 purge 同时执行。

发布前必须在 Nginx 维护门仍开启时完成一次演练：

1. 确认 Bypass 规则 Disabled。从生产主机（维护 allowlist）请求一个带唯一查询串的现有 WebP 两次，记录 `MISS → HIT`；再从非 allowlist 客户端确认同一 URL 可命中该缓存对象。
2. 启用 `Emergency bypass blog image cache`，通过 Rulesets API 或 Dashboard 读回确认 `enabled=true`，并确认它仍位于主缓存规则之后。
3. purge `/images/*` 前缀。API 使用 `POST /zones/$ZONE_ID/purge_cache`，请求体必须是：

   ```json
   {"prefixes":["blog.cokedaily.space/images"]}
   ```

4. 从非 allowlist 公网客户端重新请求演练 URL 和一个不带查询串的现有 WebP，必须观察到 `HIT → DYNAMIC → 503`，且没有 `Age`。这证明维护期间不会继续泄漏先前缓存的图片 200。
5. 演练后保持 Bypass Enabled，直到正式开放前的最后一步。

正式开放顺序：

1. 再次确认应用、数据库审计、PM2、Nginx 配置和维护态公网 503 均正常。
2. 将 `Emergency bypass blog image cache` 设为 Disabled，并从 API 读回确认；此时前缀已经 purge，维护门仍阻止公开源站响应。
3. 注释 Nginx 的 maintenance include，运行 `nginx -t`，再 reload。
4. 立即运行上面的完整 post-open smoke，确认图片 `MISS → HIT`，HTML 为 `DYNAMIC`/`private, no-store`。

若开放后的任一门禁失败，按以下顺序回滚，不得调换：

1. 启用 `Emergency bypass blog image cache` 并读回确认。
2. purge `/images/*` 前缀，并确认 Cloudflare API 返回成功。
3. 启用 Nginx 维护门，执行 `nginx -t` 后 reload。
4. 从非 allowlist 客户端确认 `/` 与现有图片均为 503；图片必须是 `CF-Cache-Status: DYNAMIC` 且没有 `Age`。
5. 捕获切换后的数据库、文章、音频和日志证据，再决定前向修复或协调回滚；不得盲目恢复发布前数据库。

正常稳定状态下，主缓存规则保持 Enabled，后置 Bypass 规则保持 Disabled，便于下一次紧急回滚只做一次受控启用。Cloudflare Token 不得写入仓库、命令历史、PM2 环境或发布证据；使用后必须从临时文件和 shell 环境清除。

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

SQLite 使用 WAL；不要在应用运行时直接 `cp blog.db`，否则可能漏掉已提交的 WAL 页面。项目内置在线备份会生成事务一致的临时文件、执行 `integrity_check`，验证成功后再原子改名：

```bash
cd /path/to/blog
npm run backup-db
```

默认部署不会自动安装备份计划。确认手工备份与恢复演练通过后，再显式配置 cron，例如每天凌晨 2 点：

```cron
0 2 * * * cd /path/to/blog && /usr/bin/npm run backup-db >> /var/log/blog-backup.log 2>&1
```

`articles/`、`public/images/` 和 `public/audio/` 仍需按部署平台的文件备份策略保存；数据库备份不能替代这些发布资产。

### 更新应用

```bash
# 1. 拉取最新代码
git pull

# 2. 安装新锁定依赖
npm ci

# 3. 在重启前完成数据库备份、迁移与验证
npm run backup-db
npm run migrate-db
npm test

# 4. 重启应用（PM2 会优雅重启，无停机）
pm2 restart blog --update-env
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
# 清理上传临时文件：仅当共享操作锁 var/operations/active.lock 不存在时允许。
# 该命令绝不能以 var/operations 为目标，也不能删除其中的清单/锁。
rm -rf uploads/temp/*

# 清理日志（可选）
pm2 flush blog
```

`var/operations/` 是持久的操作登记处：操作清单与 `active.lock` 只能由验证成功的 apply/recovery 删除；通用临时文件清理不得触碰它。

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

#### Nginx `/images/*` 返回 403

如果图片文件存在、Express 的 `http://127.0.0.1:3000/images/<file>.webp` 返回 200，但 HTTPS 经 Nginx 返回 403，请确认安装的 `deploy/nginx/blog.conf` 中 `/images/` 使用不带 URI 尾斜杠的 `proxy_pass http://127.0.0.1:3000;`，而不是指向 `/root/Blog/public/images/` 的 `alias`。缺失图片仍应由 Express 返回原有错误状态；状态映射的 `add_header Cache-Control $blog_image_cache_control always;` 必须保留 `always`，才能让 4xx/5xx 收到 `private, no-store`。禁止的是固定成功值 `add_header Cache-Control "public, immutable" always;`，因为它会把成功缓存策略错误地附加到失败响应。

**不要**通过放宽 `/root` 的目录权限、给 Nginx worker（通常为 `www-data`）授予 `/root` ACL，或把 Nginx worker 提升为 root/其他高权限用户来修复图片 403；这些做法扩大了权限边界。应保持 `/root` 不可遍历，并让 Nginx 通过现有 loopback Express 服务读取 `/images/*`。

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

# 静态缓存：只按已知路径前缀缓存（/css/、/js/、/vendor/、/fonts/、/images/、
# 精确的 /favicon.ico）。禁止扩展名正则缓存，以免带点的 taxonomy HTML
# 路由（如 /zh/tag/Node.js）被误判为静态资源。
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
- [x] 限制文件上传大小（应用文件上限 100 MiB，Nginx 请求上限 101 MiB）
- [x] 监控日志异常访问

---

## 依赖说明

### 核心功能包 (17 个生产依赖)

#### Web 框架
- **express** (5.2.1): HTTP 服务器和路由
- **ejs** (6.0.1): HTML 模板引擎

#### 数据存储
- **better-sqlite3** (12.11.1): SQLite 同步驱动，支持 Node.js 24

#### Markdown 处理
- **markdown-it** (14.3.0): Markdown → HTML 解析器（原始 HTML 默认作为文本处理）
- **markdown-it-anchor** (9.2.1): 为标题生成锚点 id
- **highlight.js** (11.11.1): 服务端代码高亮
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

1. ✅ **极简原则**: 仅 17 个生产依赖，避免过度依赖
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
