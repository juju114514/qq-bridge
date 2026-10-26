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

## 六、与 Windows 版的差异

| 能力 | Windows | Linux（本方案） |
| --- | --- | --- |
| 进程管理 | `start.bat` / 计划任务 | **systemd**（自动重启、开机自启、日志进 journald） |
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
| `npm install` 报 `patch-snowluma-sdk` 失败 | 用 `npm install --foreground-scripts` 看输出；或手动 `node scripts/patch-snowluma-sdk.mjs` |
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
