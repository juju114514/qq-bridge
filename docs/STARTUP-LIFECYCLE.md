# 启动与关闭生命周期（STARTUP LIFECYCLE）

> 2026-10-31 定稿（0.4.42）。**这份文档的顺序是从代码里实际跑出来的，不是理想设计。**
> 每张表都要能回答三个问题：谁负责、失败了怎么办、允不允许 ready。

## 一、六个阶段

| # | 阶段 | 谁负责 | 关键动作 | 失败时 |
| --- | --- | --- | --- | --- |
| 1 | **启动** | `run-bridge.ps1` → `src/bridge.js` | 找 node、加载配置、算 buildId | 退出（run-bridge 记录 exit.log，5 秒后重启） |
| 2 | **认领** | `startBridgeChannelGuard` | 抢 `state/channel-mode.json`、拿 epoch | 被占用则不收消息（控制台/工具仍可用） |
| 3 | **连接** | DSH client / SnowLuma / Official | 三条外部连接各自重连 | 连接失败 → `reconnecting`，不阻塞进程 |
| 4 | **就绪** | `health-state` | `ready = 持有通道 + DSH 连上 + 当前通道连接正常` | ready=false 时不接消息 |
| 5 | **运行** | 消息管道 | 去重 → 路由 → prompt → 发送（每步带 epoch 守卫） | 单个任务失败只影响该任务 |
| 6 | **关闭** | `gracefulShutdown` | draining → 存状态 → 打摘要 → 释放通道 | 强杀时靠 epoch fencing + 锁 TTL 兜底 |

## 二、启动时序（实际顺序）

```
run-bridge.ps1（计划任务拉起，隐藏窗口）
  └─ node src/bridge.js
       ├─ 1. 加载 config.json / 校验端口
       ├─ 2. 计算 buildId（运行时清单内容哈希）+ sourceCommit
       ├─ 3. 计算 presetHash（dsh/agent-presets/<preset>/qq-tool-restrict.mjs）
       ├─ 4. 通道认领（epoch++，写 channel-mode.json + epoch 水位）
       ├─ 5. 启动本地控制台（3100）
       ├─ 6. 连接 DSH（端口发现 + 鉴权）
       ├─ 7. 连接 SnowLuma（WS 3001；token 自愈）
       ├─ 8. 启动 Official Transport（如启用）
       ├─ 9. 进入 ready → 打 startup.summary
       └─ 10. pumpMux（消息事件循环）
```

注意 **3 和 4 的顺序**：指纹先算、再认领。因为认领会写 epoch 水位，
如果指纹计算失败就认领了，日志里会出现"有 epoch 但不知道跑的是哪套代码"。

## 三、失败策略表

| 阶段 | 失败 | 允许 ready？ | 处置 |
| --- | --- | --- | --- |
| 配置加载 | 端口非法 / JSON 坏 | ❌ | 直接退出（exit 1） |
| buildId | 哈希失败 | ✅（降级） | 记 `buildId:''`，不阻塞启动 |
| 通道认领 | 被别的实例占着 | ❌ | 不连 QQ；控制台/工具照常 |
| 控制台 | 3100 被占 | ❌ | 退出（exit 2），交给守护重启 |
| DSH 连接 | 端口漂移 / 鉴权失败 | ❌ | 后台重连；`services.dsh=reconnecting` |
| SnowLuma | WS 断 / token 不匹配 | ❌（bridge 模式） | 后台重连 + token 自愈 |
| Official | 鉴权失败 / 未启用 | ✅（不影响个人号） | `services.official=reconnecting\|stopped` |
| 消息管道 | 初始化异常 | ❌ | 退出 |

**核心原则**：`ready` 只看「当前持有通道 + DSH + 该通道连接」，
**不是**「所有服务都 connected」。Official 是可选通道，它挂了不该让个人号不可用。

## 四、关闭顺序（不可颠倒）

```
SIGINT / SIGTERM
  → health.channel.status = 'draining'（先失去 ready）
  → saveState()
  → bootReport.shutdown()（打 shutdown.summary）
  → channelModeGuard.stop()（最后才释放所有权）
  → releaseLock()
  → process.exit(0)
```

**为什么释放所有权必须最后**：如果先放通道再存状态，另一个进程可能立刻接管，
而旧进程还在写同一份 `state/` —— 这正是 epoch 要防的场景，但更好的做法是根本不制造它。

强杀（kill -9 / 任务结束）没有机会走这个顺序，所以仍然依赖：
- `epoch` fencing（旧任务在副作用边界被拦）
- 锁 TTL（60 秒后新实例可接管）

## 五、结构化启动摘要

`state/bridge.log` 里会出现一行机器可读 JSON：

```json
{"event":"startup.summary","bootId":"43c26da5","version":"0.4.42",
 "buildId":"sha256:…","sourceCommit":"…","startupDurationMs":826,
 "process":{"pid":21892,"ownerId":"5eae6dfc-…","uptimeMs":1316},
 "channel":{"mode":"bridge","epoch":9,"status":"active"},
 "services":{"dsh":"connected","snowluma":"connected","official":"stopped","console":"connected"},
 "live":true,"ready":true,
 "stages":[{"name":"channel-claim","status":"ok","durationMs":0}]}
```

- 触发时机：**第一次 `ready=true`**；若 10 秒内没 ready（sidecar-only / DSH 慢），兜底打一次
- 启动中途失败会打 `startup.incomplete`（带 `reason` 与已执行阶段），**不会因为没走完就没有证据**
- **不包含任何凭证**：只有 buildId / ownerId / epoch / 服务状态

## 六、状态取值

| 状态 | 含义 |
| --- | --- |
| `starting` | 正在启动 |
| `connected` | 连接正常 |
| `reconnecting` | 正在重连 |
| `degraded` | 可运行但部分功能异常 |
| `stopped` | 主动停止 |
| `failed` | 启动或运行失败 |

`live` = 进程活着；`ready` = 能收消息。两者分开。

## 七、资源可观测性（0.4.48）

`/health/detail` 新增 `system` 段，用来回答一个具体问题：
**是我们卡了，还是服务器被别的进程吃满了？**

```json
"system": {
  "cpuPercent": 0.9,
  "rssMb": 77.9,
  "heapUsedMb": 24,
  "freeMemMb": 4739.5,
  "totalMemMb": 16255,
  "memUsedPercent": 70.8,
  "loadavg": null,
  "eventLoopLagMs": 9,
  "eventLoopLagMaxMs": 39,
  "cores": 8,
  "platform": "win32",
  "warn": []
}
```

判读方法：

| 指标 | 说明 |
| --- | --- |
| `eventLoopLagMs` / `MaxMs` | **最能说明"我们被拖累"**：>500ms 说明 Node 主线程被抢 |
| `cpuPercent` | 只算**本进程**；它低但 lag 高 → 说明是别的进程在抢 CPU |
| `freeMemMb` | 系统剩余内存；<200MB 时 `warn` 会出现 `low-memory` |
| `loadavg` | Windows 上恒为 `null`（如实标注，不假装有值） |

`warn` 数组是**非致命告警**（不改变 `ready`）：
`event-loop-lag:*` / `event-loop-lag-max:*` / `low-memory:*` / `high-cpu:*`。
它只描述"环境变差了"，不然后果是"我们坏了" —— 这条区别很重要，
所以它**不参与** `ready` 判定。
