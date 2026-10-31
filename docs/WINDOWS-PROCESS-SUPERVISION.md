# Windows 进程监督与「窗口自动重启」诊断

> 2026-10-31 实测结论。**不要把「锁文件过期」当根因** —— 那只是旧进程退出后的恢复结果。

## 一、现象

- PowerShell 窗口自动关闭
- 几分钟后弹出一个**新的** PowerShell 窗口
- 新窗口重新打印完整启动日志，并提示「检测到过期锁文件 / 通道持有者已退出，接管通道」

## 二、实测证据

### 1) 进程父链

```
node.exe (bridge, 监听 3100)
  ← powershell.exe
    ← svchost.exe      ← 任务计划宿主
```

父进程是 `svchost`，不是 `cmd`，也不是别的 PowerShell。

### 2) 计划任务配置

```
任务     : qq-bridge
执行     : powershell.exe
参数     : -NoProfile -ExecutionPolicy Bypass -File "…\scripts\run-bridge.ps1"
登录类型 : Interactive（当前用户会话）
运行级别 : HighestAvailable
RestartOnFailure : Interval=PT1M  Count=999     ← 关键
Hidden            : （未设置）
MultipleInstances : （未设置）
```

### 3) 启动器自记日志（决定性）

`state/runner.log` 只有启动行，**没有**退出行：

```
[16:27:46] 使用 node: …\node.exe
[16:27:46] 启动 bridge
[16:28:32] 使用 node: …\node.exe     ← 又出现「使用 node」= 新的 PowerShell 进程
[16:28:32] 启动 bridge
[16:29:14] …
```

而 `run-bridge.ps1` 自己的循环重启会写：

```
bridge 退出（code X），5 秒后重启
```

**一行都没有** → 不是脚本循环重启，而是**整个 PowerShell 被结束，任务在 1 分钟后重新拉起**。
间隔 42–49 秒 ≈ `PT1M`，完全吻合。

### 4) 结论

> **根因 = 计划任务 `qq-bridge` 的「失败后重启：每 1 分钟 × 999 次」＋ 没有隐藏窗口。**

任何一次任务实例结束（手动 `/end`、node 退出、PowerShell 报错）都会被当成失败，
1 分钟后重拉一个可见窗口。

## 三、修法（需要管理员执行一次）

```powershell
# 管理员 PowerShell
cd <部署目录>
powershell -ExecutionPolicy Bypass -File scripts\harden-scheduled-task.ps1 -Apply
```

它会重写 `qq-bridge` 任务：

| 项 | 改成 |
| --- | --- |
| RestartOnFailure | **关闭**（Count=0）—— 脚本里已有 5 秒守护循环，任务级重启是重复兜底 |
| 参数 | 加 `-WindowStyle Hidden` |
| MultipleInstances | `IgnoreNew` |
| ExecutionTimeLimit | `0`（常驻任务不该被超时杀掉） |

> 不加 `-Apply` 是演练模式，只打印将要做的事。
> 非管理员执行会得到 `Access is denied.`（`Register-ScheduledTask` 需要管理员）。

## 四、另外三个启动器（现状与建议）

| 启动器 | 触发者 | 行为 | 建议 |
| --- | --- | --- | --- |
| `scripts/run-bridge.ps1` | 计划任务 `qq-bridge` | while 循环；exit 2 时退出 | **保留为唯一入口** |
| `start.bat` | 手动 / watchdog | 循环；exit 2 时 **`pause`**（窗口卡住） | 去掉 `pause`，或只用它做手动调试 |
| `scripts/keepalive.ps1` | 计划任务 `qq-bridge-watchdog`（5 分钟） | 3100 没在听 → 起 `start.bat` | 改成 `schtasks /run /tn qq-bridge` |

**不要同时装第二套 watchdog**，否则多启动器互相重启（本仓库历史上踩过）。

## 五、退出诊断

`run-bridge.ps1` 现在每次 node 退出都会写 `state/exit.log`：

```
[2026-10-31 16:40:12] exit code=0（主动退出） 运行 123.4s
[2026-10-31 16:41:03] exit code=2（发现已有实例） 运行 0.8s
```

配合启动摘要里的 `buildId / ownerId / epoch`，可以判断：
- 是**崩溃**（exit code 非 0/2）
- 还是**主动退出**（0）
- 还是**发现已有实例**（2，说明有第二个启动器在抢）

## 六、排查顺序（下次再出现"莫名重启"）

1. 看 `state/exit.log`：上次是 code 几？
2. 看 `state/runner.log`：有没有出现**新的**「使用 node」段？（有 = 新进程）
3. 看 `state/bridge.log` 的 `startup.summary`：`bootId` 变了 = 新进程
4. 看 `schtasks /query /tn qq-bridge /v /fo LIST` 的「上次结果」
5. 确认 `RestartOnFailure` 已关闭、`MultipleInstances=IgnoreNew`

## 七、三个容易被做错的细节（外部评审指出，已核实）

### 1) 不能用 `Count=0` 关闭 RestartOnFailure

Task Scheduler 的 XML 要求 `Count >= 1`、`Interval >= PT1M`。
`Count=0` 不是"关闭"，是**非法值**。正确做法是**让整个 `<RestartOnFailure>` 节点不存在**。

本仓库脚本已改成「生成完整 XML → `schtasks /create /xml`」，而不是用
`New-ScheduledTaskSettingsSet -RestartCount 0`（那会写出非法配置）。

### 2) `Settings.Hidden=true` ≠ 隐藏窗口

`Hidden` 只影响「任务计划程序列表里是否显示这个任务」。
真正让 PowerShell 窗口不弹的是**启动参数**：

```
-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File …\run-bridge.ps1
```

### 3) `IgnoreNew` 是默认值，但要显式写

导出 XML 时确认：`<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`
（本机本来就是这个值，重新注册时保留显式声明）。

## 八、本机实测：改之前 vs 改之后

从导出的 XML 读到的**真实现状**（不是猜）：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `RestartOnFailure` | `Count=999 / PT1M` | **节点已删除** |
| 启动参数 | `-NoProfile -ExecutionPolicy Bypass` | 多了 `-WindowStyle Hidden` |
| `MultipleInstancesPolicy` | IgnoreNew（本来就对） | 保持 |
| `ExecutionTimeLimit` | PT0S（本来就对，不会杀长跑 Node） | 保持 |
| 触发器 | 只有 `LogonTrigger`（没有重复触发器） | 保持 |
| `WorkingDirectory` | 项目根（正确） | 保持 |

**结论：原来列的 6 项里，只有 2 项真的需要改**，其余要么已满足、要么该改脚本而不是任务。

## 九、watchdog 的宽限期（避免 `IgnoreNew` 吃掉重启请求）

原 `keepalive.ps1` 有盲区：任务显示 `Running` 但服务已死时，`schtasks /run` 会被
`IgnoreNew` 直接忽略 —— 等于什么都没做。

现在的逻辑：

```
每 5 分钟：
  GET /health/detail → 200 且 ok:true   → 清零计数器，退出
  不可用 → 连续失败 +1；< 3 次 → 记日志，退出
         → 连续 3 次（约 15 分钟）→ 受控重启：
              schtasks /end /tn qq-bridge
              等 5 秒
              schtasks /run /tn qq-bridge
```

同时**不再调用 `start.bat`**（避免出现第二个启动器）。

## 十、验证证据（2026-10-31 16:46 执行后）

```
读回任务 XML：
  RestartOnFailure 存在: False
  含 -WindowStyle Hidden : True
  MultipleInstancesPolicy: IgnoreNew
  ExecutionTimeLimit: PT0S

进程：
  node pid=4528  ←  powershell pid=17128（16:46:43 启动）← svchost
  powershell 17128 的 MainWindowHandle = 0、MainWindowTitle = ''   ← 没有可见窗口

健康：
  /health/detail → ready=true, epoch=11, dsh/snowluma/official/console 全 connected
```

备份：`state/task-backup-20261031-164631.xml`（回滚用：`schtasks /create /xml <备份> /f`）。
