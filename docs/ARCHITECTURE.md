# 架构：为什么"能拆的拆了，还是难改"

> 这份文档解决一个具体问题：**改一个功能时，我该读哪个文件？**
> 如果你（或 AI）只想知道"改 X 去哪"，直接跳到 [§4 索引表](#4-去哪儿改索引)。

---

## 1. 现状（2026-10-30 收尾实测）

| 指标 | 值 |
| --- | --- |
| `src/bridge.js` | **10,771 行**（硬上限 10,800） |
| 闭包内顶层函数 | **262 个，共 9,659 行（89%）** |
| import | 95 条（其中 84 个本地模块） |
| 43 个工厂的 deps 清单 | 487 行（4.5%） |
| 内联路由 | 55 条（棘轮，只许减） |
| 审计脚本 | 87 个 |

**结论：真正的问题不是行数，而是"彼此耦合的函数全都放在同一个闭包作用域里"。**
要改其中任何一个函数，你必须先读这个 10,771 行的文件，才能知道 `state` / `social` / `pending` 这些变量是什么形状。

---

## 2. 目标形态：用显式 `rt` 取代隐式闭包

```
现在：  bridge.js [ main() { ~9.6k 行函数，共享隐式作用域 } ]
目标：  bridge.js [ main() ~150 行：createRuntime → wire → start* ]
            ↓
        src/runtime.js   ← 所有共享状态的唯一来源（~250 行）
            ↓
        src/domains/*.js ← 领域逻辑，每个 ≤400 行，只依赖 runtime
            ↓
        src/api/*、src/console/routes/* ← 对外接口
```

改完的效果：

| | 现在 | 之后 |
| --- | --- | --- |
| 改"唤醒判定" | 读 10,771 行 | 读 `src/domains/wake.js` |
| 加一条 console 路由 | 改 `bridge.js` | 新建 `src/console/routes/xxx.js` |
| `bridge.js` | 10,771 | ~1,200 |
| 总代码行数 | 32,590 | ~34,000（**会略增**） |

⚠️ **总行数不会减少**。换来的是"每个文件能单独读进上下文"。想清楚这一点再决定要不要做。

---

## 3. 三个显式接缝（跨模块"联通"的唯一通道）

### 接缝 1：`rt`（runtime）

```js
// src/runtime.js
export function createRuntime({ cfg, fs, path, log }) {
  return {
    cfg, log, fs, path,
    state: {},                                   // 会话映射
    social: { states: new Map(), recentMessages: new Map() },
    socialV2: { conversations: new Map() },
    queues: { pending: new Map(), queued: new Map() },
    clients: { api: null, bot: null },           // 传输层（依赖倒置）
    events: createEmitter(),                     // 跨域通知
    counters: { gatewayReconnects: 0 },          // 计数器唯一归属
  };
}
```

**硬规矩**：任何可变计数器（网关重连、无行动计数…）**只能放在 `rt.counters`**。
昨晚拆分反复卡在"这个状态归谁"，根因就是没有唯一归属。

### 接缝 2：`rt.events`（跨域只发事件，不互相 import）

```js
// ✅ 允许
rt.events.emit('wake/scheduled', { key, reason });
rt.events.on('wake/scheduled', onWakeScheduled);

// ❌ 禁止（`scripts/test-domains.mjs` 会拦）
import { scheduleWakeV2 } from './domains/wake.js';
```

### 接缝 3：路由表 / 工具表

```js
// src/console/router.js
register({ method: 'GET', path: '/api/sessions', handler: listSessions });
// 启动时统一挂载；bridge.js 里一条路由都不出现
```

---

## 4. "去哪儿改"索引

| 想改什么 | 现在去哪 | 目标位置（波次后） |
| --- | --- | --- |
| 消息进线判定（闸门：引用/空文本/待答/静默） | `src/incoming-guards.js` | 同左（已拆） |
| 公开命令、首次人设 | `src/incoming-commands.js` | 同左（已拆） |
| `/status /role /silent /active /自检 /诊断` | `src/incoming-status-commands.js` | 同左（已拆） |
| `/reset` 清理清单 | `src/session-reset.js` | 同左（已拆） |
| 唤醒判定与定时器 | `bridge.js` `evaluateWakeTriggerV2` / `scheduleWakeV2` | `src/domains/wake.js` |
| 回合收尾（no-action/静默/提醒） | `bridge.js` `pumpMux` 尾段 | `src/domains/turn-end.js` |
| 工具调用追踪 | `src/mux-tools.js` | 同左（已拆） |
| 黑话学习会话 | `src/mux-learner.js` | 同左（已拆） |
| 人物库规则 | `src/people.js` | 同左（纯函数） |
| 人物笔记接口 | `src/api/people-note.js` | 同左 |
| 记忆原子/衰减 | `src/memory-store.js` | 同左 |
| 抖音轻量解析 | `src/douyin-meta.js` | 同左 |
| 视频下载/故事板 | `src/video-download.js` | 同左 |
| 官方通道协议 | `src/qqbot-official.js`、`official-media.js` | 同左 |
| 控制台路由 | `bridge.js` 内联 55 条 | `src/console/routes/*.js` |
| MCP 工具注册 | `src/mcp-snowluma-safe.js`（1,804 行） | `src/mcp/tools-*.js` |
| 决策追踪（`/诊断`） | `src/decision-trace.js` | 同左 |

**查符号不需要读文件**：

```powershell
node scripts/find-symbol.mjs scheduleWakeV2      # 定义在哪、谁在用
node scripts/find-symbol.mjs wakeConfig --def-only
```

---

## 5. 边界规则：预算 + 留痕，**不做硬墙**

设计原则：**规矩是为了让人改得动，不是为了让项目合规。**

| 规则 | 强度 | 说明 |
| --- | --- | --- |
| `bridge.js` 内联路由 ≤ 55 | ❌ 硬失败 | 唯一真墙：防"拆完又长回去"，成本是改一个数字 |
| 跨域 import ≤ 5 处 | ❌ 硬失败（超预算才死） | 用几处完全允许，只是别让它变成常态 |
| 跨域 import 要写 `// cross-domain: 原因` | ⚠️ 只警告 | 留痕，方便半年后回看"当初为什么这么写" |
| 单个 domain ≤ 400 行 | ⚠️ 只警告 | 600 行才硬失败 |
| `bridge.js` ≤ 10,800 行 | ❌ 硬失败 | `test-file-size.mjs` |

```js
// 允许，只要写一行原因
import { pickWakeReason } from './wake.js';   // cross-domain: turn-end 收尾要用唤醒原因
```

### 为什么不禁止跨域 import

一度想立"domains 之间禁止互相 import，跨域必须走 `rt.events`"。撤掉了，因为：

1. **会被迫把同步逻辑改成异步** —— 一个纯函数调用变成事件，只会更难调；
2. **会让 `runtime.js` 变成杂物间** —— 为了合规，公共助手全塞进去，状态中心反而失控；
3. 个人项目的真实风险不是"耦合"，是"改不动"。

留一行注释的摩擦刚好：写的时候想一下，半年后看得懂。

## 6. 四个波次（每波可独立上线）

| 波次 | 内容 | 搬多少 | 前置 | 风险 |
| --- | --- | --- | --- | --- |
| 0 | 本文件 + `find-symbol` + `test-domains` | 0 | — | **零（已完成）** |
| 1 | 引入 `rt`；搬纯数据域（人物/记忆/表情/黑话/静默） | ~1,200 | 波次 0 | 低（**进行中，见下**） |
| 2 | 搬唤醒与睡眠域 | ~900 | 先补"回合序列"测试 | 中 |
| 3 | 消息管道显式串联（guards→commands→media→wake→deliver） | ~1,400 | 波次 1/2 | 中高 |
| 4 | console 路由表 + MCP 拆域 | ~1,500 | 工具清单快照测试 | 中 |

---

### 波次 1 进度（2026-10-31 实时）

| 已搬出的域 | 文件 | 行数 | 测试 | 说明 |
| --- | --- | --- | --- | --- |
| 唤醒配置 | `src/domains/wake-config.js` | 92 | 8 组 | 默认值 / 硬边界夹取 / 显式设置不被覆盖 / 触发器白名单 |
| 社交纯规则 | `src/domains/social-v2-rules.js` | 68 | 13 组 | 名单归一化 / 退场判定 / 沉睡判定 / 唤醒安全性 |
| 会话 key 规范化 | `src/conv-key.js`（合并） | +16 | 4 组 | 消灭第二份实现：`group:0123` 与 `group:123` 必须同一个人 |

同期完成（不在原计划里，但属于同一批"把闭包里的判定拿出来"）：

| 模块 | 测试 | 抓到的真实缺陷 |
| --- | --- | --- |
| `src/turn-guard.js` | 9 组 | — |
| `src/turn-finalize.js` | 6 组 | 静默队列全过期时残留空数组 |
| `src/turn-reply.js` | 7 组 | — |
| `src/turn-wake.js` | 8 组 | — |
| 回合帧形状（测试） | 5 组 | **交错回合会吞掉回复**（collector 被无条件释放） |

`bridge.js` 行数：11,236 → **10,670**（-566）。
还有一件事没做：**`rt` 本体尚未落地** —— 现在是把判定搬到 `src/domains/*`，
真正"共享状态的唯一来源"（`src/runtime.js`）等 `socialV2` 状态搬完再引入，
否则会出现两套状态来源并存。

## 7. 不要做的事

| 想法 | 为什么不做 |
| --- | --- |
| 为了行数把 10-39 行的胶水函数逐个搬走 | 净收益 ≈ 0，只是把行数挪个文件，还多了 import |
| 上 DI 容器 / 反射式依赖注入 | 错误从"编译期"移到"运行期"，对单人维护是净损失 |
| 一次重写 `main()` | 没有任何测试能覆盖"整体重写"的等价性 |
| 拆 `mcp-snowluma-safe.js` 而不先做工具清单快照 | 拆错的表现是"模型少了工具"，而且不报错 |
| 把架构规则定成硬墙 | 为了合规写的代码，通常比不合规的更差 |
