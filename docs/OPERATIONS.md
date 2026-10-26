# 运维手册（OPERATIONS）

> 日常维护、备份、隐私、账号风控、审计。
> 一键体检用 [verify.ps1](../verify.ps1)；一键维护用 [scripts/maintain.ps1](../scripts/maintain.ps1)。

## 目录

| 主题 | 跳转 |
| --- | --- |
| 备份（含加密与跨机灾备） | [备份](#备份) |
| 日志隐私与保留期 | [日志隐私](#日志隐私) |
| 凭据轮换 | [凭据轮换](#凭据轮换) |
| 变更审计 | [变更审计](#变更审计) |
| 孤儿会话清理 | [孤儿会话](#孤儿会话) |
| 文件权限硬化 | [ACL 硬化](#acl-硬化) |
| QQ 封号 / 风控 | [账号风控](#账号封号--风控) |
| 供应链（postinstall / main vs tag） | [供应链](#供应链) |
| 定期维护计划 | [维护计划](#维护计划) |
| 非 Windows 部署 | [非 Windows](#非-windows) |

---

## 维护脚本

```powershell
# 只报告，不改任何东西
powershell -ExecutionPolicy Bypass -File .\scripts\maintain.ps1

# 执行：加密备份 + 裁日志 + 清用量
.\scripts\maintain.ps1 -Apply

# 轮换控制台令牌（有效期内旧令牌立即失效，需重启桥接）
.\scripts\maintain.ps1 -Apply -RotateConsoleToken

# 只做某一项
.\scripts\maintain.ps1 -Apply -Backup
.\scripts\maintain.ps1 -Apply -TrimLogs -KeepLogDays 14
```

---

## 备份

### 为什么不能直接复制 state/

`state/` 里至少有三个文件是**凭据**：

| 文件 | 性质 |
| --- | --- |
| `state/console-token` | 控制台鉴权令牌（明文） |
| `config.json` 里的 `snowluma.accessToken` | OneBot 令牌（明文） |
| `state/roles-by-key.json` / `social-v2.json` | 会话结构 + 聊天内容片段 |

直接 `Copy-Item` 到网盘/邮箱 = 把令牌和自己的聊天记录一起送出去。

### 正确做法：DPAPI 加密备份

`maintain.ps1 -Backup` 做的是：

```
挑关键文件 → 打 zip → 用 Windows DPAPI(CurrentUser) 加密 → 写 .zip.dpapi → 覆盖并删除明文 zip
```

产出：`../qq-bridge-backups/qq-bridge-<时间戳>.zip.dpapi`

**特性**：

- 只有**当前 Windows 用户 + 本机**能解密
- 拷到别的机器**解不开**（这是安全特性，不是 bug）
- 跨机灾备见下一节

### 如何恢复加密备份

```powershell
Add-Type -AssemblyName System.Security
$enc = [IO.File]::ReadAllBytes("D:\...\qq-bridge-backups\qq-bridge-xxxx.zip.dpapi")
$zip = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$tmp = Join-Path $env:TEMP 'restore.zip'
[IO.File]::WriteAllBytes($tmp, $zip)
Expand-Archive $tmp -DestinationPath .\restore -Force
# 然后只把需要的文件复制回原位（别整目录覆盖）
```

### 跨机器灾备（换电脑 / 重装系统）

DPAPI 绑定用户+机器，所以跨机要换方式：

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| **A. 只过渡敏副本** | 备份前把 `console-token`、`accessToken` 置空，再压缩存网盘 | 只想保 config 与人设 |
| **B. 7-Zip AES 加密** | `7z a -p<强密码> -mhe=on backup.7z state config.json roles` | 需要完整迁移 |
| **C. 密码管理器存凭据** | 令牌单独存密码管理器，state 其余部分明文备份 | 最省心 |

> 恢复后**必须换新令牌**（因为旧令牌可能已随备份外流）。

### 安全删除

DPAPI 加密后，脚本会**用 0 覆盖一次明文 zip** 再删除。但：

- SSD 上「覆盖」不保证物理擦除（TRIM/磨损均衡）
- 对 SSD 的可靠做法是**全盘加密**（BitLocker）——这样即使文件残留也读不出

建议：**给存放 state/ 的分区开 BitLocker**。

---

## 日志隐私

### 日志里有什么

| 文件 | 内容 | 敏感度 |
| --- | --- | --- |
| `state/bridge.log` | 收发消息摘要、工具调用、错误 | **含群友发言原文** |
| `state/qq-activity.log` | QQ 活动流水（谁在什么时候说话） | 高 |
| `logs/*.log` | 同上，按任务分文件 | 高 |
| `state/token-usage.jsonl` | 每次调用的 token 数 | 低（但能推算活跃度） |

**结论**：日志 = 聊天记录副本。分享给他人前必须脱敏。

### 保留期建议

| 用途 | 建议保留 |
| --- | --- |
| 日常排错 | 7 天 |
| 事故复盘 | 30 天（单独归档） |
| 长期留存 | 不建议（隐私风险） |

```powershell
# 裁掉 7 天前的日志
.\scripts\maintain.ps1 -Apply -TrimLogs -KeepLogDays 7
```

### 脱敏后再分享

```powershell
# 把 QQ 号替换成占位符
$log = Get-Content state\bridge.log -Raw
$log = $log -replace '\b\d{6,12}\b', '<QQ>'
$log = $log -replace '<OWNER_QQ>', '<OWNER>'
$log | Set-Content state\bridge.redacted.log -Encoding UTF8
```

还要注意：群昵称、群号、链接也可能识别身份。

### 关闭/降低日志量

`config.json`：

| 字段 | 作用 |
| --- | --- |
| `consolePort` 相关日志 | 无法关，但可控量 |
| `socialV2.context.recentLimit` | 快照里带的消息数（小一点日志也小） |

> 桥接本身没有「关日志」开关；需要长期静默的话，用 `verify.ps1` 定期体检代替盯日志。

---

## 凭据轮换

### 轮换什么

| 凭据 | 位置 | 轮换方式 |
| --- | --- | --- |
| 控制台令牌 | `state/console-token` | `maintain.ps1 -Apply -RotateConsoleToken` |
| OneBot token | `config.json` → `snowluma.accessToken` | 在 SnowLuma 里重置，再跑 `install.ps1` 重读 |
| DeepSeek Key | **在 DSH 里**，不在本仓库 | 到 DSH 设置里换 |

### 建议周期

| 场景 | 周期 |
| --- | --- |
| 个人自用、机器只有自己 | 90 天 |
| 多人共用一台机器 | 30 天 |
| 发生过泄露 | **立即** |

`maintain.ps1` 会在令牌超过 90 天时给出 WARN。

---

## 变更审计

### 能查到什么

| 记录 | 位置 | 内容 |
| --- | --- | --- |
| QQ 活动流水 | `state/qq-activity.log` | 谁说了话、什么时候 |
| 桥接日志 | `state/bridge.log` | 工具调用、配置读写、角色切换 |
| git 历史 | 仓库 | 代码/人设/文档的每次改动 |

### 怎么回查「谁改了配置 / 人设」

```powershell
# 1) 人设切换（/role）记录
Select-String -Path state\bridge.log -Pattern '角色|role' | Select-Object -Last 20

# 2) 配置变更（控制台写入会打日志）
Select-String -Path state\bridge.log -Pattern '控制台|设置|config' | Select-Object -Last 20

# 3) 人设文件的变动（如果人设也进 git）
git log -p -- roles/
```

### 不足与补充

- 桥接**没有**结构化的「操作审计表」（谁在何时改了哪个字段）
- 需要强审计时：把 `state/bridge.log` 定期**收集到只增不改的位置**（例如另一台机器的 append-only 文件）

---

## 孤儿会话

### 是什么

每个 QQ 会话在 `state/sessions.json` 里对应一个 DSH 会话 id。
换群、改配置、DSH 重装后，旧 id 会变成**孤儿**：

- 会话映射只增不减
- 死会话仍会被 `session/follow` 触发**整份历史快照**
- 表现：唤醒变慢、token 消耗变大、日志里出现不存在的会话 id

### 怎么发现

```powershell
# 报告里会显示会话条数
.\scripts\maintain.ps1
```

条数应该 ≈「你实际在用的私聊 + 群聊数量」。明显偏大就是有孤儿。

### 怎么清

桥接有 retire 机制（删除/重置会话时会退订），但没有「批量清理」按钮。安全做法：

1. **先备份**（`maintain.ps1 -Apply -Backup`）
2. 停桥接
3. 编辑 `state/sessions.json`：只保留当前在用的 key（`private:<QQ>` / `group:<群号>`）
4. 同步清理 `state/social-v2.json` 里对应会话的 `wake`/`sessions` 段
5. 启动 → `/status` 看是否正常
6. 让机器人在每个保留的会话里各说一句，确认能建新会话

> 不想手改就**直接删掉整个 `sessions.json`**：桥接会为每个会话重建（代价是上下文丢失，但不会坏）。

---

## ACL 硬化

### 风险

默认情况下，`state/` 可能对 `Users` 可读 → **本机其他用户能读到控制台令牌和聊天记录**。

### 检查

```powershell
icacls state
# 期望只有：Administrators / SYSTEM / 你自己的账号
# 出现 BUILTIN\Users 或 Everyone → 需要硬化
```

`maintain.ps1` 的报告会把这条列为 WARN。

### 硬化

```powershell
.\scripts\maintain.ps1 -Apply -HardenAcl
```

等价于：

```powershell
icacls state /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "$env:USERDOMAIN\$env:USERNAME:(OI)(CI)F"
```

> 桥接代码在创建 `state/` 时也会做同样的事；这里是给**已有目录**补一次。

---

## 账号封号 / 风控

### 先分清三种情况

| 现象 | 性质 | 处理 |
| --- | --- | --- |
| QQ 掉线、`snowluma.good=false` | 会话失效 | SnowLuma 重新扫码 |
| 登录时要求验证/滑块 | 风控 | 人工过验证，降低频率后再试 |
| 提示账号被限制/封禁 | 平台处罚 | **只能申诉**，代码层面无解 |

### 风控常见诱因

| 诱因 | 缓解 |
| --- | --- |
| 新号立刻高频发言 | 前 3 天把 `send.maxSendPerMinute` 调到 2~3 |
| 短时间大量加群/私聊陌生人 | 别主动私聊非白名单 |
| 内容触发关键词 | 减少敏感词，别让它复读链接 |
| 同 IP 多号 | 一台机器只跑一个号 |
| 频繁改设备/换端 | 固定用 SnowLuma，别一会儿手机一会儿 PC |

### 被封后的处置流程

```
1. 立刻停桥接（别再重试登录，越试越糟）
2. 确认是「限制」还是「封禁」：看 QQ 官方提示 / SnowLuma 返回码
3. 限制：等 24~72 小时，降低频率后再登录
4. 封禁：走官方申诉；同时准备备用号（不要把备用号也高频跑）
5. 复盘：查 state/qq-activity.log，看被封前 1 小时发了什么
6. 调整：降频、减少主动发言、别碰敏感话题
```

### 备用号策略

| 做法 | 说明 |
| --- | --- |
| 备用号单独一份 config | `config.backup-account.json`，切换时替换 |
| 备用号人设更保守 | 少发表情包、少主动发言 |
| 别让两个号互相对话 | 容易被判异常 |

---

## 供应链

### postinstall 会执行代码

本仓库的 `package.json` 有 **postinstall**（`patch-snowluma-sdk.mjs`），`npm install` 时会自动跑。
这是必要步骤（要补 `@snowluma/sdk` 的兼容），但也意味着：

- **不要**在不可信的分支上跑 `npm install`
- 安装前先看一眼 `package.json` 的 `scripts.postinstall`

```powershell
node -e "console.log(require('./package.json').scripts)"
```

### 用 tag，不要盲跑 main

| 做法 | 风险 |
| --- | --- |
| 直接 `git pull` + 重启 | 拿到未验证改动 |
| **checkout 到 tag / release** | 可控、可回滚 |

```powershell
git fetch --tags
git tag --sort=-creatordate | Select-Object -First 5
git checkout <tag>
npm install
```

### 依赖审计

```powershell
npm audit
npm outdated
```

> 升级后必须跑 `node scripts/test-audit.mjs` + `verify.ps1`。

---

## 维护计划

### 每周（5 分钟）

```
[ ] .\verify.ps1                    → 退出码 0
[ ] .\scripts\maintain.ps1          → 看报告（日志大小/会话数/令牌年龄）
[ ] .\scripts\maintain.ps1 -Apply   → 备份 + 裁日志 + 清用量
```

### 每月

```
[ ] 检查备份能否解密（抽一个恢复试试）
[ ] 看 state/qq-activity.log 有没有异常发言
[ ] npm audit
[ ] 核对 allow.groups / allow.private 是否还有已经不用的群
```

### 每季度

```
[ ] 轮换 console-token 与 OneBot token
[ ] 复查人设卡是否需要更新
[ ] 检查磁盘剩余（state 增长）
```

---

## 非 Windows

本项目**只支持 Windows**（`install.ps1` / `verify.ps1` / `maintain.ps1` 都是 PowerShell + icacls + DPAPI）。
在 Linux/macOS 上跑需要自己做这些替代：

| Windows 能力 | Linux/macOS 替代 |
| --- | --- |
| DPAPI 加密 | `age` / `gpg --symmetric` / `openssl enc` |
| icacls 硬化 | `chmod 700 state && chmod 600 state/*` |
| 服务/计划任务 | systemd unit / launchd plist |
| `Get-NetTCPConnection` | `ss -ltnp` |
| `Add-MpPreference` | 无对应（用系统自带防火墙） |

**桥接本体是 Node.js，跨平台可跑**；不跨平台的只是上面这些运维脚本。
如果你想在 Linux 上部署，最小可行路径：

```bash
npm install
node src/bridge.js        # 前台跑，用 systemd 管
# 配置照 config.example.json 手填
```
