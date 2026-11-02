#!/data/data/com.termux/files/usr/bin/bash
# 手机端一键引导（0.5.47）· Termux · **不需要 root**
#
# 为什么是 Termux：普通安卓手机没有 root，App 只能在**自己的私有目录**里执行二进制
# （/data/data/<pkg>/files/...，Termux 的 $PREFIX 就是这里）。我们那套 adb + /data/local/tmp
# 的做法只适用于模拟器/开发者机，普通用户走不过来。
#
# 这个脚本做的事（全部在 Termux 里，无 root）：
#   1. 装 node（桥接本身是纯 JS）
#   2. 装 proot（用户态 chroot，靠 ptrace，不需要 root）
#   3. 下载 Ubuntu rootfs + QQ Linux + NapCat，解到 $HOME/qqb/
#   4. 编 NapCat launcher，写 OneBot 配置
#   5. 生成启动脚本（含 NODE_EXTRA_CA_CERTS，否则 Android 上所有 HTTPS 都会证书失败）
#
# 用法：
#   bash bootstrap.sh            # 全流程
#   bash bootstrap.sh --check    # 只检查环境，不动文件
#   bash bootstrap.sh --start    # 跳过安装，直接启动
set -u

BASE="$HOME/qqb"
BIN="$BASE/bin"
LOG="$BASE/logs"
PROOT_ROOT="$BASE/proot"
UBUNTU="$BASE/ubuntu"
APP="$BASE/app"

say() { printf '\033[1;36m[qqb]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[qqb] 失败：%s\033[0m\n' "$*" >&2; exit 1; }

# 手机架构：真机几乎全是 arm64，模拟器是 x86_64 —— 下载的资产必须跟着变
detect_arch() {
  case "$(uname -m)" in
    aarch64|arm64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=amd64 ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac
  say "架构：$ARCH"
}

need_termux() {
  case "${PREFIX:-}" in
    */com.termux/*) return 0 ;;
    *) die "请在 Termux 里运行（PREFIX 不是 Termux 路径：${PREFIX:-空}）" ;;
  esac
}

check_env() {
  need_termux
  say "PREFIX=$PREFIX"
  say "HOME=$HOME"
  say "架构=$(getprop ro.product.cpu.abi 2>/dev/null || echo unknown)"
  local free
  free=$(df -m "$HOME" | awk 'NR==2{print $4}')
  say "可用空间=${free}MB（完整安装约需 2500MB）"
  [ "${free:-0}" -ge 2000 ] || say "⚠ 空间可能不够：Ubuntu+QQ+NapCat 解压后约 1.6GB"
  command -v node >/dev/null && say "node: $(node -v)" || say "node: 未安装（将装）"
  command -v proot >/dev/null && say "proot: 已安装" || say "proot: 未安装（将装）"
}

install_pkgs() {
  say "安装 Termux 包（nodejs-lts / proot / unzip / curl / xz-utils）"
  pkg update -y >/dev/null 2>&1 || true
  pkg install -y nodejs-lts proot unzip curl xz-utils tar || die "pkg install 失败"
}

fetch() {
  # fetch <url> <输出文件>：带重试，失败不静默
  local url="$1" out="$2"
  [ -s "$out" ] && { say "已存在 $(basename "$out")"; return 0; }
  say "下载 $(basename "$out")"
  curl -fL --retry 3 --connect-timeout 20 --max-time 1800 -o "$out.part" "$url" || { rm -f "$out.part"; die "下载失败：$url"; }
  mv "$out.part" "$out"
}

setup_ubuntu() {
  mkdir -p "$UBUNTU" "$LOG"
  if [ ! -x "$UBUNTU/bin/bash" ]; then
    local tarball="$BASE/ubuntu-base.tar.gz"
    fetch "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.3-base-${ARCH}.tar.gz" "$tarball"
    say "解压 Ubuntu rootfs（约 80MB）"
    tar xzf "$tarball" -C "$UBUNTU" || die "解压失败"
  else
    say "Ubuntu rootfs 已就绪"
  fi
  # Android 没有 /dev/shm，Electron(QQ) 会 FATAL；proot 里 bind 一个
  mkdir -p "$BASE/shm"; chmod 1777 "$BASE/shm"
  # DNS：Android 的 resolver 在 guest 里不可用，写死两个公共 DNS
  printf 'nameserver 223.5.5.5\nnameserver 119.29.29.29\n' > "$UBUNTU/etc/resolv.conf"
}

proot_exec() {
  # 在 guest 里执行一段脚本：$1 是命令字符串
  mkdir -p "$BASE/tmp"
  printf '%s\n' "$1" > "$BASE/tmp/cmd.sh"
  PROOT_TMP_DIR="$BASE/tmp" PROOT_NO_SECCOMP=1 \
  PROOT_LOADER="$(command -v proot >/dev/null && echo "${PREFIX}/libexec/proot/loader" || echo '')" \
    proot --link2symlink -0 -r "$UBUNTU" \
      -b /dev -b /proc -b /sys -b "$BASE/shm:/dev/shm" -b "$BASE/tmp:/tmp" \
      -w /root \
      /usr/bin/env -i \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/root LANG=C.UTF-8 TERM=dumb \
        /bin/bash -l /tmp/cmd.sh
}

setup_guest() {
  say "在 Ubuntu 里装运行库 + QQ + NapCat（首次约 10~20 分钟）"
  proot_exec '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq coreutils procps xz-utils curl ca-certificates \
  zip unzip xvfb screen xauth g++ \
  libasound2t64 libnss3 libgbm1 libgssapi-krb5-2 libxkbcommon0 \
  libxdamage1 libxfixes3 libxrandr2 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libcups2t64 libdrm2 libxcomposite1 libxshmfence1
' || die "guest 依赖安装失败"
}

install_qq() {
  local deb="$BASE/linuxqq.deb"
  fetch "https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_${ARCH}.deb" "$deb"
  say "安装 QQ Linux 客户端"
  cp "$deb" "$BASE/tmp/QQ.deb"
  proot_exec 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq /tmp/QQ.deb' || die "QQ 安装失败"
}

install_napcat() {
  local zip="$BASE/NapCat.Shell.zip"
  fetch "https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip" "$zip"
  say "解 NapCat + 编译 launcher"
  cp "$zip" "$BASE/tmp/NapCat.Shell.zip"
  cp "$BASE/launcher.cpp" "$BASE/tmp/launcher.cpp" 2>/dev/null || true
  proot_exec '
set -e
mkdir -p /root/napcat
unzip -q -o -d /root/napcat /tmp/NapCat.Shell.zip
if [ -f /tmp/launcher.cpp ]; then
  cd /root && g++ -shared -fPIC launcher.cpp -o libnapcat_launcher.so -ldl
fi
mkdir -p /root/napcat/config
' || die "NapCat 安装失败"
}

write_onebot_config() {
  # OneBot WS 只监听回环：桥接和 NapCat 在同一台手机上，不需要暴露到局域网
  cat > "$BASE/onebot11.json" <<'JSON'
{
  "network": {
    "httpServers": [
      { "name": "qb-http", "enable": true, "host": "127.0.0.1", "port": 6198, "token": "", "messagePostFormat": "array", "debug": false }
    ],
    "httpClients": [],
    "websocketServers": [
      { "name": "qb-ws", "enable": true, "host": "127.0.0.1", "port": 6199, "token": "qb-token", "messagePostFormat": "array", "reportSelfMessage": false, "debug": false, "heartInterval": 30000, "enableForcePushEvent": true }
    ],
    "websocketClients": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false
}
JSON
  cp "$BASE/onebot11.json" "$UBUNTU/root/napcat/config/onebot11.json"
  say "已写 OneBot 配置（ws://127.0.0.1:6199，token=qb-token）"
}

write_launcher() {
  cat > "$BASE/start-napcat.sh" <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
# 起 QQ + NapCat（xvfb 提供虚拟显示；Android 没有 X）
BASE="$HOME/qqb"
cd "$BASE" || exit 1
export PROOT_TMP_DIR="$BASE/tmp" PROOT_NO_SECCOMP=1
setsid proot --link2symlink -0 -r "$BASE/ubuntu" \
  -b /dev -b /proc -b /sys -b "$BASE/shm:/dev/shm" -b "$BASE/tmp:/tmp" \
  -w /root /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  /bin/bash -lc 'cd /root && xvfb-run -a env LD_PRELOAD=/root/libnapcat_launcher.so /opt/QQ/qq --no-sandbox' \
  > "$BASE/logs/napcat.log" 2>&1 < /dev/null &
echo "NapCat 已后台启动，日志：$BASE/logs/napcat.log"
echo "首次需要扫码：tail -f $BASE/logs/napcat.log，或看 /root/napcat/cache/qrcode.png"
SH
  chmod +x "$BASE/start-napcat.sh"

  cat > "$BASE/start-bridge.sh" <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
# 起桥接（纯 JS，不需要 proot）
BASE="$HOME/qqb"
[ -f "$BASE/app/src/bridge.js" ] || { echo "还没放桥接代码：把 qq-bridge 的 src/public/node_modules 放到 $BASE/app/"; exit 1; }
export HOME="$BASE/app"
export NODE_EXTRA_CA_CERTS="$BASE/ubuntu/etc/ssl/certs/ca-certificates.crt"
cd "$BASE/app" || exit 1
command -v termux-wake-lock >/dev/null && termux-wake-lock
exec node --enable-source-maps src/bridge.js
SH
  chmod +x "$BASE/start-bridge.sh"
  say "启动脚本：$BASE/start-napcat.sh / $BASE/start-bridge.sh"
}

main() {
  local mode="${1:-all}"
  detect_arch
  check_env
  case "$mode" in
    --check) exit 0 ;;
    --start) write_launcher; say "已生成启动脚本"; exit 0 ;;
  esac
  install_pkgs
  mkdir -p "$BASE" "$BIN" "$LOG"
  setup_ubuntu
  fetch "https://raw.githubusercontent.com/NapNeko/napcat-linux-launcher/refs/heads/main/launcher.cpp" "$BASE/launcher.cpp" || true
  setup_guest
  install_qq
  install_napcat
  write_onebot_config
  write_launcher
  say "完成。下一步："
  say "  1) bash $BASE/start-napcat.sh   # 起 QQ+NapCat，日志里找二维码"
  say "  2) 手机 QQ 扫码登录"
  say "  3) 把桥接代码放到 $BASE/app/（src public node_modules package.json config.json）"
  say "  4) bash $BASE/start-bridge.sh   # 起桥接，浏览器开 http://127.0.0.1:3100"
}

main "$@"
