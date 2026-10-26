#!/usr/bin/env bash
# 探测 DSH 能否在无头（Linux/服务器）启动。
#
# 目的：决定「服务器方案」是否成立（见 docs/guides/TOPOLOGY.md 拓扑 B）。
# 只做探测：启动 → 等端口 → curl → 关掉。不改任何配置。
#
# 用法：
#   ./deploy/probe-dsh-headless.sh                     # 自动找 DSH 安装目录
#   ./deploy/probe-dsh-headless.sh --dsh-root /opt/dsh
#   ./deploy/probe-dsh-headless.sh --profile web --port 3080 --wait 20
set -uo pipefail

DSH_ROOT=""
PROFILE="web"
PORT="3080"
WAIT=15
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-root) DSH_ROOT="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --wait) WAIT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m[x]\033[0m %s\n' "$*"; }

command -v node >/dev/null || { bad "找不到 node"; exit 1; }

# ── 找 DSH 的 bin.js ───────────────────────────────────────────────────────
find_bin() {
  local roots=()
  [[ -n "$DSH_ROOT" ]] && roots+=("$DSH_ROOT")
  roots+=(
    "/opt/DeepSeek Harness/resources/app.asar.unpacked"
    "/opt/dsh"
    "$HOME/.dsh"
    "/usr/lib/deepseek-harness/resources/app.asar.unpacked"
  )
  for r in "${roots[@]}"; do
    [[ -d "$r" ]] || continue
    local hit
    hit="$(find "$r" -maxdepth 8 -type f -path '*@deepseek-ai/dsh/lib/bin.js' 2>/dev/null | head -1)"
    [[ -n "$hit" ]] && { echo "$hit"; return 0; }
  done
  return 1
}

BIN="$(find_bin || true)"
if [[ -z "$BIN" ]]; then
  bad "找不到 @deepseek-ai/dsh/lib/bin.js"
  echo "  说明：DSH 桌面版把它打包在 app.asar 里（不是普通目录）。"
  echo "  服务器方案需要 DSH 的 Linux 发行版/解包版；如果没有，请回到拓扑 A（家用机单机部署）。"
  exit 1
fi
ok "找到 DSH 入口：$BIN"

# ── 起进程 ─────────────────────────────────────────────────────────────────
LOG="$(mktemp /tmp/dsh-headless-XXXX.log)"
echo "  启动：node \"$BIN\" --profile $PROFILE --port $PORT"
node "$BIN" --profile "$PROFILE" --port "$PORT" >"$LOG" 2>&1 &
PID=$!
sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  bad "DSH 启动即退出（profile 可能依赖 Electron/桌面 API）"
  echo "  ---- 日志 ----"; tail -20 "$LOG"; echo "  -------------"
  exit 1
fi

# ── 等端口 ─────────────────────────────────────────────────────────────────
UP=0
for _ in $(seq 1 "$WAIT"); do
  sleep 1
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then exec 3<&-; UP=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
done

if [[ "$UP" -eq 1 ]]; then
  ok "端口 $PORT 已监听"
  BODY="$(curl -s -m 5 "http://127.0.0.1:$PORT/" || true)"
  if [[ -n "$BODY" ]]; then
    ok "HTTP 可访问（返回 $(printf '%s' "$BODY" | wc -c) 字节）"
  else
    warn "端口通但 HTTP 没响应（可能要求 Cookie 鉴权；桥接会自动铸造）"
  fi
  echo
  echo "结论：DSH 无头【可用】→ 服务器方案（拓扑 B）成立。"
  echo "      下一步：装无头 QQ 网关（NapCat/Lagrange）→ deploy/install-server.sh"
  RC=0
else
  bad "等了 ${WAIT}s 端口没起来"
  echo "  ---- 日志 ----"; tail -30 "$LOG"; echo "  -------------"
  echo
  echo "结论：DSH 无头【不可用】→ 请用拓扑 A（家用机单机部署，install.ps1）"
  RC=1
fi

# ── 清理 ───────────────────────────────────────────────────────────────────
if [[ "$KEEP" -eq 1 ]]; then
  warn "--keep：保留进程 PID=$PID 与日志 $LOG"
else
  kill "$PID" 2>/dev/null || true
  sleep 1
  kill -9 "$PID" 2>/dev/null || true
  rm -f "$LOG"
  echo "  已停止探测进程并清理日志"
fi
exit "$RC"
