# 换一台机器：迁移清单

> 场景：从旧电脑搬到新电脑、从 Windows 搬到 Linux、或者从 A 服务器换到 B 服务器。
> 本文按**「哪些能带走、哪些必须重做、按什么顺序检错」**组织，照着做一遍即可。

## 一、先分清三类东西

| 类别 | 例子 | 换机能带走吗 |
| --- | --- | --- |
| **代码** | `src/`、`scripts/`、`dsh/`、`roles/*.md` | ✅ 直接复制或 `git clone` |
| **配置** | `config.json` | ⚠️ 能带走，但**里面的路径/端口/令牌要重配** |
| **运行态** | `state/`（会话映射、社交状态、令牌）、`logs/`、`audio/` | ⚠️ **部分能带、部分必须丢**（见第三节） |

## 二、不要复制的东西

| 不要复制 | 原因 |
| --- | --- |
| `state/sessions.json` 里的 **sessionId** | DSH 会话是本机的；换机后这些 ID 全部无效，带着只会让桥接反复报「会话不存在」 |
| `state/console-token` | 换了环境应当**重新生成**（删掉即可，首次启动会新建） |
| `node_modules/` | 跨平台/跨 Node 版本会带错原生二进制，必须重装 |
| 旧机器的 `*.dpapi` 备份 | **DPAPI 绑定「用户 + 机器」**，换机后**解不开**（见下节） |

## 三、DPAPI 备份的硬限制（最容易踩）

`scripts/maintain.ps1 -Backup` 产出的是 `.zip.dpapi`，用 Windows DPAPI `CurrentUser` 作用域加密：

- 换 Windows 用户 ⇒ 解不开
- 换机器 ⇒ 解不开
- 备份文件本身**没有密码**，只有"当前登录用户 + 这台机器"能解

所以**跨机迁移不要指望它**。两条可行路径：

```powershell
# 路径 A（推荐）：迁移时直接复制原文，不经过备份
#   只复制这几样：config.json、roles/*.md、state/ 里你确定要保留的文件
#   然后在旧机器上：maintain.ps1 -Apply -RotateConsoleToken    # 让旧令牌作废
#   再到新机器上首次启动，重新生成令牌

# 路径 B：用 7-Zip 做带密码的归档（需要完整迁移时）
7z a -p<强密码> -mhe=on migrate.7z config.json roles state
```

> 原则：**能重新生成的（令牌、日志）就别带走；必须带走的（角色卡、config）走明文/密码归档，别用 DPAPI。**

## 四、新机器上必须重做的四件事

| # | 事情 | 怎么做 |
| --- | --- | --- |
| 1 | **DSH 地址与端口** | DSH 的监听端口每个进程都可能不同（实测从 3080 漂到随机高位端口）。装好后把它写进 `config.json` 的 `dsh.baseUrl`，或用仓库里的 `launcher/sync-dsh-port.ps1` 自动同步 |
| 2 | **DSH 预设与凭据** | 预设（`qq-chat` / `qq-chat-v2`）装在 **DSH 自己的 home** 里，不在本仓库：新机器上要跑一次 `node scripts/setup-dsh.mjs <preset>`。凭据见下一列 |
| 2b | **DSH 凭据** | 桥接默认用 `$DSH_HOME/.credentials.yaml` 的签名密钥离线铸造 cookie。新机器上 DSH 必须先**登录一次**；Linux 换用户跑时按 [SERVER.md](SERVER.md#降权之后必须补的那份访问dsh-凭据) 给最小授权（`setfacl` 读密钥），并把 `DSH_HOME` 写进 systemd unit |
| 3 | **外部工具路径** | `say` / `sing` / `song` 依赖外部脚本（`speak.ps1`/`sing.ps1`/`song.ps1` + ffmpeg）。新机器上要么放到 `config.paths.tools` 指向的目录，要么用 `QQBOT_SAY_SCRIPT` / `QQBOT_SING_SCRIPT` / `QQBOT_SONG_SCRIPT` 指过去。**这些脚本依赖 Windows PowerShell**：非 Windows 上接口会直接返回「依赖 Windows PowerShell」，不会静默失败 |
| 4 | **访问白名单** | `allow.groups` / `allow.private` / `ownerQQ` 一定要重新核对——换了群/换了号却沿用旧白名单，会出现"机器人对空群说话"或"该回的不回" |

## 五、按这个顺序检错（省时间）

```
1) node --version                      → 必须 >= 22.13
2) node src/bridge.js（前台跑一次）      → 看启动日志有没有「DSH 已就绪」
3) GET /api/status                     → dshReady=true、snowluma.connected=true
4) GET /api/roles                      → 角色卡列表与你复制过来的一致（且不含 README/ATTRIBUTION）
5) GET /api/roles/content?name=小鲸鱼    → 能读到卡（前缀解析生效）
6) 发一条测试消息                        → POST /api/test-send
7) 各功能抽测                          → 表情库同步、语音（仅 Windows）、拍一拍
```

任一步失败，先看 `logs/bridge.log`，再看 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)。

## 六、从 Windows 换到 Linux 时额外注意

| 项 | 说明 |
| --- | --- |
| `state/` 权限 | Windows 用 `icacls`，Linux 用 `chmod 700`；脚本两边都写了，别手工混用 |
| `pause`/`.bat` 启动器 | Windows 专有，Linux 用 `deploy/install-server.sh` + systemd |
| 语音/点歌/唱歌 | 依赖 PowerShell ⇒ 直接不可用（接口会明确告知），需要自己换成平台脚本 |
| 路径大小写 | Linux 区分大小写：`roles/小鲸鱼（已测试）.md` 里的括号是全角，复制时别改名 |
| 角色卡命名 | 身份在文件的 `id:` 里（2026-10 起），**文件名可以随便改**；旧卡先跑 `node scripts/migrate-roles-to-ids.mjs --apply` 补齐元数据并把 `state/` 里的旧名字改写成 id |

## 七、最后：让旧机器"下线"

```powershell
# 旧机器上
.\scripts\maintain.ps1 -Apply -RotateConsoleToken    # 旧控制台令牌作废
# 关掉桥接与 SnowLuma；如果 QQ 小号还在旧机器上登录，先在那边退出登录，
# 再到新机器上重新扫码 —— 同一个号在两处同时挂会互相顶号，表现为「随机掉线」。
```
