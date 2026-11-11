#!/usr/bin/env bash
# Executed on the server with sudo, from inside the cloned repository.
# Called by bootstrap.sh install, but safe to re-run on its own (idempotent).
set -euo pipefail
umask 022

DOMAIN="${1:?用法: setup.sh <HTTPS 域名>}"
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行本脚本" >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "域名不合法: $DOMAIN" >&2
  exit 1
fi

REPO=/opt/dsh/repo
NODE_DIR=/opt/dsh/node
NODE_VERSION=24.21.0
NODE_SHA=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
PNPM_VERSION=11.28.5

echo "==> 1/8 安装系统依赖 (Ubuntu 22.04)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssh-client tar xz-utils ufw python3 build-essential \
  gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! apt-get install -y -qq caddy; then
  echo "    apt 源未提供 caddy，改用官方稳定源"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
caddy version

echo "==> 2/8 安装 Node $NODE_VERSION（校验仓库 lock.json 中的官方 SHA256）"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  mkdir -p "$NODE_DIR" /tmp/dsh-node
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
    -o /tmp/dsh-node/node.tar.gz
  echo "${NODE_SHA}  /tmp/dsh-node/node.tar.gz" | sha256sum -c -
  tar -xzf /tmp/dsh-node/node.tar.gz -C /tmp/dsh-node
  cp -a "/tmp/dsh-node/node-v${NODE_VERSION}-linux-x64/." "$NODE_DIR/"
fi
"$NODE_DIR/bin/node" -v

echo "==> 3/8 安装 pnpm $PNPM_VERSION"
PATH="$NODE_DIR/bin:$PATH" npm install -g "pnpm@${PNPM_VERSION}"
PATH="$NODE_DIR/bin:$PATH" pnpm --version

echo "==> 4/8 校验 git 工作树并安装依赖（这一步最慢，通常 5-20 分钟）"
if [[ ! -d "$REPO/.git" ]]; then
  echo "$REPO 不是 git 工作树，请先跑 bootstrap.sh install" >&2
  exit 1
fi
cd "$REPO"
git log -1 --oneline
PATH="$NODE_DIR/bin:$PATH" pnpm install --frozen-lockfile

echo "==> 5/8 创建服务用户、目录与随机 Token"
if ! id -u dsh >/dev/null 2>&1; then
  useradd --system --home /var/lib/dsh --shell /usr/sbin/nologin dsh
fi
mkdir -p /var/lib/dsh /srv/dsh/workspace /etc/dsh
chown -R dsh:dsh /var/lib/dsh /srv/dsh/workspace
umask 077
if [[ ! -f /etc/dsh/daemon-token ]]; then
  "$NODE_DIR/bin/node" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' \
    > /etc/dsh/daemon-token
fi
chmod 600 /etc/dsh/daemon-token
if [[ ! -f /etc/dsh/provider.env ]]; then
  printf '# 填入模型凭证后执行: systemctl restart dsh-daemon\n# DEEPSEEK_API_KEY=sk-...\n' > /etc/dsh/provider.env
  chmod 600 /etc/dsh/provider.env
fi

echo "==> 6/8 写入 systemd unit 与 Caddyfile"
umask 022
BACKUP="/opt/dsh/backups/setup-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$BACKUP"
for config in /etc/systemd/system/dsh-daemon.service /etc/caddy/Caddyfile; do
  if [[ -f "$config" ]]; then
    cp -a "$config" "$BACKUP/$(basename "$config")"
  fi
done
sed "s/__DOMAIN__/${DOMAIN}/g" "$HERE/dsh-daemon.service.template" > /etc/systemd/system/dsh-daemon.service
sed "s/__DOMAIN__/${DOMAIN}/g" "$HERE/Caddyfile.template" > /etc/caddy/Caddyfile
chmod 644 /etc/systemd/system/dsh-daemon.service /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload

echo "==> 7/8 放行本机防火墙（云控制台的防火墙仍需单独放行 80/443）"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null 2>&1 || true

echo "==> 8/8 启动服务"
systemctl enable dsh-daemon
systemctl restart dsh-daemon
systemctl restart caddy
TOKEN="$(cat /etc/dsh/daemon-token)"
CHECK_REQUEST='{"type":"client-request","method":"session/list","rpcId":"deploy-check","payload":{"args":{"_request":{}}}}'
READY=0
for ((attempt = 0; attempt < 60; attempt++)); do
  if curl -fsS --connect-timeout 2 --max-time 3 \
    -H "Host: ${DOMAIN}" -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' --data "$CHECK_REQUEST" \
    http://127.0.0.1:3080/api/session/list 2>/dev/null \
    | python3 -c 'import json, sys; sys.exit(0 if json.load(sys.stdin).get("result", {}).get("ok") is True else 1)' 2>/dev/null; then
    READY=1
    break
  fi
  sleep 2
done
if [[ "$READY" != 1 ]]; then
  echo "Daemon 鉴权接口未就绪。请检查 journalctl -u dsh-daemon -n 50" >&2
  exit 1
fi
systemctl is-active dsh-daemon
systemctl is-active caddy
echo
echo "==> 自检（证书首次签发需要公网 80 可达，可能要等 1-2 分钟）"
curl -sS --fail --resolve "${DOMAIN}:443:127.0.0.1" \
  -X POST -H 'Content-Type: application/json' \
  --data "$CHECK_REQUEST" \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${DOMAIN}/api/session/list" | head -c 300 \
  || echo "（暂时不可用：查看 journalctl -u caddy -u dsh-daemon -n 50）"
echo
echo "================================================================"
echo " 手机 App 服务器地址 : https://${DOMAIN}"
echo " Daemon Token        : ${TOKEN}"
echo " 部署分支            : $(cat /etc/dsh/deploy-branch 2>/dev/null || echo unknown)"
echo " 代码版本            : $(git -C "$REPO" rev-parse --short HEAD)"
echo "================================================================"
echo "请把上面几行保存到密码管理器。Token 等同 Host 管理员权限，不要外传。"
echo "模型 Key: 编辑 /etc/dsh/provider.env 后 systemctl restart dsh-daemon"
echo "代码更新: sudo bash $REPO/deploy/update.sh"
