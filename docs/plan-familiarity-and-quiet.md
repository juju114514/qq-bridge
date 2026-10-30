# 借鉴方案：熟悉度 + 定时静默（不移植，只借思路）

> 参考实现（已 clone 在 `D:\repo-refs\`）：
> - `hdace-dsh-qq/src/social/people.js`（623 行）—— 人物库 + 认识程度
> - `hdace-dsh-qq/src/social/memory-policy.js`（148 行）—— 作用域可见性
> - `douyin-bridge/src/douyin/features-config.mjs`（187 行）—— 开关与配额校验
>
> **我们不照搬**：它们是完整子系统，我们是单人自用 + 已有 `memory-store.js`。
> 下面是"借哪几条规则、怎么塞进现有结构"。

---

## 一、值得借的四条硬规则（与代码量无关，全是判断）

### 1. 身份只认 QQ 号

> 昵称/群名片只是附带字段，**绝不**用来合并两个 QQ 号。
> 「同名不同号」= 两个人；「同号不同名」= 一个人。小号关联只能管理员显式设置。

**为什么重要**：我们现在的 `memory-store.js` 是按 `key`（会话）存的，
一旦有人改群名片，历史记忆就断成两个人。这条规则能一次性解决。

### 2. 记忆按作用域存，**注入时**才过滤

> 存放：`group:<群号>` / `private:<QQ号>` / `global`
> 可见范围在注入时由 policy 过滤，模型拿不到超出当前会话可见范围的条目。

**和我们的对比**：我们现在是"按会话 key 存，取的时候按会话取"——
效果类似，但**没有 global 层**，"这个人在 A 群说过的话"在 B 群完全不可见。
借用点：加一层 `global`（只存跨群安全的信息：称呼偏好、明显禁忌）。

### 3. 首次部署的存量成员标 `listed`，不当作新人

**为什么重要**：我们第一次打开 `people` 表时，群里几百人会被判成"新朋友"，
机器人会挨个欢迎/搭话——非常吵。它们用 `listed`（见过名单）解决。

### 4. 删除是真删除

`deletePerson` 抹掉此人**全部作用域**的记录，不留残片。
我们现在没有任何删除路径（只有覆盖），这条要补。

---

## 二、定时静默：借它的"校验器写法"

`features-config.mjs` 的 `quietHours` 校验很值得抄（代码只有 10 行）：

```js
const quiet = s.quietHours ?? [23, 8];          // 两个 0~23 的整数
if (!Array.isArray(quiet) || quiet.length !== 2 ||
    quiet.some((n) => !Number.isInteger(n) || n < 0 || n > 23)) {
  throw new TypeError('social.quietHours 需要两个 0~23 的整数');
}
```

**借的是风格**：默认值 + 严格校验 + 错误信息里写清"要什么"，而不是静默回退。
这个仓库的 `loadConfig` 正是缺这个（漏字段就静默失效，我们踩过多次）。

---

## 三、我们的落地设计（比参考实现小很多）

### 3.1 人物库：`src/people.js`（目标 ~200 行，不是 623）

只存"跨会话有用"的东西，不重复 `memory-store` 已有的能力：

```json
{
  "version": 1,
  "people": {
    "123456789": {
      "qq": "123456789",
      "names": { "global": "小A", "byGroup": { "123456789": "群名片A" } },
      "relation": { "level": "acquaintance", "firstSeenAt": 0, "lastSeenAt": 0, "msgCount": 0 },
      "notes": { "global": ["喜欢被叫小A"], "group:123456789": ["在这个群聊游戏"] },
      "history": [{ "kind": "join", "at": 0 }]
    }
  }
}
```

| 字段 | 来源 | 上限 |
| --- | --- | --- |
| `names.byGroup` | 每条消息的群名片 | 每群 1 条，覆盖式 |
| `relation.level` | `stranger → listed → acquaintance → familiar` | 固定 4 档 |
| `notes` | 显式写入（管理员或模型主动） | 每作用域 30 条 / 每条 120 字 |
| `history` | 入群/退群/久别回归 | 最近 10 条 |

**熟悉度怎么算**（我们自己定，不抄它的公式）：
`msgCount` 与 `活跃天数` 两个指标，取较慢的那个升档（防止一天刷 500 条就变"熟人"）。

### 3.2 静默时段：`src/quiet-hours.js`（目标 ~40 行）

```js
export function inQuietHours(now, [start, end], { tzOffsetMin = -new Date().getTimezoneOffset() } = {}) { ... }
```

- 支持跨零点（23 → 8）
- `start === end` 视为关闭
- 纯函数，可离线测（不需要真等到半夜）

接入点：`handleIncoming` 决定是否唤醒前判一次 → 命中就不唤醒（但仍记录消息）。

### 3.3 记忆淘汰（借 memory-policy 的"注入时过滤"思路）

不给记忆加过期时间（不可预测），改成**注入时按关系档位截断**：

| 关系 | 注入的笔记条数 |
| --- | --- |
| stranger / listed | 0 条（只当陌生人） |
| acquaintance | 3 条 |
| familiar | 8 条 |

好处：不用定时任务删数据，只是"临时看不见"，恢复关系就又能看到。

---

## 四、与现有代码的关系（不重复造）

| 现有 | 新东西的角色 |
| --- | --- |
| `src/memory-store.js` | 继续管"这个会话记了什么"；people 只管"这个人是谁、什么关系" |
| `src/social-v2` 状态 | 不变；people 是独立文件 `state/people.json` |
| `socialV2.wake.*` | 静默时段在唤醒前判一次，不改唤醒配置本身 |
| `src/sticker-notes.js` | 已经是"按 scope 存 + 缺 scope 不生效"的范式，people 沿用同一套 |

---

## 五、落地顺序（两步，各自可回滚）

### 第 1 步：静默时段（半天）

1. 写 `src/quiet-hours.js` + 测试（跨零点、边界、关闭）
2. `config.example.json` 加 `socialV2.quietHours: [23, 8]`（默认关闭 = `null`）
3. `handleIncoming` 唤醒前判一次
4. 验证：把时段设成"现在"→ 群里说话不回复但仍记录；改回来恢复正常

### 第 2 步：人物库（1–2 天）

1. 写 `src/people.js`（纯函数 + 文件读写分离）+ 测试
2. `handleIncoming` 里 upsert（只写 qq / 群名片 / lastSeen / msgCount）
3. 首次扫描：把现有白名单群里已见过的人标 `listed`
4. 注入侧：`prompt` 里加"你认识这个人（familiar/acquaintance）+ N 条笔记"
5. 验证：同一个人改群名片 → 不新增记录；换群 → 关系还在，但群内笔记不串

---

## 六、明确不借的部分

| 不借 | 原因 |
| --- | --- |
| 623 行的完整人物库（分层记忆 + 多作用域继承） | 我们用不上那么细 |
| TOTP / 多管理员 | 单人自用 |
| 它的熟悉度公式 | 它的输入字段我们不全有，硬套会得出怪结果 |
| 独立控制台页面 | 我们控制台够用 |
