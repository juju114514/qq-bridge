# 人设的「语气 / 内容」边界在哪，怎么放开

> 你想要的：「让朋友和群友能聊得更放开一点 —— 骂人、涩一点」。
> 这篇讲清楚**约束现在分散在哪几层**、**哪层该改哪层不能改**，以及新加的 `personaPolicy` 怎么用。

## 一、约束一共四层（从硬到软）

| # | 层 | 位置 | 能不能改 | 说明 |
| --- | --- | --- | --- | --- |
| ① | **模型自带对齐** | DeepSeek 模型本身 | 改不了 | 提示词只能"放宽表达"，不能让它必然违规；太露骨的请求它仍会拒 |
| ② | **预设 persona** | `dsh/agent-presets/qq-chat{,-v2}/agent.cordis.yml` 的 `prefix` | **别改**（安全边界） | 里面是"无本地工具 / 群友无管理权 / 不泄露配置"等硬规则，跟语气无关，别混在一起 |
| ③ | **人格卡正文** | `roles/<名字>.md` | 可以改 | 卡里写的"骂人就拒绝"（例如 `roles/派蒙（无测试）.md:147`）属于**卡内自述**，改卡即生效 |
| ④ | **桥接注入的顺序与截断** | `src/bridge.js` 的 `currentRoleHint()` → `promptText` | 可以改 | 角色卡有注入上限 `role.maxInjectChars`：**写在卡片末尾的话会被截掉**；而且卡片本身不该承担"全局许可" |

新加的第 ⑤ 层就是本次的模块：**`src/persona-policy.js`（personaPolicy）**——独立注入块，拼在角色卡**之后**、永不被截断、按群解析。

```
promptText =
  [角色卡正文]        ← roles/<名>.md（可能被 maxInjectChars 截断）
  [语气许可块]        ← persona-policy.js（本次新增，不截断）
  [管理员标记] [群友名]：消息正文
```

注入点：`src/bridge.js` 里 `const toneBlock = personaPolicyBlockText(key);` 紧跟在 `currentRoleHint(key)` 之后。

## 二、怎么开

`config.json`：

```json
"personaPolicy": {
  "profanity": "mild",
  "nsfw": "off",
  "perGroup": {
    "group:123456789": { "profanity": "strong", "nsfw": "explicit" }
  }
}
```

| 键 | 取值 | 效果 |
| --- | --- | --- |
| `profanity` | `off` / `mild` / `strong` | off 不提；mild 允许吐槽损人；strong 允许骂人爆粗（仍不针对真人身份特征） |
| `nsfw` | `off` / `suggestive` / `explicit` | suggestive 只到开黄腔/暗示；explicit 才写成人内容 |
| `perGroup` | `{ "group:<群号>": {...} }` | 按群覆盖；`"*"` 是兜底 |
| `requireAdultConfirm` | `true`（默认） | `explicit` 必须先做成年确认，否则自动降级为 `suggestive` |

**成年确认**：把群号写进 `state/persona-adult.json`（不进 git）：

```json
{ "confirmed": ["123456789"] }
```

> 注意：`explicit` 只对**私域、成年、群主知情**的群开。开了以后群里任何人的一句话都可能触发，包括未成年人。
> 所以默认 `requireAdultConfirm: true`，且**每个群单独放行**，不要全局开。

## 三、永远不放开的部分（写死在代码里）

`hardLimitsBlock()` 会**无条件**拼在每段许可后面，不受配置影响：

- 涉及未成年人的性内容 → 拒绝
- 真实人物（非公众人物/未经同意）的性化或侮辱 → 拒绝
- 违法内容（犯罪教程、暴力威胁等）→ 拒绝
- 泄露他人隐私（住址/证件/联系方式）→ 拒绝

理由很实际：这几类不是"口味问题"，是**法律和平台红线**——QQ 侧一旦被举报，封的是你的号。

## 四、改之前先知道的坑

| 坑 | 说明 |
| --- | --- |
| 角色卡末尾的约束会被截断 | `role.maxInjectChars` 默认只注入前 N 字符；所以"放开/收紧"的规则要放 `personaPolicy`，别写卡尾 |
| 群里默认不注入人设 | `role.groupEnabled=false` 时要管理员 `/role 名字` 才生效，否则语气块也没人用武之地 |
| 模型仍可能拒 | 第 ① 层在，提示词只能提高概率，不能保证 |
| 平台会撤回 | QQ 官方通道有内容审核；个人号也有风控，露骨内容可能被撤回甚至限制发言 |
| 改了 `dsh/agent-presets/` 要重启 DSH | 预设只在 DSH 启动/建会话时加载（见 AGENTS.md「四条硬规则」第 2 条） |

## 五、自检

```powershell
node scripts/test-persona-policy.mjs     # 8 条：默认关闭 / 按群覆盖 / 成年降级 / 硬底线
```

想确认实际注入了什么，看日志里的：

```
[persona-policy] group:123 explicit→suggestive：该会话还没做成年确认
```
## 六、安全词（说了就停）

放开之后最怕"收不住"。所以两个地方都带安全词：

| 位置 | 触发方式 | 效果 |
| --- | --- | --- |
| QQ 群 | 群里**任何人**说 `安全词` / `收一下` / `打住` | 立刻把**本群**的放开策略写成 off（持久化到 config.json），回一句「收到安全词，本群的『放开』设定已关闭。」，这条消息**不进模型** |
| 抖音（room-pet） | 对方私信/评论里含 `安全词` / `别回了` / `停下` | 不生成、不发送，并在 `dm_replies.json` 标记已处理（避免下一轮又回） |

配置：`personaPolicy.safetyWords`（QQ 侧）与 `auto.json` 的 `safetyWords`（抖音侧）；
给空数组 = 关闭安全词（不建议）。

实现：`src/persona-policy.js` 的 `isSafetyWordText()` / `resolveSafetyWords()`；
QQ 侧在 `bridge.js` 的 `handleSafetyWord()`，抖音侧 `safety_words.py` + 两个 auto_* 脚本。

