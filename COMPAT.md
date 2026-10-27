# COMPAT.md · 兼容与适配手册（给 AI 与人）

> **你（AI）在别的机器上接手这个仓库时读这份。**
> 目标：让"换一台电脑 / 换一个 DSH 版本 / 换一个 OneBot 实现"能**按步骤适配**，
> 而不是靠猜着改代码。
>
> 机器可读版：[`compat.json`](compat.json)（矩阵 + 契约清单，脚本会拿它比对）。
> 人类快速上手：[README.md](README.md)；AI 入口：[AGENTS.md](AGENTS.md)。

## 一、先跑这三条，5 秒定位"环境对不对"

```bash
node --version                 # 必须 >= 22.13（内置 WebSocket 从 22 起）
node scripts/test-audit.mjs    # 39 套回归；全绿说明「代码自身」没问题
node scripts/test-portability.mjs  # 6 项：换机器会不会废
```

- 第 1 条过、第 2 条绿 → 代码没问题，去查**环境/配置**（第二节）。
- 第 2 条红 → 是代码被你改坏了，按报错修，别去动环境。

## 二、环境矩阵（不一致时的处置）

| 依赖 | 要求 | 实测过 | 不一致时的处置 |
| --- | --- | --- | --- |
| Node | `>= 22.13.0` | 24.21.0 | 低于 22 直接不跑（`globalThis.WebSocket` 不存在）；建议 22 LTS 或 24 |
| DeepSeek Harness（DSH） | `>= 0.2.0` | 0.2.1-rc.2 | 0.2.0 起 inbox 投影路径变过；0.2.1 起 system prompt 只注册 `provider`/`model` 两个变量，写 `{{cwd}}` 会 fail loud |
| SnowLuma | `>= 1.14.0` | 2.1.1 | 1.14.17 起才有 `bot_status`（账号上下线）；HTTP(3000) 与 WS(3001) 是**两个不同 token** |
| OneBot 实现 | 任意 v11 兼容 | SnowLuma / NapCat / Lagrange | 见第三节「硬契约」；动作缺失会在启动或首次调用时明确报错 |

**本项目不再依赖**：`@snowluma/sdk`、`@snowluma/mcp`（已移除）。OneBot 客户端是自带的
`src/onebot-ws.js`，只用 Node 内置 `WebSocket`。所以：

- 不需要 `postinstall` 补丁，也**不会修改任何第三方包**；
- 你想换成 `ws` 包也行，改 `src/onebot-ws.js` 的 `WebSocketCtor` 注入即可。

## 三、硬契约（只改这些是不允许的）

> 判断标准：**只要换掉它、外面的行为就变了**，那就是契约。

### 3.1 传输层

```
WS  : ws://<host>:3001/?access_token=<token>        ← 鉴权走 query，不是 header
HTTP: http://<host>:3000/<action>  Authorization: Bearer <token>

动作上行：{ action, params, echo }
响应下行：{ status: 'ok'|'failed', retcode: 0, data, echo }   ← 靠 echo 配对
事件下行：带 post_type 的帧
```

### 3.2 需要支持的动作（26 个，缺哪个就哪个功能坏）

| 分类 | 动作 |
| --- | --- |
| 基础 | `get_login_info` `get_status` `get_version_info` `get_msg` `get_image` `fetch_face_entity` |
| 发送 | `send_private_msg` `send_group_msg` `send_msg` `send_private_forward_msg` `send_group_forward_msg` |
| 群/成员 | `get_group_member_list` `get_group_member_info` |
| 互动 | `send_like` `group_poke` `send_poke` |
| 表情 | `fetch_custom_face_detail` `add_custom_face` `modify_custom_face` |
| 转发/消息 | `get_forward_msg` |
| QQ 空间 | `get_qzone_feeds` `get_qzone_msg_list` `send_qzone_msg` `like_qzone` `unlike_qzone` `comment_qzone` |

### 3.3 需要消费的事件

| post_type | 必需字段 | 用途 |
| --- | --- | --- |
| `message` / `message_sent` | `message_type`(private/group)、`user_id`、`group_id`、`raw_message`、`message`、`sender`、`self_id` | 聊天主链路；`message_sent` 是自己发的回显，也要按 message 处理 |
| `notice` + `notify` | `sub_type`（拍一拍等） | 拍一拍提醒 |
| `notice` + `bot_status` | `sub_type`(online/offline)、`user_id`（**必须是 number**） | 账号上下线判活 |
| `meta_event` + `heartbeat` | `interval` | 心跳判活（不参与业务） |
| `request` | `request_type`、`flag` | 只旁路统计，**不自动同意** |

### 3.4 角色卡契约（换机器/搬迁时最容易坏的一块）

```
roles/<任意文件名>.md
  ---
  id: xiaojingyu        ← 身份（ASCII 小写，唯一）；state 只存它
  name: 小鲸鱼（已测试）    ← 显示名，自由文本
  ---
  正文…
```

| 规则 | 原因 |
| --- | --- |
| `id` 必须 ASCII 小写、唯一 | 要能安全当状态键与文件名；中文名做 id 会在不同平台/编码下出岔子 |
| 改 `name` **不影响** `state/current-role.json` / `roles-by-key.json` | 绑定存的是 id，不是名字 |
| 改文件名**不影响**任何绑定 | id 在文件里；桥接靠索引找 `entry.file`，不靠拼路径 |
| 老卡（无 front matter）用文件名哈希当 id | 保证同一份文件在任何机器上得到同一个 id |
| 元数据不得出现在注入文本里 | `selectRoleText` / `parseRoleSections` 统一剥 front matter |

迁移工具：`node scripts/migrate-roles-to-ids.mjs`（`--dry-run` 默认；`--apply` 真写）。
回归：`scripts/test-role-id.mjs`（9 项，含「改文件名 id 不变」）。

### 3.5 启动方式（Windows 一键 / Linux systemd）

| 平台 | 入口 | 说明 |
| --- | --- | --- |
| Windows | `.\start-bridge.ps1` | 起守护 → 起桥接；崩溃自动拉起、单实例、退避重启。启动器**不代启 SnowLuma**（只探测 `:3000/:3001`）。契约见 [docs/guides/LAUNCHER.md](docs/guides/LAUNCHER.md) |
| Linux | `deploy/install-server.sh` + systemd | `systemctl start qq-bridge`；unit 见 `deploy/qq-bridge.service` |

不要绕过入口直接长跑 `node src\bridge.js`：那样没有单实例保护、崩了没人拉起。
退出码契约（0/1/2/3/4/5）在 LAUNCHER.md，改启动逻辑必须同步更新那张表。

### 3.6 配置键（换 DSH/换机器要重配的）

`compat.json` 的 `contracts.configKeys` 有完整清单。最常需要改的四个：

```jsonc
{
  "dsh": { "baseUrl": "http://127.0.0.1:<实际端口>" },   // DSH 端口每次重启可能变
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "<token>" },
  "paths": { "tools": "<放外部脚本的目录>" },              // 语音/点歌脚本；为空则用 <项目>/tools
  "allow": { "groups": [], "private": [<你的QQ>] }        // 白名单；空 = 只放行 ownerQQ
}
```

## 四、适配步骤（照着做，别自由发挥）

```
1. 跑第一节的三条命令，确认「代码自身是好的」
2. 对照 compat.json：
     · Node / DSH / SnowLuma 在主版本区间内？不在 → 看第二节处置
     · OneBot 实现是否支持 3.2 的动作？缺 → 只改「适配层」，不要改业务
3. 只允许改这些地方（适配层）：
     · src/onebot-ws.js        ← 换传输实现（WebSocket → ws 包、HTTP 轮询等）
     · src/dsh-client.js       ← 换 DSH 版本的 API 差异
     · config.json             ← 端口/路径/白名单
   不允许改：路由语义、发送额度与回滚、唤醒状态机、协议细节（echo/事件分发）
4. 改完必须跑：node scripts/test-audit.mjs（39）→ 必须全绿
5. 再跑 node scripts/test-onebot-ws.mjs（18）→ 覆盖 echo 配对/事件分发/重连
6. 最后人工抽测：发一条、收一条、表情、拍一拍（见 MIGRATION.md 第五节）
```

## 五、失败特征表（症状 → 根因）

| 症状 | 最可能根因 | 怎么确认 / 怎么修 |
| --- | --- | --- |
| 启动即退，日志 `globalThis.WebSocket is not defined` | Node < 22 | 升到 22.13+ |
| `/api/status` 的 `dshReady=false`，日志「连不上 DSH」 | `dsh.baseUrl` 端口变了 | 看日志里打印的 URL 与错误；改成实际端口 |
| DSH 401 / 「铸造 cookie 失败」 | 读不到 `$DSH_HOME/.credentials.yaml` | Linux 降权用户要按 SERVER.md 给 ACL；或填 `dsh.authToken` |
| `snowluma.connected=false` 但 curl 3000 通 | WS token 与 HTTP token 不是同一个 | 让桥接自愈（首次 1006 后会自动刷新）；或手动更新 `snowluma.accessToken` |
| 收不到消息但连接正常 | 上游只接了 HTTP，没订阅事件 / 白名单过滤 | 看 `onEvent` 旁路统计（日志会打 `lastPacketKind`） |
| 首次引导给的默认人设是「傲娇助手」 | 角色卡名带后缀导致精确匹配失败（已修） | 确认 `role.defaultName` 是稳定名、且 `resolveRoleName` 生效 |
| `say`/`sing`/`song` 报「依赖 Windows PowerShell」 | 非 Windows 平台 | 设 `QQBOT_SAY_SCRIPT` 等指向平台脚本；或用自带 TTS |
| 换机器后反复「会话不存在」 | `state/sessions.json` 带着旧 sessionId | 清空 `state/sessions.json`（见 MIGRATION.md） |
| 备份解不开 | DPAPI 绑定用户+机器 | 跨机改用 7-Zip 密码归档（MIGRATION.md） |

## 六、你（AI）不该做的事

1. **不要为了让某台机器跑起来去改业务语义**（额度、唤醒、白名单、脱敏）。这些是多机一致的护栏，改一处就会在别的机器上行为不同。
2. **不要重新引入 `@snowluma/*` 依赖** —— 移除它们是为了让「不依赖、不修改、不分发」成立（见 [`docs/design/decisions/0002`](docs/design/decisions/0002-drop-snowluma-npm-deps.md)）。测试 `test-compat.mjs` 会拦。
3. **不要把机器相关的值写进代码或示例配置**：`test-portability.mjs` 会拦盘符、本机端口、真实 QQ 号。
4. **不要在 `LICENSE` 里追加说明**：GitHub 会因此判成 `NOASSERTION`（说明放 `NOTICE.md`）。
5. **不要跳过审计**：39 套里有一半是"只在特定条件下才炸"的回归（额度回滚、租约、BOM、归属完整性）。

## 七、把这份手册变得更准

`compat.json` 的 `contracts` 是**契约的唯一来源**。你发现某台机器需要额外契约（比如某实现要求 `send_msg` 带 `message_type`），做法是：

1. 先改 `compat.json`（加动作/字段/环境差异）
2. 再改代码适配
3. 跑 `node scripts/test-compat.mjs` —— 它会检查「文档里写的动作，代码里真的用到了；代码里用到的动作，文档里也写了」

这样下一个人接手时，看到的永远是**当下真实**的契约。
