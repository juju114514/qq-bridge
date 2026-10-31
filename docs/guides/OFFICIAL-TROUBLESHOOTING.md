# 官方通道：报错调整方案（实测版）

> 这份文档记录**真机上真实撞到的报错**，以及每个报错的调整办法。
> 与 [LOCK.md](../../LOCK.md) 配套：官方通道**仍然上锁**（仓库口径），本文只是把「踩到坑怎么绕」写清楚，
> 不代表它已验证可用。
>
> 记录时间：2026-11-01 · 真机 `0.4.65` · 官方通道 `enabled=true`（本地开发态）

---

## 一、最快定位顺序（照这个顺序看日志）

```powershell
# 1) 官方通道有没有连上
Select-String -Path state\bridge.log -Pattern '\[official\] (鉴权成功|已就绪|错误)' | Select-Object -Last 5

# 2) 每条入站走了哪一步（这行是链路总闸）
Select-String -Path state\bridge.log -Pattern '\[official\] (收到|进入处理|处理返回|忽略)' | Select-Object -Last 10

# 3) 官方层白名单
#    "白名单=通过/拒绝" 在「进入处理」那一行里

# 4) 私聊层白名单（官方过了还有一层）
Select-String -Path state\bridge.log -Pattern '\[private\] 拒绝' | Select-Object -Last 5
```

判定口诀：**两层白名单，先官方后私聊**。

---

## 二、报错对照表（全部来自实测）

### 1. 收到消息但完全没有后续处理

```
[official] 收到 单聊消息（作者 ?，文本 3 字）
（没有任何「进入处理」）
```

**原因**：`onEvent` 抛异常被静默吞了，或 transport 没把事件交给 `onMessage`。
**调整**：升级到带 `[official] 转交失败` 日志的版本；若仍无，检查 `state/bridge.log` 里有没有
`[official] 错误：`（网关层错误通常在这）。

---

### 2. `白名单=拒绝`（官方层）

```
[official] 进入处理：kind=private openid=64824F… 白名单=拒绝
忽略未授权的官方会话（private openid=64824F…）
```

**原因**：该 openid 不在 `config.official.allow`，且 `allowAll=false`。
**调整**：把这个 openid 加进 `official.allow`：

```jsonc
"official": { "allow": ["<群openid>", "<个人openid>"] }
```

> 群 openid 与个人 openid **是两串不同的值**，群能收到不代表私聊能收到。

---

### 3. 官方层通过，但被 `not-friend` 拦下（私聊层）

```
[official] 进入处理：kind=private … 白名单=通过
[private]  拒绝 private:official-64824F…（not-friend）：
           网关不支持好友列表，仅白名单放行（config.allow.private）
```

**原因**：官方通道拿不到好友关系，私聊层只能靠 `config.allow.private`；
官方会话的 key 是 `official-<openid>`，要以**带前缀**的形式加进去。
**调整**：

```jsonc
"allow": { "private": ["official-<个人openid>"] }
```

**这是最容易漏的一步**：owner 私聊必须**同时**出现在 `official.allow` 与 `allow.private`。

---

### 4. `ownerOpenid` 填了但管理员指令不生效

**原因**：owner 判定发生在两层白名单**之后**。被白名单拦下的消息根本走不到 owner 判定。
**调整**：先按 §2、§3 放行，再验 owner。
owner 值取自 `state/official-inbound.json` 里 `kind=private` 的 `openid`（**不是**群 openid）。

---

### 5. `被动回复窗口已过` / 主动消息发送失败

```
[official] 发送失败：…（active message …）
```

**原因**：官方消息只有在收到后约 4.5 分钟内可以「被动回复」（`PASSIVE_WINDOW_MS`）；
超时就得走主动消息，而多数机器人没有主动消息权限。
**调整**：把回复做在窗口内；排障时可以用 `node scripts\official-probe.mjs --send-test <group_openid>` 单测主动消息。

---

### 6. 同一条消息被回两次

**原因**：官方网关断线重连会重投同一 `msg_id`（已修缺口 3，但仍可能在某些版本出现）。
**调整**：确认日志有 `[official] 重复消息，跳过`；没有的话说明去重没生效，检查版本是否 ≥ 0.4.29。

---

### 7. 鉴权失败

```
[official] 错误：鉴权失败 / invalid appid
```

**原因**：`appid` / `secret` 不对，或 secret 已重置、或 `sandbox` 与实际环境不匹配。
**调整**：`state/official.json` 与 `config.official` 两处**任一**有值即可（state 优先）；
两边不一致时以 `state/official.json` 为准，容易误判。

---

### 8. `控制台 /api/official` 显示「已连接」但清单不全绿

**原因**：闸门按五项判（`enabled` / `appid` / `secret` / `allow` / `probe`），
「已连接」只说明前几项成立，`probe` 可能是 false。
**调整**：跑一次 `node scripts\official-probe.mjs --seconds 120`（会写 `state/official-probe.json`）。
闸门认两种证据：**探针标记** 或 **当前已连接**。

---

## 三、配置自检清单（改完照这个核对）

| 项 | 值应该是什么 | 查法 |
| --- | --- | --- |
| `official.enabled` | `true` | `config.json` |
| `official.appid` / `secret` | 非空（或放 `state/official.json`） | 同上 |
| `official.allow` | 至少含目标**群** openid；owner 私聊则再加**个人** openid | 同上 |
| `official.ownerOpenid` | 个人 openid（无 `official-` 前缀） | 同上 |
| `allow.private` | `["official-<个人openid>"]` | 同上 |
| 探针标记 | 存在即算验证过 | `state/official-probe.json` |
| 身份日志 | `[official] 自我身份已设置：显示名「官方机器人」` | `state/bridge.log` |

---

## 四、仍未解决 / 仍在验证

| 项 | 现状 |
| --- | --- |
| 真机 e2e 四条 | 进行中，清单见 [OFFICIAL-E2E-CHECKLIST.md](../audits/OFFICIAL-E2E-CHECKLIST.md) |
| 「两层白名单」能否合并成一层 | 未做：可能破坏现有私聊安全边界，暂不合并 |
| 主动消息配额可视化 | 未做，`official-proactive.js` 有窗口逻辑但控制台没展示 |
| 官方 + 个人号双通道同时在线 | 未验证，`channel-mode` 目前倾向二选一 |

---

## 五、这条文档的边界

- 它**不改变**上锁状态：官方通道仍是 `🔒 上锁 + 🧪 EXPERIMENTAL`
- 它**不承诺**照着做就能用：能解决的是「配置/白名单/窗口」这类问题，协议层问题不在本文范围
- 它**来自实测**：每一条报错都在真机日志里出现过（`2026-11-01` 那一轮）
