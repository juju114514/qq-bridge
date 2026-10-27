#!/usr/bin/env bash
# qq-bridge 首次运行引导（Linux / macOS 版，Windows 用 scripts/first-run.ps1）
#
# 一条命令走完"别人把仓库 clone 下来之后的全部准备动作"：
#   步骤 1/5  环境体检   → node scripts/preflight.mjs        （只读）
#   步骤 2/5  装依赖     → npm install                        （--skip-npm 可跳）
#   步骤 3/5  配置       → 复制 config.example.json           （**绝不覆盖已有 config.json**）
#   步骤 4/5  DSH preset → node scripts/setup-dsh.mjs          （--skip-preset 可跳）
#   步骤 5/5  启动（可选）→ systemd 或前台 node src/bridge.js   （--start 才做）
#
# 不许做的事（设计不变量，测试会拦）：
#   · **不启动、不安装、不停止 SnowLuma**（第三方程序；L6）
#   · **不覆盖已存在的 config.json**（用户配置永远是用户的）
#   · 不写任何密钥（config.json 来自 example；控制台令牌由桥接首次启动自己生成）
#
# 用法：
#   ./deploy/first-run.sh                 # 交互式走完 1~4，最后问是否启动
#   ./deploy/first-run.sh --dry-run       # 只体检 + 打印计划
#   ./deploy/first-run.sh --non-interactive --start
#   ./deploy/first-run.sh --root /opt/qq-bridge --node /usr/bin/node
#
# 退出码：0 完成 · 1 某步失败 · 2 环境不满足 · 3 用户放弃
set -uo pipefail

ROOT=""
NODE_BIN=""
DRY_RUN=0
SKIP_NPM=0
SKIP_PRESET=0
DO_START=0
NON_INTERACTIVE=0

# 打印文件头部的注释块（从第 2 行到 set 之前），不用手写行号
usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --node) NODE_BIN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    --skip-preset) SKIP_PRESET=1; shift ;;
    --start) DO_START=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

# ── 输出风格（与 deploy/install-server.sh 保持一致）──────────────────────
cyan() { printf '\n\033[36m  ── %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m[OK]\033[0m   %-14s %s\n' "$1" "$2"; }
wo()   { printf '  \033[33m[WARN]\033[0m %-14s %s\n' "$1" "$2"; }
no()   { printf '  \033[31m[FAIL]\033[0m %-14s %s\n' "$1" "$2"; }
info() { printf '         %s\n' "$*"; }
next() { printf '         \033[33m└─ 下一步：%s\033[0m\n' "$*"; }

confirm() {
  local question="$1"
  if [[ "$NON_INTERACTIVE" -eq 1 ]] || [[ ! -t 0 ]]; then return 0; fi
  local answer=""
  printf '         %s [Y/n] ' "$question"
  read -r answer || true
  [[ -z "$answer" ]] && return 0
  case "$answer" in y|Y|yes|YES|是|好) return 0 ;; *) return 1 ;; esac
}

find_node() {
  if [[ -n "$NODE_BIN" ]] && [[ -x "$NODE_BIN" ]]; then printf '%s' "$NODE_BIN"; return 0; fi
  if [[ -n "${QQBOT_NODE:-}" ]] && [[ -x "${QQBOT_NODE}" ]]; then printf '%s' "${QQBOT_NODE}"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node "$HOME/.nvm/current/bin/node"; do
    if [[ -x "$candidate" ]]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

# 改 config.json 的字段：用 node 而不是 jq（node 一定在，jq 不一定）。
# 注意 `node -e 'script' a b` 里 process.argv[1] 才是第一个附加参数。
config_set_owner() {
  ( cd "$ROOT" && "$NODE_BIN" -e '
    const fs = require("fs");
    const p = "config.json";
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.ownerQQ = Number(process.argv[1]);
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  ' "$1" )
}
config_set_groups() {
  ( cd "$ROOT" && "$NODE_BIN" -e '
    const fs = require("fs");
    const p = "config.json";
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.allow = c.allow || {};
    c.allow.groups = process.argv.slice(1).map(String);
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  ' "$@" )
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$ROOT" ]]; then ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"; fi
if [[ ! -d "$ROOT" ]]; then echo "目录不存在：$ROOT" >&2; exit 2; fi
ROOT="$(cd "$ROOT" && pwd)"

printf '\n\033[36m  qq-bridge 首次运行引导（Linux/macOS）\033[0m\n'
info "目录: $ROOT"
if [[ "$DRY_RUN" -eq 1 ]]; then info '模式: dry-run（只体检 + 打印计划，不装不改不启动）'; fi

# ── 前置 ─────────────────────────────────────────────────────────────────
cyan '前置检查'
if [[ ! -f "$ROOT/src/bridge.js" ]]; then
  no '目录' "这里不像仓库根目录（缺 src/bridge.js）：$ROOT"
  next '用 --root 指向 qq-bridge 仓库根'
  exit 2
fi
if ! NODE_BIN="$(find_node)"; then
  no 'Node' '找不到 node'
  next '装 Node >= 22.13（推荐 nvm 或官方二进制包）'
  next 'TROUBLESHOOTING.md#a1-找不到-node请先装-nodejs-22-lts'
  exit 2
fi
NODE_VER="$("$NODE_BIN" -v 2>/dev/null || echo '')"
ok 'Node' "$NODE_VER ($NODE_BIN)"
# 版本比较：取 major.minor
NODE_MM="${NODE_VER#v}"; NODE_MM="${NODE_MM%%-*}"
NODE_MAJOR="${NODE_MM%%.*}"; NODE_REST="${NODE_MM#*.}"; NODE_MINOR="${NODE_REST%%.*}"
if [[ -z "$NODE_MAJOR" ]] || [[ "$NODE_MAJOR" -lt 22 ]] || { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "${NODE_MINOR:-0}" -lt 13 ]]; }; then
  no 'Node 版本' "$NODE_VER 低于 22.13（没有内置 WebSocket）"
  next 'TROUBLESHOOTING.md#a2-node-版本太低v18x需要--22130'
  exit 2
fi

# ── 步骤 1：体检（只读）──────────────────────────────────────────────────
cyan '步骤 1/5  环境体检（只读）'
PREFLIGHT_OK=0
if [[ -f "$ROOT/scripts/preflight.mjs" ]]; then
  "$NODE_BIN" "$ROOT/scripts/preflight.mjs" --dir "$ROOT"
  CODE=$?
  if [[ "$CODE" -eq 0 ]] || [[ "$CODE" -eq 2 ]]; then
    PREFLIGHT_OK=1
    ok '体检' "通过（退出码 $CODE：0=全绿 2=仅 WARN）"
  else
    no '体检' "有 FAIL 项（退出码 $CODE）"
    next '先按上面每条 FAIL 的「下一步」修；全新机器对照 docs/guides/FRESH-INSTALL.md'
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info '（dry-run 仍以 1 退出：体检有 FAIL）'
    else
      exit 1
    fi
  fi
else
  wo '体检' "没有 scripts/preflight.mjs（仓库不完整？）"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  cyan 'dry-run：接下来的计划'
  info '2) npm install（若已装则跳过）'
  info '3) 若无 config.json → 从 config.example.json 复制，然后交互式补 ownerQQ/白名单'
  info '4) node scripts/setup-dsh.mjs（把 qq-chat / qq-chat-v2 preset 装进 DSH）'
  info '5) 询问是否启动（systemd 或前台 node src/bridge.js）'
  info ''
  info '真跑：./deploy/first-run.sh'
  printf '\n'
  if [[ "$PREFLIGHT_OK" -eq 1 ]]; then exit 0; else exit 1; fi
fi

# ── 步骤 2：依赖 ─────────────────────────────────────────────────────────
cyan '步骤 2/5  安装依赖'
if [[ "$SKIP_NPM" -eq 1 ]]; then
  wo '依赖' '按 --skip-npm 跳过'
elif [[ -d "$ROOT/node_modules/js-yaml" ]]; then
  ok '依赖' '已安装，跳过'
else
  if ! command -v npm >/dev/null 2>&1; then
    no 'npm' '找不到 npm（精简版 Node 常见）'
    next '装官方 Node（自带 npm）或用 nvm 重装；也检查 npm 是否在 PATH'
    next 'TROUBLESHOOTING.md#a8-npm-本身不存在npm--无法将npm项识别为'
    exit 1
  fi
  if ! confirm '现在执行 npm install？（可能需要几分钟）'; then no '依赖' '用户取消'; exit 3; fi
  ( cd "$ROOT" && npm install --no-audit --no-fund )
  if [[ $? -ne 0 ]]; then
    no 'npm install' '失败'
    next 'TROUBLESHOOTING.md#a3-npm-install-卡住或超时 / #a4'
    exit 1
  fi
  if [[ ! -d "$ROOT/node_modules/js-yaml" ]]; then
    no '依赖' '装完仍找不到 js-yaml：删掉 node_modules 重装（TROUBLESHOOTING A4）'
    exit 1
  fi
  ok '依赖' '安装完成'
fi

# ── 步骤 3：配置 ─────────────────────────────────────────────────────────
cyan '步骤 3/5  配置 config.json'
CFG="$ROOT/config.json"
EXAMPLE="$ROOT/config.example.json"
if [[ -f "$CFG" ]]; then
  ok 'config.json' '已存在，**不做任何覆盖**'
  OWNER="$("$NODE_BIN" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.ownerQQ||""))}catch{process.stdout.write("")}' "$CFG")"
  if [[ -z "$OWNER" ]]; then wo 'ownerQQ' '为空：审批/管理命令/closed-agent 不可用（TROUBLESHOOTING G1）'; fi
  COUNTS="$("$NODE_BIN" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=c.allow||{};process.stdout.write(String((a.private||[]).length+(a.groups||[]).length))}catch{process.stdout.write("0")}' "$CFG")"
  if [[ "$COUNTS" == "0" ]]; then wo '白名单' '为空：不会响应任何消息（TROUBLESHOOTING E3）'; fi
elif [[ ! -f "$EXAMPLE" ]]; then
  no 'config.example.json' '模板缺失，无法生成配置'
  next '仓库不完整：重新 clone（TROUBLESHOOTING A4）'
  exit 1
else
  cp "$EXAMPLE" "$CFG"
  ok 'config.json' '已从 config.example.json 生成'
  if [[ "$NON_INTERACTIVE" -eq 0 ]] && [[ -t 0 ]]; then
    info '下面几项可以现在填，也可以稍后在控制台「访问与安全」页填：'
    printf '         管理员 QQ（直接回车跳过）: '
    read -r owner || true
    if [[ "$owner" =~ ^[0-9]{5,12}$ ]]; then
      config_set_owner "$owner"
      ok 'ownerQQ' "已写入：$owner"
    elif [[ -n "$owner" ]]; then
      wo 'ownerQQ' '看起来不是 QQ 号（5~12 位数字），跳过；稍后手动填'
    fi
    printf '         允许的群号（逗号分隔，直接回车跳过）: '
    read -r groups || true
    if [[ -n "$groups" ]]; then
      cleaned="$(printf '%s' "$groups" | tr ',，' '  ')"
      valid=""
      for g in $cleaned; do if [[ "$g" =~ ^[0-9]{5,12}$ ]]; then valid="$valid $g"; fi; done
      if [[ -n "$valid" ]]; then
        # shellcheck disable=SC2086  （$valid 是空格分隔的群号列表，故意不加引号）
        config_set_groups $valid
        ok 'allow.groups' "已写入：$(printf '%s' "$valid" | wc -w) 个群"
      else
        wo 'allow.groups' '没有合法群号，跳过'
      fi
    fi
  fi
  info '还需要手填：dsh.baseUrl（DSH 端口每次重启可能变）、snowluma.accessToken（SnowLuma WebUI 里的）'
fi

# ── 步骤 4：DSH preset ───────────────────────────────────────────────────
cyan '步骤 4/5  DSH preset'
if [[ "$SKIP_PRESET" -eq 1 ]]; then
  wo 'preset' '按 --skip-preset 跳过'
elif [[ ! -f "$ROOT/scripts/setup-dsh.mjs" ]]; then
  wo 'preset' '没有 scripts/setup-dsh.mjs，跳过'
  next 'TROUBLESHOOTING.md#c3b'
else
  if ! confirm '现在把 qq-chat / qq-chat-v2 preset 装进 DSH？'; then
    wo 'preset' '跳过（AI 行为会不正常，见 TROUBLESHOOTING C3b）'
  else
    ( cd "$ROOT" && "$NODE_BIN" scripts/setup-dsh.mjs )
    if [[ $? -ne 0 ]]; then
      wo 'preset' '安装脚本非 0 退出（DSH 没装/没登录时会这样）'
      next 'TROUBLESHOOTING.md#c3b-dshreadyt好但工具不对--行为像没接-qqpreset-没装'
      next 'docs/guides/DSH_SETUP.md'
    else
      ok 'preset' '已安装（幂等，可重复跑）'
    fi
  fi
fi

# ── 步骤 5：启动（可选）─────────────────────────────────────────────────
cyan '步骤 5/5  启动'
if [[ "$DO_START" -eq 0 ]]; then
  if [[ "$NON_INTERACTIVE" -eq 0 ]] && [[ -t 0 ]]; then
    if confirm '现在启动 qq-bridge？'; then DO_START=1; fi
  fi
fi
if [[ "$DO_START" -eq 0 ]]; then
  wo '启动' '跳过'
  info '生产建议：sudo systemctl start qq-bridge（先跑 deploy/install-server.sh 装好）'
  info '临时前台：cd 到仓库根后 node src/bridge.js'
else
  info '提示：SnowLuma 必须自己启动并登录（本项目不代启，设计不变量 L6）'
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^qq-bridge\.service'; then
    if [[ "$(id -u)" -eq 0 ]]; then
      systemctl start qq-bridge && ok '启动' 'systemctl start qq-bridge'
    else
      info '需要提权：sudo systemctl start qq-bridge'
      sudo systemctl start qq-bridge && ok '启动' 'systemctl start qq-bridge'
    fi
  else
    info '没装 systemd unit：前台运行（Ctrl+C 停）。生产请用 deploy/install-server.sh'
    ( cd "$ROOT" && "$NODE_BIN" src/bridge.js )
  fi
fi

printf '\n\033[36m  首次运行引导结束\033[0m\n'
info '控制台: http://127.0.0.1:3100  （令牌在 state/console-token）'
info '状态:   deploy/verify-server.sh'
info '体检:   node scripts/preflight.mjs'
info '遇到问题: TROUBLESHOOTING.md / docs/guides/FRESH-INSTALL.md'
printf '\n'
exit 0
