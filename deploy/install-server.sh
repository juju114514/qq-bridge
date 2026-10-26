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
#   4. 解决 DSH 凭据访问（见下）—— 降权用户必须能读本机签名密钥
#   5. npm install（含 postinstall 的 sdk 补丁）
#   6. 写 systemd unit 并启动
#
# 为什么第 4 步是必须的：
#   桥接默认不带 dsh.authToken，而是用 `$DSH_HOME/.credentials.yaml` 里的签名密钥
#   **离线铸造** DSH cookie。降权到 qqbridge 后 HOME 变成 /home/qqbridge，
#   既找不到 root/别的用户的 .dsh 目录，也没有该文件的读权限 —— 表现是
#   「DSH 401 / 铸造 cookie 失败」，而 curl 打 DSH 又是通的，很难查。
#   本脚本因此：探测真正的 DSH_HOME → 写入 unit → 用 ACL 只授予
#   「穿过目录(x) + 读该文件(r)」这一份最小权限，并用 qqbridge 身份实测一次。
#   若 DSH 在另一台机器上（非回环地址），铸造本来就不成立，脚本会提示改用 authToken。
#
# 需要人工完成的两件事（脚本会提醒）：
#   · 登录 DeepSeek Harness（DSH）
#   · 在 SnowLuma 里扫码登录 QQ 小号
set -euo pipefail

OWNER_QQ=""
DIR="/opt/qq-bridge"
USER_NAME="qqbridge"
DSH_URL="http://127.0.0.1:3080"
DSH_HOME_ARG=""
CRED_GROUP="dshcred"
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
    --dsh-home) DSH_HOME_ARG="$2"; shift 2 ;;
    --snowluma-ws) SNOWLUMA_WS="$2"; shift 2 ;;
    --snowluma-http) SNOWLUMA_HTTP="$2"; shift 2 ;;
    --groups) GROUPS="$2"; shift 2 ;;
    --privates) PRIVATES="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
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

# ── 4. DSH 凭据（降权用户必须能读本机签名密钥）─────────────────────────────
# 判定 DSH 是不是在本机：只有回环地址才能用本机密钥铸造 cookie。
DSH_HOST="$(printf '%s' "$DSH_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
DSH_LOCAL=1
case "$DSH_HOST" in
  localhost|127.*|::1) DSH_LOCAL=1 ;;
  *) DSH_LOCAL=0 ;;
esac

DSH_HOME_FOUND=""
detect_dsh_home() {
  local cand
  for cand in \
    "${DSH_HOME_ARG:-}" \
    "${DSH_HOME:-}" \
    "${SUDO_USER:+/home/$SUDO_USER/.dsh}" \
    "${HOME:-}/.dsh" \
    "/root/.dsh" \
    "/home/$USER_NAME/.dsh"
  do
    [[ -n "$cand" && -f "$cand/.credentials.yaml" ]] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}

if [[ "$DSH_LOCAL" -eq 0 ]]; then
  warn "DSH 不在本机（$DSH_HOST）：本机密钥铸造不成立，请把 dsh.authToken 填成那台 DSH 的启动凭据"
  warn "跳过 DSH 凭据授权（这是设计使然，不是漏配）"
elif DSH_HOME_FOUND="$(detect_dsh_home)"; then
  CRED_FILE="$DSH_HOME_FOUND/.credentials.yaml"
  ok "找到 DSH 凭据：$CRED_FILE"

  # 最小授权：只给「穿过目录(x)」与「读该文件(r)」，不给目录列表权限。
  # 优先 ACL（能精确到单用户单文件）；没有 setfacl 时退回「专用组 + 640」。
  grant_ok=0
  if command -v setfacl >/dev/null 2>&1; then
    # 路径上每一级都要能穿过：这里只处理 DSH_HOME 本身与其父目录
    setfacl -m "u:$USER_NAME:--x" "$(dirname "$DSH_HOME_FOUND")" 2>/dev/null || true
    if setfacl -m "u:$USER_NAME:--x" "$DSH_HOME_FOUND" 2>/dev/null \
       && setfacl -m "u:$USER_NAME:r--" "$CRED_FILE" 2>/dev/null; then
      grant_ok=1
      ok "已用 ACL 授予 $USER_NAME：目录穿越(x) + 读密钥(r)（不含列表权限）"
    fi
  fi

  if [[ "$grant_ok" -eq 0 ]]; then
    warn "没有 setfacl（Debian/Ubuntu: apt install acl；RHEL: dnf install acl），改用专用组方案"
    groupadd -f "$CRED_GROUP"
    chgrp "$CRED_GROUP" "$CRED_FILE" && chmod 640 "$CRED_FILE" \
      && usermod -aG "$CRED_GROUP" "$USER_NAME" \
      && grant_ok=1
    if [[ "$grant_ok" -eq 1 ]]; then
      # 组方案需要目录穿越位；只在 .dsh 目录上加 o+x，不动 $HOME 的 o+x 以外权限
      chmod o+x "$DSH_HOME_FOUND" 2>/dev/null || true
      ok "已建组 $CRED_GROUP 并把 $USER_NAME 加入（密钥 640 $CRED_GROUP）"
      warn "组方案需要重新登录会话才生效；install 末尾已用 systemctl restart 重启服务，通常已足够"
    fi
  fi

  # 实测：以服务用户身份真读一次（比看 mode 位可靠 —— 父目录 700 一样读不到）
  if sudo -u "$USER_NAME" test -r "$CRED_FILE" 2>/dev/null; then
    ok "以 $USER_NAME 身份实测可读凭据"
  else
    warn "以 $USER_NAME 身份仍读不到 $CRED_FILE"
    warn "常见原因：某个上级目录（如 /root 或 \$HOME）是 700，需要给穿越权限："
    warn "  setfacl -m u:$USER_NAME:--x /path/to/parent"
    warn "或直接把 DSH_HOME 指到桥接可读的位置：--dsh-home /srv/dsh"
  fi
else
  warn "没找到 .credentials.yaml（探测过 \$DSH_HOME、\$HOME/.dsh、/root/.dsh）"
  warn "如果 DSH 还没登录，登录后再跑一次本脚本；或显式指定：--dsh-home /path/to/.dsh"
  warn "否则桥接启动后会出现「DSH 401 / 铸造 cookie 失败」"
fi

# ── 5. 依赖 ────────────────────────────────────────────────────────────────
if [[ ! -d node_modules/@snowluma/sdk ]]; then
  echo "  npm install（首次较慢）"
  # -H 必须带上：否则 HOME 仍是 root 的，npm 会把缓存写到 /root/.npm 并因 EACCES 失败，
  # 或者把 root 属主的文件留在项目里，后续服务以 qqbridge 身份跑不动。
  sudo -H -u "$USER_NAME" env "PATH=$PATH" "$(command -v npm)" install --no-fund --no-audit \
    || die "npm install 失败（若见 EACCES/.npm 相关错误，删掉 $DIR/node_modules 后重跑）"
fi
ok "依赖就绪"

# ── 6. systemd ────────────────────────────────────────────────────────────
UNIT=/etc/systemd/system/qq-bridge.service
# DSH_HOME 写进 unit：否则服务进程的 homedir 是 /home/qqbridge，永远找不到凭据。
# 没探测到就留空 —— 代码里 `process.env.DSH_HOME || homedir()/.dsh` 会把空串当 falsy 兜底。
sed -e "s#__USER__#$USER_NAME#g" \
    -e "s#__DIR__#$DIR#g" \
    -e "s#__NODE__#$NODE_BIN#g" \
    -e "s#__HOME__#/home/$USER_NAME#g" \
    -e "s#__DSH_HOME__#${DSH_HOME_FOUND}#g" \
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

DSH 凭据：${DSH_HOME_FOUND:-（未找到，见上面的 [!] 提示）}
  桥接要用它离线铸造 cookie；换了 DSH 登录账号/迁移了 .dsh 目录后，
  重跑本脚本（或手动 setfacl）即可，不用改 config.json。

自检：
  sudo ./deploy/verify-server.sh

常用：
  systemctl status qq-bridge
  journalctl -u qq-bridge -f          # 跟日志
  ./deploy/maintain-server.sh --backup  # 备份
EOF
