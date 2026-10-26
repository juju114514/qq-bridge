#!/usr/bin/env bash
# qq-bridge 花费熔断（服务器版，给 cron 用）
#
# 桥接的 token 账本只记不拦；本脚本统计当天花费，超限就关掉 AI 回复并通知管理员。
#
# crontab 示例（每 30 分钟）：
#   */30 * * * * /opt/qq-bridge/deploy/guard-server.sh --limit 5 >> /var/log/qq-bridge-guard.log 2>&1
#
# 恢复：
#   /opt/qq-bridge/deploy/guard-server.sh --resume
set -uo pipefail

DIR="${QQBOT_DIR:-/opt/qq-bridge}"
LIMIT="5"
RESUME=0
APPLY=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

cd "$DIR" || { echo "目录不存在：$DIR" >&2; exit 1; }
command -v node >/dev/null || { echo "需要 node"; exit 1; }
command -v curl >/dev/null || { echo "需要 curl"; exit 1; }

PORT="$(node -e "const c=require('./config.json');console.log(c.consolePort||3100)" 2>/dev/null || echo 3100)"
TOK="$(cat state/console-token 2>/dev/null || true)"
[ -n "$TOK" ] || { echo "缺 state/console-token"; exit 1; }

api() { # method path json
  curl -s -m 8 -X "$1" "http://127.0.0.1:$PORT$2" \
    -H "X-Console-Token: $TOK" -H 'content-type: application/json' \
    ${3:+--data "$3"}
}

if [[ $RESUME -eq 1 ]]; then
  api POST /api/socialV2/config '{"enabled":true}' >/dev/null && echo "[ok] 已恢复 AI 回复"
  exit 0
fi

# 统计今天（本地时区）的花费
COST="$(node - <<'NODE'
const fs = require('fs');
const t0 = new Date(); t0.setHours(0,0,0,0);
let cost = 0, n = 0;
try {
  for (const line of fs.readFileSync('state/token-usage.jsonl', 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = Number(o.t ?? o.ts ?? 0);
    if (!t) continue;
    const at = t > 1e12 ? new Date(t) : new Date(t * 1000);
    if (at < t0) continue;
    cost += Number(o.cost ?? o.c ?? 0);
    n++;
  }
} catch {}
console.log(cost.toFixed(6), n);
NODE
)"
CUR="$(echo "$COST" | awk '{print $1}')"
CNT="$(echo "$COST" | awk '{print $2}')"

echo "$(date '+%F %T')  今日 $CNT 条 / ￥$CUR  上限 ￥$LIMIT"

OVER="$(awk -v a="$CUR" -v b="$LIMIT" 'BEGIN{print (a>=b)?1:0}')"
[[ "$OVER" -eq 0 ]] && exit 0

echo "  超限 → 熔断"
if [[ $APPLY -eq 0 ]]; then echo "  （dry-run，未执行）"; exit 2; fi

api POST /api/socialV2/config '{"enabled":false}' >/dev/null && echo "  [ok] 已关闭 AI 回复（socialV2.enabled=false）"

OWNER="$(node -e "console.log(require('./config.json').ownerQQ||'')" 2>/dev/null)"
if [[ -n "$OWNER" ]]; then
  MSG="【花费熔断】今天已花 ￥$CUR，超过上限 ￥$LIMIT。AI 回复已自动关闭。管理员执行 deploy/guard-server.sh --resume 可恢复。"
  BODY="$(node -e "console.log(JSON.stringify({user_id:Number('$OWNER'),message:process.argv[1]}))" "$MSG")"
  HTTP_URL="$(node -e "console.log((require('./config.json').snowluma||{}).httpUrl||'http://127.0.0.1:3000')" 2>/dev/null)"
  SNOW_TOK="$(node -e "console.log((require('./config.json').snowluma||{}).accessToken||'')" 2>/dev/null)"
  if [[ -n "$SNOW_TOK" ]]; then
    curl -s -m 10 -X POST "$HTTP_URL/send_private_msg" \
      -H "Authorization: Bearer $SNOW_TOK" -H 'content-type: application/json' \
      --data "$BODY" >/dev/null && echo "  [ok] 已私聊通知 $OWNER"
  fi
fi

echo "$(date '+%F %T')  熔断  cost=￥$CUR limit=￥$LIMIT" >> state/guard.log
exit 2
