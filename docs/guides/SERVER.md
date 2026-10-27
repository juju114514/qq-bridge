# 服务器部署（Linux）

> ⚠️ **先读：[TOPOLOGY.md](TOPOLOGY.md)**。
> 把桥接单独放到服务器、而 DSH / SnowLuma 留在家里 Windows 上，是**不建议**的架构：
> 桥接是本系统最轻的组件，还多出一段跨机链路；DSH 的会话 Cookie 依赖**本机**签名密钥，
> 跨机就得外借凭据。真正值得上服务器的是「DSH 能无头 + QQ 网关换 NapCat/Lagrange」那种
> 全 Linux 方案（拓扑 B）。家里有常开 PC 的话，直接用 Windows 的 `install.ps1` 更省事。
>
> 本文的脚本适用于：**三个组件在同一台 Linux 上**（NAS / 软路由 / 云服务器）。

> Windows 用 `install.ps1` / `verify.ps1` / `maintain.ps1`；
> **Linux 用 `deploy/*.sh`**（systemd + bash）。桥接本体是 Node，两边行为一致。

## 目录

| 脚本 | 作用 |
| --- | --- |
| `deploy/install-server.sh` | 一键安装（建用户/目录、生成 config、npm install、写 systemd、启动） |
| `deploy/verify-server.sh` | 自检（Node/依赖/config/端口/systemd/状态接口/磁盘） |
| `deploy/maintain-server.sh` | 备份（可 GPG 加密）、裁日志、清用量、重启 |
| `deploy/guard-server.sh` | 花费熔断（给 cron） |
| `deploy/qq-bridge.service` | systemd unit 模板 |

## 一、前置（必须人工）

| 组件 | 说明 |
| --- | --- |
| **Node ≥ 22.13** | `nvm install 22` 或发行版源 |
| **DeepSeek Harness（DSH）** | 装好并**登录**；确认 `http://127.0.0.1:3080`（或你改的端口）可访问 |
| **SnowLuma** | 装好并**扫码登录** QQ 小号；确认 `:3000`(HTTP) 与 `:3001`(WS) 可连 |

> 服务器上通常没有桌面，SnowLuma 需要能在该机器跑（或用另一台机器 + 端口可达）。
> 桥接只通过 HTTP/WS 连它，不关心它在哪台机器。

## 二、安装

```bash
sudo ./deploy/install-server.sh --owner-qq 123456789
# 可选：
#   --dir /opt/qq-bridge        安装目录
#   --user qqbridge             运行用户（会创建，nologin）
#   --dsh-url http://127.0.0.1:3080
#   --groups "111,222" --privates "333"
#   --no-start                  只装不启动
```

它做的事：

1. 校验 Node 版本与 systemd
2. 创建系统用户 `qqbridge` + 目录（`state/` 权限 700）
3. 用 `config.example.json` 生成 `config.json`（ownerQQ / dsh / snowluma / 白名单）
4. `npm install`（含 postinstall 的 `@snowluma/sdk` 补丁）
5. 渲染并启用 `qq-bridge.service`，启动

## 三、自检

```bash
sudo ./deploy/verify-server.sh
# 退出码：0 全通过 / 2 有警告 / 1 有失败
```

检查项：Node、依赖、config、四个端口、systemd 状态与开机自启、`/api/status` 的 `dshReady` 与 `snowluma.good`、`state/` 可写、磁盘余量。

## 四、日常运维

```bash
# 看状态
systemctl status qq-bridge
journalctl -u qq-bridge -f

# 备份（默认明文 tar.gz → 建议 GPG 加密）
sudo ./deploy/maintain-server.sh --backup --gpg-recipient me@example.com

# 备份 + 裁 7 天前日志 + 清用量 + 重启
sudo ./deploy/maintain-server.sh --backup --trim-logs --prune-usage --restart

# 只看看占多少
sudo ./deploy/maintain-server.sh --status
```

> **安全提示**：备份含 `state/console-token` 与 `config.json` 里的 OneBot token（明文）。
> 不加 `--gpg-recipient` 时请确保 `$QQBOT_BACKUP_DIR`（默认 `/var/backups/qq-bridge`）权限 700 且不在公开路径。

## 五、花费熔断（cron）

```bash
sudo crontab -e
# 每 30 分钟检查，超 5 元就关 AI 并私聊管理员
*/30 * * * * /opt/qq-bridge/deploy/guard-server.sh --limit 5 >> /var/log/qq-bridge-guard.log 2>&1
```

恢复：

```bash
sudo /opt/qq-bridge/deploy/guard-server.sh --resume
```

## 服务器用户怎么解决「两个 GUI 硬依赖」

服务器（无桌面）上跑这套系统，必须先解决 DSH 与 QQ 网关的登录界面问题。
**两条腿都要换**，少一条就跑不起来：

| 依赖 | 桌面版做法 | 服务器上的做法 | 官方/社区支持 |
| --- | --- | --- | --- |
| **DSH** | 打开 Electron 窗口登录 | `node .../@deepseek-ai/dsh/lib/bin.js --profile web --port 8080`（无头跑 web profile） | DSK CLI 自带 `--profile` 机制；**需实测** |
| **QQ 网关** | SnowLuma 扫码 | 换 **NapCatQQ**（Docker）或 **Lagrange.OneBot**：都实现 OneBot v11，桥接不绑死 SnowLuma | 成熟，有 Docker 镜像 |

### 第一步：先证明 DSH 能无头跑

```bash
chmod +x deploy/probe-dsh-headless.sh
./deploy/probe-dsh-headless.sh --port 3080
```

- 退出码 `0` → 打印「DSH 无头【可用】」→ 继续第二步
- 退出码 `1` → 打印「DSH 无头【不可用】」+ 日志 → **停止**，回拓扑 A（家用机）

> 探测脚本会自己起、自己等端口、自己收尾；`--keep` 可保留进程看细节。
> 它能免掉你手工找 `bin.js`、拼 profile 参数的麻烦。

### 第二步：装无头 QQ 网关（NapCat 示例）

```bash
# 1) 拉镜像并起（端口与桥接默认一致：3000 HTTP / 3001 WS）
docker run -d --name napcat --restart unless-stopped   -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001   -v /opt/napcat:/app/napcat/config   mlikiowa/napcat-docker:latest

# 2) 首次扫码登录（看日志里的二维码 / 或用它的 WebUI）
docker logs -f napcat

# 3) 在 NapCat 配置里开启 OneBot v11：
#    HTTP 服务器 127.0.0.1:3000（记下 access token）
#    WebSocket 服务器 127.0.0.1:3001（记下 access token）
```

> 只监听 `127.0.0.1`（上面 `-p 127.0.0.1:...` 就是干这个），不要暴露公网。

### 第三步：装桥接

```bash
sudo ./deploy/install-server.sh --owner-qq <你的QQ号>   --dsh-url http://127.0.0.1:3080   --snowluma-http http://127.0.0.1:3000   --snowluma-ws   ws://127.0.0.1:3001
sudo ./deploy/verify-server.sh
```

### 与桌面版的差异（服务器版要知道）

| 项 | 桌面版（SnowLuma + DSH 窗口） | 服务器版（NapCat + DSH 无头） |
| --- | --- | --- |
| QQ 登录 | 扫码，随时可看 | 首次扫码一次，之后靠 token；掉线要重新扫码（可看容器日志） |
| 表情/收藏 | SnowLuma 面板管理 | 靠桥接的 `qq_list_stickers`（OneBot 接口提供） |
| 语音发送 | 面板可试听 | 直接发文件，无试听 |
| DSH 更新 | 应用内更新 | 手工替换 runtime 目录或镜像重建 |
| 排错入口 | 两个窗口的日志 | `journalctl -u qq-bridge` + `docker logs napcat` |

### 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `probe-dsh-headless.sh` 报找不到 `bin.js` | 桌面版把它封在 `app.asar` 里 | 用 DSH 的 Linux 解包发行版；否则回拓扑 A |
| 探测时进程立刻退出 | `web` profile 依赖 Electron API | 换 profile（`--profile host`）试；仍不行则回 A |
| NapCat 起来但桥接 `snowluma.good=false` | token 填错 / 未扫码 | `docker logs napcat` 看登录状态；核对 config 的 accessToken |
| QQ 图收不到 | NapCat 未开图片下载/缓存目录只读 | 检查 `-v` 挂载权限（`chown 1000:1000 /opt/napcat`） |
| 两处 token 不一致 | OneBot HTTP 与 WS 是两个 token | 桥接的 `accessToken` 存 HTTP 那份；WS 由自愈逻辑补 |

### 什么时候干脆别上服务器

- 无法拿到 DSH 的无头运行时（只有桌面安装包）
- 不想维护容器与扫码重登
- 家里本来就有一台常开机器

→ 直接用 Windows 的 `install.ps1`（拓扑 A），别绕服务器。

## 六、与 Windows 版的差异

| 能力 | Windows | Linux（本方案） |
| --- | --- | --- |
| 进程管理 | `start-bridge.ps1` + `scripts/bridge-supervisor.ps1`（或计划任务） | **systemd**（自动重启、开机自启、日志进 journald） |
| 首次准备 | `scripts\first-run.ps1` | **`deploy/first-run.sh`**（体检→依赖→配置→preset→可选启动；与 Windows 版同逻辑同退出码） |
| 备份加密 | DPAPI（绑用户+机器） | **GPG**（可跨机解密）或直接放加密卷 |
| 权限硬化 | `icacls` | `chown qqbridge` + `chmod 700 state` |
| 端口探测 | `Get-NetTCPConnection` | `/dev/tcp` 探测 |
| 日志 | `state/*.log` + 手动裁 | journald + `maintain-server.sh --trim-logs` |
| 防火墙 | Windows 防火墙 | `ufw` / `firewalld` / `nftables` |

## 七、最小权限（重要）

`install-server.sh` 默认就建了专用用户，systemd unit 里还有这些硬化：

```ini
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=Full
ProtectHome=read-only
ReadWritePaths=/opt/qq-bridge/state /opt/qq-bridge/logs /opt/qq-bridge/audio
```

想再收紧（可选）：

```bash
# 只允许它连本机回环（不出网）
sudo iptables -A OUTPUT -m owner --uid-owner qqbridge -d 127.0.0.1 -j ACCEPT
sudo iptables -A OUTPUT -m owner --uid-owner qqbridge -j DROP
```

> 注意：上面这条会让联网搜索/点歌这类功能失效，只在完全内网场景用。

### 降权之后必须补的那份访问：DSH 凭据

这条最容易漏，症状也最容易误诊，所以单独说。

桥接默认**不**在 `config.json` 里存 DSH 的 token，而是用 DSH 的**本机签名密钥**离线铸造 cookie：

```
$DSH_HOME/.credentials.yaml      # DSH_HOME 默认 = ~/.dsh
```

`install-server.sh` 把桥接降权成 `qqbridge` 之后会出现两个连带问题：

| 问题 | 后果 |
| --- | --- |
| 服务进程的 `HOME` 变成 `/home/qqbridge` | 去 `/home/qqbridge/.dsh` 找凭据 → 不存在 |
| `.credentials.yaml` 通常是 `600 root:root`，`/root` 是 `700` | 即便路径指对了也读不到 |

表现是：**`curl` 打 DSH 是通的，但桥接报 DSH 401 / 「铸造 cookie 失败」**。因为 curl 用的是你自己的身份，桥接用的是 `qqbridge`。

`install-server.sh` 现在会自动做这四件事：

1. 探测真正的 DSH_HOME（`--dsh-home` > `$DSH_HOME` > `$SUDO_USER` 的 `~/.dsh` > `/root/.dsh`）
2. 把探测结果写进 unit：`Environment=DSH_HOME=/root/.dsh`
3. 用 ACL 只授予**穿越目录(x) + 读该文件(r)** 这一份最小权限（不给目录列表权限）：

   ```bash
   setfacl -m u:qqbridge:--x /root /root/.dsh     # 能穿过，但不能 ls
   setfacl -m u:qqbridge:r-- /root/.dsh/.credentials.yaml
   ```

   没有 `setfacl` 时退回「专用组 + 640 + usermod -aG」。
4. **以 `qqbridge` 身份实测读一次**（`sudo -u qqbridge test -r ...`）——只检查 `mode` 位是不够的，父目录 `700` 一样读不到。

装完可以单独复查：

```bash
sudo ./deploy/verify-server.sh | grep 'DSH 凭据'
# [OK] DSH 凭据   qqbridge 可读 .dsh/.credentials.yaml
```

手工补救（脚本提示哪一级不通就补哪一级）：

```bash
# 1) 看是哪一级挡住了（x 缺失时连 test -r 都会失败）
sudo -u qqbridge test -r /root/.dsh/.credentials.yaml; echo $?

# 2) 补穿越 + 读
sudo setfacl -m u:qqbridge:--x /root
sudo setfacl -m u:qqbridge:--x /root/.dsh
sudo setfacl -m u:qqbridge:r-- /root/.dsh/.credentials.yaml

# 3) 确认 unit 里 DSH_HOME 指向同一个目录
systemctl show -p Environment --value qq-bridge | tr ' ' '\n' | grep DSH_HOME
sudo systemctl restart qq-bridge
```

两个边界情况：

- **DSH 在另一台机器上**（`dsh.baseUrl` 不是回环地址）：本机密钥铸造**本来就不成立**，别折腾权限了，改为把 `dsh.authToken` 填成那台 DSH 的启动凭据。安装脚本检测到非回环地址会直接跳过授权并提示这一点。
- **换了 DSH 登录账号 / 迁移了 `.dsh` 目录**：ACL 绑定的是路径，重跑 `install-server.sh`（或按上面三步手工修）即可，不用改 `config.json`。

> 为什么不做「把 `.credentials.yaml` 复制一份给 qqbridge」：签名密钥一旦有两份就会漂移，DSH 那边轮换后桥接静默失效，比权限问题更难查。宁可要一次 ACL。

## 八、远程访问

**不要把 3100 / 3000 / 3001 / DSH 端口直接暴露到公网。**

| 方式 | 命令 |
| --- | --- |
| SSH 隧道（推荐） | `ssh -L 3100:127.0.0.1:3100 user@server`，本地开 `http://127.0.0.1:3100` |
| Tailscale | `tailscale up`，用 tailnet IP 访问 |
| Cloudflare Tunnel | `cloudflared tunnel --url http://127.0.0.1:3100` + Access 策略 |

控制台本身只接受回环 Host（非回环 403），所以隧道是最省事的安全路径。

## 九、SELinux / AppArmor

- **SELinux（CentOS/RHEL/Alma）**：`/opt` 下一般没问题；若 systemd 报 `Permission denied`：
  ```bash
  sudo ausearch -m avc -ts recent | tail
  sudo semanage fcontext -a -t bin_t "/opt/qq-bridge(/.*)?"
  sudo restorecon -Rv /opt/qq-bridge
  ```
- **AppArmor（Ubuntu）**：默认不限制普通服务；如启用 profile，需要额外允许读 `/opt/qq-bridge`。

## 十、常见问题

| 现象 | 处理 |
| --- | --- |
| `npm install` 报 `node is not recognized` | npm 的 postinstall 找不到 node：把 node 目录加进本次会话 PATH 重试 |
| 服务起来但 `dshReady=false` | DSH 没登录 / 端口不对（`config.json` 的 `dsh.baseUrl`）；DSH 重启会换端口，需同步改 |
| `snowluma.good=false` | QQ 掉线：去 SnowLuma 重新扫码 |
| `journalctl` 里 `EACCES state/` | 属主不对：`sudo chown -R qqbridge:qqbridge /opt/qq-bridge` |
| 时间不对导致 401 | `sudo timedatectl set-ntp true`（Cookie 校验依赖时钟） |
| 想跑两个号 | 两个目录 + 两个 systemd unit（`qq-bridge-a.service` / `-b.service`），各自 config 与端口 |

## 十一、卸载

```bash
sudo systemctl disable --now qq-bridge
sudo rm -f /etc/systemd/system/qq-bridge.service && sudo systemctl daemon-reload
sudo rm -rf /opt/qq-bridge /var/backups/qq-bridge
sudo userdel -r qqbridge
```
