#!/usr/bin/env bash
# Pull the newest commit from the deploy branch and restart the daemon.
# Run on the server with sudo:  sudo bash /opt/dsh/repo/deploy/update.sh [branch]
set -euo pipefail

REPO=/opt/dsh/repo
NODE_DIR=/opt/dsh/node
BRANCH_FILE=/etc/dsh/deploy-branch
BRANCH="${1:-$(cat "$BRANCH_FILE" 2>/dev/null || echo deploy/seoul)}"

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行本脚本" >&2
  exit 1
fi
if [[ ! -d "$REPO/.git" ]]; then
  echo "$REPO 不是 git 工作树，请先跑 bootstrap.sh install" >&2
  exit 1
fi

cd "$REPO"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "$REPO 有未提交改动，拒绝覆盖；请先手工处理" >&2
  exit 1
fi

OLD="$(git rev-parse HEAD)"
echo "==> 拉取 $BRANCH"
git fetch --depth 1 origin "$BRANCH"
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git reset --hard -q "origin/$BRANCH"
NEW="$(git rev-parse HEAD)"
echo "    $OLD -> $NEW"

if [[ "$OLD" != "$NEW" ]]; then
  echo "==> 同步依赖"
  PATH="$NODE_DIR/bin:$PATH" pnpm install --frozen-lockfile
  echo "==> 重启 daemon"
  systemctl restart dsh-daemon
  sleep 2
  systemctl --no-pager status dsh-daemon | head -12
else
  echo "    代码未变化，跳过依赖安装和重启"
fi
