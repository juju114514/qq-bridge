# 方案 B 设计：薄插件 + 复用核心（qq-bridge → DSH 插件）

> 目标读者：将来动手的我/你。读完应该能直接开任务清单，不需要再翻别的文档。
> 依据：`docs/audits/ecosystem-repos-2026-10-31.md` 里对 4 个真实 DSH 插件的实测。

## 0. 一句话

把"**消息通路**"搬进 DSH 插件（进程内、随 DSH 生命周期），把"**大脑和记忆**"留在常驻 sidecar，
中间用一层**纯函数核心库**做共享；`bridge.js` 从 8.7k 行的单体，缩成"sidecar 壳"。

## 1. 目标 / 非目标

**目标**

- G1 装完插件即可收发 QQ 消息，**不需要额外守护进程**（这是插件式的核心卖点）
- G2 行为与现在的 reserved2 一致：该不该回、人格卡、记忆、表情、语音、工具，一样不少
- G3 控制台（12 页）继续可用，数据仍落在 `state/`
- G4 现有 117 个审计脚本继续全绿；快照「行为一致 ✓」

**非目标**

- 不追 DSH 内核（不改 agent loop），只做 channel
- 不在第一版做"多 IM 通道"（那是 dsh-im 的赛道）
- 不在第一版做官方 Bot 通道的插件化（`qqbot-official.js` 先留在 sidecar）

## 2. 现状盘点（谁在干什么）

| 能力 | 现在住在哪 | 行数量级 |
| --- | --- | --- |
| 消息收（OneBot） | `src/onebot-ws.js`（357 行）+ `bridge.js` 接入段 | 小 |
| 该不该回 / 防遗忘 | `src/turn-wake.js`（纯函数）+ `bridge.js` 26 处 `setTimeout/setInterval` | 中 |
| 提示词组装 | `src/api/socialV2-prompt.js` + `role-card.js` + `sticker-hint.js` + `people*.js` | 中 |
| Agent 往返（DSH 会话） | `src/dsh-client.js`（805 行）+ `bridge.js` pumpMux | **大** |
| 工具（29 个 `qq_*`） | `src/mcp-snowluma-safe.js`（1,649 行，**stdio MCP**，被 DSH spawn） | **大** |
| 发送 | `src/api/socialV2-send.js`（905 行）+ `bridge.js` sendChain | 大 |
| 控制台 | `bridge.js` `startConsoleServer` + `src/api/*`（109 条路由） | **最大** |
| 调度/提醒 | `src/scheduler/engine.js`（425 行）+ `schedule.js` | 中 |
| 记忆/人物库 | `src/people*.js` + `state/people.json` | 中 |
| 记账/价格 | `src/token-ledger.js`（835）+ `model-prices.js`（273） | 中 |

**结论**：真正该搬进插件的是「收 → 判 → 组 → 送」这四段；
`dsh-client.js` + `pumpMux` 在插件模式下**整段消失**（DSH 自己就是 agent 宿主），这是我们最大的净收益。

## 3. 目标架构

```
┌──────────────── DSH 进程（插件宿主）────────────────┐
│  qq-plugin（Cordis）                              │
│    ├─ OneBot WS 客户端（收/发）                    │
│    ├─ 归一化 + 去重 + 会话 key                     │
│    ├─ 调 core：decideWake / buildPrompt / splitSend│
│    ├─ ctx.agents.create / followup（每会话一个）    │
│    └─ 工具注册（qq_* 直接在进程内，不走 MCP）       │
└───────────────┬──────────────────────────────────┘
                │ HTTP 127.0.0.1:3110（loopback + token）
                │ · GET  /snapshot?key=     读状态快照（带 ETag）
                │ · POST /events            入站事件（落库、记账、黑话学习）
                │ · POST /intents           出站意图（记账、活动流、提醒）
                │ · GET  /health
┌───────────────▼──────────────────────────────────┐
│  sidecar（当前 bridge.js 的"壳"）                  │
│    ├─ 控制台 HTTP :3100（12 页，保持现状）          │
│    ├─ 调度器 / 提醒 / 主动消息（唯一持有定时器）     │
│    ├─ state/ 唯一写者（people / social-v2 / sessions）│
│    ├─ token-ledger（记账）                         │
│    └─ MCP stdio server（兼容旧客户端，可关）        │
└──────────────────────────────────────────────────┘
```

**为什么状态只能 sidecar 写**：`state/*.json` 是"单写者"模型（`check-atomic-write` 就是防这个）。
插件只读快照、只发意图；sidecar 串行落盘。这样不会出现"插件和 sidecar 互相覆盖"。

## 4. 核心库抽取清单（`packages/core`，纯函数，无 IO）

| 模块 | 从哪来 | 新签名（草案） | 为什么能纯 |
| --- | --- | --- | --- |
| `wake.js` | `turn-wake.js` + bridge 的唤醒判定 | `decide({ event, state, cfg }) → { wake: boolean, reason, replyHint? }` | 只读入参 |
| `prompt.js` | `socialV2-prompt.js` + `role-card.js` + `sticker-hint.js` | `build({ role, people, slang, stickers, recent, mode }) → { system, messages }` | 输入即输出 |
| `split.js` | `socialV2-send.js` 里的切分/分条 | `split(text, { limit, style }) → string[]` | 纯字符串 |
| `memory.js` | `people-note.js` / `people.js` 的规则部分 | `recall(store, key) → hints` / `applyNote(store, note) → store'` | 用"不可变 store 进/出" |
| `stickers.js` | `sticker-lib.js` 的挑选算法 | `pick(catalog, mood) → id[]` | 纯 |
| `tokens.js` | `model-prices.js` | `price(usage, model) → CNY` | 纯 |

**验收**：这 6 个模块必须能在**没有任何 IO** 的情况下跑测试（`node --test`），
并且 `bridge.js` 改成 `import { decide } from '../packages/core/wake.js'` 后，
快照仍「行为一致 ✓」。**先做这一步，不改变任何行为。**

## 5. 关键设计决策（需要你拍板的 5 个）

### D1 状态归属 → **sidecar 单写者**（推荐）

- 插件要改状态时 POST `/intents`（append-only JSONL），sidecar 合并
- 代价：跨进程一次往返（<1ms 环回，可忽略）
- 备选：插件直写 → ❌ 会出现双写覆盖，`schema` 迁移也会两边打架

### D2 工具走哪条路 → **插件内注册**（推荐）

- 现在：DSH spawn 我们的 MCP stdio server（29 个 `qq_*`），每次工具调用多一跳
- 插件模式：`ctx` 上直接注册工具，**少一跳、少一个进程、能共享内存里的会话状态**
- 代价：`mcp-snowluma-safe.js`（1,649 行）要拆成"工具实现（纯）" + "协议壳（可留可弃）"
- 备选：继续走 MCP → 省事但没解决"多一个进程"

### D3 定时器归属 → **全留 sidecar**（推荐）

- 插件的 `wake`/`remind`/`proactive` 判定是**纯函数**，但"到点了叫我"必须有人真的计时
- 插件生命周期跟着 DSH，DSH 关了定时器就没了 —— 这正好符合"DSH 不在就不该主动发消息"
- 代价：sidecar 必须在跑（否则没有主动消息，但被动回复仍可用）→ **这是一条要写进文档的降级语义**

### D4 控制台 → **sidecar 保留 HTTP，插件不碰**（推荐）

- 控制台已有 109 条路由 + 12 页前端，搬进插件毫无收益
- 插件只往 sidecar 推事件，控制台自然就能看到"插件模式"的会话
- 代价：用户仍需开 sidecar 才能看控制台 → 但**不开也能聊天**

### D5 通道 → **插件自带 OneBot WS 客户端**（推荐）

- 直接复用 `onebot-ws.js`（357 行，已经替代了 `@snowluma/sdk`）
- 不做"反向 WS 服务器"（那是 dsh-onebot 为 NapCat 正向连接准备的），我们保持客户端形态
- 代价：SnowLuma/NapCat 仍需单独跑（与现在一致）

## 6. 插件与 sidecar 的契约（第一版就这 4 个）

```http
GET /snapshot?key=group:123
→ 200 { etag, state: { role, people, slang, stickers, recent, wake, mode } }

POST /events
{ key, kind: "inbound"|"outbound"|"tool", at, payload }
→ 202 { ok: true }

POST /intents
{ key, intent: "memory.append"|"note.people"|"ledger.record"|"activity", payload }
→ 202 { ok: true, applied: n }

GET /health
→ 200 { ok, mode: "plugin"|"bridge", version, startedAt }
```

约束：
- 只监听 `127.0.0.1`，带 `state/console-token` 同级别的 bearer
- `/snapshot` 必须支持 `If-None-Match`（每轮都拉，不能每次回 30KB）
- 任何 sidecar 不可用 → 插件**降级可用**：跳过记忆/记账，只做收发

## 7. 迁移阶段（每阶段都可停、可回滚）

| 阶段 | 做什么 | 停在这里的样子 | 估时 |
| --- | --- | --- | --- |
| **P0** | 建 `packages/core`，搬 6 个纯模块；`bridge.js` 改 import | 行为完全不变，117 测试 + 快照全绿 | 2 天 |
| **P1** | 插件 MVP：文本收发 + 会话映射 + `decide`/`build`；`QQB_PLUGIN_MODE` 特性开关 | 能在 DSH 里跑通"群里 @ 有回复"，工具/表情暂缺 | 4 天 |
| **P2** | 工具内注册（先 10 个高频：send/reply/wait/markRead/prompt/sticker/voice/note），媒体与表情 | 日常场景可用，MCP 仍保留作兼容 | 5 天 |
| **P3** | sidecar 契约落地 + 控制台显示"插件模式" + 记账/记忆接通 | 控制台能看到插件会话，数据一致 | 3 天 |
| **P4** | 一致性闸门：录制回放对比（bridge 模式 vs 插件模式同一份 inbox 输出一致）、文档、互斥锁 | 可发布；`bridge` 模式仍可一键切回 | 2 天 |

**总估 ≈ 16 人日**（不含意外）。P0 单独就有价值：即使不做插件，纯函数核心也让测试更好写。

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Cordis 插件 API 随 DSH 升级变动 | 插件可能随时坏 | 锁 `testedWith.dsh`；插件只依赖 `inject=['agents']` 与最少的 ctx 面 |
| 两套运行形态行为分叉 | 文档/issue 混乱，用户困惑 | **互斥锁**：同一 `state/` 只允许一种模式；`/health` 暴露 mode；P4 的录制回放闸门 |
| 插件生命周期内状态丢失（DSH 重启） | 记忆/唤醒配置丢 | 状态全在 sidecar；插件启动即 `/snapshot` 冷启动 |
| 工具安全边界弱化 | 越权/注入 | 保留 `agentToken` 与会话白名单校验，工具注册时统一包一层 `guard()` |
| sidecar 没开 → 主动消息静默 | 用户以为坏了 | 启动日志 + 控制台横幅明确"插件模式：主动消息需要 sidecar" |

## 9. 验收（Definition of Done）

1. 在 DSH 里 `plugin add` 后，群里 @ 一次 → 5 秒内有回复（文本）
2. `qq_get_prompt` / `qq_send_message` / `qq_wait_for_messages` 三个核心工具可用且带 `agentToken` 校验
3. 控制台能看到该会话的最近消息与记账
4. `node scripts/test-audit.mjs` 全绿；两种模式各跑一遍
5. 录制回放：同一份 inbox 在 bridge 模式与插件模式产出**逐字一致**的 prompt 与发送序列
6. 切回 bridge 模式只需改一行配置 + 重启

## 10. 待你拍板

- D1~D5 是否按推荐？（尤其 **D2 工具内注册** 和 **D3 定时器留 sidecar**）
- 是否接受「插件模式下必须开 sidecar 才有主动消息」这个降级语义？
- P0 我可以先做（纯重构、零行为变化、可随时回滚）——要不要现在开始？