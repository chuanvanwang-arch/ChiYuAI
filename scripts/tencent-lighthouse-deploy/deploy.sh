#!/usr/bin/env bash
# CRM-ai-native 一键部署脚本（在腾讯云 Lighthouse / 任意 Ubuntu + Docker 主机上运行）
# 前置：项目已放置到 /opt/crm-ai-native（git clone 或本地打包解压），且已安装 docker + docker compose
# 用法：bash deploy.sh
#       （首次运行会生成 .env 提示填密码；填好后重跑一次即完成部署）
#       （需要灌种子数据时：bash deploy.sh --seed）
#       （检测到 crm-pg-age:pg16 镜像时自动叠加 docker-compose.age.yml；
#         强制回到纯 pgvector 用 --no-age，会丢失 AGE，生产慎用）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

WANT_SEED=false
WANT_AGE_UNSET=true        # 未显式指定 --no-age 时，按环境自动判定
for _a in "$@"; do
  case "$_a" in
    --seed)   WANT_SEED=true ;;
    --no-age) WANT_AGE_UNSET=false ;;   # 强制回到纯 pgvector（会丢 AGE，慎用于生产）
  esac
done

echo "==> 项目根: $PROJECT_ROOT"

# ---------- 0. 依赖检查 ----------
command -v docker >/dev/null 2>&1 || { echo "✗ 未安装 docker，请先安装（Lighthouse 选 Docker 镜像或 apt install docker.io）"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✗ 未安装 docker compose 插件：sudo apt-get update && sudo apt-get install -y docker-compose-plugin"; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ 当前用户无 docker 权限，请执行：sudo usermod -aG docker \$USER && newgrp docker"; exit 1; }

# ---------- 1. .env 生成与密码校验 ----------
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "✓ 已生成 $SCRIPT_DIR/.env"
  echo ""
  echo "⚠ 下一步：编辑该文件，把 PGPASSWORD 改成强密码，然后重新运行："
  echo "    bash $0"
  exit 0
fi

if grep -qE '^PGPASSWORD=(请改成强密码|change_me|)$' "$SCRIPT_DIR/.env"; then
  echo "✗ $SCRIPT_DIR/.env 中的 PGPASSWORD 仍是占位值，请先改成强随机密码："
  echo "    sed -i \"s|^PGPASSWORD=.*|PGPASSWORD=\$(openssl rand -base64 24 | tr -d '/+=')|\" $SCRIPT_DIR/.env"
  exit 1
fi
chmod 600 "$SCRIPT_DIR/.env"

# ---------- 2.5 解析 compose 文件栈（AGE 安全闸，勿删） ----------
# 背景（2026-09-04 生产事故隐患）：db 镜像已从 pgvector/pgvector:pg16 换成自建 crm-pg-age:pg16
# （AGE 1.6.0 决策网络图）。若只用 docker-compose.yml 执行 up -d --build，compose 会按主文件
# 把 db 重建回纯 pgvector → AGE 扩展/决策图全部失效，且不易察觉。
# 规则：只要本地存在 crm-pg-age:pg16 镜像，或存在 .age-enabled 标记，就自动叠加 override。
COMPOSE_FILES="-f $SCRIPT_DIR/docker-compose.yml"
AGE_DESIRED=false
if [ "$WANT_AGE_UNSET" = true ]; then
  if docker image inspect crm-pg-age:pg16 >/dev/null 2>&1 || [ -f "$SCRIPT_DIR/.age-enabled" ]; then
    AGE_DESIRED=true
  fi
fi
if [ "$AGE_DESIRED" = true ]; then
  [ -f "$SCRIPT_DIR/docker-compose.age.yml" ] || { echo "✗ 缺少 docker-compose.age.yml"; exit 1; }
  COMPOSE_FILES="$COMPOSE_FILES -f $SCRIPT_DIR/docker-compose.age.yml"
  echo "✓ AGE override 已叠加（db 镜像 crm-pg-age:pg16）"
else
  echo "· 使用纯 pgvector（未启用 AGE）"
fi

# 反向安全闸：正在运行的 db 已是 AGE 镜像，但本次解析未叠加 override → 立刻中止，防止静默丢失 AGE。
CUR_DB_IMAGE=$(docker inspect -f '{{.Config.Image}}' crm-pg 2>/dev/null || echo "")
if [ "$CUR_DB_IMAGE" = "crm-pg-age:pg16" ] && [ "$AGE_DESIRED" != true ]; then
  echo "✗ 中止：当前 db 容器运行的是 crm-pg-age:pg16，但本次未叠加 docker-compose.age.yml。"
  echo "  继续执行会把 db 重建为纯 pgvector，导致 Apache AGE / 决策网络图丢失。"
  echo "  如确有降级需求，请先确认已备份，再显式执行：bash $0 --no-age"
  exit 1
fi

# ---------- 2. 生成 .dockerignore ----------
# 项目根含大量 PNG 截图 / zip / 文档 / 前端子工程，不排除会让 build 上下文达数百 MB。
# 注意：docs/ 与 skills/ 都不能排除。
#   · docs/  —— src/http/routes.js 运行时会读取 docs/specs/*.md。
#   · skills/ —— src/skills/skillRegistry.js:16 与 methodologySync.js:25 以 <repo>/skills
#               为「出厂声明源」（扫 skills/*/registry.json）。排除后容器 /app/skills 缺失
#               → listSkillDeclarations() 恒返 0 → 启动日志 `[skill-registry] seed inserted=0/0`，
#               服务不报错但 DB skill_registry 只剩历史行（静默降级）。2026-09-11 实锤修复。
cat > .dockerignore <<'EOF'
node_modules
.git
.workbuddy
test
tmp
tmp_verify
scripts-qa
CordysCRM-main
Lanch
plugin
plugin-platform-admin
*.png
*.jpg
*.zip
*.log
*.mjs
npm-debug.log*
.env
scripts/tencent-lighthouse-deploy/.env
EOF

# 初始化脚本需要可执行位，否则 PG 容器 initdb 阶段不会执行它
chmod +x "$SCRIPT_DIR/init-pgvector.sh"

# ---------- 3. 国内镜像拉取兜底 ----------
# Docker Hub 在国内常受限；先直连，失败则用公共代理重拉并 retag。
pull_with_fallback() {
  local image="$1"
  if docker pull "$image" >/dev/null 2>&1; then
    echo "✓ 镜像就绪: $image"
    return 0
  fi
  echo "! 直连拉取失败: $image，尝试公共代理..."
  local proxy
  for proxy in "docker.m.daocloud.io" "dockerproxy.com" "hub.rat.dev"; do
    local proxy_img="${image%%/*}"
    if [ "$proxy_img" = "$image" ]; then
      proxy_img="${proxy}/library/${image}"
    else
      proxy_img="${proxy}/${image}"
    fi
    if docker pull "$proxy_img" >/dev/null 2>&1; then
      docker tag "$proxy_img" "$image"
      echo "✓ 经代理就绪: $image （来源 $proxy）"
      return 0
    fi
  done
  echo "✗ 无法拉取 $image。请到腾讯云控制台「容器镜像服务 → 镜像加速器」获取专属地址，"
  echo "   或手动执行：sudo tee /etc/docker/daemon.json <<<'{\"registry-mirrors\":[\"https://<你的加速器地址>\"]}' && sudo systemctl restart docker"
  return 1
}

echo "==> 预拉基础镜像"
pull_with_fallback "node:22-bookworm-slim"
pull_with_fallback "pgvector/pgvector:pg16"

# ---------- 4. 构建并启动 ----------
# 分两条命令：db 单独 up（仅在镜像/配置变更时重建，避免日常发布误动数据库），
# app/mcp 才 --build（承载业务代码）。首次部署 db 不存在时第一条会完成创建。
echo "==> 启动/校验数据库容器（不强制重建）"
docker compose $COMPOSE_FILES --env-file "$SCRIPT_DIR/.env" up -d db

echo "==> 构建并重启应用容器（app + mcp，代码在此注入镜像）"
docker compose $COMPOSE_FILES --env-file "$SCRIPT_DIR/.env" up -d --build app mcp

echo "==> 等待数据库就绪..."
for i in $(seq 1 30); do
  if docker compose $COMPOSE_FILES exec -T db pg_isready -U "${PGUSER:-agent2b}" >/dev/null 2>&1; then
    echo "✓ PostgreSQL 就绪"; break
  fi
  sleep 2
done

# ---------- 5. 可选：灌种子数据 ----------
# 红线：迁移（migrate）只建表结构，不含业务数据；seed 会写入租户/用户/商机等初始数据。
# 生产库执行 seed 前务必确认种子内容是否为真实数据，勿把本地 demo 数据当生产数据。
if [ "$WANT_SEED" = true ]; then
  echo "==> 执行种子数据（node db/migrate.js --seed）"
  docker compose $COMPOSE_FILES exec -T app node db/migrate.js --seed
else
  echo "· 跳过种子数据（仅建表）。如需初始数据请执行：bash $0 --seed"
fi

# ---------- 6. 就绪与自测 ----------
echo "==> 等待服务就绪..."
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null || echo "000")
  [ "$code" != "000" ] && break
  sleep 2
done

docker compose $COMPOSE_FILES ps
echo ""
echo "==> 本机自测: HTTP $code (http://127.0.0.1:3000/)"

# ---------- 7. Nginx 反代（若已安装）----------
if command -v nginx >/dev/null 2>&1; then
  echo "==> 配置 Nginx 反代"
  sudo cp "$SCRIPT_DIR/nginx-crm.conf" /etc/nginx/sites-available/crm 2>/dev/null || true
  sudo ln -sf /etc/nginx/sites-available/crm /etc/nginx/sites-enabled/crm 2>/dev/null || true
  sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  if sudo nginx -t 2>/dev/null; then
    sudo systemctl reload nginx 2>/dev/null || sudo systemctl restart nginx 2>/dev/null || true
    echo "✓ Nginx 反代已生效（80 → 3000）"
  else
    echo "（Nginx 配置未生效，请手动检查 /etc/nginx/sites-available/crm）"
  fi
else
  echo "· 未检测到 Nginx。如需 80 端口访问：sudo apt-get install -y nginx"
fi

echo ""
echo "════════════════════════════════════════════════"
echo "✓ 部署完成"
echo "  公网入口: http://<你的公网IP>/  → 301 → /landing.html（对外宣传页）"
echo "  直连 3000 /landing.html 亦可（测试端口，不必放通公网）"
echo "  查看日志: docker compose $COMPOSE_FILES --env-file $SCRIPT_DIR/.env logs -f app"
echo "  重启服务: docker compose $COMPOSE_FILES --env-file $SCRIPT_DIR/.env restart app"
echo ""
echo "⚠ 安全提醒："
echo "  1. 腾讯云 Lighthouse 控制台「防火墙」需放通 80/443（3000 不必放通，走 Nginx 即可）"
echo "  2. PostgreSQL 仅监听 127.0.0.1:5432，请勿改为 0.0.0.0"
echo "  3. $SCRIPT_DIR/.env 含数据库密码，已 chmod 600 且被 .gitignore 排除，勿提交仓库"
echo "════════════════════════════════════════════════"
