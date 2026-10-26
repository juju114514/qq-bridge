#!/usr/bin/env bash
# qq-bridge 服务器自检（只读，不改任何东西）
set -uo pipefail

DIR="${QQBOT_DIR:-/opt/qq-bridge}"
FAIL=0
WARN=0

ok()   { printf '\033[32m[OK]\033[0m   %-22s %s\n' "$1" "$2"; }
warn() { printf '\033[33m[WARN]\033[0m %-22s %s\n' "$1" "$2"; WARN=$((WARN+1)); }
bad()  { printf '\033[31m[FAIL]\033[0m %-22s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

echo
echo "qq-bridge 服务器自检"
echo "  目录: $DIR"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo

# ── Node ──────────────────────────────────────────────────────────────────
if command -v node >/dev/null; then
  V="$(node --version | sed 's/^v//')"
  MAJ="${V%%.*}"; REST="${V#*.}"; MIN="${REST%%.*}"
  if [[ "$MAJ" -lt 22 || ( "$MAJ" -eq 22 && "$MIN" -lt 13 ) ]]; then bad "Node" "$V（需要 >= 22.13.0）"; else ok "Node" "$V"; fi
else
  bad "Node" "未安装"
fi

# ── 依赖 ──────────────────────────────────────────────────────────────────
if [[ -d "$DIR/node_modules/@snowluma/sdk" ]]; then ok "依赖" "node_modules 存在"; else bad "依赖" "缺 node_modules（npm install）"; fi

# ── config ────────────────────────────────────────────────────────────────
if [[ -f "$DIR/config.json" ]]; then
  if node -e "JSON.parse(require('fs').readFileSync('$DIR/config.json','utf8'))" 2>/dev/null; then
    ok "config.json" "可解析"
    OWNER="$(node -e "const c=require('$DIR/config.json');console.log(c.ownerQQ||'')" 2>/dev/null)"
    if [[ -n "$OWNER" ]]; then ok "ownerQQ" "$OWNER"; else bad "ownerQQ" "未设置"; fi
    PORT="$(node -e "const c=require('$DIR/config.json');console.log(c.consolePort||3100)" 2>/dev/null)"
    DSH="$(node -e "const c=require('$DIR/config.json');console.log((c.dsh&&c.dsh.baseUrl)||'')" 2>/dev/null)"
  else
    bad "config.json" "JSON 解析失败"
    PORT=3100; DSH=""
  fi
else
  bad "config.json" "不存在"
  PORT=3100; DSH=""
fi

# ── 端口 ──────────────────────────────────────────────────────────────────
check_port() { # name port
  if (exec 3<>"/dev/tcp/127.0.0.1/$2") 2>/dev/null; then exec 3<&-; ok "$1" "$2 可连"; else bad "$1" "$2 连不上"; fi
}
check_port "控制台" "${PORT:-3100}"
check_port "SnowLuma HTTP" 3000
check_port "SnowLuma WS" 3001
if [[ -n "${DSH:-}" ]]; then
  DPORT="$(echo "$DSH" | sed -E 's#.*:([0-9]+)/?$#\1#')"
  [[ "$DPORT" =~ ^[0-9]+$ ]] && check_port "DSH" "$DPORT"
else
  warn "DSH" "config 里没有 dsh.baseUrl"
fi

# ── DSH 凭据（降权用户必须能读，否则铸造 cookie 失败 ⇒ 全站 401）────────────
# 判据不是「文件存在」，而是「以服务用户身份真能读」——父目录 700 时文件存在也没用。
SVC_USER="$(systemctl show -p User --value qq-bridge 2>/dev/null || true)"
SVC_USER="${SVC_USER:-qqbridge}"
UNIT_DSH_HOME="$(systemctl show -p Environment --value qq-bridge 2>/dev/null | tr ' ' '\n' | sed -n 's/^DSH_HOME=//p' | head -n1)"
CRED_CANDIDATES=()
[[ -n "$UNIT_DSH_HOME" ]] && CRED_CANDIDATES+=("$UNIT_DSH_HOME")
[[ -n "${DSH_HOME:-}" ]] && CRED_CANDIDATES+=("$DSH_HOME")
CRED_CANDIDATES+=("$HOME/.dsh" "/root/.dsh" "/home/$SVC_USER/.dsh")

as_user_readable() { # path
  if command -v runuser >/dev/null 2>&1; then runuser -u "$SVC_USER" -- test -r "$1" 2>/dev/null
  elif command -v sudo >/dev/null 2>&1; then sudo -n -u "$SVC_USER" test -r "$1" 2>/dev/null
  else [[ -r "$1" ]]  # 退化为当前用户视角，仅作参考
  fi
}

CRED_FOUND=""
for c in "${CRED_CANDIDATES[@]}"; do
  [[ -n "$c" && -f "$c/.credentials.yaml" ]] && { CRED_FOUND="$c/.credentials.yaml"; break; }
done

if [[ -z "$CRED_FOUND" ]]; then
  warn "DSH 凭据" "没找到 .credentials.yaml（探测过 unit DSH_HOME / \$DSH_HOME / \$HOME / /root）"
elif as_user_readable "$CRED_FOUND"; then
  ok "DSH 凭据" "$SVC_USER 可读 $(basename "$(dirname "$CRED_FOUND")")/.credentials.yaml"
else
  bad "DSH 凭据" "$SVC_USER 读不到 $CRED_FOUND（铸造 cookie 会 401；见 SERVER.md 凭据一节）"
fi

# ── systemd ───────────────────────────────────────────────────────────────
if command -v systemctl >/dev/null; then
  if systemctl is-active --quiet qq-bridge; then ok "systemd" "qq-bridge 运行中"; else bad "systemd" "qq-bridge 未运行"; fi
  ENABLED="$(systemctl is-enabled qq-bridge 2>/dev/null || true)"
  if [[ "$ENABLED" == "enabled" ]]; then ok "开机自启" "enabled"; else warn "开机自启" "$ENABLED"; fi
fi

# ── 状态接口 ──────────────────────────────────────────────────────────────
TOK_FILE="$DIR/state/console-token"
if [[ -f "$TOK_FILE" ]] && command -v curl >/dev/null; then
  TOK="$(cat "$TOK_FILE")"
  BODY="$(curl -s -m 8 -H "X-Console-Token: $TOK" "http://127.0.0.1:${PORT:-3100}/api/status" || true)"
  if [[ -n "$BODY" ]]; then
    READY="$(echo "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(String(j.dshReady))}catch{console.log('parse-error')}})" 2>/dev/null)"
    GOOD="$(echo "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(String(j.snowluma&&j.snowluma.good))}catch{console.log('parse-error')}})" 2>/dev/null)"
    [[ "$READY" == "true" ]] && ok "DSH 就绪" "true" || bad "DSH 就绪" "$READY"
    [[ "$GOOD" == "true" ]] && ok "QQ 在线" "true" || bad "QQ 在线" "$GOOD"
  else
    bad "状态接口" "取不到 /api/status（服务没起？）"
  fi
elif ! command -v curl >/dev/null; then
  warn "状态接口" "没装 curl，跳过"
fi

# ── 磁盘与日志 ────────────────────────────────────────────────────────────
if [[ -d "$DIR/state" ]]; then
  if touch "$DIR/state/.verify-probe" 2>/dev/null; then rm -f "$DIR/state/.verify-probe"; ok "state 可写" "ok"; else bad "state 可写" "不可写（权限/磁盘）"; fi
fi
AVAIL="$(df -Pk "$DIR" | awk 'NR==2{print int($4/1024)}')"
if [[ "${AVAIL:-0}" -gt 2048 ]]; then ok "磁盘" "${AVAIL} MB 可用"; else warn "磁盘" "${AVAIL} MB 可用（偏少）"; fi

echo
if [[ $FAIL -eq 0 && $WARN -eq 0 ]]; then echo "全部通过。"; exit 0; fi
if [[ $FAIL -eq 0 ]]; then echo "可用，但有 $WARN 项警告。"; exit 2; fi
echo "有 $FAIL 项失败，$WARN 项警告。"; exit 1
