#!/usr/bin/env bash
# qq-bridge 服务器维护：备份（可选 GPG 加密）、裁日志、清用量、重启
#
# 用法：
#   ./deploy/maintain-server.sh --status
#   ./deploy/maintain-server.sh --backup
#   ./deploy/maintain-server.sh --backup --gpg-recipient me@example.com
#   ./deploy/maintain-server.sh --backup --trim-logs --prune-usage --restart
set -uo pipefail

DIR="${QQBOT_DIR:-/opt/qq-bridge}"
BACKUP_DIR="${QQBOT_BACKUP_DIR:-/var/backups/qq-bridge}"
DO_BACKUP=0
DO_TRIM=0
DO_PRUNE=0
DO_RESTART=0
GPG_TO=""
KEEP_DAYS=7

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) DO_STATUS=1; shift ;;
    --backup) DO_BACKUP=1; shift ;;
    --trim-logs) DO_TRIM=1; shift ;;
    --prune-usage) DO_PRUNE=1; shift ;;
    --restart) DO_RESTART=1; shift ;;
    --gpg-recipient) GPG_TO="$2"; shift 2 ;;
    --keep-days) KEEP_DAYS="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ $# -eq 0 && -z "${DO_STATUS:-}" && $DO_BACKUP -eq 0 ]] && DO_STATUS=1
ok() { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }

cd "$DIR" || { echo "目录不存在：$DIR" >&2; exit 1; }

# ── 状态 ───────────────────────────────────────────────────────────────────
if [[ -n "${DO_STATUS:-}" ]]; then
  echo "state/ 占用：$(du -sh state 2>/dev/null | cut -f1)"
  echo "logs/  占用：$(du -sh logs 2>/dev/null | cut -f1)"
  echo "日志文件："
  find state logs -maxdepth 1 -type f \( -name '*.log*' -o -name 'token-usage.jsonl' \) -printf '  %-40p %8s bytes\n' 2>/dev/null | head -20
  if command -v systemctl >/dev/null; then
    echo "服务：$(systemctl is-active qq-bridge 2>/dev/null || echo unknown)"
  fi
  echo "令牌年龄：$(( ( $(date +%s) - $(stat -c %Y state/console-token 2>/dev/null || date +%s) ) / 86400 )) 天"
  exit 0
fi

# ── 备份 ───────────────────────────────────────────────────────────────────
if [[ $DO_BACKUP -eq 1 ]]; then
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  TS="$(date +%Y%m%d-%H%M%S)"
  TAR="$BACKUP_DIR/qq-bridge-$TS.tar.gz"
  ITEMS=()
  for f in config.json roles state/console-token state/current-role.json state/roles-by-key.json \
           state/role-setup.json state/social-v2.json state/slang.json state/stickers.json state/sessions.json; do
    [[ -e "$f" ]] && ITEMS+=("$f")
  done
  tar -czf "$TAR" -C "$DIR" "${ITEMS[@]}" 2>/dev/null
  chmod 600 "$TAR"
  ok "备份：$TAR（$(du -h "$TAR" | cut -f1)）"

  if [[ -n "$GPG_TO" ]]; then
    command -v gpg >/dev/null || { warn "没有 gpg，跳过加密"; }
    if command -v gpg >/dev/null; then
      gpg --yes --encrypt --recipient "$GPG_TO" "$TAR" && shred -u "$TAR" 2>/dev/null || rm -f "$TAR"
      ok "已 GPG 加密（收件人 $GPG_TO）"
    fi
  else
    warn "未加密：备份里有明文令牌。建议加 --gpg-recipient，或把 $BACKUP_DIR 放到加密卷/受控权限目录"
  fi
fi

# ── 裁日志 ─────────────────────────────────────────────────────────────────
if [[ $DO_TRIM -eq 1 ]]; then
  N="$(find state logs -maxdepth 1 -type f -name '*.log*' -mtime +"$KEEP_DAYS" | wc -l)"
  find state logs -maxdepth 1 -type f -name '*.log*' -mtime +"$KEEP_DAYS" -delete 2>/dev/null
  ok "裁掉 $N 个超过 $KEEP_DAYS 天的日志"
fi

# ── 清用量 ─────────────────────────────────────────────────────────────────
if [[ $DO_PRUNE -eq 1 && -f state/token-usage.jsonl ]]; then
  SZ="$(du -h state/token-usage.jsonl | cut -f1)"
  rm -f state/token-usage.jsonl
  ok "已清 token-usage.jsonl（原 $SZ）"
fi

# ── 重启 ───────────────────────────────────────────────────────────────────
if [[ $DO_RESTART -eq 1 ]]; then
  if command -v systemctl >/dev/null; then
    systemctl restart qq-bridge && sleep 3
    systemctl is-active --quiet qq-bridge && ok "服务已重启" || warn "服务未起来：journalctl -u qq-bridge -n 50"
  else
    warn "没有 systemd，手动重启"
  fi
fi
