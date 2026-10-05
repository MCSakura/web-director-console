#!/usr/bin/env bash
# ============================================================
#  网页导播台 · 一键自部署脚本
#  用法（在任意一台 Linux 服务器上以 root 执行）：
#    curl -sSL http://43.139.182.16/install.sh | bash
#
#  或带参数：
#    SOURCE_URL=http://你的源服务器 curl -sSL http://43.139.182.16/install.sh | bash
#    WEB_PORT=8080 DM_PORT=9099 curl -sSL http://43.139.182.16/install.sh | bash
#
#  可覆盖的环境变量：
#    SOURCE_URL     源服务器地址（拉取部署包），默认 http://43.139.182.16
#    WEB_DIR        前端部署目录，默认 /opt/director-web
#    WEB_PORT       前端监听端口，默认 80
#    DM_DIR         弹幕网关源码目录，默认 /opt/danmaku-src
#    DM_PORT        弹幕网关端口，默认 8099
#    WEB_CONTAINER  前端容器名，默认 director-web
#    DM_CONTAINER   弹幕网关容器名，默认 danmaku-gateway
#    DM_IMAGE       弹幕网关镜像名，默认 danmaku-gateway:latest
#    DANMAKU_COOKIE B站登录 Cookie（可选，注入弹幕网关）
# ============================================================
set -euo pipefail

# ---------- 可配置项 ----------
SOURCE_URL="${SOURCE_URL:-http://43.139.182.16}"
TARBALL_URL="${TARBALL_URL:-${SOURCE_URL%/}/director-console.tar.gz}"
WEB_DIR="${WEB_DIR:-/opt/director-web}"
WEB_PORT="${WEB_PORT:-80}"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/opt/director-web-nginx}"
DM_DIR="${DM_DIR:-/opt/danmaku-src}"
DM_PORT="${DM_PORT:-8099}"
WEB_CONTAINER="${WEB_CONTAINER:-director-web}"
DM_CONTAINER="${DM_CONTAINER:-danmaku-gateway}"
DM_IMAGE="${DM_IMAGE:-danmaku-gateway:latest}"
DANMAKU_COOKIE="${DANMAKU_COOKIE:-}"

# ---------- 颜色输出 ----------
info() { echo -e "\033[1;34m[INFO]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[ OK ]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
err()  { echo -e "\033[1;31m[FAIL]\033[0m $*"; exit 1; }

# ---------- 前置检查 ----------
[ "$(id -u)" -eq 0 ] || err "请使用 root 用户运行（或 sudo bash）"

if ! command -v docker >/dev/null 2>&1; then
  warn "未检测到 docker，开始自动安装（仅支持 Debian/Ubuntu/CentOS）..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq docker.io curl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q docker curl && systemctl enable --now docker
  else
    err "无法自动安装 docker，请手动安装：https://docs.docker.com/engine/install/"
  fi
fi
command -v curl >/dev/null 2>&1 || err "未安装 curl，请先安装 curl"

# 启动 docker 服务（若未运行）
if ! docker info >/dev/null 2>&1; then
  warn "docker 服务未运行，尝试启动..."
  (systemctl start docker 2>/dev/null || service docker start 2>/dev/null) || err "无法启动 docker"
fi

# ---------- 下载部署包 ----------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "从 $TARBALL_URL 下载部署包..."
curl -fsSL "$TARBALL_URL" -o "$TMP/pkg.tar.gz" || err "下载失败，请检查 SOURCE_URL 或网络"
info "下载完成（$(du -h "$TMP/pkg.tar.gz" | cut -f1)）"

info "解压部署包..."
tar -xzf "$TMP/pkg.tar.gz" -C "$TMP"
[ -d "$TMP/web" ] || err "部署包结构异常：缺少 web/ 目录"
[ -d "$TMP/danmaku" ] || err "部署包结构异常：缺少 danmaku/ 目录"

# ============================================================
#  1. 部署导播台前端（nginx 容器）
# ============================================================
info "===== 1/2 部署导播台前端 ====="

mkdir -p "$WEB_DIR"
cp -rf "$TMP/web/." "$WEB_DIR/"
ok "前端文件已写入 $WEB_DIR"

# 生成 nginx 配置
mkdir -p "$NGINX_CONF_DIR"
cat > "$NGINX_CONF_DIR/default.conf" <<'NGINX'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ =404;
    }
}
NGINX
ok "nginx 配置已写入 $NGINX_CONF_DIR/default.conf"

# （重建）前端容器
if docker ps -a --format '{{.Names}}' | grep -qx "$WEB_CONTAINER"; then
  info "移除已有容器 $WEB_CONTAINER"
  docker rm -f "$WEB_CONTAINER" >/dev/null
fi
docker run -d \
  --name "$WEB_CONTAINER" \
  --restart unless-stopped \
  -p "${WEB_PORT}:80" \
  -v "${WEB_DIR}:/usr/share/nginx/html:ro" \
  -v "${NGINX_CONF_DIR}/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine >/dev/null
ok "前端容器 $WEB_CONTAINER 已启动（端口 $WEB_PORT）"

# ============================================================
#  2. 部署 B站弹幕网关（Docker 构建 + 运行）
# ============================================================
info "===== 2/2 部署 B站弹幕网关 ====="

mkdir -p "$DM_DIR"
cp -rf "$TMP/danmaku/." "$DM_DIR/"
ok "弹幕网关源码已写入 $DM_DIR"

info "构建镜像 $DM_IMAGE（首次需拉取 python 基础镜像，稍候）..."
docker build -t "$DM_IMAGE" "$DM_DIR" >/dev/null || err "镜像构建失败"

if docker ps -a --format '{{.Names}}' | grep -qx "$DM_CONTAINER"; then
  info "移除已有容器 $DM_CONTAINER"
  docker rm -f "$DM_CONTAINER" >/dev/null
fi

ENV_ARGS=()
[ -n "$DANMAKU_COOKIE" ] && ENV_ARGS=(-e "DANMAKU_COOKIE=$DANMAKU_COOKIE")

docker run -d \
  --name "$DM_CONTAINER" \
  --restart unless-stopped \
  -p "${DM_PORT}:8099" \
  "${ENV_ARGS[@]}" \
  "$DM_IMAGE" >/dev/null
ok "弹幕网关容器 $DM_CONTAINER 已启动（端口 $DM_PORT）"

# ============================================================
#  健康检查
# ============================================================
sleep 3
info "===== 健康检查 ====="

WEB_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" || echo '000')"
if [ "$WEB_CODE" = "200" ]; then
  ok "导播台前端 HTTP $WEB_CODE"
else
  warn "导播台前端 HTTP $WEB_CODE（请检查 $WEB_CONTAINER 容器日志）"
fi

DM_HEALTH="$(curl -s --max-time 8 "http://127.0.0.1:${DM_PORT}/health" || echo '')"
if echo "$DM_HEALTH" | grep -q '"ok"'; then
  ok "弹幕网关健康：$DM_HEALTH"
else
  warn "弹幕网关健康检查未通过：${DM_HEALTH:-无响应}（docker logs $DM_CONTAINER）"
fi

# ============================================================
#  部署摘要
# ============================================================
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "============================================================"
echo "  部署完成！"
echo "  导播台地址  : http://${HOST_IP}:${WEB_PORT}/"
echo "  弹幕网关地址: ws://${HOST_IP}:${DM_PORT}/danmaku"
if [ -n "$DANMAKU_COOKIE" ]; then
  echo "  B站 Cookie : 已注入"
else
  echo "  B站 Cookie : 未注入（弹幕昵称显示为 ***）"
fi
echo "  容器状态："
docker ps --filter name="$WEB_CONTAINER" --filter name="$DM_CONTAINER" \
  --format '    {{.Names}} | {{.Status}} | {{.Ports}}'
echo "============================================================"
