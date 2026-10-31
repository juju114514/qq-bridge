# 更新日志

只记**用户能感知的变化**与**踩过的坑**。按日期倒序。

## 2026-10-31 — 0.4.26：清理 preset 的旧 deny 名单（纯日志噪音）

> 小更新。0.4.21 之后白名单已经接管，旧黑名单只剩噪音。

### 之前

每次建 agent 都会先跑一遍 78 个必然失败的 `restrict({deny})`：

```
[qq-tool-restrict] restrict 失败 78/82：unknown global tool "pwsh"; known global tools: desktop_control, …
（3 秒后再重试一遍，再失败 77 个）
allow-restrict ok 保留=4/10：…
```

日志被两屏噪音盖住，真正的结论（保留了几个）反而看不见。

### 现在

顺序改成 **先白名单，失败才退回黑名单**：

```js
let allowApplied = false
try { ctx.tools.restrict({ allow: keep }); allowApplied = true } catch {}
if (!allowApplied) { /* 历史 deny 名单 + 3s 重试，作为兜底 */ }
ctx.tools.guard(...)      // 执行期白名单，始终生效
```

效果：正常路径只打一行 `allow-restrict ok 保留=N/M`；拿不到工具清单时才回退老逻辑。

### 验证（mock ctx）

```
allow 调用: 1  deny 调用: 0  guard: 1
保留: mcp__snowluma__qq_ping, todo_write
```
## 2026-10-31 — 0.4.25：self-test 连不上时给可操作提示

> 小更新。来自干净环境实测：只有 `fetch failed` 三个字，什么也说明不了。

### 之前

```
❌ 自测失败: fetch failed
```

### 现在

```
❌ 连不上 DSH：http://127.0.0.1:3999
   可能是：① DSH 没在跑  ② 端口变了（DSH 每次启动可能换端口）
   排查：
     · 看 config.json 的 dsh.baseUrl 是不是当前端口
     · 或直接指定：node src/self-test.js http://127.0.0.1:<端口>
     · 桥接在跑的话，它启动时会自动探测并写回正确端口
```

- 端口优先级：命令行参数 → `config.json` 的 `dsh.baseUrl` → 旧默认 3080
- 401 单独识别：提示检查 `dsh.authToken` 或跑 `setup-dsh.mjs`
- 其他错误仍然抛出（不掩盖真 bug）

### 实测

| 场景 | 结果 |
| --- | --- |
| 死端口 3999 | 给出上面的排查清单，exit 1 |
| 真机端口 63262 | `🎉 自测通过 —— DSH 侧链路可用`，agent 回复「收到」 |
## 2026-10-31 — 0.4.24：干净/脏环境实测发现的两个问题

> 小更新。用「全新克隆」和「现有部署」各跑了一遍，抓出两个只有真实环境才暴露的问题。

### 干净环境（git clone + pnpm install）

| 发现 | 处置 |
| --- | --- |
| `pnpm install` 会生成 `pnpm-lock.yaml`，而 packaging 守卫硬性要求"只能有一个锁文件" → **全新克隆直接红** | 守卫改成"必须有 package-lock.json，额外的 pnpm 锁只提示"；`.gitignore` 加 `pnpm-lock.yaml` |
| 全新 state 起服正常；DSH 端口自动漂移（3080 → 63262）也自动修好了 | 无需改动 |
| `self-test.js` 在桥接没跑时只报 `fetch failed` | 记入待办（提示可更友好） |

### 脏环境（现有部署重启）

| 发现 | 处置 |
| --- | --- |
| **僵尸认领**：旧进程被杀了，认领文件还在 60s 心跳窗口内 → 新 bridge 判"被另一个 bridge 占着" → **不连 QQ**，日志只有一行 warning | 桥接侧补上「按 pid 存活性接管」（插件侧早就有） |
| 快照一度报 2 处差异 | 是认领冲突导致 API 返回不完整；修好后 `行为一致 ✓` |

### 测试

`test-channel-mode-store.mjs`：「被占用」用真实存活 pid（`process.pid`）+
新增「死持有者接管」用例。9/9 通过。
## 2026-10-31 — 0.4.23：一天的工作纪要

> 纯文档版本。

新增 [docs/reports/2026-10-31-session.md](docs/reports/2026-10-31-session.md)：

- **11 个静默失败**的完整清单（症状 → 根因）
- **越权事故**的经过、后果、根因、处置（4 个版本的加固）
- **凭据轮换**记录（GitHub / TLS / console-token / SnowLuma）
- 两条路的切换方式、排障入口、遗留待办

一句话总结：**插件模式从设计推到群里能回话，代价是踩完 11 个静默坑 + 一次越权事故。**## 2026-10-31 — 0.4.22：`sync-snowluma-token` 的 token 语义修正

> 小更新。轮换 SnowLuma token 时发现的真机结论。

### 结论

`config.json` 里两个字段各管一条链路，**写反了不会报错，但会"连上却发不出消息"**：

| 字段 | 用途 |
| --- | --- |
| `snowluma.accessToken` | **WS 连接**（3001）——动作也走这条 |
| `snowluma.httpToken` | HTTP 调用（3000，发语音/取图/查状态） |

之前脚本把 HTTP token 写进了 `accessToken`，实测后果：

```
3001 连上了，但 send_group_msg 一律返回 unauthorized
```

### 修法

脚本拆成两处分别写，并新增 `snowluma.httpToken`。

### 附带

轮换流程也验证了一遍：改 SnowLuma 的 `config/onebot_<QQ>.json` 里两个 token → watchdog 自动重启 →
`node scripts/sync-snowluma-token.mjs` → 重启桥接。**不需要重新扫码登录 QQ。**
## 2026-10-31 — 0.4.21：桥接的工具限制改成「按真实工具名算的白名单」

> 安全加固。上一版的 deny 名单在 DSH 0.2.1 上几乎全失效。

### 现象（一直存在，没人注意到）

```
[qq-tool-restrict] restrict ok=4 failed=78
  unknown global tool "pwsh"; known global tools: desktop_control, desktop_sequence, …
```

名单是按 **DSH 0.1.7** 的工具名写的；现在实际工具叫 `desktop_control` / `desktop_sequence` 之类，
**78 个名字全部 unknown** → `restrict()` 全部静默失败。

真正兜底的只剩 `tools.guard()`（执行期白名单）——那是最后一道，schema 里工具仍在。

### 修法

在 restrict 之前，先枚举**当前真实存在**的工具名，只保留白名单内的，再用 `allow` 一次性限制：

```js
const schemas = ctx.tools.schemas()
const names = schemas.map(s => s?.name).filter(Boolean)
const keep = names.filter(n => SAFE_EXACT.has(n) || SAFE_PREFIXES.some(p => n.startsWith(p)))
if (keep.length < names.length) ctx.tools.restrict({ allow: keep })
```

- **不再依赖写死的名字**：新增/改名的工具默认被挡
- 拿不到工具清单时**退回原 deny + guard**，不静默失效
- 诊断写进 `state/tool-restrict.log`：`allow-restrict ok 保留=N/M：…`

### 验证方式

preset 的 apply 在**建 agent 时**才跑（≈第一条 QQ 消息到达时）。
消息来之后看 `state/tool-restrict.log` 有没有这行：

```
allow-restrict ok 保留=3/20：ask_user_question, todo_write, mcp__snowluma__qq_ping, …
```
## 2026-10-31 — 0.4.20：熔断开关 + 工具调用取证

> 小更新，来自那次越权事故的两条教训。

### ① 插件日志现在记工具名（取证缺口）

之前只有一行 `会话事件：tool/call`——**看不出调的是什么**。
真机事故里就是 `desktop_sequence` + `win+r` + `powershell`，日志里完全看不见。

现在：

```
工具调用：desktop_sequence [{"action":"key","key":"win+r"},{"action":"type","text":"powershell"}]
工具结果：{"ok":true,...}
```

### ② 熔断开关（2 秒生效，不用重启 DSH）

插件跑在 DSH 进程里，出事时"改配置 + 重启"太慢，也没有外部手段叫停正在跑的 agent。
新增文件开关：

```powershell
# 双击
熔断-停插件.bat
```

等价于写入 `state/plugin-kill`。插件每 2 秒轮询，一旦发现就：

- 断开 QQ 通道（`channel.close()`）
- 释放通道认领（`channelGuard.stop()`）
- 日志写 `🔴 已熔断`

恢复：双击 `恢复-插件.bat`（删标记）+ 重启 DSH。

### 为什么这样设计

- **不用重启**：DSH 重启要几十秒，熔断要秒级
- **不依赖 UI**：出事时你可能连界面都点不动
- **可审计**：熔断事件本身留在 plugin.log
## 2026-10-31 — 0.4.19：**安全修复** — 插件模式下群友可越权操作本机

> ⚠️ 这是安全修复，请尽快升级。

### 漏洞

插件模式早期版本建 agent 时**没挂 `agentPreset`**，于是 agent 拿到的是 DSH 默认工具集
（`pwsh` / `read` / `write` / `edit` / `subagent` …），**权限等于用户本人**。

群聊消息来自陌生人 —— 任何群友 @ 它一句，就能让它读写本机文件、执行命令。

真机已发生：群友要求"管理员级操作"，agent 照做。

### 为什么桥接模式没这个问题

桥接走 `qq-chat-v2` preset，里面有 `qq-tool-restrict`：

- 注册期 `tools.restrict()` 把本地工具从 schema 隐藏
- 执行期 `tools.guard()` 白名单兜底（`ask_user_question` / `todo_write` / `mcp__snowluma__*` / `mcp__web-search-safe__*`）

插件模式绕过了整条链路。

### 修法（两层，缺一不可）

| 层 | 位置 | 效果 |
| --- | --- | --- |
| 工具白名单（注册期） | 插件 `tools.restrict({ allow: [...] })` | 只留 `qqb_*` + `todo_write` + `ask_user_question`；本地工具不出现在 schema |
| 执行期 guard | `agentPreset: qq-chat-v2` | 越界调用直接拒绝 |

启用插件模式后必须确认 `plugin.log` 有这两行，否则不要交出通道：

```
已对 agent 应用工具白名单（10 个；本地工具全部不可见）
agent 已建：preset=qq-chat-v2 cwd=…
```

### 文档

- `README.md` 顶部加安全警告
- `docs/guides/PLUGIN-MODE.md` 新增「〇·一、安全边界（必读，先于一切）」
## 2026-10-31 — 0.4.18：插件模式没有人设（角色卡没挂上）

> 小更新。群里说话不像"小鲸鱼"，像通用助手。

### 现象

插件模式下它回话是这样的：

> 「不过有个情况得跟你说一声：我刚试着往 QQ 群里回话，结果报错……」
> 还带 Markdown 表格 `| 调用 | 返回 |`。

**没有人设卡，也没有 QQ 场景规则**（简短、不用 Markdown、只在被 @ 时说话）。

### 根因

桥接模式的人设来自 DSH 的 **agent preset**（`qq-chat-v2`：persona + 场景规则 + 工具面）。
插件建 agent 时只给了 `sessionId / meta.cwd / 模型`，**没给 `agentPreset`** ——

```js
meta: { chatKey, cwd }        // ← 少了 agentPreset
```

于是拿到的是 DSH 默认系统提示，与 QQ 聊天无关。

### 修法

```js
meta: { ..., agentPreset: config.agentPreset }   // 默认 'qq-chat-v2'
```

并新增配置项 `agentPreset`（可改 `qq-chat` / 自定义）。
建好后日志会打印实际生效的 preset：

```
agent 已建：preset=qq-chat-v2 cwd=…\state\agents\group_994920175
```

### 顺带

`mdToPlain` 的表格分隔符 `|` 换成 `·`：QQ 里 `a | b | c` 很难读。
## 2026-10-31 — 0.4.17：工具只回"最近 N 条"，把正文丢了

> 小更新。读消息类工具真机一测就露馅。

### 现象

```
qqb_get_recent_messages(group:994920175)  → "最近 9 条"
qqb_get_unread_messages(...)              → "9 条未读"
```

**有计数、没正文** —— 工具对模型等于没用。

### 根因

`OUTPUT.render` 只渲染了 `v.message`（那句摘要），把 `messages` 数组整个丢掉：

```js
const text = v.message;      // "最近 9 条"
return [{ type: 'text', text }];   // ← 数据没了
```

工具**执行**返回的是完整对象（`messages`、`handoff`、`role`、`wake` 都在），
只是 render（决定模型看到什么）把它们扔了。

### 修法

render 改成把数据也渲成文本：

```
最近 2 条
  #1 1599683156: 在吗？
  #2 我: 在的，我在。
```

同时补上 `handoff`（交接记忆）、`role`（角色卡字数）、`wake`（唤醒配置）、
`readThroughSeq`（已读水位）、`timeout`（等待超时）。

### 教训

工具要测**渲染结果**，不是只测 execute 的返回值——模型看到的是 render 的产物。
## 2026-10-31 — 0.4.16：插件模式在真机跑通（一次性修掉 10 个静默失败）

> 这是插件模式第一个**真能用的版本**：群里 @ 它 → 它回话。

### 里程碑

```
[qq-plugin] 入站投递 group:994920175 uid=…
[qq-plugin] 会话映射建立 session=qqbridge:group:… → group:994920175
[qq-plugin] agent 初始：status=running seq=6
[qq-plugin] 助手回复 → group:994920175（422 字，转纯文本 380 字）
[qq-plugin] 发送成功 group:994920175 message_id=…
```

### 10 个坑（全部"不报错、只是不动"）

| 环节 | 症状 | 根因 |
| --- | --- | --- |
| 工具注册 | `schema … got 'type': null` | `register()` 不编译，编译在 `defineTool()` |
| sidecar | 快照全 401 | token 空；`/health` 免鉴权所以看着正常 |
| 通道独占 | 一条消息回两次 | sidecar-only 仍建 WS 连接 |
| @ 判定 | @ 它没反应 | 事件无 `self_id` |
| 认领 | 重启后不连 | 僵尸认领未判 pid 存活 |
| 发送 | `client.action is not a function` | 方法名是 `call()` |
| 投递 | 会话建了没消息 | 新 agent 的 `whenIdle()` 永不 resolve |
| Agent | 无 turn、无报错 | 没给模型（`agentOptions:{}`） |
| Agent | 同上 | `meta` 缺 `cwd` |
| **Windows** | `mkdir …group:994920175: ENOENT` | **文件名不允许 `:`** |
| 转发 | 模型答了群里没有 | fallback session id 与监听 id 不一致 |

### 新增（可用性）

- 插件日志落盘 `<stateDir>/plugin.log`（512KB 轮转）——桌面版看不到 stdout
- 回复前 `mdToPlain()`：QQ 不渲染 Markdown，去掉围栏/反引号/粗体
- agent 创建时 `tools.restrict({ deny: [...] })` 禁掉所有发送类工具：文本走自动转发，避免模型先试工具白烧 30+ 步
- 只 @ 不带文字 → 当成一次"戳"（原来判 `empty` 丢掉）

### 文档

`docs/guides/PLUGIN-MODE.md` 新增「真机踩坑清单」：12 行症状→根因→修法对照表。## 2026-10-31 — 0.4.13：两条路都开放，一键切换

> 小更新。插件模式和原来的 bridge 模式**并存**，用户按需选。

### 为什么

插件模式能跑，但不是所有场景都合适（长期挂机还是独立进程更稳）。
之前切换要手改两个文件、还要记住重启顺序，容易出错。

### 新增

`scripts/switch-mode.mjs` + Windows 上两个 bat：

```powershell
node scripts/switch-mode.mjs status   # 看现在谁在收
node scripts/switch-mode.mjs bridge   # 路线 A：常驻 bridge
node scripts/switch-mode.mjs plugin   # 路线 B：DSH 插件
```

```
切换-桥接模式.bat
切换-插件模式.bat
```

脚本改两处：

| 文件 | 字段 | A | B |
| --- | --- | --- | --- |
| `config.json` | `channel.enabled` | `true` | `false` |
| `<DSH profile>/cordis.patch.yml`（`qq-bridge`） | `enabled` | `false` | `true` |

并打印**正确的重启顺序**：

- 切到 A：先重启 DSH（插件释放通道）→ 再重启 bridge
- 切到 B：先重启 bridge（让出通道）→ 再重启 DSH

### 文档

`docs/guides/PLUGIN-MODE.md` 开头加「两条路怎么选」对照表 + 「怎么切（一键）」；
顺手修掉重复的 `## 二·五` 标题。## 2026-10-31 — 0.4.12：插件里 @ 判定失效（事件没有 self_id）

> 小更新。真机第一次端到端发消息就踩到了。

### 现象

群里 `@小鲸鱼 在吗` → **完全没反应**，日志不报错，事件流也没有新记录。
但通道确实被插件认领了（`channel-mode.json` = plugin），3001 上也只有插件一条连接。

### 原因

SnowLuma 推送的消息事件里**没有 `self_id` 字段**。而插件是这么判定的：

```js
const r = gate(event, { selfId: event?.self_id });   // ← undefined
// inbound.js
const target = String(selfId ?? event?.self_id ?? '');  // → ''
if (!target) return false;                              // → 永远"没 @ 我"
```

结果 `requireMention: true` 下，**每一条群消息都被判成 no-mention 丢掉**。
桥接没这个问题，因为它在启动时调 `get_login_info` 拿到了自己的 QQ 号。

### 修法

通道启动后主动问一次网关：

```js
const info = await channel.call('get_login_info', {});
state.selfId = String(info?.data?.user_id ?? '');
// 之后
gate(event, { selfId: state.selfId ?? event?.self_id });
```

取不到时会打一行警告（`@` 判定可能失效），而不是静默失败。

### 教训

`requireMention` 这类"静默丢弃"的判定，失败时不报错 —— 只能靠**真实发一条消息**才能发现。## 2026-10-31 — 0.4.11：sidecar-only 时**真的**不连网关（否则两边各收一份）

> 小更新。真机实测发现：日志写着"让出通道"，实际却还连着 3001。

### 现象

```
[bridge] sidecar-only 模式（channel.enabled=false）：不连接 QQ 网关，也不占用通道认领
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001      ← 说好的不连呢
```

`Get-NetTCPConnection -RemotePort 3001` 能看到**两条**：DSH 插件一条 + bridge 一条。
后果是**同一条群消息被消费两次**，插件和桥接可能各回一句。

### 修法（两层兜底）

```js
if (!channelModeClaimed) {
  bot.reconnect = false;          // 禁自动重连
  bot.connect = async () => {};   // 把 connect 变成空操作（真机第二次踩到：close 之后仍有连接建立）
  bot.close(1000, 'sidecar-only');
  log('已断开 SnowLuma 连接并禁用重连（本实例只作 sidecar）');
}
```

同时自愈路径里的重连也受 `bot.reconnect !== false` 约束。

### 验证

```
3001 连接: DeepSeek Harness.exe(12708)      ← 只剩插件
bridge 日志: sidecar-only 模式 … / 已断开 SnowLuma 连接并禁用重连
```

### 顺带

`src/bridge.js` 体积基线更新（本轮 N3 通道闸 + sidecar 兜底，增量 59 行、真实无法再拆）。## 2026-10-31 — 0.4.10：插件自动读 sidecar console-token（原来全 401）

> 小更新。真机测试暴露的问题：工具通了，但**读快照一律 401**。

### 现象

```
qqb_get_prompt → { "ok": false, "status": 401, "error": "unauthorized" }
```

### 原因

sidecar 的 `/snapshot`、`/events`、`/intents` 都要 Bearer token，
而插件配置里 `sidecarToken: ""` 意味着**不带 Authorization** → 401。

之前"能用"只是因为在同一台机器上、且我们只测了 `/health`（免鉴权）。

### 修法

`sidecarToken` 为空时，自动读 `<stateDir>/console-token`：

```js
let sidecarToken = config.sidecarToken;
if (!sidecarToken) {
  const f = path.join(config.stateDir, 'console-token');
  if (fs.existsSync(f)) sidecarToken = fs.readFileSync(f, 'utf8').trim();
}
```

同机部署下开箱即用；跨机部署显式配 `sidecarToken` 即可。

### 验证（真机 group:631539503）

```
role: xiaojingyu   角色卡 9012 字
wake: diving / infinite / 关键词 11 个 / probability 0.05
recent: 0 条（沉睡中）
```

之前 401，现在 200 且有真实数据。## 2026-10-31 — 0.4.9：真正的根因 —— 工具没经过 `defineTool()` 编译

> 小更新，修的是"改名也没用"的那个 schema 错。

### 现象

```
Invalid schema for function 'qqb_get_prompt':
schema must be a JSON Schema of type: 'object', got 'type: null'
```

改名之后**还是同样的错**，说明名字不是原因。

### 根因

宿主 `ctx.tools.register()` **不做 schema 编译**，它只校验 `output`。
编译发生在 `defineTool()` 里：

```js
// @deepseek-ai/dsh-tools
function defineTool(options) {
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters);  // ← 这里才补上 type: 'object'
  ...
}
```

而我们一直把**裸对象**（`{ chat_id: { type:'string', required:true } }`）直接丢给 `register()`，
于是供应商收到的函数 schema 是 `{ chat_id: {...} }` —— 没有 `type`，被读成 `type: null`。

**这解释了为什么 0.4.5（撞名跳过）和 0.4.7（改名）都没治本。**

### 修法

`plugin/index.js` 顶层动态取 `defineTool`，注册前包一层：

```js
let defineToolImpl = null;
try { ({ defineTool: defineToolImpl } = await import('@deepseek-ai/dsh-tools')); } catch {}

// registerTool 里
ctx.tools.register(defineToolImpl ? defineToolImpl(tool) : tool);
```

- 取不到（离线测试）就退回裸对象，不影响挂载
- 实测编译结果：`parameters.type = "object"`，`required: ["chat_id"]` 正常

### 守卫

`test-plugin-mount.mjs` 增加一条：`index.js` 必须同时出现 `defineToolImpl ? defineToolImpl(tool)` 与
`import('@deepseek-ai/dsh-tools')` —— 防止以后又把裸对象直接注册。## 2026-10-31 — 0.4.8：`sync-snowluma-token.mjs`（HTTP/WS token 别手改）

> 小更新。加一个脚本，避免"手改 token 改错那一个"。

SnowLuma 的 **HTTP token 与 WS token 是两个不同的值**，重新扫码后都会变：

| 位置 | 字段 | 用哪个 |
| --- | --- | --- |
| `config.json` | `snowluma.accessToken` | **HTTP**（桥接的 API 调用） |
| DSH profile 的 `cordis.patch.yml`（`qq-bridge` 条目） | `accessToken` | **WS**（插件连 3001） |

```powershell
node scripts/sync-snowluma-token.mjs --dry   # 先看会改什么（token 默认打码）
node scripts/sync-snowluma-token.mjs         # 真改
```

- 自动从 SnowLuma 的 `config/onebot_<QQ>.json` 读两个 token
- 多账号时用 `config.json` 的 `selfQQ` 固定；没配会告警并取第一个
- 只在必要时写文件；改完提示要重启 DSH（插件启动时加载）## 2026-10-31 — 0.4.7：插件工具改名 `qqb_*`，彻底避开 MCP 同名

> 小更新。修的是桌面版"每一轮都报 schema 错"的根因。

### 之前为什么没修好

0.4.5 加的「同名就跳过」依赖 `ctx.tools.get(name)` 能看见 MCP 注册的工具。
真机上它**看不见**（MCP 工具在另一层），于是插件照样注册了 `qq_get_prompt`，
冲突还在 → 供应商侧 schema 仍是 `type: null`。

### 现在

插件工具统一加 `qqb_` 前缀：

| 旧名 | 新名 |
| --- | --- |
| `qq_ping` | `qqb_ping` |
| `qq_send_message` | `qqb_send_message` |
| `qq_reply` | `qqb_reply` |
| `qq_get_prompt` | `qqb_get_prompt` |
| `qq_mark_read` | `qqb_mark_read` |
| `qq_get_recent_messages` | `qqb_get_recent_messages` |
| `qq_get_unread_messages` | `qqb_get_unread_messages` |
| `qq_wait_for_messages` | `qqb_wait_for_messages` |

- **MCP 的 `qq_*` 工具一个没动**，两边可以并存
- 撞名跳过逻辑保留（对那些真的能看见的同名工具仍然有效）
- 名字变化不影响功能：参数、返回、降级语义都没变## 2026-10-31 — 0.4.6：提交到 awesome-dsh-plugin 的收录草稿

> 纯文档版本。

新增 [docs/guides/AWESOME-SUBMISSION.md](docs/guides/AWESOME-SUBMISSION.md)：

- **条目 YAML**（可直接放进 `data/plugins/juju114514__qq-bridge.yml`）
- **门槛逐条核对**：`dsh.bundle` ✅、仓库 5 天 ✅、未归档 ✅、不是 DSH 本身 ✅、单 PR 单条目 ✅
- **为什么用 `tree/main/plugin` 这种 URL**：市场会把子目录 URL 拼成
  `github:<owner>/<repo>#path:/<subdir>`，那才是能真正装上的形式；
  而直接 `pnpm add .../tree/main/plugin` 会**忽略子目录**、装成仓库根（桥接应用本身）

清单现状（实测）：7,924 条，其中 41 条与 QQ 相关；我们不在其中。## 2026-10-31 — 0.4.5：同名工具冲突（真机整轮失败）

> 小更新，修的是"插件装上之后每一轮都报错"。

### 现象

```
本轮运行失败 Invalid schema for function 'qq_get_prompt':
schema must be a JSON Schema of type: 'object', got 'type: null'
```

### 原因

桌面版同时还挂着 `mcp-snowluma`，它也有 `qq_get_prompt` 等 45 个工具。
**同名工具并存**时，供应商侧拿到的那个函数 schema 变成 `type: null`，整轮直接失败。

我们自己的 schema 是合法的（已用宿主同版本的 `dsh-tools` 实测编译，`type: 'object'` 正常）。

### 修法

注册前先查 `ctx.tools.get(name)`：

- 已存在 → **跳过**并记一行日志（该功能走 MCP 那份）
- 不存在 → 正常注册

冲突时插件仍然提供那些**不撞名**的工具（如 `qq_ping`），不会整段失效。

### 说明

这条只在"插件 + MCP 同时挂"的环境出现（桌面版就是）。纯净插件环境不会触发。## 2026-10-31 — 0.4.4：插件自包含 + 可以直接从仓库安装

> 小更新。让"填个地址就能装"成立。

### 三个改动

| 改动 | 为什么 |
| --- | --- |
| `plugin/vendor/` 打进 9 个依赖模块（onebot-ws + 通道闸） | 之前插件用 `../src/...`，单独安装后找不到文件——装得上、跑不起来 |
| DSH 相关 peer 标 `optional` | 它们不在公共 npm 上；不标的话从 git 安装会去 npm 拉，直接失败 |
| 移除仓库根的 `postinstall` | pnpm 会因此报 `ERR_PNPM_IGNORED_BUILDS`，**git 方式安装被拦** |

### 现在三种安装方式

| 方式 | 填什么 | 说明 |
| --- | --- | --- |
| 本地路径（推荐） | `<仓库>\plugin` | 最稳 |
| GitHub 子目录 | `github:juju114514/qq-bridge#main&path:/plugin` | 实测 `pnpm` 直接成功 |
| npm 包名 | ❌ 404 | 插件是 `private`，未发布 |

### 守卫

新增 `scripts/check-plugin-vendor-fresh.mjs`：vendor 副本必须与 `src/` 源头**逐字节一致**，
并检查插件里没有跨包相对导入——防止"装走之后用的是旧逻辑"。## 2026-10-31 — 0.4.3：插件模式真机跑通（三个必需项）

> 小更新。修的是"插件装上了但连不上 QQ"这类只在真机上出现的问题。

### 三个修复

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| 插件 `inject` 少了 `agents` | 报 `cannot get property "agents" without inject`，通道启动直接失败 | `inject = ['tools', 'agents']` |
| 挂载时探 sidecar 只给 1.5s | 宿主启动忙 → 明明开着却报「sidecar 未连接」 | 超时改 5s，并把失败原因打进日志 |
| 认领文件写到了相对路径 | `stateDir` 默认 `./state`，cwd 不是 sidecar 的 state → **通道互斥形同虚设** | 新增 `stateDir` 配置项；文档写明必须与 sidecar 一致 |

### 真机验证（隔离 DSH_HOME，未碰桌面版）

```
[qq-plugin] 通道模式：plugin（free）
[qq-plugin] OneBot 已连接：ws://127.0.0.1:3001
[qq-plugin] QQ 通道已启动
[qq-plugin] 已挂载；sidecar 在线（mode=bridge）
```

`state/channel-mode.json` 显示 `mode: plugin`，sidecar 处于 sidecar-only。

### 文档

`docs/guides/PLUGIN-MODE.md` 增加「三个真机才会暴露的必需项」：
`accessToken` 要用 **WS** token、`stateDir` 必须与 sidecar 一致、`inject` 要含 `agents`；
另加一条：杀进程后 60 秒内重启会被心跳 TTL 拒绝，删 `channel-mode.json` 即可。## 2026-10-31 — 0.4.2：升级指南（给还在用 0.2.x / 0.3.x 的人）

> 纯文档版本，没有代码改动。

新增 [docs/guides/UPGRADE-FROM-OLD.md](docs/guides/UPGRADE-FROM-OLD.md)：

- **30 秒版**：备份 → 拉代码 → `npm install` → `restart.bat` → `自检.bat`
- **配置项对照表**：0.3.1 的 `notifyAgentErrors` / `roleInjectEvery`、0.4.1 的 `channel.enabled`，
  标明"默认值都等于旧行为，一个都不改也能跑"
- **行为变化**：角色卡改 `isOwner`、`consolePort` 启动校验、`/api/voice/send` 修复、通道认领
- **从 0.2.x 上来要额外做的**：Node ≥22.13、DSH ≥0.2.1-rc.2、preset 名 `qq-chat-v2`、跑一次 `setup-dsh.mjs`
- **state 兼容性**：只增不改；新增 `state/memory/`、`channel-mode.json`、`plugin-events.jsonl`
- **回滚方法**：换回旧代码 + `state.bak-*` 覆盖回去
- **升级后自查清单** 5 条

README 顶部与 docs 索引都加了入口。## 2026-10-31 — 0.4.1：`channel.enabled` —— 让 sidecar 把通道让给插件

> 小更新（+0.0.1）。默认行为不变（`channel.enabled` 默认 `true`，照常连网关）。

### 解决什么问题

0.4.0 的插件模式发布后有个卡点：**插件和常驻 bridge 只能有一个收消息**，
但 bridge 没有"我不收消息、只当 sidecar"的开关 —— 想试插件就得把 bridge 整个关掉，
而那意味着记忆、记账、控制台全都没了。

### 现在怎么做

```jsonc
// sidecar 机器上的 config.json
{ "channel": { "enabled": false } }
```

启动日志：

```
[bridge] sidecar-only 模式（channel.enabled=false）：不连接 QQ 网关，也不占用通道认领
```

- 控制台、sidecar 契约、定时器**全部照常**
- `state/channel-mode.json` 不再生成 → 插件可以拿到通道（`claim(plugin) → ok=true`）
- 想切回：改回 `true` 并重启

### 验证

- 真机实测：sidecar-only 启动后 `channel-mode.json` 不存在，插件侧 `claim` 成功（`reason=free`）；
  改回 `true` 后 bridge 重新认领（`reason=free`）
- 审计 127/127## 2026-10-31 — 0.4.0：qq-bridge 可以装进 DSH 了（插件模式）+ 群记忆交接

> 这一版是**新增形态**，不是替换：`start.bat` 的常驻模式完全没变，行为一致。
> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。无破坏性变更。

### 新形态：插件模式

- 插件装进 DSH（`plugin add`），**消息通路跟宿主同生命周期**，不用再单独守护一个通道进程
- 工具从 MCP 改成**进程内注册**：少一跳、少一个进程
- 已提供 8 个工具：发消息 / 引用回复 / 最近记录 / 未读 / 等新消息 / 提示词快照 / 标记已读 / 自检
- **默认 `enabled: false`**：装上不等于连 QQ，必须显式打开

### 群记忆交接（§〇）

- 每个会话一份 `state/memory/<key>.md`，`## §〇 交接` 覆盖写，**≤4 KB**
- 四个固定子项：上次聊到哪 / 当前话题 / 记忆变更 / 下一步想聊
- 解决"换模型、重启之后像失忆"：**记忆在文件里，不在会话里**

### sidecar 契约

- `GET /health`、`GET /snapshot?key=`（带 ETag）、`POST /events`、`POST /intents`
- 插件只读快照、只发意图；`state/` 仍由常驻进程单写

### 通道互斥（安全）

- `state/channel-mode.json` 带心跳认领：同一份 `state/` **只允许一个东西收 QQ 消息**
- bridge 被占用时**不连网关**（控制台与工具照常），日志直说要先停插件
- 心跳过期（崩溃残留）可被新实例抢占

### 验证

- 审计 126 个脚本全绿（新增 8 个插件相关测试）
- 一致性闸：入站判定（会话 key / 文本抽取 / 白名单 / @ / 去重 / 自己发的）在两种形态下一致
- 真机：`/health`、`/snapshot`（ETag 304）、`/intents`（交接落盘）、通道认领冲突全部实测

### 已知限制

- 表情包 / 语音类工具还在 MCP 侧，插件模式暂未覆盖（下一版）
- 插件模式下**主动消息 / 定时提醒 / 控制台需要 sidecar 在跑**；不开只有被动回复
## 2026-10-31 — 0.3.2：新手开箱（零基础指南 / 自检.bat / 占位截图）+ 角色卡按节奏注入

> 无破坏性变更。新增 1 个配置项 `socialV2.roleInjectEvery`（默认 `1` = 行为不变）。

### 新手开箱

- **零基础八步指南** `docs/guides/BEGINNER.md`：从空电脑到「她在群里回话」，
  每步都写「做什么 / 应该看到什么 / 没看到怎么办」+ 卡点速查表 + 术语小抄
- **`自检.bat`**：双击就能跑环境体检（12 项），末尾 `pause` 不闪退，按退出码给结论
- 第 5 步拆成 6 个带**截图位**的子步骤；`assets/beginner/` 已放入占位图（覆盖同名文件即可换真图）
- README 顶部与「什么都没有」两条路径都指向零基础指南

### 省 token：角色卡按节奏注入

- `socialV2.roleInjectEvery`（默认 `1` = 每轮全量，行为不变）
- 设成 `8`：首次/换卡全量，其后每 8 轮一次 —— 实测提示词 **33,473 → 10,282 字节**
  （≈15K → 4.7K tokens），**每轮省约 10K**
- 只影响提示词，不影响服务端权限判定；脏配置（0/负数/字符串）一律退化成每轮全量

### 验证

- **干净克隆**（新文件夹、无 node_modules/config/state）→ 审计全绿、文档链接全通
- 顺带修掉 4 处「本地没事、仓库读者会撞」的文档漂移：
  体检项数写错（16→12）、体检提示没指向新手文档、README 表格串行、README 缺新手入口

### 已知未做

- `scripts/first-run.ps1 -DryRun` 在全新克隆里 exit=1（体检 FAIL: 无 config.json），
  对新手有误导；下次改成 0/2 并加说明
## 2026-10-31 — 0.3.1：波次 4 收官（bridge.js 11.2k → 10.0k）+ 三条外部模型路线验证

> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。**没有破坏性变更**；
> 新增 1 个配置项（`socialV2.notifyAgentErrors`），其余行为不变。

### 用户能感知的变化

- **回复更快、更稳**：`bridge.js` 从 11,236 行降到 **10,050**，内联路由从 41 条降到 **1 条** ——
  以后加接口只能写进 `src/api/*.js` 并接进派发链（有棘轮守着，不会再长回去）。
- **技术报错不再刷屏**：新增 `socialV2.notifyAgentErrors`（默认 `true`）。
  换成第三方模型时 `No API key` / `context overflow` 这类消息不再推到 QQ，只进日志。
- **换模型不再静默失败**：非 DeepSeek 的 provider（如千问、Bedrock）若模型不支持"思考强度"，
  桥接会自动去掉该字段重试一次，并在日志里写明原因 —— 以前是失败两次然后**静默退回默认模型**。
- **`/api/voice/send` 修好了**：这个操作者通道此前一直是 500（三个依赖没注入），现在能正常发语音。
- **角色卡可以"按节奏注入"**：新增 `socialV2.roleInjectEvery`（默认 `1` = 每轮全量，行为不变）。
  设成 `8` 之后：首次/换卡全量，其后每 8 轮一次 —— 实测提示词从 **33,473 → 10,282 字节**
  （≈15K → 4.7K tokens），**每轮省约 10K tokens**。只影响提示词，不影响权限判定。

### 修复

- **角色卡不再写死管理员 QQ**：改用 `isOwner` 标记（号码由服务端校验）。
  之前隐私脱敏把号码换成了占位值，导致机器人**不认老板** —— 这是一次真实的回退。
- **`consolePort` 现在会校验**：写成 `"abc"` / `99999` 会在启动时直接报错并说清范围，
  以前是 `listen EACCES` 之后控制台静默打不开。
- **干净克隆 113 → 116 个测试套全绿**（新增：`check-privacy` / `test-config-dirty` /
  `test-model-effort-fallback`）。

### 外部模型路线（实测记录）

| 路线 | 文本 | 工具调用 |
| --- | --- | --- |
| DeepSeek（默认） | ✅ | ✅ |
| 千问 `qwen-max` | ✅ | ✅ |
| 千问 `qwen-flash` / `qwen-plus` | ✅ | ❌ 工具参数传错 |
| 暴喵网关（实际是小米 MiMo） | ✅ | ✅ 但窗口小、常空收尾 |

细节见 [docs/guides/GPT-ROUTE-STATUS.md](docs/guides/GPT-ROUTE-STATUS.md)。
**生产配置仍是 `deepseek-official / deepseek-flash`。**

### 踩过的坑（写下来免得再踩）

- 按**缩进**切代码 → 误删了相邻的 `/api/security` 整块；必须按大括号配平 + 复核 diff。
- 按**命令行**过滤进程 → 误杀了真机；要按端口归属（3100 真机 / 3199 沙箱）。
- 自定义 provider 不写 `contextWindow` → 一上来就 `context overflow`。
- 中转站先问一句"你是哪个模型"再付钱。
## 2026-10-30 — 0.3.0：拆到 10.7k 行 + 三件新功能 + 十个测试护栏

> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。这一版**没有破坏性变更**，
> 但新增了几个配置项与一次自动生成的 `state/people.json`，升级后建议跑一次 `/自检`。

### 新功能（用户能感知）

- **`/自检`（管理员）**：一条指令看清 网关 / DSH / 队列 / 会话表 / 数据量 / 最近错误 /
  **网关重连次数** / **抖音 cookies 剩余**。命令由桥接直接执行、不经过模型，零 token。
- **抖音轻量档**：`qq_open_video(mode="meta")` 与"消息里出现抖音链接自动附元数据"——
  只取 作者/标题/文案/封面，**不下载视频**（下载才是风控高危动作），同会话 10 秒冷却。
  可用 `socialV2.media.video.links.autoMeta=false` 关掉自动附加。
- **静默时段**：`socialV2.quietHours = [23, 8]`，夜里不主动搭话；消息照常记录，
  `admin` / `bootstrap` 不受限。默认关闭。
- **人物库**（`src/people.js`）：身份只认 QQ 号（改群名片不再断成两个人），
  关系升档要求"消息数 + 活跃天数"同时达标（一天刷 500 条也不算熟人）。
  首次启动会按白名单群存量成员标 `listed`，不会把老群友当新人欢迎。
- **命令清单进提示词**：模型不再答"我没有自检功能"，被问起会直接告诉你发什么命令。

- **`/诊断`（管理员）**：回答"这条消息为什么没回我"。桥接记下每条消息的决策链
  （闸门 → 暂停 → 唤醒命中/未命中 → 投递），环形缓冲 80 条、只记截断文本。
  `/诊断` 看本会话最近 8 条，`/诊断 全部` 看全局，`/诊断 #12` 查单条。
- **`qq_people_note` 工具**：模型终于能"记事"和"纠错"——以前人物库只读，
  记错只能 `/reset` 全清。`op=add/list/clear`，作用域可到群或全局；
  档位太低（陌生人/仅名单）时笔记暂不注入，`list` 会明确告诉你有几条被隐藏。

### 重构（bridge.js 11,236 → 10,728 行，−4.5%）

一晚十刀，每刀一个模块一提交、都能单独回滚：
`console-dsh` / `socialV2-video` / `console-ops` / `incoming-commands` /
`incoming-status-commands` / `session-registry` / `session-reset` / `incoming-guards` /
`preset-sim` / `workspace-reset` / `group-members` / `slang-submit` / `mux-learner` / `mux-tools`。

### 按公开 issue 核对后的修复（2026-10-30 收尾）

拿上游公开 issue 清单逐条对照**当前代码**核，不照抄结论。结果：#110 / #114 / #115 成立并已修；
#112 在本仓库不复现；#80 / #109 / #111 仍待验证（见下）。

**已修复**

- **DSH 凭据读取恢复（#110）**：不再把一次瞬时读取失败永久缓存成"匿名可用"。
  成功值才缓存；失败按 2s / 4s / 8s…（上限 30s）退避重试。
  以前 DSH 还没写出 `.credentials.yaml` 时，一次失败就要重启进程才能恢复。
- **限频重试定时器（#114）**：真正开始一次新的唤醒时清掉仍在排队的限频重试定时器。
  否则它到点会**再起一个回合**（重复调模型、可能重复回复）。
- **令牌日志脱敏（#115）**：移除 4 处令牌片段日志（控制台令牌前 6 位、
  SnowLuma WS / HTTP 令牌前 4 位、连接探测结果前 4 位）。现在只说明"已生成 / 已更新"。

**验证**

| 项 | 结果 |
| --- | --- |
| 审计套件 | **88/88** 通过 |
| 干净克隆 | `git clone` → **85/88**（3 个失败的含义见下，不是"全过"） |
| 重启后运行状态 | 已验证（SnowLuma / DSH / 官方通道全就绪，日志无令牌片段） |
| 黄金快照 | 一致（`snapshot-prompt.mjs --diff 2026-10-29T17-13-36`） |

**仍待验证（不要当成已解决）**

- **#80 / #79 提示词注入**：目前只有部分防线（`slang-learner` 对群聊文本做标签转义与控制字符剔除；
  工具守卫拒绝未知工具）。**主聊天提示词的段落伪造边界尚未系统验证**，列为下一轮 P0。
- **#109 mark_read 水位语义**：`pendingWakeKeys` / `unread` / `markReadCalledKeys` 三者的
  "已收到"与"已处理"语义尚未统一验证，需要专门一轮追踪，不做猜测式修改。
- **#111 Clash TUN / fake-ip**：需要在真实代理环境复现；**不得以修复兼容性为由削弱 SSRF 防护**。
- **#112 干净克隆 ENOENT**：本仓库 `docs/guides/VOICE.md` 已纳入版本控制，不复现。

### 已知不稳定项（如实记录）

`scripts/test-reply-wait.mjs` **偶发失败**：单独跑 10/10 通过，全量审计时偶尔红一次
（本轮 3 次全量里红 1 次）。原因是它依赖真实的静默窗口计时，机器负载高时会被挤压。
**这不是功能回归**，但会让人误判。下一轮处理方向：
要么把窗口改成可注入的假时钟，要么在审计里给它单独的重跑一次。

### 文档一致性修复（2026-10-30 夜间）

一次完整的文档复核抓到 5 类问题，全部已修：

| 问题 | 修法 |
| --- | --- |
| TROUBLESHOOTING 有两个 `S` 节、`R` 跑到 `S` 后面 | 官方通道排错整段搬到 [OFFICIAL-QQ.md 第九节](docs/guides/OFFICIAL-QQ.md)，原文只留指针；`R` 回到 `Q` 之后 |
| 目录漏列官方通道 | 目录补一行，直接跳 OFFICIAL-QQ 第九节 |
| 审计套数三个数字（43 / 69 / 73→78） | 统一为 **88**，并写明"以脚本输出为准" |
| bridge.js 行数三种说法（10,940 / 约 1.2 万 / 11,236→10,940） | 统一为 **约 1.1 万（当前 10,771，以 wc -l 为准）** |
| 真机器人号 / 群友昵称 / 群 openid 未脱敏 | 全部替换为 `<你的机器人QQ号>` / `<群友昵称>` / `official-<openid>` |
| OFFICIAL-QQ 第六节标题写"下一步"、状态表写"已接入" | 改为「接入设计（已落地）」+ 每行标 ✅ |
| ttl=86400 的结论容易被误读成"依赖 86400" | 补一句"不要用 ttl 做任何超时/缓存决策" |
| 端口示例数字会被误当固定值 | 三处改为 `<旧端口>` / `<新端口>` 并注明每次启动不同 |
| 作者本机代理写死 | 标注"作者本机，按需替换" |

另：TROUBLESHOOTING 顶部新增**症状 → 节号**索引表（19 行），AI 和人都不用读全文。

### 干净克隆实测（2026-10-30 收尾，如实记录）

在 `git clone` 出来的目录里跑审计：**85/88**。三个失败的归因：

| 脚本 | 原因 | 是否代码缺陷 |
| --- | --- | --- |
| `test-qq-model-view.mjs` | 依赖复制不全（缺 `zod-to-json-schema` 等传递依赖；本机无 npm 可装） | 否（环境） |
| `test-qq-mode-plugin.mjs` | 同上（缺 `@deepseek-ai/cosmokit`） | 否（环境） |
| **`test-first-run.mjs`** | **它直接读仓库根目录的 `config.json`，而该文件被 gitignore** | **是** |

最后一条是本轮新发现，与 #112 同源：**审计脚本不应假设本地状态文件存在**。
修法（下一轮）：让该脚本自己写一份临时 `config.json` 到沙箱目录再跑，
而不是读工作区里那份。**在此之前，不要把"干净克隆全绿"写进任何发布说明。**

> 本次验证的局限：本机打包环境没有 npm，`node_modules` 是从开发目录复制的，
> 所以**没有覆盖"全新安装（npm ci）"这条路**。

### 修复（都是"线上会静默坏掉"的那类）

| 现象 | 根因 |
| --- | --- |
| 机器人在线但**一条消息都不回** | 拆分后漏 import（`node --check` 查不出、VM 审计按名注入还掩盖） |
| 私聊全部 `cfg is not defined` | 把 `main` 的局部变量写进 `main` 之外的函数 |
| `/like` `/song` 报 `cmdText is not defined` | 半截搬迁：搬走定义、留下用法 |
| 控制台启动即炸 | TDZ（引用了后文 `const`），改惰性创建 |
| 抖音解析第一次就"冷却 9 秒" | cooldown 把"没有记录"当成"上次在 0 时刻" |
| `/status` 一按就 ReferenceError | 只写了调用、没写实例定义 |
| 真机 500 `agentTokenOk is not defined` | 新 handler 建在了 `main` 层，而它依赖 console 作用域的 const |
| `/诊断` 被人设菜单吞掉 | 管理命令放在了公开命令之后（与 `/自检` 同源） |

### 测试（73 → 84 个脚本）

新增护栏：`test-bridge-imports`（静态扫"用了但没来源"的工厂）、`test-file-size`（体积棘轮，
新文件 >800 行直接失败）、`test-incoming-guards`、`test-session-registry`、`test-selfcheck`、
`test-workspace-reset`、`test-douyin-meta`、`test-mux-pump`（假 mux 喂帧）、`test-mux-learner`、
`test-mux-tools`。

### 文档

- 运维指南新增 §20「拆分期最危险的五个坑」；`docs/sessions/2026-10-30.md` 交接记录；
  `docs/validation/linux-run-2026-10-30.md`（另一台 Linux 独立复跑，审计 84/84）
- **新增 [docs/UPGRADE.md](docs/UPGRADE.md)**：按版本写"升级要做什么"

## 2026-10-29 — 网关可替换：NapCat 实测通过 + 登录体验修复

- 实测 NapCat（OneBot v11）替代 SnowLuma：桥接零改动，只改 `snowluma.wsUrl`
- 踩坑记录写进 QUICKSTART：HTTP+WS 都要开、不能与 QQ 客户端同时登录、二维码要放大
- `scripts/napcat-login.ps1`：一键拉起 + 二维码放大 4 倍（147px 手机扫不动）
- 登录助手里的示例账号是占位符，仓库不含真实 QQ 号与 token

## 2026-10-29 — 装机体验：体检 + 一键安装 + 一页版快速开始

- `npm run doctor`：逐条诊断四大卡点（Node / DSH 路径 / SnowLuma / 官方凭证），**每条失败都带修法**
- `scripts/setup.ps1`：一键装（便携 Node、官方凭证当场验证、自动打开扫码页、绝不覆盖已有 config）
- `QUICKSTART.md`：一页版，读完就能判断自己该走哪条路线
- README「装起来」改成三条路线对照 + 四大卡点表

## 2026-10-28

### 新增

- **视频理解**：`qq_get_message_video` / `qq_open_video` —— 视频降维成「一张 3×3 故事板（每格烧时间戳）+ 音轨转写」。模型第一次能"看视频"。见 [docs/guides/VIDEO.md](docs/guides/VIDEO.md)
- **视频链接识别**：B站 / 抖音 / 快手 / 小红书 / YouTube 五站白名单；yt-dlp 只下前 180 秒（实测 84MB/8s → 1.5MB/3s）
- **抖音专用解析器**（`src/douyin-resolve.js`）：yt-dlp 的 Douyin extractor 要 a_bogus 签名（无签名 403，**登录也无效**），改走分享页 `play_addr` + `playwm→play` 去水印；实测 97 秒 / 6.2MB
- **cookies.txt 兜底**：`socialV2.media.video.links.cookiesPath`（优先级高于 `cookiesFromBrowser`）—— Chrome/Edge 127+ 的 app-bound 加密让 `--cookies-from-browser` 读不出
- **cookie 体检**：`GET /api/socialV2/video-cookies` → `ok` / `cookie-aging` / `cookie-expired` / `cookie-missing` + `remaining`（人话剩余时间）。抖音链接成功时若即将过期会附提醒；失败时直接说「重导一次」而不是「视频不存在」
- **技能**：vendored `caveman`（Apache-2.0，纯 markdown）+ `scripts/install-skills.ps1`；边界是「**只压日志和输出，代码逐字**」。见 [docs/guides/SKILLS.md](docs/guides/SKILLS.md)
- 排障脚本：`verify-video-live.ps1`（真机验证视频）、`probe-video-cookies.ps1`（探测哪个浏览器能出 cookie）、`set-video-cookies.ps1`（自动发现并接上导出的 cookies.txt）

### 新增（长期记忆 · LivingMemory 式结构）

- `src/memory-store.js`：记忆原子 `{text,tags,weight,createdAt,lastHitAt,hits,source}`，
  有效权重 = `weight · 0.5^(天数/30)`（半衰期 30 天）；命中 `weight += 0.3`（封顶 3）；
  打分 = `0.6·关键词覆盖 + 0.3·归一化权重 + 0.1·新鲜度`；Jaccard≥0.6 合并；有效权重<0.05 归档
- 接线：`memory-append` 落长期层（话题/群友印象；临时想法不落），`GET /api/socialV2/memory`
  注入 top-K（6 条 / 800 字预算，支持 `?q=` 按查询排序）；**老会话现场迁移**，升级即可见
- **合并留原文**：被 Jaccard 吞掉的文本进 `atom.variants[]`（每条最多 5 份），
  新增 `POST /api/socialV2/memory-split` 把任一条拆回独立原子（幂等）
- `scripts/test-memory-store.mjs`：13 项契约测试（分词/衰减/强化/打分/预算/合并/容量/归档/迁移/接线）

### 新增（官方通道 · 协议层）

- **QQ 官方机器人客户端** `src/qqbot-official.js`：AppID+AppSecret → access_token（缓存/提前刷新）、
  gateway、WebSocket（op10 HELLO / op2 IDENTIFY / op6 RESUME / op1 心跳）、事件翻译（群 @ / 群全量 / 单聊）、
  被动回复自动分配 `msg_seq`（**官方上限 5 次**，超了抛错而不是静默丢）
- `scripts/official-probe.mjs`：端到端验证（票据 → gateway → 收事件 → 回复一条）
- `scripts/test-official-client.mjs`：11 项离线契约测试（`<@!id>` 清洗、openid 不当 QQ 号、seq 上限、路由）
- `docs/guides/OFFICIAL-QQ.md`：两条腿的差异、加群前置（个人主体只能加自己管理的群）、协议要点、接入设计与**诚实状态表**

> **2026-10-28 端到端已实测通过**（真机器人 + 真群）：
> token ✓ → gateway ✓ → WS 鉴权 ✓ → 收到群 @ 事件（「测试」）✓ → **被动回复成功** ✓。
> 复现：`node scripts\official-probe.mjs --creds <state/official.json> --seconds 180`

### 修复（官方通道 · 端到端打通）

一条「群里 @ 了却不下话」的排查，连续挖出 6 个坑，全部修掉并各自有测试/日志兜底：

- **@ 标记**：官方 @ 由网关在事件层剥掉 → 唤醒判定认 `__official.atBot`
- **配置登记**：`loadConfig()` 逐字段装配，漏登记 `official` 段 → 启用等于没启用（且零日志）
- **会话 key 正则**：`canonicalV2Key` / `isSessionAllowedInCurrentMode` 只认数字 → 官方 `official-<openid>` 被静默丢弃
- **空 @**：只 @ 不打字时 `content` 为空，被"空消息"分支丢掉 → 合成上下文让模型自己应
- **发送分流**：`sendToQQ` 直连 OneBot，官方 id 被 `Number()` 打成 NaN → 按前缀分流走官方 API
- **id 守卫短路**：`!Number.isFinite(id)` 对字符串恒真，压根没走到白名单 → `typeof id !== 'string' &&`
- **首回复闸门**：模型被唤醒先做 5 分钟"沉睡前观察"，群里 5 分钟没回复 → 未发言时观察请求直接 409
- **中止回合**：`⏹️ 已停止` 顶替了模型已生成的正文 → 有正文时发正文

另修：**DSH 搬目录后 MCP 区块被改名 `.disabled`** → QQ 会话完全没有 `qq_*` 工具（已恢复并写进 docs/guides/OFFICIAL-QQ.md 第九节 9.2）。

### 修复

- **排队消息落盘**：队列原来只在内存里，桥接重启就丢（真实吞过一条消息）。现在写
  `state/pending-queue.json`（临时文件 + rename 原子替换），启动时按「24 小时 / 每会话 50 条」剪枝恢复，
  DSH 就绪后自动补投；坏文件/旧版本一律降级成空队列并写日志，不会把桥接拖死
- **DSH 端口漂移自愈**：DSH 每次重启都换随机端口（54694 → 65452 → 50075），以前 QQ 侧只会回「⏳ 消息已排队」。
  现在桥接连不上时会问系统「DSH 在听哪个端口」（`Get-NetTCPConnection` + HTTP 探活），
  找到就写回 `config.json` 并重建客户端；日志有 `[dsh] 端口漂移：… → …`

- **`package.json` 的 postinstall 坏了**（少一个右引号 + 中文 mojibake）→ 任何人 `npm install` 都会在 postinstall 阶段失败。已修，并用 `test-packaging` 真跑一遍钉住
- 视频以 **`image` 段 + `.mp4`** 到达（不是 `video` 段）导致识别不了 → 按扩展名兜底识别
- 双 BOM 的 `.ps1` 会让 PowerShell 5.1 解析失败（`param()` 报"赋值表达式无效"）→ 加断言：所有 `.ps1` 必须恰好一个 BOM
- 视频链路曾因缺 `import fs` / `probeVideo` / 变量名写错，**把桥接打死**（守护自动拉起）→ 加「导入完整性」静态断言
- 抖音解析分支漏挂 `cleanup` → 临时目录永远删不掉（`r.cleanup is not a function`），已修并钉住

### 安全 / 稳定性

- **播放地址域名白名单**：解析出来的 `play_addr` 属于"数据不是信任"——下载器现在**每一跳**都校验
  `snssdk.com` / `douyinvod.com` / `amemv.com` / `byteimg.com` 等媒体域，跳数上限 3。
  只校验第一跳等于没校验（一个 302 就能带走）。
- **解析器 fixture 回归**：`scripts/fixtures/video/*.html` 存脱敏页面快照，
  上游改版时 `test-video-resolve.mjs` 直接红，而不是等用户发链接失败。
- 新增 [docs/guides/VIDEO-SOURCES.md](docs/guides/VIDEO-SOURCES.md)：**站点 → 路径 → 为什么**。
  实测结论：B 站 HTML 会 412（同一 URL 两个 IP 两种结果，按 IP 判定），公开 API 无 cookie 也通；
  抖音必须爬分享页（yt-dlp 缺 a_bogus 签名，登录也 403），而且**爬也要 cookie**（无 cookie 页面没有 `play_addr`）。

- **体检包含「视频工具就绪」**：`verify.ps1` 新增第 16 项，调用 `diag-tools.mjs` 判断三件套会不会注册
  （`[OK] 视频工具` / `[WARN]` 附原因与改法）；新人不必等到模型说"没这个工具"才发现
- **修掉一个假 FAIL**：`verify.ps1` 的依赖检查还硬编码着 `node_modules/@snowluma/sdk`，
  而该依赖在 `8f65bac` 就移除了（自带 OneBot 客户端）——全新机器体检会稳定报「缺 node_modules」，
  其实什么都不缺。现在改为读 `package.json` 的 `dependencies` 逐个核对
- **一条命令查工具可见性**：`node scripts\diag-tools.mjs` —— 桥接侧 / 代码侧 / 运行侧三条线索
  一次摊开并给结论（`0` 全注册 / `1` 有缺失且指出改什么 / `2` 连不上），支持 `--json`、`--skip-mcp`
- **工具可见性可诊断**：MCP 启动时打印「工具注册完成：N 个｜视频/图片：…✓…」与被关闭的工具清单
  （以前 `disabledTools` 收完就丢，模型看不到某个工具时只能靠猜）；桥接新增只读端点
  `GET /api/socialV2/tools`，直接告诉你三个视频工具会不会注册、以及 `getImages=false` 的后果

### 测试

- 审计 **50/50**；新增 `test-video-frames`（12 项）、`test-video-link`（12 项）、`test-video-resolve`（13 项）
