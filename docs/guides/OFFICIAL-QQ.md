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
| 接入 qq-bridge（作为第二 transport） | ⏳ 未接；设计见下一节 |
| 腾讯频道（帖子/成员）那套 skill | ✅ 已装并实测（建频道→发帖→读回），但**那是频道，不是群聊** |

> 按本仓库的规矩：**没端到端跑过的，不写"已支持"**。2026-10-28 23:5x 实测通过后，状态已改为 ✅。
> 复现命令（凭证放 `state/official.json`，跑完去群里 @ 一次）：
>
> ```powershell
> node scripts\official-probe.mjs --creds "D:\deepseek工作区\qq-bridge\state\official.json" --seconds 180
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
