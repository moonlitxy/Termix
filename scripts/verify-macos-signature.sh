#!/usr/bin/env bash
# 校验 macOS 安装包的签名与公证状态（发版前/后自检用）。
# 用法：scripts/verify-macos-signature.sh <Termix_*.dmg>
# 退出码：0 = 签名与公证票据齐全；1 = 未通过（会打印具体原因）。
set -uo pipefail

DMG="${1:-}"
if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  echo "用法: $0 <Termix_*.dmg>" >&2
  echo "提示: npm run tauri build -- --bundles dmg 会输出到" >&2
  echo "      src-tauri/target/release/bundle/dmg/" >&2
  exit 1
fi

fail=0

echo "== Gatekeeper 安装包评估"
if spctl -a -vv --type install "$DMG" 2>&1; then
  echo "   ✅ accepted"
else
  echo "   ❌ 被拒绝（未签名或未公证）"
  fail=1
fi

echo
echo "== 公证票据装订"
if xcrun stapler validate "$DMG" 2>&1; then
  echo "   ✅ stapled"
else
  echo "   ❌ 没有有效公证票据"
  fail=1
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo "结论：签名与公证均通过，可发布。"
else
  echo "结论：未通过。请确认 CI 已配置 docs/signing.md 中的 6 个 Apple secrets。"
fi
exit "$fail"
