# 拆分计划：startConsoleServer（1,980 行）

> 状态：**未开工**。这是目前 `bridge.js` 里最大的一块，也是唯一不能机械搬迁的部分。
> 这份文档的目的是：下次开工时不用重新调研，直接照着做。

---

## 一、为什么它最值得拆

| 指标 | 数值 |
| --- | --- |
| 行数 | **1,980**（约占 bridge.js 的 19%） |
| 内容 | HTTP 服务器创建 + 50 个路由的 if 链 + 一大批 handler 的装配（闭包捕获） |
| 现状 | 所有 `src/api/*.js` 的 handler 都在这里被 `createXxxHandler({...})` 装配 |
| 难点 | 它捕获了几十个 main() 内的变量（`cfg` / `state` / `bot` / `api` / 各种 Map 与定时器） |

拆掉它，`bridge.js` 能直接降到 **8,000 行以内**。

---

## 二、不能机械搬的原因

1. **闭包依赖多**：50 个分支里用到几十个 main() 局部变量，甚至有的是 `let`（会被修改）。
2. **装配顺序有意义**：某些 handler 依赖前面创建的对象（如 `handleSend` 依赖 `bot` 已连接）。
3. **启动副作用**：`listen()`、健康检查、CORS、Host 校验、控制台令牌校验都在里面。
4. **一条错就全挂**：桥接起不来，机器人和控制台一起消失。

---

## 三、方案：三步走（每步都可独立回滚）

### 第 1 步：抽出"路由器"（低风险，减 ~300 行）

把 50 个 `if (req.method === 'X' && url.pathname === 'Y') { await handleZ(req, url); return; }`
换成一张表：

```js
// src/http/routes.js
export const ROUTES = [
  ['GET',  '/api/status',            (ctx) => handleStatus(ctx)],
  ['POST', '/api/send/group',        (ctx) => handleSend(ctx)],
  ...
];
export function matchRoute(method, pathname) { ... }
```

`bridge.js` 里只留一个 `matchRoute` + 调用。

**验收**：`routes-map.mjs` 显示内联数降到个位数；审计 69/69；快照一致。

### 第 2 步：抽出 handler 装配（中风险，减 ~800 行）

把 `createXxxHandler({...})` 的装配代码集中到 `src/http/wiring.js`，
入参是一个 `deps` 大对象（由 bridge.js 构造一次）。

```js
// src/http/wiring.js
export function createHandlers(deps) {
  return {
    send: createSendHandler(deps),
    socialV2Read: createSocialV2ReadHandler(deps),
    ...
  };
}
```

**验收**：`map-routes.mjs` 的「已装配」仍为全部；启动日志与改造前逐行一致。

### 第 3 步：抽出服务器启动（中风险，减 ~700 行）

把 `http.createServer(...)` + listen + 健康检查 + CORS + 令牌校验搬进
`src/http/server.js`，签名 `startConsoleServer({ deps, handlers })`。

**验收**：控制台 3100 可用、`/api/status` 200、`/api/socialV2/prompt` 快照一致。

---

## 四、每一步的固定动作（不许跳）

```
1. 备份：Copy-Item src\bridge.js D:\QQBot\temp\bridge.js.bak-<步骤名>
2. 先跑一遍快照：node scripts/snapshot-prompt.mjs --save
3. 改 → node --check → node scripts/test-audit.mjs（必须 69/69）
4. 部署到 live → 重启 → 看日志（桥接已启动 / SnowLuma 已连接 / DSH 已就绪）
5. node scripts/snapshot-prompt.mjs --diff <刚存的 ts>   ← 必须「一致」
6. node scripts/map-routes.mjs → 行数下降符合预期
7. 提交（一步一提交）
```

任何一步不过 → `git checkout -- src/bridge.js` 回滚，不硬撑。

---

## 五、开工前的前置条件（重要）

| # | 条件 | 为什么 |
| --- | --- | --- |
| 1 | **留出连续 2–3 轮** | 中途被打断最危险：容易留下半截改动 |
| 2 | 机器人可以短暂离线 | 每步都要重启桥接 |
| 3 | 不在"老板在群里说话"的时段 | 重启期间消息会漏 |
| 4 | 先跑一次 `map-routes.mjs` 与 `map-bridge.mjs` | 拿到最新行号，别用旧索引 |

---

## 六、风险与回滚

| 风险 | 概率 | 影响 | 兜底 |
| --- | --- | --- | --- |
| 启动失败（handler 未定义） | 中 | 机器人与控制台全挂 | `git checkout` + 重启 |
| 路由漏注册 | 中 | 某个功能 404 | `routes-map.mjs` 对比端点数量 |
| 闭包变量拿不到最新值 | 中 | 行为悄悄变化 | 用 getter（`getCfg: () => cfg`）而不是快照值 |
| 快照出现差异 | 高（一定会遇到） | 说明行为变了 | 逐字段看差异，判断是运行时字段还是真改动 |

---

## 七、已知的"不要做的事"

1. **不要**把 `cfg` 当值传进模块（要传 getter），否则热更新配置后模块还在用旧对象。
2. **不要**在搬迁时顺手"优化"逻辑——先纯搬，优化单独提。
3. **不要**信旧行号（`map-bridge.md` 每次提交后都要重新生成）。
4. **不要**为了减少行数把 for 循环压成一行——可读性比行数重要。

---

## 八、做完之后的预期

| 指标 | 现在 | 做完 |
| --- | --- | --- |
| `bridge.js` 行数 | 10,186 | **< 4,000** |
| 单函数最大行数 | 1,980 | < 300 |
| 改一个端点要读的行数 | 全文件（靠 grep） | 一个模块文件 |
| 审计 | 69/69 | 69/69（不变） |
