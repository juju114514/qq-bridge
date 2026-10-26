# bridge.js 重构方案（REFACTOR-BRIDGE）

> 现状：单文件、单函数、平铺路由。本文给**分阶段、可回滚**的拆法，不追求一次重写。
> 自动统计工具：`node scripts/route-inventory.mjs`（重构前后各跑一次，对照路由数是否守恒）。

## 一、现状量化（自动统计）

| 指标 | 数值 |
| --- | --- |
| `src/bridge.js` 行数 | **13,429** |
| 大小 | 740 KB |
| 顶层函数 | 66 个 |
| **`main()` 行数** | **约 11,862 行**（L1567 → 文件末尾） |
| `url.pathname` 比较 | 163 次 / **115 条唯一路径** |
| `req.method` 判断 | 128 次 |
| 路由命中（含前缀） | 147 处 |

按域分布（`route-inventory.mjs` 输出）：

| 分组 | 路由数 | 起始行 |
| --- | ---: | ---: |
| socialV2 | 68 | 3526 |
| other | 19 | 3425 |
| slang | 14 | 3571 |
| roles | 9 | 3700 |
| stickers | 8 | 3549 |
| send | 6 | 3492 |
| tokens | 6 | 6954 |
| status | 5 | 3491 |
| social(v1) | 4 | 4421 |
| images | 3 | 3493 |
| console-static | 2 | 3456 |
| sessions | 2 | 4196 |
| voice | 1 | 6221 |

## 二、为什么难改（具体痛点）

| 痛点 | 表现 |
| --- | --- |
| **无路由表** | 找一个端点必须先知道它在哪个 if 链里；新增端点要插到「位置正确」的地方 |
| **`main()` 是上帝函数** | 配置、状态、MCP、HTTP、社交调度、定时器全在一个作用域，靠闭包共享 20+ 个可变状态 |
| **层次耦合** | 改「发一条消息」要同时动：路由分支 → 参数校验 → 调 OneBot → 写 state → 打日志 |
| **状态隐式** | `slangStore` / `stickerStore` / `sessions` / `activeStates` 都是闭包变量，测试只能整进程起 |
| **无法单测** | 想测一个 handler 得启动整个 server（还要 DSH + SnowLuma） |

## 三、目标结构（渐进式，不是重写）

```
src/
  bridge.js              # 只做：读配置 → 起服务 → 挂路由表（<500 行）
  http/
    router.js            # ✅ 已有：注册/匹配（本方案第一步）
    middleware.js        # 待建：token 校验 / CSRF / JSON body / 只读降级 / agent 白名单
    respond.js           # 待建：sendJson / sendError / 静态文件
  api/
    status.js            # 待建：/api/status /api/security
    send.js              # 待建：/api/send/*
    roles.js             # 待建：/api/role*
    socialV2.js          # 待建：/api/socialV2/*（68 条，最后搬）
    slang.js             # 待建：/api/slang*
    stickers.js          # 待建
    sessions.js          # 待建
  services/
    send.js              # 待建：发送编排（分条/延迟/引用/重试）
    voice.js             # 待建：语音校验与发送
    storage.js           # 待建：原子读写 + 只读降级
  store/
    state.js             # 待建：sessions / social-v2 / roles-by-key
```

**原则**：`bridge.js` 永远是入口，永远可运行；每一步都是「搬一块 + 保持绿」。

## 四、五个阶段

### 阶段 0：安全网（半天）

| 动作 | 说明 |
| --- | --- |
| 跑通现有测试 | `node scripts/test-audit.mjs`（CI 已跑） |
| 加路由单测 | ✅ 已有 `node scripts/test-router.mjs`（11 项） |
| 加冒烟脚本 | 起 server → `GET /api/status` → 断言 `dshReady` 字段存在（不依赖 DSH 真实在线） |
| **记录基线** | `node scripts/route-inventory.mjs --json > route-baseline.json` |

**验收**：基线文件进仓库；重构后路由数与路径集合必须一致。

### 阶段 1：抽路由表（1~2 天，零行为变化）

把 `if (req.method === 'GET' && url.pathname === '/x')` 改成注册：

```js
// 之前（bridge.js 里，散落几百行）
if (req.method === 'GET' && url.pathname === '/api/status') { ...; return; }

// 之后（bridge.js 顶部集中注册）
import { createRouter } from './http/router.js';
const router = createRouter();
router.get('/api/status', handleStatus);
router.use('/api/socialV2/', handleSocialV2);
```

**handler 暂时留在 bridge.js 内**（只改分派方式），这样：

- 改动可机械核对（147 处 → 147 条注册）
- 行为零变化（router 的匹配语义已对齐原 if 链：精确优先、前缀严格 startsWith）
- 出问题可以整段 revert

**验收**：

```
node scripts/route-inventory.mjs --json > route-after.json
# 对比 uniquePaths 数量与集合，必须完全相同
node scripts/test-router.mjs
node scripts/test-audit.mjs
.\verify.ps1
```

### 阶段 2：抽中间件（2~3 天）

现在这些判断散在每个 handler 之前：

| 逻辑 | 现状 | 目标 |
| --- | --- | --- |
| Host 必须回环 | 每个 handler 前手写 | `middleware.requireLoopback` |
| `x-console-token` 校验 | 散落多处 | `middleware.requireToken` |
| CSRF（写操作必须 JSON） | 手写 | `middleware.requireJson` |
| agent token 白名单 | `agentAllowed` 数组 | `middleware.blockAgent` |
| 只读降级（slang/stickers） | 每个写接口重复 | `middleware.readonlyGuard` |

**收益**：以后新增端点默认就有安全防护，不会「忘记拉黑」。

**验收**：`curl` 打一遍关键端点，401/403 行为与重构前逐条一致（写个 `scripts/test-http-guards.mjs` 固化）。

### 阶段 3：按域搬 handler（5~7 天，逐组）

顺序按「依赖少 → 依赖多」：

1. `status`（5 条，无状态）
2. `images`（3 条）
3. `roles`（9 条，只读文件）
4. `slang`（14 条，一个 store）
5. `stickers`（8 条）
6. `send`（6 条，开始碰发送层）
7. `sessions` / `tokens`（8 条）
8. `social(v1)`（4 条）
9. **`socialV2`（68 条，最后）**

每搬一组：

```
移 handler 到 src/api/<domain>.js → 导出 → bridge.js 里注册 → 跑测试 → commit（一次一组）
```

**收益**：`bridge.js` 每搬一组就掉几百行；新加端点只改对应域文件。

### 阶段 4：抽服务层与存储（3~5 天）

| 抽什么 | 为什么 |
| --- | --- |
| `services/send.js` | 「发一条消息」现在跨路由/校验/OneBot/日志四层 |
| `services/voice.js` | 语音校验（时长/大小/响度）逻辑独立 |
| `store/state.js` | 原子写 + 只读降级 + 备份恢复，集中一处 |
| `store/sessions.js` | 会话映射与孤儿清理 |

**验收**：`bridge.js` < 1500 行；`main()` 拆成 `bootstrap()` 的若干阶段函数（config → state → mcp → http → social）。

### 阶段 5：拆 `main()`（2~3 天）

目标形态：

```js
async function main() {
  const cfg = loadConfig();
  const state = await initState(cfg);
  const services = createServices({ cfg, state });
  const http = await startHttp({ cfg, state, services });
  startSocial({ cfg, state, services });
  installShutdownHooks({ http, state });
}
```

每个 `init*` 只做一件事，失败点清晰（现在任何一处炸都表现为「整个进程没起来」）。

## 五、风险与对策

| 风险 | 对策 |
| --- | --- |
| 搬错分支导致 500 | 每组搬完立刻 `curl` 全端点（脚本化） |
| 前缀/精确优先级变化 | router 单测已覆盖；迁移前先补一条「优先级」用例 |
| 状态闭包被拆散后行为变 | **状态只搬不改**——先原样传给 handler（`ctx.state`），后续再分离 |
| 一次改太多无法 review | 一次 commit 只搬一个域；`git revert` 可控 |
| 与上游 diff 变大 | 上游改动按域 cherry-pick；重构期间少动业务逻辑 |

## 六、不要做的事

- ❌ 直接换成 Express/Koa（会连带改响应层与中间件语义，风险远超收益）
- ❌ 重写业务逻辑（重构只搬位置，不改行为）
- ❌ 一次搬完 147 条路由（无法 review、无法回滚）
- ❌ 在没有冒烟测试前动 `send` / `socialV2`

## 七、工作量与收益

| 阶段 | 工作量 | `bridge.js` 行数 | 主要收益 |
| --- | --- | ---: | --- |
| 0 安全网 | 0.5 天 | 13,429 | 有基线、可验证 |
| 1 路由表 | 1~2 天 | 13,400 | **找端点从「翻几千行」变「看一张表」** |
| 2 中间件 | 2~3 天 | 13,200 | 安全默认化 |
| 3 按域搬 | 5~7 天 | **~6,000** | 新增端点只改一个文件 |
| 4 服务/存储 | 3~5 天 | **~3,000** | 发送/存储可单测 |
| 5 拆 main | 2~3 天 | **< 1,500** | 失败点清晰 |

合计 **2~3 周**（一个人、每天 2~3 小时），全程可运行、可回滚。

## 八、给 AI agent 的操作约定

如果让 AI 来推进重构，要求它：

1. **一次只做一个阶段的一个分组**，commit 信息写清「搬了哪组、路由数未变」
2. 每次提交前必须跑：`node scripts/test-audit.mjs` + `node scripts/test-router.mjs` + `node scripts/route-inventory.mjs --stats`
3. 路由数/唯一路径数必须与基线**完全一致**（多一个少一个都要说明）
4. 不许在同一 commit 里既搬位置又改逻辑
5. 遇到拿不准的优先级语义，先补测试再动代码

## 附：常用命令

```powershell
# 现状盘点
node scripts/route-inventory.mjs            # Markdown 表
node scripts/route-inventory.mjs --stats    # 只看统计
node scripts/route-inventory.mjs --json > baseline.json

# 路由单测
node scripts/test-router.mjs

# 审计测试（CI 跑的那个）
node scripts/test-audit.mjs

# 运行中体检
.\verify.ps1
```

## 迁移进度（实时）

> 安全网已就绪：`scripts/test-audit.mjs`（35/35）+ `scripts/test-router.mjs`（11）+ `scripts/test-api-module-loader.mjs`（17）。
> 守恒校验：`node scripts/route-inventory.mjs --stats`（会同时扫 `src/bridge.js` 与 `src/api/*.js`）。
> 基线：`uniquePaths=115`（迁移后每多一个「分派前缀」`routeHits` 会 +1，属预期）。

| 分组 | 路由数 | 状态 | 产出 |
| --- | ---: | --- | --- |
| status | 5 | ✅ 已迁出 | `src/api/status.js` |
| images | 3 | ✅ 已迁出 | `src/api/images.js` |
| roles | 9 | ✅ 已迁出 | `src/api/roles.js` |
| slang | 14 | ✅ 已迁出 | `src/api/slang.js` |
| stickers | 8 | ✅ 已迁出 | `src/api/stickers.js` |
| send | 6 | ✅ 已迁出 | `src/api/send.js` |
| sessions/tokens | 8 | ✅ 已迁出（8/8，含高危 reset） | `src/api/sessions.js`、`src/api/tokens.js`；reset 有回归测试 `test-session-reset.mjs`（10 项） |
| social(v1) | 4 | ✅ 已迁出 | `src/api/social.js` |
| socialV2 | 68 | 🟡 43/68 已迁（A+B 27 + C1 2 + C2 5 + C3a 6 + C3b 媒体 3；剩发送 3（send-message/send-burst/send-poke）与 D 批 wait，均留给 pro） | `src/api/socialV2-read.js`（config/activity/tool-log/feedback/states/my-recent/memory/slang-query）；**B/C 进行中，D（wait 长轮询租约）留给 pro** |

每迁一组必须满足：

```
node scripts/test-audit.mjs            → 35/35
node scripts/route-inventory.mjs --stats → uniquePaths 不减少（115）
node scripts/test-router.mjs           → 11/11
```
