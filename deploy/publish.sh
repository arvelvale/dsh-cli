#!/usr/bin/env bash
# Publish the current HEAD as a snapshot commit on the deploy branch.
# Run on the workstation (Git Bash works):  bash deploy/publish.sh [branch]
#
# Why a snapshot commit instead of `git push dsh-cli master:deploy/seoul`:
# this checkout is shallow (see .git/shallow). The boundary commit is a merge
# whose parent objects are absent locally, so any push of master fails on the
# server with "did not receive expected object ... / index-pack failed".
# The fork itself stores source snapshots (main is a single root commit), so we
# build a fresh commit from HEAD's tree whose parent is the current deploy tip.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REMOTE="${DSH_REMOTE:-dsh-cli}"
BRANCH="${1:-${DSH_BRANCH:-deploy/seoul}}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作区有未提交改动；本脚本只发布已提交的 HEAD tree，请先 commit" >&2
  exit 1
fi

TREE="$(git rev-parse HEAD^{tree})"
PARENT="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1)"

if [[ -z "$PARENT" ]]; then
  echo "部署分支尚不存在，以 $REMOTE/main 的快照提交作为 parent"
  git fetch -q "$REMOTE" main
  PARENT="$(git rev-parse FETCH_HEAD)"
elif ! git cat-file -e "$PARENT^{commit}" 2>/dev/null; then
  echo "本地缺少父提交 $PARENT，正在 fetch"
  git fetch -q "$REMOTE" "$BRANCH"
fi

if ! git cat-file -e "$PARENT^{commit}" 2>/dev/null; then
  echo "拿不到父提交对象 $PARENT，中止" >&2
  exit 1
fi

NEW="$(printf '发布 DSH CLI 源码快照 %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | git commit-tree "$TREE" -p "$PARENT")"
echo "tree   : $TREE"
echo "parent : $PARENT"
echo "commit : $NEW"

git push --no-thin "$REMOTE" "$NEW:refs/heads/$BRANCH"
