# 启动与守护（Windows）

> 一句话：**`.\start-bridge.ps1` 就是唯一入口**。它起守护，守护起桥接，桥接崩了守护拉回来。
> Linux 不用这个，用 systemd：见 [SERVER.md](SERVER.md)。

## 一、三层链条（别弄反）

```
start-bridge.ps1            ← 人用的入口（一键启动 / 停止 / 看状态 / 登录自启）
   └─ scripts\bridge-supervisor.ps1    ← 守护：单实例、退避重启、退出码分类
         └─ node src\bridge.js         ← 桥接本体（长跑进程）
```

**SnowLuma 不在这条链上。** 它是第三方程序，必须你自己启动并登录（WebUI `:5099`）。
本项目对它的全部动作只有两件：**探测端口**、**读它的 onebot 配置发现 token**。
（设计不变量 L6：不代装、不代启、不代停。守护在起桥接前会探测 `:3000/:3001`，
没就绪就等待并提示，**绝不会替你去启动 SnowLuma**。）

## 二、日常用法

```powershell
cd D:\deepseek工作区\qq-bridge

.\start-bridge.ps1                  # 前台启动（日志直接看得到，Ctrl+C 一起停）
.\start-bridge.ps1 -Hidden          # 后台启动（日志进 state\logs\）
.\start-bridge.ps1 -Status          # 看一眼：谁在跑、端口、SnowLuma、DSH
.\start-bridge.ps1 -Stop            # 优雅停止（15 秒没收尾就兜底强杀）
.\start-bridge.ps1 -InstallStartup  # 登录自动起（计划任务 qq-bridge-supervisor）
.\start-bridge.ps1 -RemoveStartup   # 取消登录自启
```

`-Status` 的输出长这样（每项都有判据，不用猜）：

```
  [OK]   守护进程   pid=20880（在跑）
  [OK]   桥接进程   pid=12776（在跑）
  [OK]   控制台 3100  在听；mode=reserved2 role=小鲸鱼（已测试） dshReady=True
  [OK]   上游       snowluma.connected=True accountOnline=True 心跳=1639ms
  [OK]   SnowLuma   :3000/:3001 在听
```

## 三、退出码契约（脚本之间靠它沟通）

| 码 | 含义 | 谁产生 |
| --- | --- | --- |
| `0` | 正常（启动成功 / 停止完成 / 状态打印 / 已有实例无需重启） | 两者 |
| `1` | 连续快速崩溃超上限，守护放弃（避免掩盖真问题） | supervisor |
| `2` | 桥接发现控制台端口被占（已有实例）→ 守护不再重启 | bridge → supervisor |
| `3` | 已有一个守护在跑（单实例） | supervisor / start-bridge |
| `4` | SnowLuma 未就绪且等待超时（提示人工启动，绝不代启） | supervisor |
| `5` | 环境不满足（找不到 node / 缺 config.json / 缺入口） | 两者 |

重启策略（`supervisor` 内部）：

| 子进程退出 | 处理 |
| --- | --- |
| `code=2` | 端口被占 → 守护退出，避免双开 |
| `code=0` | 正常退出（例如控制台点了「重启桥接」）→ 1 秒后重启 |
| 其它 / 取不到（`-1`） | 崩溃：60 秒内算「快速崩溃」，退避 **5 → 10 → 20 → 40 → 60** 秒；连败 5 次放弃 |

> `-1` 是刻意归一化的：PowerShell 5.1 在进程被强杀时经常拿不到 `ExitCode`，
> 不归一化就会把「被杀」误判成「正常退出」，于是无限重启而不报错。

## 四、运行态文件（都不进 git）

| 文件 | 谁写 | 作用 |
| --- | --- | --- |
| `state\supervisor.lock` | supervisor | 单实例锁（JSON：pid / startedAt / root）；进程不在=残留锁，下次自动清 |
| `state\bridge.pid` | supervisor | 当前被守护的桥接进程号（`-Stop` 用它兜底） |
| `state\supervisor.stop` | start-bridge | 停止信号（存在即优雅退出，收尾后删除） |
| `state\logs\supervisor.log` | supervisor | 启停/重启/崩溃原因 |
| `state\logs\bridge.out.log` / `.err.log` | 子进程重定向 | `-Hidden` 模式下桥接的 stdout/stderr |
| `state\bridge.log` | 桥接自己 | 业务日志（看问题先看这个） |

## 五、启动顺序（固定，别反）

```
1) SnowLuma 已启动并登录（WebUI :5099 扫码）      ← 你自己来
2) DSH 已在跑（端口可能每次不同）                ← 你自己来
3) .\start-bridge.ps1                           ← 本条链
4) 桥接日志出现「DSH 已就绪（模式: reserved2）」与「SnowLuma 已连接」
```

**首连报一次 `1006` 是正常路径**：桥接会顺手把 SnowLuma 的 WS token 自愈一遍
（日志里能看到「自愈完成：账号 …」），第二次就连上了。每次启动都会走这一遭。

## 六、排障速查

| 症状 | 先看 | 处置 |
| --- | --- | --- |
| `-Status` 显示桥接未运行 | `state\logs\supervisor.log` 尾部 | 看是放弃重启（code=1）还是端口被占（2） |
| 守护反复重启 | `state\logs\bridge.err.log` | 多半是 config 错 / Node 版本低 / 端口占用 |
| `退出码 4` | SnowLuma 端口 | 先去把 SnowLuma 起来并登录 |
| `退出码 3` | `state\supervisor.lock` | 已经有守护在跑，`-Status` 看一眼即可；确实要重启就 `-Stop` |
| 端口 3100 被别的进程占 | `Get-NetTCPConnection -LocalPort 3100` | 那个进程就是旧桥接，先 `-Stop` 再起 |
| 重启后机器人不说话 | `state\bridge.log`：有没有「DSH 已就绪」 | 没有就是 DSH 端口变了，改 `config.dsh.baseUrl` |

## 七、给接手的 AI（重要）

1. **不要绕过 `start-bridge.ps1` 直接 `node src\bridge.js` 长跑** —— 那样崩了没人拉起，
   而且没有单实例保护。
2. **不要在这个链条里加「启动 SnowLuma」的逻辑**，哪怕是为了"方便"。这是设计不变量
   （[NOTICE.md](../../NOTICE.md) 与 SnowLuma 许可争议的边界就在这里）。
3. 改脚本时保持**契约块**（每个 `.ps1` 顶部的 `.SYNOPSIS`/`退出码`）同步更新 ——
   那是给下一个 AI（和你自己三个月后）看的唯一可靠说明。
4. 改完跑：`node scripts/test-launcher-scripts.mjs`（结构契约）+
   `node scripts/test-audit.mjs`（全套 43 项）。
5. 两个 `.ps1` 必须是 **UTF-8 带 BOM**：PowerShell 5.1 读中文不带 BOM 会乱码，
   连 `-Status` 的输出都会变成问号。
