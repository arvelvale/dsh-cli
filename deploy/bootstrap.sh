#!/usr/bin/env bash
# Server-side bootstrap for the git-based deployment.
#
#   sudo bash deploy/bootstrap.sh init-key
#   sudo bash deploy/bootstrap.sh install <https-domain> [branch] [repo-ssh-url]
#
# No source tarball is copied from the workstation. The server clones the repo
# over SSH with a read-only GitHub deploy key; all later updates are git fetch.
set -euo pipefail

REPO_DIR=/opt/dsh/repo
SSH_DIR=/root/.ssh
KEY="$SSH_DIR/dsh_deploy"
BRANCH_FILE=/etc/dsh/deploy-branch
DEFAULT_BRANCH="${DSH_BRANCH:-deploy/seoul}"
DEFAULT_REPO="${DSH_REPO_SSH:-git@github.com:arvelvale/dsh-cli.git}"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "请用 sudo 运行: sudo bash $0 $*" >&2
    exit 1
  fi
}

init_key() {
  require_root "$@"
  echo "==> 生成服务器专用 SSH deploy key"
  for bin in ssh-keygen ssh-keyscan ssh git; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      echo "缺少 $bin，请先: apt-get update && apt-get install -y git openssh-client" >&2
      exit 1
    fi
  done

  mkdir -p "$SSH_DIR/config.d"
  chmod 700 "$SSH_DIR"
  if [[ ! -f "$KEY" ]]; then
    ssh-keygen -t ed25519 -C "dsh-deploy-$(hostname)" -f "$KEY" -N "" >/dev/null
  fi
  chmod 600 "$KEY" "$KEY.pub"

  cat > "$SSH_DIR/config.d/dsh-deploy.conf" <<EOF
Host github.com
    HostName github.com
    User git
    IdentityFile $KEY
    IdentitiesOnly yes
EOF
  chmod 600 "$SSH_DIR/config.d/dsh-deploy.conf"

  if [[ ! -f "$SSH_DIR/config" ]]; then
    printf 'Include config.d/*.conf\n' > "$SSH_DIR/config"
  elif ! grep -qF 'Include config.d/*.conf' "$SSH_DIR/config"; then
    { printf 'Include config.d/*.conf\n\n'; cat "$SSH_DIR/config"; } > "$SSH_DIR/config.tmp"
    mv "$SSH_DIR/config.tmp" "$SSH_DIR/config"
  fi
  chmod 600 "$SSH_DIR/config"

  if ! grep -q 'github.com' "$SSH_DIR/known_hosts" 2>/dev/null; then
    ssh-keyscan -t ed25519 github.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
  fi
  if ! grep -q 'github.com' "$SSH_DIR/known_hosts" 2>/dev/null; then
    echo "拿不到 github.com 的 host key，请检查服务器出网/DNS" >&2
    exit 1
  fi
  chmod 600 "$SSH_DIR/known_hosts"

  echo
  echo "==================== 把下面这段公钥填到 GitHub ===================="
  cat "$KEY.pub"
  echo "===================================================================="
  echo
  echo "位置: GitHub -> 仓库 -> Settings -> Deploy keys -> Add deploy key"
  echo "Title 填服务器名字；不要勾选 Allow write access（只读即可）"
  echo
  echo "加完以后执行:"
  echo "  sudo bash $0 install <你的HTTPS域名> [分支名]"
}

install() {
  require_root "$@"
  local domain="${1:?用法: install <HTTPS 域名> [分支] [仓库SSH地址]}"
  local branch="${2:-$DEFAULT_BRANCH}"
  local repo="${3:-$DEFAULT_REPO}"

  if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "域名不合法: $domain" >&2
    exit 1
  fi

  echo "==> 1/4 验证 GitHub SSH 认证（deploy key）"
  local auth
  auth="$(ssh -T -o BatchMode=yes -o ConnectTimeout=15 git@github.com 2>&1 || true)"
  if ! printf '%s' "$auth" | grep -q 'successfully authenticated'; then
    echo "SSH 认证失败: $auth" >&2
    echo "先执行 init-key，并把公钥加进仓库的 Deploy keys" >&2
    exit 1
  fi
  printf '%s\n' "$auth"

  echo "==> 2/4 拉取代码到 $REPO_DIR（分支 $branch）"
  mkdir -p /opt/dsh
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    git clone --depth 1 --branch "$branch" "$repo" "$REPO_DIR"
  else
    if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
      echo "$REPO_DIR 有未提交改动，拒绝覆盖；请先手工处理" >&2
      exit 1
    fi
    git -C "$REPO_DIR" fetch --depth 1 origin "$branch"
    git -C "$REPO_DIR" checkout -q -B "$branch" "origin/$branch"
    git -C "$REPO_DIR" reset --hard -q "origin/$branch"
  fi

  echo "==> 3/4 校验检出的代码"
  for f in pnpm-lock.yaml apps/cli/src/tui-panels.ts deploy/setup.sh; do
    if [[ ! -f "$REPO_DIR/$f" ]]; then
      echo "缺少 $REPO_DIR/$f" >&2
      echo "远端分支 $branch 不是最新代码，请先在开发机把提交 push 上去" >&2
      exit 1
    fi
  done
  git -C "$REPO_DIR" log -1 --oneline

  mkdir -p /etc/dsh
  printf '%s\n' "$branch" > "$BRANCH_FILE"

  echo "==> 4/4 安装依赖并启动服务"
  bash "$REPO_DIR/deploy/setup.sh" "$domain"
}

case "${1:-}" in
  init-key) shift; init_key "$@" ;;
  install) shift; install "$@" ;;
  *)
    echo "用法:" >&2
    echo "  sudo bash $0 init-key" >&2
    echo "  sudo bash $0 install <HTTPS 域名> [分支] [仓库SSH地址]" >&2
    exit 1
    ;;
esac
