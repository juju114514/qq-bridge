# 让卡巴斯基（Kaspersky）与 qq-bridge / DSH 共存

> 症状：**开着卡巴斯基，DeepSeek（DSH）/ 机器人就不正常；关掉就一切正常。**
> 目标：**不用关杀软**，只加几条排除与受信任规则。
>
> 适用：Kaspersky 21.x（标准版 / 加强版 / Plus / Premium）。
> 本机实测版本：`Kaspersky 21.25`，服务名 `AVP21.25`。

## 0. 先跑自动诊断（只读，不改设置）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\kaspersky-diagnose.ps1
```

它会：

| 检查 | 说明 |
| --- | --- |
| 杀软是否在跑 | 服务 `AVP21.25` / 进程 `avp` |
| 本机端口 | 3000 / 3001 / 3100 / DSH 端口是否可达 |
| 外网 HTTPS | 是否被「加密连接扫描」拖慢 |
| **打印该加白名单的路径** | 自动探测 DSH 目录、项目目录、node.exe、ffmpeg |
| 冒烟测试 | 桥接 `/api/status` 的 `dshReady` / `snowluma.good` |

输出末尾会给出「复制即用」的排除项清单。

## ⚠️ 重要前提：Kaspersky **免费版**没有排除项

实测（Kaspersky 免费版 21.25）：

```
设置 → 安全设置 → 高级设置 → 排除项和检测到对象时的操作
  只有：扫描时执行的操作 / 检测对象类型
  没有：管理排除项 / 指定受信任应用程序

设置里搜索「信任」→ 我们非常擅长查找恶意软件，但我们找不到"信任"
```

**结论**：免费版无法把本项目加白。当它误判 `node.exe` / 脚本时，只能关掉它。

### 三条出路

| 方案 | 代价 | 效果 |
| --- | --- | --- |
| **A. 升级到标准版 / Plus** | 付费 | 有完整排除项与受信任应用，最正规 |
| **B. 卸载卡巴，改用 Windows Defender** | 免费 | Defender 支持排除项，可用脚本全自动配置（推荐） |
| **C. 保留免费版，取消自动删除** | 免费 | 只是不自动删，仍会扫描 → 仍可能卡 |

### 方案 B：Defender 一键排除（推荐）

以**管理员**身份运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\av-exclusions.ps1 -Apply
```

它会：

1. 识别当前杀软（卡巴/Defender/360/火绒）
2. 收集本项目、DSH、`.dsh`、node.exe、ffmpeg 等路径
3. 写入 Defender 排除项（`Add-MpPreference -ExclusionPath / -ExclusionProcess`）
4. 回读验证

> 前提：卡巴要**卸载**（不是只停服务）。装了卡巴时 Defender 会被置为被动模式，排除项不生效。

### 方案 C：只关自动删除（治标）

```
设置 → 安全设置 → 高级设置 → 排除项和检测到对象时的操作
  → 「扫描时执行的操作」取消勾选：
     ☐ 自动执行推荐操作
     ☐ 删除恶意工具、广告软件、自动拨号软件和可疑打包程序
  → 保存
```

这样它不会**直接删掉**你的文件，但仍会在后台扫描（可能拖慢 DSH）。

## 1. 要排除哪些路径

| 路径 | 为什么 |
| --- | --- |
| `D:\DEEPSEEK`（DSH 安装目录） | DSH 主程序、资源、大量读写，最容易被实时扫描拖慢 |
| `C:\Users\<你>\.dsh`（DSH 数据目录） | 会话、附件、运行时会频繁读写 |
| 项目目录（如 `D:\deepseek工作区\qq-bridge`、`D:\QQBot`） | 桥接/日志/状态文件高频读写 |
| `node.exe`（**所有**你用到的） | DSH 自带运行时、系统 Node、项目里的 node |
| `ffmpeg.exe` / `ffprobe.exe` | 语音处理，常被启发式误判 |
| `QQ.exe` / SnowLuma 的 `node.exe` | QQ 协议端 |

> 诊断脚本会把**实际路径**列出来，直接照着加。

## 2. 图形界面操作（Kaspersky 21.x 中文版）

> 不同小版本菜单名可能略有差异。找不到时：设置页顶部直接**搜索「排除」**。

### 2.1 加文件/文件夹排除项

```
卡巴斯基主界面 → 左下「设置」⚙ → 「安全设置」
  → 「威胁与排除」（有的版本叫「常规」下的「排除项」）
    → 「管理排除项」→「添加」
```

添加内容：

| 类型 | 填什么 |
| --- | --- |
| 文件夹 | `D:\DEEPSEEK`、`C:\Users\<你>\.dsh`、项目目录、`D:\QQBot` |
| 文件 | 各个 `node.exe`、`ffmpeg.exe`、`ffprobe.exe` |

**组件**那一栏全选（或至少：文件反病毒、行为检测、系统监视器）。

### 2.2 加「受信任应用程序」（关键，比排除项更有效）

```
设置 → 安全设置 → 威胁与排除 → 「指定受信任应用程序」→「添加」→「浏览」选程序
```

对每个 exe 勾选：

- ☑ **不扫描所有流量**（DSH 的 localhost WebSocket 就靠这项）
- ☑ **不监控应用程序活动**（避免行为检测反复读文件时卡住）
- ☑ **允许与子进程交互 / 不控制子进程**
- ☑ **允许所有网络活动**（如果防火墙那栏出现这个选项）

必须加的程序：

```
DSH 主程序（DeepSeek Harness.exe）
<各路径>\node.exe
ffmpeg.exe / ffprobe.exe
QQ.exe（以及 SnowLuma 的 node.exe）
```

### 2.3 加密连接扫描（HTTPS 变慢/证书报错的元凶）

```
设置 → 安全设置 → 「网络设置」→ 「加密连接扫描」
```

两种做法任选：

| 做法 | 说明 |
| --- | --- |
| **加受信任地址**（推荐） | 「受信任地址」里加 `127.0.0.1`、`localhost`、`*.deepseek.com` |
| 关掉「加密连接扫描」 | 简单粗暴，但会影响全局 HTTPS 防护 |

> 如果你见过 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `self signed certificate` 之类报错，
> 基本都是这一项在中间解密导致的。

### 2.4 防火墙：放行本机端口

```
设置 → 安全设置 → 「防火墙」
  → 「应用程序规则」→ 找到 node.exe → 「网络规则」→ 允许所有
  → 「网络包规则」→「添加」→ 允许 TCP，方向「入站」，地址 127.0.0.1，端口 3000,3001,3100,<DSH端口>
```

<DSH端口> 每次启动会变，所以更省事的做法是**直接给 node.exe 应用规则放行所有网络活动**。

### 2.5 系统监视器 / 入侵防御（可选）

```
设置 → 安全设置 → 「入侵防御」/「系统监视器」→ 受信任应用程序
```

把 node.exe、DSH 主程序加进去，避免「程序行为可疑」类提示。

## 3. 命令行能做与不能做

Kaspersky 21 家庭版**没有**命令行加排除项的接口（`avp.com` 只支持 SCAN/UPDATE/EXPORT/IMPORT 等）：

```
avp.com HELP
  HELP  SCAN  UPDATE  ROLLBACK  RENEW  FEATUREFLAGS  START  STOP
  STATUS  STATISTICS  EXPORT  IMPORT  AcceptEULA  REPORT  FASTFAIL
  SHOWTM  PROXYAUTH  EXIT  TRACES
```

所以排除项只能**图形界面加一次**（加完长期有效）。
脚本能做的是：**探测 + 冒烟测试 + 告诉你该加什么**。

## 4. 加完之后怎么验证

```powershell
# 1) 确认卡巴在跑（不是关掉）
Get-Service AVP21.25

# 2) 冒烟测试
powershell -ExecutionPolicy Bypass -File .\scripts\kaspersky-diagnose.ps1

# 3) 正常聊天
#    用管理员 QQ 私聊机器人发一句「你好」，应能回复
```

通过标准：

```
[OK] 杀软在运行（AVP21.25 = Running）
[OK] 桥接 /api/status：dshReady=True snowluma.good=True
[OK] 外网 HTTPS < 3s
[OK] 冒烟：发消息有回复
```

## 5. 常见症状对照

| 症状 | 大概率原因 | 对应章节 |
| --- | --- | --- |
| DSH 启动很慢 / 界面卡 | 实时扫描 DSH 目录 | 2.1 |
| DSH 页面能开，但 AI 不回 | localhost 流量被扫 / 防火墙拦 | 2.2 + 2.4 |
| 桥接 `dshReady=false` 但 DSH 明明开着 | 同上 | 2.2 + 2.4 |
| 外网请求偶发证书错误 | 加密连接扫描 | 2.3 |
| 语音/视频处理被拦或变慢 | ffmpeg 被启发式误判 | 2.1 + 2.2 |
| 提示「程序行为可疑」 | 系统监视器 | 2.5 |
| 一切正常但偶发超时 | 扫描优先级抢占 IO | 2.1（把项目目录排除） |

## 6. 如果还是不行

1. 先把卡巴**临时暂停保护**（右下角托盘 → 暂停 15 分钟）做对照测试：
   - 暂停后正常 → 100% 是杀软拦截，回到第 1 / 2 节把路径补齐
   - 暂停后仍不正常 → 不是杀软问题，看 [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md)
2. 抓证据：卡巴主界面 → 「更多工具」/「报告」→ 找被拦截的条目，看它拦的是**哪个 exe、哪个路径、哪个端口**
3. 把这三样贴出来：诊断脚本输出 + 卡巴拦截报告截图 + 桥接 `logs/` 最近 50 行

## 7. 不要做的事

- ❌ 不要长期关闭杀软来跑机器人（等于裸奔）
- ❌ 不要把整个 `D:\` 加进排除项（等于没防护）
- ❌ 不要为了绕过检测去改程序签名/加壳
- ✅ 正确做法：**只排除本项目相关路径 + 把相关 exe 设为受信任应用**
