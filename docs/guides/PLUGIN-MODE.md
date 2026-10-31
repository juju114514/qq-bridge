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

### 怎么切（一键）

```powershell
node scripts/switch-mode.mjs status   # 看现在谁在收
node scripts/switch-mode.mjs bridge   # 路线 A：常驻 bridge
node scripts/switch-mode.mjs plugin   # 路线 B：DSH 插件
```

Windows 上也可以直接双击仓库根的两个 bat：

```
切换-桥接模式.bat
切换-插件模式.bat
```

脚本改两个文件：

| 文件 | 字段 | 路线 A | 路线 B |
| --- | --- | --- | --- |
| `config.json` | `channel.enabled` | `true` | `false` |
| `<DSH profile>/cordis.patch.yml` 的 `qq-bridge` 条目 | `enabled` | `false` | `true` |

**然后按它打印的顺序重启**（顺序错了要么空窗、要么两边各回一条）：

- 切到 A：先**重启 DSH**（插件释放通道）→ 再重启 bridge
- 切到 B：先**重启 bridge**（让出通道）→ 再重启 DSH

## 二、安装（三种方式，任选）

### 方式 A：本地路径（最稳，推荐）

先 `git clone` / `git pull` 到本地，然后「添加插件」里填**目录**：

```
<你的仓库路径>\plugin
```

### 方式 B：GitHub 子目录（验证可用，0.4.4+）

```
github:juju114514/qq-bridge#main&path:/plugin
```

- 插件已**自包含**（`plugin/vendor/` 里带了 `onebot-ws` 与通道闸），装下来就能跑
- 前提：仓库根的 `postinstall` 已移除（0.4.4 起）——它会让 pnpm 报
  `ERR_PNPM_IGNORED_BUILDS`，装不上

### 方式 C：等 npm 发布（还没做）

插件是 `private: true`、没发到 npm，**填包名会 404**。

> ⚠️ 直接填仓库**根地址**（不带 `&path:/plugin`）不行：根目录是桥接应用本身，
> 不是 DSH 插件（没有 `dsh.bundle`），只会被装成普通依赖。

## 二·六、安装（临时验证必须用独立 DSH_HOME）

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
  "sidecarToken": "",                    // 空 = 自动读 <stateDir>/console-token（推荐留空）
  "accessToken": "…",                    // ⚠️ SnowLuma 的 **WS** token（不是 HTTP 那个）
  "stateDir": "<sidecar 的 state 目录>",  // ⚠️ 必须和 sidecar 同一个，否则通道互斥失效
  "requireMention": true,
  "allowGroups": [123456789]             // 空白名单 = 谁都不回
}
```

## 四、能用到什么

| 工具 | 作用 | 依赖 |
| --- | --- | --- |
| `qqb_send_message` | 发纯文本 | 通道 |
| `qqb_reply` | 引用某条回复 | 通道 |
| `qqb_get_recent_messages` | 最近聊天记录（含自己） | 通道 |
| `qqb_get_unread_messages` | 上次已读之后的新消息 | 通道 |
| `qqb_wait_for_messages` | 等新消息（1~60s） | 通道 |
| `qqb_get_prompt` | 人格卡 / 人物印象 / 群记忆交接 | **sidecar** |
| `qqb_mark_read` | 已读水位（内存 + sidecar） | **sidecar** |
| `qqb_ping` | 自检 | 无 |

## 四·五、三个真机才会暴露的必需项

| 项 | 为什么 |
| --- | --- |
| `accessToken` = SnowLuma 的 **WS** token | 空着能连上 TCP，但网关会立刻断开（`OneBot 错误：` 后面是空的，很难看出是 token 问题） |
| `stateDir` 指向 **sidecar 的 state/** | 通道认领文件写在这里才和 sidecar 互斥；写错地方 = 互斥形同虚设 |
| 插件 `inject` 必须含 `agents` | 宿主只把声明过的服务放进 `ctx`，没声明时访问 `ctx.agents` 会抛 `cannot get property "agents" without inject` |

还有一个坑：**杀掉插件实例后 60 秒内重启会被拒**（心跳 TTL）。
日志会写「通道被占用：plugin（pid …）」。确认那个 pid 已经不在了，删掉
`state/channel-mode.json` 即可（等价于等它过期）。

## 五、降级语义（必须知道）

sidecar 没开时：

| 能力 | 状态 |
| --- | --- |
| 收发消息 / 消息类工具 | ✅ 正常 |
| 人格卡 / 群记忆 / 人物印象（`qqb_get_prompt`） | ❌ 返回 `degraded:true` |
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

## 六·五、换 token / 换号之后

SnowLuma 的 **HTTP token 与 WS token 是两个不同的值**，重新扫码后会一起变。
插件只认 WS 那个，桥接的 HTTP 调用认另一个 —— 手改很容易搞反。用脚本：

```powershell
node scripts/sync-snowluma-token.mjs --dry    # 先看会改什么
node scripts/sync-snowluma-token.mjs          # 真改
```

它会同时更新两处：

| 位置 | 字段 | 用哪个 token |
| --- | --- | --- |
| `config.json` | `snowluma.accessToken` | **HTTP**（桥接的 API 调用） |
| `<DSH profile>/cordis.patch.yml` 里 `qq-bridge` 条目 | `accessToken` | **WS**（插件连 3001） |

改完**重启 DSH**（插件在启动时加载）。多账号时用 `config.json` 的 `selfQQ` 固定用哪个。

## 六·九、真机踩坑清单（2026-10-31 一次性踩完）

插件模式从"能装"到"能在群里说话"，在 **Windows + dsh 0.2.1-rc.5** 上共踩了 10 个坑。
全部是**静默失败**：不报错、不崩溃，只是不动。按链路顺序排列，症状 → 修法：

| 环节 | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 工具注册 | 每轮 `Invalid schema for function …: got 'type': null` | `ctx.tools.register()` **不编译** parameters，编译在 `defineTool()` 里 | 注册前 `defineTool(tool)` 包一层 |
| sidecar 鉴权 | 读快照全 401 | `sidecarToken` 空 → 不带 Authorization（`/health` 免鉴权所以"看着是好的"） | 自动读 `<stateDir>/console-token` |
| 通道独占 | 一条群消息被回两次 | `channel.enabled=false` 时仍建了 WS 连接 | 让出通道时 `reconnect=false` + `connect=async()=>{}` + `close()` |
| @ 判定 | 群里 @ 它完全没反应 | 事件里**没有 `self_id`**，`mentionsSelf` 恒 false | 连上后 `get_login_info` 拿自己的号并缓存 |
| 通道认领 | 重启 DSH 后不连 QQ | 旧实例的认领还在 60s 心跳窗口内，新实例被判"被占用" | 认领失败时用 `process.kill(pid,0)` 探测存活，死了直接接管 |
| 发送动作 | `client.action is not a function` | `OneBotWsClient` 的方法叫 `call()` | 改 `client.call(action, params)` |
| 投递 | 会话建了、消息没进去、不报错 | 新建 agent 的 `whenIdle()` 可能永不 resolve | `Promise.race(whenIdle(), 1.5s)` |
| Agent 启动 | 有入队、无任何 turn 事件 | `agents.create` 没给模型（`agentOptions:{}` + 无 `setup`） | 取 `ctx.get('agentDefaultModel').currentSelection()`，传 `{provider, model}` + `installModelSelection` |
| Agent 启动 | 同上 | `meta` 没带 `cwd`（宿主建 agent 必带） | `cwd = state/agents/<key>`，先 `mkdir -p` |
| **Windows 路径** | `mkdir …\stategents\group:994920175: ENOENT` | **Windows 文件名不允许 `:`** | 目录名把 `:` 换成 `_` |
| 回复转发 | 模型明明回答了，QQ 里没有 | 会话 id 撞车时 driver 用 fallback id（`…#xxxx`），监听却按原始 id 匹配 | 用 `deliver()` 返回的**真实** sessionId 建映射 |
| 只 @ 不带字 | `入站丢弃（empty）` | 用户发 `@小鲸鱼 `（只有 @）被判空文本丢掉 | 群消息且 @ 了自己 → 当成一次"戳"，给占位文本 |

### 观测：插件日志

插件跑在 DSH 进程里，**桌面版的 stdout 看不到**。0.4.15 起每条日志同时写：

```
<stateDir>/plugin.log     # 超过 512KB 自动轮转成 plugin.log.1
```

排障时先看它，能直接定位到上面哪一环：

```
入站投递 group:… uid=…          → @ 判定通过
会话映射建立 session=… → group:…
agent 初始：status=running seq=6
助手回复 → group:…（N 字，转纯文本 M 字）
发送成功 group:… message_id=…
```

### 插件模式下别让模型用 `qq_*` MCP 工具

插件会**自动转发** assistant 的文本到 QQ，模型不需要再调发送工具。
真机上它先试了 `qqb_send_message`（报「通道未启动」），再绕 30+ 步才回到文本回复——白烧 token。

插件已在 agent 创建时 `tools.restrict({ deny: [...] })` 禁掉：

```
qqb_send_message / qqb_reply / qq_send_message / qq_reply
qq_send_group_message / qq_send_private_message / qq_send_burst
```

如果你的 DSH 里同时挂着 `mcp-snowluma`，建议在插件模式下**把它的 qq 工具关掉**（控制台面板有开关）：
既能省掉 45 个工具描述的上下文，也不会让模型走错路。

## 七、排障

| 现象 | 先查 |
| --- | --- |
| 装完没反应 | `--dump-config` 里有没有 `id: qq-bridge`；有没有加进 `dsh.profile.bundles` |
| 日志说 `sidecar 未连接` | sidecar 的 `consolePort` 端口对不对；`sidecarToken` 与 `state/console-token` 是否一致 |
| 群里没回复 | `allowGroups` 有没有这个群；`requireMention` 下有没有 @ |
| 两个通道打架 | 看 `state/channel-mode.json` 的持有者 |