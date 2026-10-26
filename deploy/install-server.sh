#!/usr/bin/env bash
# qq-bridge 服务器（Linux）一键安装
#
# 用法：
#   sudo ./deploy/install-server.sh --owner-qq 123456789
#   sudo ./deploy/install-server.sh --owner-qq 123456789 --dir /opt/qq-bridge --dsh-url http://127.0.0.1:3080
#
# 做的事：
#   1. 检查 Node >= 22.13 / npm / systemd
#   2. 建专用用户与目录（默认 /opt/qq-bridge，用户 qqbridge）
#   3. 生成 config.json（从 config.example.json）
#   4. npm install（含 postinstall 的 sdk 补丁）
#   5. 写 systemd unit 并启动
#
# 需要人工完成的两件事（脚本会提醒）：
#   · 登录 DeepSeek Harness（DSH）
#   · 在 SnowLuma 里扫码登录 QQ 小号
set -euo pipefail

OWNER_QQ=""
DIR="/opt/qq-bridge"
USER_NAME="qqbridge"
DSH_URL="http://127.0.0.1:3080"
SNOWLUMA_WS="ws://127.0.0.1:3001"
SNOWLUMA_HTTP="http://127.0.0.1:3000"
GROUPS=""
PRIVATES=""
NO_START=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner-qq) OWNER_QQ="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --dsh-url) DSH_URL="$2"; shift 2 ;;
    --snowluma-ws) SNOWLUMA_WS="$2"; shift 2 ;;
    --snowluma-http) SNOWLUMA_HTTP="$2"; shift 2 ;;
    --groups) GROUPS="$2"; shift 2 ;;
    --privates) PRIVATES="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo）"
[[ -n "$OWNER_QQ" ]] || die "必须给 --owner-qq（管理员 QQ 号）"
[[ "$OWNER_QQ" =~ ^[0-9]+$ ]] || die "--owner-qq 必须是数字"

# ── 1. 环境 ────────────────────────────────────────────────────────────────
command -v node >/dev/null || die "找不到 node。装 Node 22 LTS：https://nodejs.org 或 nvm install 22"
NODE_BIN="$(command -v node)"
NODE_VER="$("$NODE_BIN" --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"; NODE_MINOR="${NODE_REST%%.*}"
if [[ "$NODE_MAJOR" -lt 22 || ( "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 13 ) ]]; then
  die "Node $NODE_VER 太低，需要 >= 22.13.0"
fi
ok "Node $NODE_VER（$NODE_BIN）"

command -v npm >/dev/null || die "找不到 npm"
command -v systemctl >/dev/null || die "没有 systemd（本脚本只支持 systemd 发行版）"
ok "systemd 可用"

# ── 2. 用户与目录 ───────────────────────────────────────────────────────────
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /usr/sbin/nologin "$USER_NAME"
  ok "已创建用户 $USER_NAME"
else
  ok "用户 $USER_NAME 已存在"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if [[ "$REPO_DIR" != "$DIR" ]]; then
  mkdir -p "$DIR"
  # 复制仓库内容（排除 node_modules/.git/state/logs）
  tar -C "$REPO_DIR" -cf - \
    --exclude=node_modules --exclude=.git --exclude=state --exclude=logs --exclude=audio \
    . | tar -C "$DIR" -xf -
  ok "已复制到 $DIR"
fi

mkdir -p "$DIR"/{state,logs,audio}
chown -R "$USER_NAME:$USER_NAME" "$DIR"
chmod 750 "$DIR"; chmod 700 "$DIR/state"
ok "目录就绪（$DIR，属主 $USER_NAME）"

# ── 3. config.json ─────────────────────────────────────────────────────────
cd "$DIR"
if [[ ! -f config.json ]]; then
  [[ -f config.example.json ]] || die "缺 config.example.json"
  cp config.example.json config.json
  ok "已生成 config.json（从 example）"
else
  cp config.json "config.json.bak-$(date +%Y%m%d-%H%M%S)"
  warn "已存在 config.json，已备份后更新"
fi

# 用 node 改 JSON（保证转义正确）
"$NODE_BIN" - "$OWNER_QQ" "$DSH_URL" "$SNOWLUMA_WS" "$SNOWLUMA_HTTP" "$GROUPS" "$PRIVATES" <<'NODE'
const fs = require('fs');
const [owner, dshUrl, ws, http, groups, privates] = process.argv.slice(2);
const p = 'config.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.ownerQQ = Number(owner);
c.dsh = { ...(c.dsh || {}), baseUrl: dshUrl };
c.snowluma = { ...(c.snowluma || {}), wsUrl: ws, httpUrl: http };
const nums = (s) => String(s || '').split(/[,\s]+/).filter(Boolean).map(Number);
if (groups) c.allow.groups = nums(groups);
c.allow.private = Array.from(new Set([...(c.allow.private || []), Number(owner), ...nums(privates)]));
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
console.log(`  ownerQQ=${c.ownerQQ} dsh=${c.dsh.baseUrl} groups=${c.allow.groups.length} privates=${c.allow.private.length}`);
NODE
ok "config.json 已更新"

# ── 4. 依赖 ────────────────────────────────────────────────────────────────
if [[ ! -d node_modules/@snowluma/sdk ]]; then
  echo "  npm install（首次较慢）"
  sudo -u "$USER_NAME" "$(command -v npm)" install --no-fund --no-audit || die "npm install 失败"
fi
ok "依赖就绪"

# ── 5. systemd ────────────────────────────────────────────────────────────
UNIT=/etc/systemd/system/qq-bridge.service
sed -e "s#__USER__#$USER_NAME#g" \
    -e "s#__DIR__#$DIR#g" \
    -e "s#__NODE__#$NODE_BIN#g" \
    -e "s#__HOME__#/home/$USER_NAME#g" \
    "$SCRIPT_DIR/qq-bridge.service" > "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable qq-bridge >/dev/null
ok "systemd unit 已写入 $UNIT"

if [[ "$NO_START" -eq 0 ]]; then
  systemctl restart qq-bridge
  sleep 4
  if systemctl is-active --quiet qq-bridge; then ok "服务已启动"; else warn "服务未正常运行，看：journalctl -u qq-bridge -n 80 --no-pager"; fi
fi

cat <<EOF

装好了。接下来（必须人工做）：
  1. 登录 DeepSeek Harness（DSH），确认它在 ${DSH_URL} 可访问
  2. 在 SnowLuma 里扫码登录 QQ 小号，确认 ${SNOWLUMA_HTTP} 与 ${SNOWLUMA_WS} 可连通

自检：
  sudo ./deploy/verify-server.sh

常用：
  systemctl status qq-bridge
  journalctl -u qq-bridge -f          # 跟日志
  ./deploy/maintain-server.sh --backup  # 备份
EOF
