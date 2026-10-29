# 明天（2026-10-31）的 bridge.js 计划

> 基于 10-30 收尾时的真实测量，不是凭印象排的。
> 上一轮的教训写在 [运维指南 §20](运维指南.md) 与 §21：**没有端到端测试就不搬核心逻辑**。

---

## 零、起点数据（03:10 实测）

| 项 | 值 |
| --- | --- |
| `src/bridge.js` | **10,771 行** |
| 审计脚本 | 86 个（86/86 通过） |
| 内联路由 | **48 条**（全在 `startConsoleServer` 里） |
| 版本 | 0.3.0 |

### 还剩的大块（按行数）

| 块 | 行数 | 说明 |
| --- | --- | --- |
| `startConsoleServer` | **1,024** | 里面 48 条内联路由占大头 |
| `handleIncoming` | 478 | 消息主流程 |
| `pumpMux` | 461 | 已搬出 learner + tools 两段 |
| `cleanSenderName` | 304 | 名字清洗（可疑：为什么这么大） |
| `sendOfficialProactive` | 218 | 官方通道主动消息 |
| `fetchMediaData` | 169 | 媒体抓取 |
| `mcp-snowluma-safe.js` | 1,804 | MCP 工具注册（另一个文件） |

---

## 一、批次安排（按"收益 ÷ 风险"排序）

### 批次 1：把 48 条内联路由按功能拆出去（预计 −300~400 行）

**为什么先做这个**：每一条都能用 console token 在**真机打一次端点**验证，
是唯一"收益大、风险可控"的活。

做法：按**领域**建模块，而不是一条一路由文件（否则只是把行数挪个地方）：

| 新模块 | 收哪些路由 | 预估 |
| --- | --- | --- |
| `src/api/console-session.js` | `/api/sessions`、`/api/pending`、`/api/queue/*` | ~120 行搬走 |
| `src/api/console-activity.js` | `/api/activity`、`/api/tool-log`、`/api/errors` | ~90 行 |
| `src/api/console-wake.js` | 唤醒配置读写、手动唤醒 | ~110 行 |
| `src/api/console-memory.js` | 记忆/人物/黑话的读接口 | ~80 行 |
| `src/api/console-restart.js` | `/api/restart`、`/api/workspace/reset`(已搬) | 小 |

**每刀验收**（缺一不可）：

1. `node --check`
2. `node scripts/test-audit.mjs` 全绿（不许从 86 掉）
3. 部署 → 重启 → **真机打该端点**（200 + 关键字段）
4. `snapshot-prompt.mjs --diff` 一致
5. 一个模块一个提交

---

### 批次 2：`pumpMux` turn 收尾（~120 行，**必须先补测试**）

**现状**：`pumpMux` 461 行，已搬出 learner、tools 两段；剩下的 turn 收尾包含
no-action 计数、静默 turn、唤醒提醒三件事，与 `socialV2` 状态深度耦合。

**前置（不做就不许动）**：给 `test-mux-pump.mjs` 补"完整回合序列"用例：

```
turn/start → tool/call → tool/result → turn/end
  ① 有发送工具成功 → 不累计 noActionCount
  ② 全程没行动 → 累计 +1
  ③ 连续 N 次 → 重置唤醒配置（并打日志）
  ④ 静默 turn（social.silentTurns 有值）→ 不计数
  ⑤ turn/start 丢失（重连补发）→ 跳过计数并记日志
```

补完再搬，搬完用同一套用例证明行为不变。

---

### 批次 3：`handleIncoming`（478 行）

按"消息类型分流"切：

- `src/incoming-official.js`：官方通道分支（openid/@ 判定）
- `src/incoming-media.js`：媒体抓取 + 自动描述接线
- `src/incoming-social.js`：reserved2 的入库/唤醒编排

**风险**：这是主流程，错的代价是"机器人不回话"。
**前置**：先用 harness 写 3 条端到端（私聊/群@/群非@）钉住行为，再动。

---

### 批次 4：`cleanSenderName`（304 行）

**先查清楚它为什么 304 行**——大概率是一堆名字清洗规则 + 表格。
如果是纯数据 + 纯函数，直接搬 `src/sender-name.js` 并配表驱动测试（最快的一刀）。

---

### 批次 5：`mcp-snowluma-safe.js`（1,804 行）

**最后做，因为风险最高**：拆错的表现是"模型少了某个工具"，而且不报错。

**前置**：写一个"工具清单快照"测试 —— 用 `server.tool` 的注册顺序与名字做基线，
任何拆分都必须让快照一致。

再按域拆：`mcp/tools-send.js`、`tools-read.js`、`tools-social.js`、`tools-memory.js`。

---

## 二、明确**不**在明天做的

| 事项 | 原因 |
| --- | --- |
| 继续硬搬 `pumpMux` 剩余而不写测试 | 今晚的 8 个缺陷全出在这类路径上 |
| `privacy-scan` 规则重构 | 需要单独一轮完整做（改到一半会污染所有后续扫描） |
| 清 git 历史里的旧私有路径 | 要 `filter-repo` 改所有 commit hash，得你拍板 |
| 追 star 数 / i18n / 多账号 | 与"单人自用小群"的定位不符 |

---

## 三、如果只有半天

按这个顺序挑：**批次 1（console-session）→ 批次 4（cleanSenderName 探明）→ 批次 2 的测试部分**。
前两个都能在半天内拿到"行数下降 + 全绿 + 真机验证"，第三个即使不搬也把最难的地方保护起来了。

---

## 四、每轮固定动作（贴在显眼处）

```powershell
# 1) 备份
Copy-Item src\bridge.js D:\QQBot\temp\bridge.js.bak-<名字>

# 2) 改完自检
node --check src\bridge.js
node scripts\test-audit.mjs          # 必须 86/86 起，只许增不许减

# 3) 部署 + 真机验证（每条路由/每个分支都要打一次）
# 4) 快照一致性
node scripts\snapshot-prompt.mjs --diff 2026-10-29T17-13-36

# 5) 提交（一个模块一提交，消息写清"为什么"）
git commit -F <utf8-no-bom 文件>
```

---

## 五、明天的验收标准

| 指标 | 今天 | 明天目标 |
| --- | --- | --- |
| `bridge.js` | 10,771 | **≤ 10,300** |
| 内联路由 | 48 | **≤ 15** |
| 审计脚本 | 86 | **≥ 88** |
| pumpMux | 461 | ≤ 350（且新增 5 条回合用例） |
| 真机 | 全就绪 | 全就绪，且 `/诊断`、`/自检`、people-note 都复验过 |
