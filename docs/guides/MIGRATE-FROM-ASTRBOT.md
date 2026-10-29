# 从 AstrBot 迁过来

> 面向已经在用 AstrBot（NapCat + 插件 + 群规则）的人。
> 结论先说：**不用推倒重来，不用换网关，可以先并跑再决定。**

---

## 一、最常问的三个问题

### Q1：我装的 NapCat 要换掉吗？

**不用。** 这个项目原生支持两种 OneBot 网关：

| 网关 | 说明 |
| --- | --- |
| SnowLuma | 默认主通道 |
| **NapCat**（AstrBot 常用） | 直接用，端口同样是 3000 / 3001 |

由 `src/gateway-select.js` 自动选择：默认 SnowLuma，连续失败 3 次降级 NapCat，
恢复 5 次后回切，切换有 60 秒冷却（不会两个网关之间反复横跳）。

一键识别当前该用谁：

```powershell
.\scripts\start-all.ps1 -StatusOnly
```

### Q2：AstrBot 的插件能搬过来吗？

**不能直接搬**（运行时不同：AstrBot 插件跑在 Python 框架里，这里是 DSH agent + 工具）。

对应关系：

| AstrBot 里的东西 | 这个项目里对应什么 | 迁移方式 |
| --- | --- | --- |
| 插件（Python） | DSH agent preset + 工具 | 按功能重写，或直接不用（很多能力已内置） |
| 人格/提示词配置 | `role` 人格卡（文件） | 手工复制文本 |
| 长期记忆 / LivingMemory | `src/memory-store.js` + 原子记忆 | 手工导出成 JSON 再导入（无自动脚本） |
| 群规则（allow/deny） | `config.json` 的 `allow` / `deny` | 见下面 §三 的模板 |
| 定时任务 | 官方通道的 cron 播报 / `socialV2.proactive` | 重新配 |
| 语音（TTS 插件） | edge-tts 系列工具（`qq_say` / `qq_sing` / `qq_song`） | 换个调用名，能力等价 |

### Q3：能不能先跑着看看，不影响我现在的 AstrBot？

**可以，而且推荐这样做。** 见 §四「只读试用」。

---

## 二、配置字段对照

AstrBot 的配置在 `data/config/*.yaml`，这个项目在 `config.json`。常用项：

| AstrBot | 这里 | 备注 |
| --- | --- | --- |
| `platform` 里的 QQ 号 | `allow.groups` / `allow.private` | 数组，数字 |
| 管理员 QQ | `ownerQQ` | 单个数字 |
| 黑名单群 | `deny.groups` | 数组 |
| 触发前缀 / @ 才回 | `socialV2.wake.*`（atMention / keywords / probability） | 更细，按会话存 |
| 回复间隔 | `socialV2.send.burstIntervalMinMs/MaxMs` | 毫秒 |
| 最大回复长度 | `socialV2.send.maxMessageChars` | 默认 500 |
| 是否分条发送 | `socialV2.send.burstEnabled` | 空格分句 |
| TTS 开关 | `socialV2.voice.enabled` | 默认 **false**（要先放音频到 `audio/`） |

---

## 三、把群规则搬过来的模板（不写导入器，给可改的脚本）

为什么不做"一键导入 AstrBot 配置"：它的 YAML 结构在不同版本之间变过，
写死解析器迟早坏。给一段**你改两行就能用**的模板更耐用：

```powershell
# 把 AstrBot 里允许的群号贴进 $groups，管理员号贴进 $owner，然后跑
$groups = @(123456789, 987654321)
$owner  = 111111111
$cfgPath = 'D:\deepseek工作区\qq-bridge\config.json'
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.allow.groups = $groups
$cfg.allow.private = @()
$cfg.ownerQQ = $owner
($cfg | ConvertTo-Json -Depth 32) | Set-Content $cfgPath -Encoding UTF8
```

然后在控制台点一次「白名单已更新」（或重启桥接）让它热生效。

---

## 四、只读试用：先看一周再决定

目标：**机器人只在群里"潜水观察"，不抢你现有 AstrBot 的话**。

| 做法 | 效果 |
| --- | --- |
| `role.mode = silent` | 群友消息只记录、不回复；管理员私聊仍可指挥 |
| 控制台「暂停」(`socialV2.paused = true`) | 全局急停，一条都不发 |
| 只把 `allow.groups` 设成**测试群** | 天然隔离，不会碰到正式群 |

关键：**两条轨道（本地注入 / 官方 Bot）和 AstrBot 用的是同一个 QQ 号**吗？

- 如果**同一个号**：两边都会收到消息、都可能发言 → 建议先只把 AstrBot 停掉，或把这个项目设为 `silent`
- 如果是**不同号**（推荐的试法）：直接并跑，互不干扰

---

## 五、迁移检查清单

```
[ ] 1. 网关：start-all.ps1 -StatusOnly 确认识别到 NapCat 或 SnowLuma
[ ] 2. 白名单：allow.groups 只放测试群，ownerQQ 填自己
[ ] 3. 隐私：state/ 与 logs/ 不进 git；config.json 里没有真实 token 提交
[ ] 4. 只读跑一天：确认它记录到的消息量与 AstrBot 那边一致（证明入站没漏）
[ ] 5. 打开回复：先把概率调低（socialV2.wake.recommendedProbability=0.05）
[ ] 6. 观察一周：看它会不会刷屏/复读；有必要再调 burst 与 maxSendPerHour
```

---

## 六、已知差异（别期待完全等价）

| 项 | AstrBot | 这里 |
| --- | --- | --- |
| 插件生态 | 大量现成 Python 插件 | 没有插件市场，能力内置或写 DSH 工具 |
| 多人分级权限 | TOTP / 分组管理 | **没有**，定位是单人自用 |
| Web 管理面板 | 完整后台 | 有控制台（`http://127.0.0.1:3100`），但轻量 |
| 官方 QQ 通道 | 一般没有 | ✅ 有（合规、不封号），这是本项目的差异点 |
