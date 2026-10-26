#!/usr/bin/env bash
# 逻辑自测：不碰系统、不碰权限，只验「凭据探测 / 主机判定 / unit 占位替换」这三段纯逻辑。
# 目的是在 Windows 上也能证明 install-server.sh 的判定分支没错，避免又出现
# 「加固做一半、默认配置跑不通」这类只能到服务器上才暴露的问题。
set -uo pipefail

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s — %s\n' "$1" "$2"; }
eq()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "期望[$3] 实际[$2]"; fi; }

echo "## 1) DSH 主机判定（只有回环才用本机密钥铸造）"
dsh_local() { # url -> 1/0
  local host
  host="$(printf '%s' "$1" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
  case "$host" in
    localhost|127.*|::1) printf '1' ;;
    *) printf '0' ;;
  esac
}
eq "http://127.0.0.1:3080 判为本机"   "$(dsh_local http://127.0.0.1:3080)" "1"
eq "http://localhost:3080 判为本机"    "$(dsh_local http://localhost:3080)" "1"
eq "http://127.0.0.1 不带端口 判本机"  "$(dsh_local http://127.0.0.1)" "1"
eq "https://dsh.example.com 判远程"    "$(dsh_local https://dsh.example.com)" "0"
eq "http://10.0.0.5:3080 判远程"       "$(dsh_local http://10.0.0.5:3080)" "0"

echo "## 2) DSH_HOME 探测（按优先级，且必须真有 .credentials.yaml）"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mk() { mkdir -p "$1"; printf 'models: {}\n' > "$1/.credentials.yaml"; }

detect_dsh_home() { # 与 install-server.sh 同一套候选顺序
  local cand
  for cand in "${DSH_HOME_ARG:-}" "${DSH_HOME:-}" "${SUDO_USER:+/home/$SUDO_USER/.dsh}" "${HOME:-}/.dsh" "/root/.dsh"; do
    [[ -n "$cand" && -f "$cand/.credentials.yaml" ]] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}

mk "$TMP/a"
eq "显式 --dsh-home 优先" "$(DSH_HOME_ARG="$TMP/a" HOME="$TMP/none" detect_dsh_home)" "$TMP/a"

mk "$TMP/b"
eq "环境变量 DSH_HOME 次之" "$(DSH_HOME_ARG="" DSH_HOME="$TMP/b" HOME="$TMP/none" detect_dsh_home)" "$TMP/b"

eq "都没有时返回非零" "$(DSH_HOME_ARG="" DSH_HOME="" HOME="$TMP/none" detect_dsh_home; echo "rc=$?")" "rc=1"

# 目录存在但没有 .credentials.yaml → 不能被当命中
mkdir -p "$TMP/c"
eq "空 .dsh 目录不算命中" "$(DSH_HOME_ARG="" DSH_HOME="$TMP/c" HOME="$TMP/none" detect_dsh_home; echo "rc=$?")" "rc=1"

echo "## 3) unit 占位替换（含 DSH_HOME 为空时不能写坏 unit）"
mkdir -p "$TMP/unit"
cp "$(dirname "$0")/../deploy/qq-bridge.service" "$TMP/unit/qq-bridge.service" 2>/dev/null \
  || cp "/d/QQBot-open/qq-bridge/deploy/qq-bridge.service" "$TMP/unit/qq-bridge.service"
render() { # dsh_home
  sed -e "s#__USER__#qqbridge#g" -e "s#__DIR__#/opt/qq-bridge#g" \
      -e "s#__NODE__#/usr/bin/node#g" -e "s#__HOME__#/home/qqbridge#g" \
      -e "s#__DSH_HOME__#$1#g" "$TMP/unit/qq-bridge.service"
}
OUT="$(render /root/.dsh)"
grep -q '^Environment=DSH_HOME=/root/.dsh$' <<<"$OUT" \
  && ok "探测到路径时写进 unit" || bad "探测到路径时写进 unit" "$(grep DSH_HOME <<<"$OUT")"
! grep -q '__[A-Z_]*__' <<<"$OUT" \
  && ok "没有残留占位符" || bad "没有残留占位符" "$(grep -o '__[A-Z_]*__' <<<"$OUT" | sort -u | tr '\n' ' ')"

OUT_EMPTY="$(render '')"
grep -q '^Environment=DSH_HOME=$' <<<"$OUT_EMPTY" \
  && ok "空值时留空（不写坏 unit，代码侧当 falsy 兜底）" || bad "空值时留空" "$(grep DSH_HOME <<<"$OUT_EMPTY")"

echo "## 4) --help 区间覆盖新的文件头（不能截断，也不能把代码打出来）"
# 区间从脚本里读，避免测试自己写死一份而与被测脚本漂移
INSTALL_SH="/d/QQBot-open/qq-bridge/deploy/install-server.sh"
RANGE="$(grep -oE "sed -n '[0-9]+,[0-9]+p'" "$INSTALL_SH" | head -n1 | sed -E "s/.*'([0-9]+,[0-9]+)p'/\1/")"
if [[ -z "$RANGE" ]]; then
  bad "--help 区间可解析" "没从 install-server.sh 里读到 sed -n 'a,bp'"
else
  ok "--help 区间可解析（$RANGE）"
  HEAD="$(sed -n "${RANGE}p" "$INSTALL_SH")"
  grep -q '凭据' <<<"$HEAD" && ok "--help 包含凭据说明" || bad "--help 包含凭据说明" "头部未覆盖"
  grep -q '扫码登录 QQ' <<<"$HEAD" && ok "--help 覆盖到人工步骤" || bad "--help 覆盖到人工步骤" "区间太短"
  ! grep -q '^set -euo' <<<"$HEAD" && ok "--help 没有把代码打出来" || bad "--help 没有把代码打出来" "区间太长"
fi

echo
if [[ $FAIL -eq 0 ]]; then echo "  全部通过（$PASS 项）"; else echo "  $FAIL 项失败 / $PASS 项通过"; exit 1; fi
