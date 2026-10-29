# 模块化路线（避免再长回 1.3 万行）

> 触发原因：用户提出"后续想往模块化走，避免又出现 1.3 万行的 bridge.js"。
> 这份文档先把**真实体积**摊开，再给可执行的拆分顺序与闸门。

---

## 零、先纠一个错（重要）

我此前多次报告 "bridge.js 9,600 行、比峰值少 20%"，**这个数字是错的**。

| 口径 | 结果 | 是否可信 |
| --- | --- | --- |
| `Measure-Object -Line` | 9,600 | 漏计 |
| `.NET ReadAllLines()` | **11,175** | 与 git blob 一致 |
| `split("\n")` | 10,192 | 文件里有裸 `\r`，会漏切 |

真实情况：**bridge.js 现在 11,175 行**，比"9,600"多了 1,575 行。
所以"已经瘦身 20%"要撤回 —— **瘦身真的发生过，但没有那么多**。

教训与之前那次快照计数错误一样：**测量口径必须先验证，再拿去汇报**。
新增的 `scripts/test-file-size.mjs` 就是为了固定这件事：它用与 ReadAllLines 同款的口径，
并把基线写进文件，谁改大了一目了然。

---

## 一、当前体积（前 10）

| 文件 | 行数 |
| --- | --- |
| `src/bridge.js` | 11,175 |
| `src/mcp-snowluma-safe.js` | 1,770 |
| `src/dsh-client.js` | 979 |
| `src/token-ledger.js` | 959 |
| `src/api/socialV2-send.js` | 948 |
| `src/api/socialV2-write.js` | 759 |
| `src/media-normalize.js` | 718 |
| `src/core/session-router.mjs` | 624 |
| `src/safe-fetch.js` | 515 |
| `src/web-search.js` | 497 |

结构判断：
- `bridge.js` 仍是**唯一**的巨石，占全部 src 的三分之一；
- 已拆出去的大块是 `mcp-snowluma-safe`、`token-ledger`、`dsh-client`、`socialV2-send`、`socialV2-write`；
- 拆分瓶颈不在"文件多"，而在 `bridge.js` 里同时住着 **5 种职责**（见下表）。

---

## 二、bridge.js 里混着的 5 种职责

| 职责 | 大致规模 | 现在的样子 |
| --- | --- | --- |
| 入口与生命周期 | ~300 行 | 读配置、连网关、连 DSH、实例锁、优雅退出 |
| HTTP 控制台骨架 | ~540 行 | `startConsoleServer` 的巨型 if 链 |
| 消息入站处理 | ~900 行 | `handleIncoming`：权限、静默、命令、媒体、去重、投递 |
| 提示词组装 | ~600 行 | 把人格、记忆、表情、群上下文拼成 prompt |
| 工具/动作执行 | ~700 行 | 发消息、发表情、点歌、拍一拍… |

**结论**：继续"从 bridge.js 里抠函数"收益递减（每次都要动同一条发送链）。
下一步应按**能力边界**切目录，而不是按"函数多大"切。

---

## 三、目标结构：能力模块（不是插件市场）

```
src/
  bridge.js            ← 只做：启动、装配、转发（目标 < 3,000 行）
  capabilities/        ← 每个能力一个目录，自带契约
    messaging/         ← 发消息（文本/图片/表情/语音）
    persona/           ← 人格卡 + 提示词组装
    memory/            ← 记忆与人物库
    stickers/          ← 表情策展（已有 4 个模块，收进来）
    official/          ← 官方通道
    social/            ← 唤醒、主动搭话、社交状态
  core/                ← 与业务无关的地基（已有 http/ 目录）
  api/                 ← HTTP 路由（已有 26 个模块）
```

### 模块契约（先定这个再动手）

```js
// src/capabilities/<name>/index.js
export default function createCapability(deps) {
  // deps 只给"该能力需要的"，不给整个 bridge 上下文
  return {
    name: 'messaging',
    routes: [],                 // [{ method, path, handler }]
    tools: [],                  // 给模型的工具定义（可选）
    prompt: async (ctx) => '',  // 往提示词里加一段（可选）
    start: async () => {},
    stop: async () => {}
  };
}
```

三条硬约束：
1. **能力之间不直接 import**，只能通过 `deps` 拿到的接口通信；
2. 每个能力**自带测试**，审计自动跑；
3. 能力目录**不许 import bridge.js**（用测试断言 + 体积闸门兜底）。

---

## 四、拆分顺序（按收益/风险，不是按行数）

| 波次 | 目标 | 为什么这个顺序 | 风险 |
| --- | --- | --- | --- |
| **0** | 体积闸门（已完成） | 先有刹车，再谈加速 | 无 |
| **1** | `capabilities/persona`：提示词组装 | 逻辑最"纯"，只读状态、无网络 | 低 |
| **2** | `capabilities/messaging`：发送层 | 所有能力都依赖它，先定接口后大家受益 | 中（动发送链） |
| **3** | `capabilities/memory`：记忆 + 人物库 | 刚做完 people.js / memory-store.js，顺势收进来 | 低 |
| **4** | `capabilities/stickers` | 4 个模块已在，只需搬家 + 接契约 | 低 |
| **5** | `capabilities/official` | 依赖 messaging 的接口 | 中 |
| **6** | `capabilities/social` + 收尾 handleIncoming | 最复杂，放最后 | 高 |

每波固定 7 步：备份 → 拆 → `node --check` → 审计全绿 → 部署 → 黄金快照「一致」→ 提交（一模块一提交）。

---

## 五、体积闸门怎么用

```powershell
node scripts/test-file-size.mjs            # 检查（已进审计）
node scripts/test-file-size.mjs --update   # 有意变长时更新基线
```

| 规则 | 值 |
| --- | --- |
| 已有文件允许增量 | +50 行（写注释不算违规） |
| 新文件上限 | 800 行 |
| bridge.js 硬上限 | 11,400（当前 11,175，先钉住） |

想合法变长必须**显式 --update 并在提交信息里说明原因**——这是"有意为之"与"悄悄膨胀"的分界线。

---

## 六、里程碑（可验证）

| 阶段 | bridge.js 行数 | 判定方式 |
| --- | --- | --- |
| 现在 | **11,175** | test-file-size 基线 |
| 波次 1–2 完成 | ≤ 9,500 | 同上 |
| 波次 3–5 完成 | ≤ 7,000 | 同上 |
| 最终 | ≤ 3,000 | 只剩启动与装配 |

每个里程碑必须同时满足：**审计全绿 + 黄金快照一致**，否则不算完成。

---

## 七、明确不做

| 不做 | 原因 |
| --- | --- |
| 插件市场 / 动态加载 | 单人自用，收益低、调试成本高 |
| 把 API 路由也拆成能力目录 | 路由已经 26 个独立模块，够用 |
| 为一个文件 300 行就强行劈开 | 会制造"跳来跳去"的阅读成本 |
