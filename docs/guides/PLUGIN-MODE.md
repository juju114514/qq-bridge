# 插件模式（PLUGIN-MODE）使用说明

> 形态：把 QQ 通道装进 DSH（`plugin add`），消息通路跟宿主同生命周期；
> 记忆 / 记账 / 控制台 / 定时器留在常驻的 sidecar（`bridge.js`）。
>
> 设计依据：[docs/design/plugin-mode-2026-10-31.md](../design/plugin-mode-2026-10-31.md)；
> 真机踩过的坑：[docs/design/dsh-plugin-api-notes.md](../design/dsh-plugin-api-notes.md)。

## 一、两条路怎么选

| | bridge 模式（默认） | plugin 模式 |
| --- | --- | --- |
| 跑在哪 | 独立进程（`start.bat`） | DSH 进程内 |
| 要额外守护吗 | 要（`start.bat` 自带重启） | 不要 |
| 主动消息 / 定时提醒 | ✅ | ⚠️ 需要 sidecar 在跑 |
| 控制台 | ✅ | ⚠️ 需要 sidecar 在跑 |
| 工具 | MCP（`qq_*`，另一个进程） | 进程内（少一跳） |
| 适合谁 | 长期 24/7 挂机 | 已经在用 DSH 的人 |

**两者互斥**：同一份 `state/` 只允许一个东西收 QQ 消息（见 `state/channel-mode.json`）。

## 二、安装（临时验证必须用独立 DSH_HOME）

```powershell
# 1) 隔离环境（千万别装在真实 ~/.dsh 里，会和桌面版抢状态文件）
$env:DSH_HOME = '<临时目录>\dsh-home'

# 2) 装 CLI（一次性）
pnpm add @deepseek-ai/dsh@<与桌面版一致的版本>

# 3) 把插件装进临时 profile
node <dsh-cli>\lib\bin.js --from-default-profile web --profile qqtest --dump-config
node <dsh-cli>\lib\bin.js plugin --profile qqtest add <repo>\plugin

# 4) 把包名加进 profile 的 dsh.profile.bundles（`plugin add` 不会自动加）
#    "@juju114514/qq-bridge-plugin"

# 5) 确认组合结果里有它
node <dsh-cli>\lib\bin.js --profile qqtest --dump-config | Select-String 'qq-bridge'
```

## 二·五、让 sidecar 把通道让出来（必做）

插件和常驻 bridge **只能有一个收消息**（`state/channel-mode.json` 里的认领）。
所以正式用插件模式时，sidecar 要以 **sidecar-only** 姿态启动：

```jsonc
// sidecar 机器上的 config.json
{
  "channel": { "enabled": false }   // ← 只提供控制台 / 契约 / 定时器，不连网关、不占通道
}
```

启动日志应该看到：

```
[bridge] sidecar-only 模式（channel.enabled=false）：不连接 QQ 网关，也不占用通道认领
```

此时 `state/channel-mode.json` **不存在**，插件才能拿到通道（`claim(plugin) → ok=true`）。

> 反过来：想切回 bridge 模式，就把 `channel.enabled` 改回 `true`（或删掉这一行）并重启。

## 三、配置

```jsonc
// DSH profile 的 cordis.patch.yml 里给 qq-bridge 的 config
{
  "enabled": true,                       // 默认 false：装上不等于连 QQ
  "onebotUrl": "ws://127.0.0.1:3001",    // SnowLuma / NapCat 的 WS
  "accessToken": "",
  "sidecarUrl": "http://127.0.0.1:3100", // 常驻 bridge 的控制台地址
  "sidecarToken": "",                    // 空 = 用 sidecar 的 state/console-token
  "requireMention": true,
  "allowGroups": [123456789]             // 空白名单 = 谁都不回
}
```

## 四、能用到什么

| 工具 | 作用 | 依赖 |
| --- | --- | --- |
| `qq_send_message` | 发纯文本 | 通道 |
| `qq_reply` | 引用某条回复 | 通道 |
| `qq_get_recent_messages` | 最近聊天记录（含自己） | 通道 |
| `qq_get_unread_messages` | 上次已读之后的新消息 | 通道 |
| `qq_wait_for_messages` | 等新消息（1~60s） | 通道 |
| `qq_get_prompt` | 人格卡 / 人物印象 / 群记忆交接 | **sidecar** |
| `qq_mark_read` | 已读水位（内存 + sidecar） | **sidecar** |
| `qq_ping` | 自检 | 无 |

## 五、降级语义（必须知道）

sidecar 没开时：

| 能力 | 状态 |
| --- | --- |
| 收发消息 / 消息类工具 | ✅ 正常 |
| 人格卡 / 群记忆 / 人物印象（`qq_get_prompt`） | ❌ 返回 `degraded:true` |
| 已读水位持久化 | ⚠️ 只记内存，重启丢 |
| 主动消息 / 定时提醒 / 控制台 | ❌ 不可用 |

启动日志会直接说：

```
[qq-plugin] sidecar 未连接（http://127.0.0.1:3100）：主动消息、记忆写入、记账、控制台均不可用（被动回复正常）
```

## 六、怎么切回 bridge 模式

1. 把插件配置里的 `enabled` 改成 `false`（或从 profile 的 bundles 里移除）
2. 重启 DSH
3. `start.bat` 启动 bridge —— 它会重新认领通道

如果 bridge 启动时报「通道被占用」，说明插件还持有认领（心跳 60s 内），等一分钟或确认插件已停。

## 七、排障

| 现象 | 先查 |
| --- | --- |
| 装完没反应 | `--dump-config` 里有没有 `id: qq-bridge`；有没有加进 `dsh.profile.bundles` |
| 日志说 `sidecar 未连接` | sidecar 的 `consolePort` 端口对不对；`sidecarToken` 与 `state/console-token` 是否一致 |
| 群里没回复 | `allowGroups` 有没有这个群；`requireMention` 下有没有 @ |
| 两个通道打架 | 看 `state/channel-mode.json` 的持有者 |