# 整体回归 · 2026-10-31

波次 4 拆了 5 批（内联路由 41 → 19）之后的一次**整体回归**，确认这一路没有累积破坏。

## 一、干净克隆 + 全量审计

```
git clone（HEAD 8be8fe3）→ pnpm install → node scripts/test-audit.mjs
Audit suite: 113/113 scripts passed
```

**干净克隆 113/113**，与工作区一致 —— 没有"只有本机能过"的测试。

（坑：这台机器 PATH 里没有 npm，用 pnpm 装依赖会生成 `pnpm-lock.yaml`，
会让 `test-packaging` 变红。这次用 `--lockfile=false` 避开；仓库里也已经把
`pnpm-lock.yaml` 加进 `.gitignore`。）

## 二、全量 GET 端点探测

从 `docs/ROUTES.md` 抽出 **46 条 GET/ANY 路径**逐条打（带控制台令牌，只发 GET）：

```
2xx 36 条 · 404 4 条 · 其它 6 条
```

### 4 条 404 都是**探测脚本的问题**，不是路由丢失

| 路径 | 真相 |
| --- | --- |
| `/api/send/private`、`/api/send/reply`、`/api/send/voice` | **POST-only** 端点（`src/api/send.js` 里按 pathname + POST 分派）；GET 打当然 404 |
| `/api/tokens/` | 文档里的**前缀行**（`startsWith('/api/tokens/')`），不是真实端点 |

### 6 条 400 都是**缺参数**（不是坏）

`/api/images/message`（要 messageId）、`/api/roles/content`（要角色名）、
`/api/socialV2/message-detail`（要 messageId）、`/forward-message`（要 id）、
`/api/socialV2/official-say`、`/official-recall`（要 body）。

### 抽查了"最容易被搬坏"的几条

```
GET /api/tokens/summary              → 200
GET /api/socialV2/official-proactive → 200
GET /api/socialV2/dead-letter        → 200
GET /api/socialV2/state?key=…        → 200
GET /api/socialV2/active-members?key=… → 200
GET /api/socialV2/tools              → 200
GET /api/socialV2/prompt?key=…       → 200（17,639 字节）
GET /api/security                    → 200（第二批曾误删过，已回滚修好）
```

## 三、这一路修掉的两个"自己挖的坑"

| 批次 | 坑 | 发现方式 |
| --- | --- | --- |
| 2 | 按**缩进**切代码，把紧跟的 `/api/security` 整块删掉 | `git diff` 复核 |
| 3/4/5 | 4 个测试用 `grep bridge.js` 断言路径存在，搬走必红 | 审计 |

两者都说明同一件事：**搬结构性代码后，必须"复核 diff + 跑审计 + 真机打端点"三件一起做**。

## 四、结论

- 干净克隆：**113/113**
- 真机 GET 全量：**无路由丢失**
- 黄金快照：**行为一致**
- `bridge.js`：11,236 → **10,219**（-1,017）