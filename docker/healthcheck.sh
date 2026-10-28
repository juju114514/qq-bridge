#!/bin/sh
# 容器健康检查：只探 HTTP 是否活着。
#
# 注意：/api/status 需要令牌，未带令牌返回 401 —— 401 也说明 HTTP 正常工作，
# 不能当成"不健康"（早期版本用 curl -f 就会因此一直 unhealthy）。
set -eu

PORT="${QQB_CONSOLE_PORT:-3100}"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/status" || echo 000)"

case "$code" in
  200|401) exit 0 ;;
  *) echo "healthcheck: HTTP ${code} on port ${PORT}" >&2; exit 1 ;;
esac
