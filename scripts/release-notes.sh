#!/usr/bin/env bash
# 根据上一个 tag 到当前 tag 的提交生成 Release 说明。
# 用法：bash scripts/release-notes.sh v1.0.12
set -euo pipefail

TAG="${1:?usage: release-notes.sh <tag>}"
PREV_TAG="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"

if [[ -n "$PREV_TAG" ]]; then
  NOTES="$(git log --no-merges --reverse --pretty=format:'- %s' "${PREV_TAG}..${TAG}" \
    | grep -vE '^- (chore|ci)(\(|:)' || true)"
else
  NOTES="$(git log --no-merges --reverse --pretty=format:'- %s' "$TAG" \
    | head -n 50 \
    | grep -vE '^- (chore|ci)(\(|:)' || true)"
fi

if [[ -z "$NOTES" ]]; then
  NOTES="- 本次发布包含维护性更新。"
fi

printf '## 更新内容\n\n%s\n' "$NOTES"
