# QQ 官方机器人通道（q.qq.com · QQ Bot）

> 这份文档回答三件事：**官方通道能给什么**、**和 SnowLuma 那条腿怎么并存**、**现在接好到哪一步**。
> 相关：[VIDEO-SOURCES.md](VIDEO-SOURCES.md)（视频来源策略）、[FRESH-INSTALL.md](FRESH-INSTALL.md)（安装）、
> [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)（报错排查）。

---

## 一、两条腿，别搞混

| | **个人号通道（SnowLuma / OneBot v11）** | **官方通道（q.qq.com · QQ Bot）** |
| --- | --- | --- |
| 身份 | 你自己的 QQ 号（扫码登录） | 独立的机器人号（如 `1906089685`，有自己的 QQ 号） |
| 登录方式 | 扫码 / 密码，有掉线与风控 | AppID + AppSecret → access_token，**不封个人号** |
| 能读到什么 | **群里所有消息**（全量） | 默认只有被 @ 的；群主可开「接收全量消息」 |
| 回复限制 | 无（可分条、可沉默、可撤回、拍一拍） | 被动回复 **5 分钟 / 每条消息最多 5 次**；主动消息有频控 |
| 媒体 | 图片/语音/表情包/合并转发都行 | 文本/Markdown/富媒体（图片/语音/文件，需**先上传**）；单聊与群聊上传接口不互通 |
| 适合 | 拟人聊天、潜水接话、斗图、点歌 | 合规兜底、私聊问答、定时推送 |

> **结论**：官方通道不会取代 SnowLuma。它们的价值互补——官方通道「稳、合规、不会封你号」，个人号通道「像人、能看见全部消息」。

## 二、官方通道的前置条件（缺一个都进不去群）

| 条件 | 说明 |
| --- | --- |
| 主体 | **个人主体不支持公开使用**；但**你自己是群主/管理员的群可以加**（用最新版手机 QQ 添加）。企业主体才能公开给别人的群用 |
| 加群 | 手机 QQ → 群设置 → 群机器人 → 添加 → 搜机器人 QQ 号 |
| 权限项 | 加群时会弹「设置权限」：① 接收群内全部消息 ② 主动推送消息 ③ 撤回成员消息（设为管理员） |
| 凭证 | `q.qq.com` → 机器人 → 开发 → 开发设置 → **AppID + AppSecret** |

## 三、协议要点（实现时踩准这几条）

```
POST https://bots.qq.com/app/getAppAccessToken   {appId, clientSecret} → {access_token, expires_in}
GET  {api}/gateway                                Authorization: QQBot <access_token> → {url(wss)}
WS   op10 HELLO(heartbeat_interval) → op2 IDENTIFY{token:"QQBot <at>", intents, shard}
     intents: GROUP_AND_C2C_EVENT = 1 << 25
     op0 DISPATCH{t,s,d} → READY / GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE / C2C_MESSAGE_CREATE
     断线用 op6 RESUME{session_id, seq}；心跳 op1{d:seq}，服务端 ack op11
发送  POST {api}/v2/groups/{group_openid}/messages   {content, msg_type:0, msg_id?, msg_seq?}
     POST {api}/v2/users/{user_openid}/messages
```

三条最容易踩的约定：

1. **`openid` 不是 QQ 号**：`group_openid` / `member_openid` 都是不透明字符串，**不能与 OneBot 的 `group_id`（纯数字）混用同一个 key**。
2. **被动回复必须带 `msg_id`**，同一条消息最多 5 次，用 `msg_seq` 递增；超了就别硬发，合并成一条。
3. **消息里的 @ 会被渲染成 `<@!123>` 占位符**，进模型前必须清掉（`stripMention()`）。

## 四、代码在哪

| 文件 | 作用 |
| --- | --- |
| `src/qqbot-official.js` | 官方客户端：token 缓存、gateway、WebSocket（心跳/重连/RESUME）、事件翻译、`reply()` 自动分配 `msg_seq` |
| `scripts/official-probe.mjs` | **端到端验证**：票据 → gateway → 收事件 → 回复一条；`--send-test` 还能测主动消息 |
| `scripts/test-official-client.mjs` | 11 项离线契约测试（文本清洗 / 事件翻译 / seq 上限 / 路由） |

打开官方通道：

```powershell
# 1) 凭证放 state/（已 gitignore，不会进仓库）
#    state\official.json : { "appid": "102xxx", "secret": "xxx", "sandbox": false }
# 2) 先跑验证：去群里 @ 机器人一次，看能不能收到+回复
node scripts\official-probe.mjs --seconds 120
```

## 五、现在的状态（诚实版）

| 项 | 状态 |
| --- | --- |
| 协议实现（token / gateway / WS / 事件 / 回复） | ✅ 已完成，**11 项离线测试通过** |
| **端到端实测（真机器人 + 真群）** | ✅ **2026-10-28 已通过**：`access_token` ✓ → gateway `wss://api.sgroup.qq.com/websocket` ✓ → WS 鉴权 `机器人1906089685` ✓ → 收到群 @ 事件（作者「居居」，内容「测试」）✓ → **被动回复成功（msg_id 链路通）** ✓ |
| 接入 qq-bridge（作为第二 transport） | ✅ 已接入：官方事件走同一个 `handleIncoming`，人格/记忆/工具共用；发送按 `official-` 前缀分流 |
| **会话内工具可用**（模型自己调 `qq_send_message`） | ✅ 2026-10-29 打通（前提：DSH 的 MCP 注入未被关掉，见 TROUBLESHOOTING S2） |
| 腾讯频道（帖子/成员）那套 skill | ✅ 已装并实测（建频道→发帖→读回），但**那是频道，不是群聊** |

> 按本仓库的规矩：**没端到端跑过的，不写"已支持"**。2026-10-28 23:5x 实测通过后，状态已改为 ✅。
> 复现命令（凭证放 `state/official.json`，跑完去群里 @ 一次）：
>
> ```powershell
> node scripts\official-probe.mjs --creds "D:\qq-bridge\state\official.json" --seconds 180
> ```
>
> 成功的样子：
>
> ```
> [official] WebSocket 已连接
> [official] 鉴权成功：机器人1906089685
> · [群@] id=7132C…8B3（长 32） 作者=居居 内容「测试」
>   ✓ 被动回复成功（msg_id 链路通）
> ```

## 六、接进 qq-bridge 的设计（下一步）

```
官方事件 ──► toBridgeEvent() ──► key = official:group:<group_openid> / official:private:<openid>
                                     │
                                     ├─► 复用现有：人格卡 / 记忆 / 工具 / 白名单 / 额度
                                     └─► 发送侧按 key 前缀路由：
                                         official:*  → OfficialQqBot.reply()
                                         其它        → OneBot HTTP（现状）
```

三处要改的地方（都是**单一入口**，不散落）：

| 位置 | 改法 |
| --- | --- |
| 事件注入 | 桥接启动时若 `official.enabled`，连 gateway，把事件翻成 OneBot 形状（`group_id` 用 openid、`message_id` 用官方 `id`）后走**同一个**入站处理函数 |
| 发送路由 | 三处 `send_group_msg` / `send_private_msg` 前加一个 `transportOf(key)` 判断；官方 key 就走 `OfficialQqBot.reply()` |
| 权限 | `allow.groups` 只认数字 QQ 号；官方通道单独用 `allow.officialGroups`（openid 白名单），默认空 = 全拒 |

**已知会退化的能力**（接之前先说清）：分条拟人（官方最多 5 条/消息）、拍一拍（无接口）、表情包库（只能当富媒体发）、
"潜水接话"（除非群主开了全量消息）。

## 七、给接手的 AI

```
1. 官方通道 ≠ SnowLuma，两套协议；openid ≠ QQ 号，key 必须带前缀
2. 回复必须带 msg_id（被动），同一 msg_id 最多 5 次 → 用 ReplySeqTracker
3. 消息里的 <@!id> 要清掉再进模型
4. 说"官方可用"之前，先跑 scripts\official-probe.mjs 拿到「收到 + 回复成功」两条证据
5. 频道能力（tencent-channel-cli）是另一套东西，别混进来
```

## 八、主动消息（A 手动 / B 定时）

> 主动消息 = **不带 `msg_id`** 发送。它不是"偷偷多一条"，而是有明确三道闸的功能。

### 8.1 三道闸（缺一条都发不出去）

| 闸 | 内容 | 怎么解 |
| --- | --- | --- |
| **群权限** | 群主在加机器人时要勾选「主动推送消息」；**个人主体只能给自己建的群开** | 群主在群机器人设置里打开；别人的群你开不了 |
| **用户开关** | 对方可在 QQ 客户端关闭「允许主动发送」→ 一律失败 | 无解，只能等他先说话 |
| **频控** | 群 30/分（未认证）或 60/分、单聊 10/分；单关系 20/分；**1000 条/群/天、1000 条/用户/天** | 代码里已用 `QuotaBook` 兜住，超了直接拒绝而不是硬撞 |

### 8.2 A：手动发一条

```powershell
curl -X POST http://127.0.0.1:3100/api/socialV2/official-say ^
  -H "X-Console-Token: <state/console-token>" -H "content-type: application/json" ^
  -d "{\"key\":\"group:official-7132C6...\",\"text\":\"今晚八点开黑，来不来\"}"
```

- 走 `/api/socialV2/` 前缀 → 自动继承控制台令牌校验、暂停/只读降级
- 先过白名单（`official.allow`）→ 再过配额 → 才发送
- 失败会返回人话：群权限没开 / 对方关了开关 / 触发频控（`explainProactiveError`）

查看状态：`GET /api/socialV2/official-proactive` → 配额用量 + 定时任务列表。

### 8.3 B：定时播报

`config.json`：

```jsonc
{
  "official": {
    "proactive": {
      "enabled": true,
      "schedules": [
        { "key": "group:official-7132...", "cron": "0 9 * * *", "text": "早上好，今天也要摸鱼", "enabled": true },
        { "key": "private:official-<openid>", "cron": "30 22 * * 5", "text": "周五了，作业交了没", "enabled": true }
      ]
    }
  }
}
```

- 5 段 cron（分 时 日 月 周），支持 `*`、`,`、`-`、`/`
- **同一分钟只跑一次**（`lastRunStamp` 去重），tick 20 秒
- 发送失败也会记一次，避免同一分钟疯狂重试把配额烧光

### 8.4 私聊主动（朋友那种）

单聊主动消息是**官方允许**的（不需要群权限），但：

| 项 | 值 |
| --- | --- |
| 频控 | 10/分（Bot 维度）、20/分（单关系）、**1000 条/用户/天** |
| 用户可关 | 是。对方关了「允许主动发送」就发不出去 |
| 更"礼貌"的做法 | 官方提供 **互动召回消息**（`is_wakeup=true`）：对方聊过之后，30 天内 4 个周期各 1 条，专门用来"叫他回来"，比普通主动消息更不容易被判骚扰 |

> 建议：朋友加你之后，第一次由他先说话；后面用**低频**主动（每天 ≤1 条）而不是定时轰炸。

### 8.5 去"无权限的群"会怎样

| 场景 | 结果 |
| --- | --- |
| 你群主/管理员 + 开了主动推送 | 正常发 |
| 你是普通成员，群主没开主动推送 | 接口报错 → 代码翻译成「请让群主在群机器人设置里打开」 |
| 机器人没被加进那个群 | 连 `group_openid` 都拿不到，发不了 |
| 别人群里的**被动回复** | 不受影响（被 @ 时才回，属于被动，不需要主动权限） |

所以：**官方通道在别人群里只能"被叫才说话"**；想主动插话，得群主开权限，或者回到 SnowLuma 那条腿。

#### 意向分两级（决定"开窗"还是"可以主动发"）

| tier | 触发例子 | 行为 |
| --- | --- | --- |
| **soft** | 晚安，明天见 / 我先睡了，明天聊 | **只开召回窗口，不主动发** —— 等真有下文再说 |
| **firm** | 明天聊那个事 / 约好明天聊 / 希望以后都陪着我 / 记得找我 | 开窗，且后续允许用召回真正找他 |

判定顺序：先看"告别语 + 下次语 + 无具体约定"→ soft；否则走四类规则。
`RecallWindow.arm()` 会把 tier 记进 `armedTier`，状态端点可查。
