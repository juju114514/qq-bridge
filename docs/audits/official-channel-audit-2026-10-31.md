# Official 通道专项审计（2026-10-31）

> 目的：确认官方 QQ 机器人通道（`src/qqbot-official.js` + `official-transport.js`）
> 是否**真的**与 SnowLuma 通道共用会话 / 记忆 / prompt，而不是"只共用 DSH API"。
>
> 结论先说：**共享的是核心链路，但有 3 个真实缺口**，其中 2 个会影响行为（身份写错、管理员失效）。

## 一、共享情况（逐项核对）

| 能力 | 是否共享 | 证据 |
| --- | --- | --- |
| 入站处理函数 | ✅ 同一个 | `bridge.js` L9869：`handleIncoming(event.kind, …, oneBotEvent, cfg)`，与 SnowLuma 的 `bot.onGroupMessage` 走同一个函数 |
| 会话键 | ✅ 同一规则 | `convKey(kind, id)`；官方 id 带 `official-` 前缀（`official-transport.js` L40 `officialId()`）|
| 会话 / agent | ✅ 同一套 | 都在 `socialV2` 状态里按 key 存，`state/agents/<key>` 也是同一套 |
| 记忆（`state/memory/`） | ✅ 同一套 | key 相同即同一份记忆文件 |
| 人设 / 角色卡 | ✅ 同一份 | `buildWakePromptV2` → `selfIdentityTextV2()` + 角色卡，无分支 |
| 黑话 / 表情 / 上下文 | ✅ 同一套 | 都在 `handleIncoming` 之后的公共路径 |
| 控制台 | ✅ 同一个 | 控制台读的是同一份 `social-v2.json` |
| 去重 / 审批 / 权限 | ⚠️ 部分 | 见下面的缺口 2、3 |

**一句话**：官方通道不是"另一套系统"，它就是同一套核心的**第三个入口**（前两个是群聊、私聊）。

## 二、三个缺口

### 缺口 1：prompt 里的「你的身份」写的是 SnowLuma 的号（影响行为）

`selfDisplayName` / `selfUserId` 只在 SnowLuma 登录成功后赋值：

```js
// bridge.js L9938-9941
selfDisplayName = String(login.nickname).trim();
if (login?.user_id != null) selfUserId = String(login.user_id);
```

而官方通道（`official-transport.js` / `qqbot-official.js`）**从不设置这两个值**，
且 `toOneBotEvent()` 里 `self_id: ''`（L47）。

后果：

- 官方通道下，prompt 仍然告诉模型「你的昵称是「小鲸鱼（大肥鱼）」（QQ 3976372760）」
  —— 那是**雪晴个人号**的身份，不是官方机器人
- 如果 SnowLuma 没连上（只跑官方通道），这两个值是空 → 身份行整段消失
- 模型可能因此对"@自己"判断错（issue #29 的同一个坑，只是换了通道）

**修法**：官方通道启动后拉一次自己的身份（官方 API 有 `/users/@me`），写入同一组变量；
或按 transport 区分（`official` 用官方身份，`snowluma` 用个人号身份）。

### 缺口 2：管理员在官方通道永远是"非 owner"（影响权限）

- `ownerQQ` 是**数字 QQ 号**（`normalizeOwnerQQ` 只收 `/^\d+$/`）
- 官方通道的 `user_id` 是 **openid**（`official-<openid>`），两者永不相等

后果：

- 管理员在官方机器人里发指令 → 不被识别为 owner
- 审批、`/role` 切换、封闭模式这些"仅管理员"的能力在官方通道下**全部不可用**
- 但 prompt 里又写着「只有管理员（会话里带 isOwner 标记的那位）……」→ 模型会以为没有管理员在场

**修法**：新增 `official.ownerOpenid`（或 `official.allow` 里的标记），
把 openid 也纳入 owner 判定；并让 prompt 的权限段能表达"本通道的管理员是 openid X"。

### 缺口 3：官方入站的 `msgSeq` 恒为 0（影响去重/顺序）

`qqbot-official.js` L48/L66：`msgSeq: 0`（官方事件确实没有 OneBot 的 seq）。

后果：

- 任何依赖 `msgSeq` 做**去重**或**顺序**的地方，在官方通道下会退化
- 官方同一 `msg_id` 重投（重连后常见）时，只能靠 `message_id` 去重；
  现在入站路径没有显式按 `message_id` 去重 → **可能重复处理，重复回复**

**修法**：入站闸门加一条「同一 `message_id` 在 N 秒内只处理一次」，与 `msgSeq` 解耦。

## 三、设计上的"不同"（不是 bug，但要写进文档）

| 项 | 说明 |
| --- | --- |
| 记忆键 | 官方群聊的 key 是 `group:official-<openid>`。**同一个真实 QQ 群**，如果既被个人号看到、又被官方机器人看到，会是**两份独立记忆**。这是设计选择（两个身份、两套上下文），但用户容易困惑 |
| 身份 | 官方机器人 ≠ 个人号，昵称/头像/权限都不同；不能指望"同一个机器人"在两个通道表现一致 |
| 好友/群列表 | 官方 API 没有好友列表；`privateAccess` 的好友判定在官方通道不适用（走 `official.allow`） |

## 四、修复清单（按优先级）

| # | 事项 | 影响 | 工作量 |
| --- | --- | --- | --- |
| 1 | 官方通道的身份值写入 `selfDisplayName/selfUserId`（或按 transport 分支） | prompt 正确性 | 半天 |
| 2 | `official.ownerOpenid` → owner 判定支持 openid | 权限可用性 | 半天 |
| 3 | 入站按 `message_id` 去重（与 seq 解耦） | 防重复回复 | 2 小时 |
| 4 | `OFFICIAL-QQ.md` 补「记忆键是 openid，与个人号不同」 | 用户预期 | 1 小时 |
| 5 | 官方通道专项 e2e（真机）：@ 它、发图、私聊、拒绝非白名单 | 验证 | 半天 |

## 五、结论

**方案 2（自有 official 通道）在架构上成立**：它确实复用同一套核心（会话/记忆/prompt/人设/控制台），
不是"共用 DSH API 的两套系统"。

但**上线前必须修 1 和 2**：

- 否则模型会拿错身份说话（缺口 1）
- 否则管理员在官方通道里没有任何管理能力（缺口 2）

缺口 3 属于健壮性，建议一起修。

> 审计方法：读代码路径 + 逐项对照（不是凭文档）。涉及
> `src/qqbot-official.js`、`src/official-transport.js`、`src/bridge.js`（L9869 分派点、L7900 身份行、L9938 赋值）、
> `src/config.js`（official 配置）。

## 六、锁定状态（2026-10-31 定）

代码侧三个缺口已在 **0.4.29** 修完（owner openid / 按通道身份 / message_id 去重）。
但因为**还没有真机 e2e**，仓库对该通道**上锁**：

- 见根目录 [LOCK.md](../../LOCK.md)
- `config.example.json` 的 `official.enabled` 固定 `false`
- README 顶部有 🔒 横幅

**只锁 git 仓库口径，不锁本地运行** —— 本地按需 `official.enabled: true` 仍可测试。
解锁条件见 LOCK.md 第三节。
