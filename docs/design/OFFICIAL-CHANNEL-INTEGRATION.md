# 官方通道接入契约（预留接口）

> 状态：**代码已实现、接入位已预留、仍上锁未验证**（见 [LOCK.md](../../LOCK.md)）。
> 这份文档说明「接入一件什么产物、缺什么、什么时候可以打开」。

---

## 一、接入是什么（一句话）

官方通道（QQ 官方机器人，q.qq.com）在本仓库里是**第二条通道**，和 NapCat/SnowLuma 那条并列。
它的接入不是"改代码"，而是**满足清单 + 改一个开关**：

```jsonc
"official": {
  "enabled": true,        // ← 就这一个开关
  "appid": "…",
  "secret": "…",          // 也可以放到 state/official.json（不进仓库）
  "sandbox": false,
  "allowAll": false,
  "allow": ["<openid>"]   // 官方会话按 openid 判，不是 QQ 号
}
```

代码侧已有：`src/qqbot-official.js`（协议）、`src/official-transport.js`（收发适配）、
`src/official-media.js`（媒体）、`src/official-proactive.js`（主动消息窗口）。

---

## 二、接入闸门（`src/official/gate.js`）

判断逻辑收敛成一个**纯函数**，控制台与启动日志都用它，避免"各处理解不同"：

| 检查项 | 满足条件 | 不满足时的提示 |
| --- | --- | --- |
| `enabled` | `official.enabled === true` | 拿到验证结果前保持 false |
| `appid` | 非空 | q.qq.com → 机器人 → 开发设置 |
| `secret` | `official.secret` 非空（或 `state/official.json`） | secret 放 `state/`，不进仓库 |
| `allow` | `allow` 非空列表，或 `allowAll = true` | 官方会话按 openid 判，默认全拒 |
| `probe` | 跑过 `scripts/official-probe.mjs`（留下 `state/official-probe.json`），**或当前已连接** | 先跑探针 |

两个衍生字段：

- `allowed`：五项全满足
- `readyToFlip`：只差 `enabled` 一项（其余齐了）—— 这是"万事俱备"的信号

> 为什么 `probe` 也认"运行时已连接"：已连上说明鉴权/网关/事件都通了，比探针更强；
> 不认它会让**明明在跑的实例**显示"未就绪"，那是自相矛盾。

---

## 三、控制台入口

「运维 → 官方通道」页（`/api/official`）：

- 顶部状态：未启用 / 已配置未启用 / 连接中 / 已连接 / 连接失败
- 清单：五项 ✅/❌
- 还差什么：逐项列出 + 提示（缺 appid 去哪拿、secret 放哪、探针怎么跑）
- `readyToFlip` 时提示「只差一个开关」

页面不提供"一键启用" —— 官方通道涉及账号风险，**开关留给人手动改**，符合 LOCK.md 的口径。

---

## 四、接入步骤（等验证通过后照做）

```powershell
# 1) 先跑探针（会写 state/official-probe.json）
node scripts\official-probe.mjs --seconds 120

# 2) 看控制台「官方通道」页：五项应全绿
#    若只差 enabled → readyToFlip=true

# 3) 改 config.json：official.enabled = true
# 4) 重启
schtasks /end /tn qq-bridge ; schtasks /run /tn qq-bridge

# 5) 验：/api/official 应 allowed=true、state=已连接
#    群里 @ 它一次，确认能回
```

---

## 五、回退

| 情况 | 动作 |
| --- | --- |
| 回复异常 / 被风控 | `official.enabled = false` 后重启，回到 NapCat 通道 |
| 只想临时停 | 同上（不需改代码） |
| 想清掉"已验证"记录 | 删 `state/official-probe.json` |

---

## 六、还没做的（不影响预留）

- `official-user-posts` 之外的官方主动消息配额可视化（`official-proactive.js` 有窗口逻辑，控制台暂未展示）
- 双通道同时在线（目前是"二选一"倾向，见 `channel-mode` 与 `LOCK.md`）
- 官方通道真机 e2e 记录（等验证通过后补进 `docs/audits/`）
