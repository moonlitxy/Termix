#!/usr/bin/env bash
# 用真实构建产物做英文界面自检：起临时静态服务器 → 无头 Chrome 抓 DOM →
# 断言出现关键英文文案且主界面没有中文残留。
# 依赖：npm run build 产物、Google Chrome（macOS 默认路径，可用 CHROME 覆盖）。
# 用法：scripts/check-en-ui.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8899}"
DIST="$ROOT/dist"

[[ -f "$DIST/index.html" ]] || { echo "先运行 npm run build" >&2; exit 1; }
[[ -x "$CHROME" ]] || { echo "找不到 Chrome：$CHROME（可用 CHROME=... 指定）" >&2; exit 1; }

# 语言引导页：写入 en 后跳回主界面
cat > "$DIST/__lang-en.html" <<'HTML'
<!doctype html><meta charset="utf-8"><script>
localStorage.setItem("termix.settings", JSON.stringify({lang:"en"}));
location.replace("/index.html");
</script>
HTML

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$DIST/__lang-en.html"
}
trap cleanup EXIT

(cd "$DIST" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER_PID=$!
# 脱离作业控制，避免收尾 kill 时打印 "Terminated" 噪音
disown "$SERVER_PID" 2>/dev/null || true
sleep 1

DOM="$(mktemp)"
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --virtual-time-budget=10000 --dump-dom \
  "http://127.0.0.1:$PORT/__lang-en.html" 2>/dev/null > "$DOM"

fail=0
echo "== 英文文案"
for s in "Sessions" "Start a remote session" "Broadcast" "Resources"; do
  if grep -q "$s" "$DOM"; then echo "   ✅ $s"; else echo "   ❌ 缺少 $s"; fail=1; fi
done

echo "== 主界面中文残留"
for s in "会话" "未连接" "端口转发" "命令片段" "设置" "帮助" "同步输入" "快速新建"; do
  n="$(grep -c "$s" "$DOM" || true)"
  if [[ "$n" -eq 0 ]]; then echo "   ✅ 无「$s」"; else echo "   ❌ 仍有「$s」×$n"; fail=1; fi
done

rm -f "$DOM"
if [[ "$fail" -eq 0 ]]; then
  echo "结论：英文界面自检通过。"
else
  echo "结论：存在英文缺失或中文残留，请修复后重试。"
fi
exit "$fail"
