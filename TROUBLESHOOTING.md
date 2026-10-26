# 排错手册（TROUBLESHOOTING）

> 按「**你在哪一步卡住**」查。每条都是：现象 → 原因 → 排查 → 解决。
> 日志里的关键行都可以直接在 `logs/` 里搜到。
>
> 先跑一遍体检，能定位 80% 的问题：
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\verify.ps1
> ```

## 目录

| 阶段 | 跳转 |
| --- | --- |
| A. 安装 / 依赖 | [A](#a-安装--依赖) |
| B. 启动桥接 | [B](#b-启动桥接) |
| C. 连 DSH | [C](#c-连-dsh) |
| D. 连 SnowLuma / QQ | [D](#d-连-snowluma--qq) |
| E. 能连上但不回话 | [E](#e-能连上但不回话) |
| F. 人设 / 角色 | [F](#f-人设--角色) |
| G. 发消息 / 工具报错 | [G](#g-发消息--工具报错) |
| H. 图片 / 语音 / 表情 / 转发 | [H](#h-图片--语音--表情--转发) |
| I. 控制台 | [I](#i-控制台) |
| J. 升级 / 版本兼容 | [J](#j-升级--版本兼容) |
| K. 性能 / 资源 | [K](#k-性能--资源) |
| L. 看着像 bug、其实不是 | [L](#l-看着像-bug其实不是) |

---

## A. 安装 / 依赖

### A1. `找不到 node。请先装 Node.js 22 LTS`

**原因**：PATH 里没有 node，常见目录也没有。

**解决**：

1. 装 Node 22 LTS：<https://nodejs.org/en/download>
2. 装完**重开终端**（PATH 才会刷新），再跑 `install.ps1`
3. 或手动指定：`.\install.ps1 -OwnerQQ <号>` 前先 `setx PATH "%PATH%;C:\Program Files\nodejs"`

### A2. `Node 版本太低（v18.x），需要 >= 22.13.0`

**原因**：老版本 Node 缺少本项目用到的语法/API（例如 `??=`、较新的 `fetch` 行为）。

**解决**：升级 Node。用 nvm 的话：

```powershell
nvm install 22.13.0
nvm use 22.13.0
```

### A3. `npm install` 卡住或超时

**现象**：一直停在 `reify` / `idealTree`，最后 `ETIMEDOUT`。

**解决**：

```powershell
npm install --registry=https://registry.npmmirror.com
```

仍失败就清缓存重来：

```powershell
npm cache clean --force
Remove-Item -Recurse -Force node_modules
npm install
```

### A4. `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'`

**原因**：依赖没装全（中途断网/被杀）。

**解决**：

```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

### A5. postinstall 报错（patch `@snowluma/sdk` 失败）

**现象**：`npm install` 退出码非 0，提示 `patch` 或 `node 不是内部或外部命令`。

**原因**：postinstall 脚本里调 `node`，但安装时 PATH 里没有。

**解决**：

```powershell
# 确认 node 可用
node --version
# 用带 node 的终端重装
npm install --foreground-scripts
```

### A6. 脚本报 `意外标记`、中文变乱码、`表达式或语句中包含意外的标记`

**原因**：PowerShell 5.1 读**无 BOM 的 UTF-8** 会按 ANSI 解析，中文注释/字符串被打乱，导致语法错误。

**解决**：

- 仓库自带的 `install.ps1` / `verify.ps1` 已经是 **UTF-8 with BOM**，不要另存为「UTF-8 无 BOM」
- 用 VS Code 保存时选 **UTF-8 with BOM**
- 或者改用 PowerShell 7（`pwsh`），它默认按 UTF-8 读

### A7. `config.json` 解析失败：`Unexpected UTF-8 BOM`

**原因**：用记事本另存时带了 BOM，而桥接用严格 JSON 解析。

**解决**：另存为「UTF-8（无 BOM）」；或让 `install.ps1` 重新生成一份。

---

## B. 启动桥接

### B1. 启动后立刻退出，日志 `检测到过期锁文件（PID 不存在或为空），删除后重试…`

**说明**：这是**自愈**，不是错误。上一次进程被强杀留下的锁，桥接自己删掉重试。

**只有反复出现**才是问题：检查是否有两个桥接在抢同一个端口。

### B2. `Error: listen EADDRINUSE 127.0.0.1:3100`

**原因**：控制台端口被占（通常是上一次的桥接没死）。

**解决**：

```powershell
# 看谁占了 3100
Get-NetTCPConnection -LocalPort 3100 -State Listen | Select-Object OwningProcess
# 结束它（确认是本项目再杀）
Stop-Process -Id <PID> -Force
```

或改 `config.json` 的 `consolePort`。

### B3. 双击 `start.bat` 窗口一闪就没了

**原因**：启动即报错，窗口关闭看不到。

**解决**：在终端里跑，看输出：

```powershell
cd <项目目录>
node src\bridge.js
```

### B4. 日志目录不可写：`EPERM` / `EACCES`

**原因**：目录权限或杀软拦截。

**解决**：

- 把项目放到用户目录（如 `D:\qq-bridge`），不要放 `C:\Program Files`
- 杀软把项目目录加白名单

---

## C. 连 DSH

### C1. 控制台 `dshReady=false`

**原因**（按概率）：

1. DSH 没开 / 没登录
2. `config.json` 的 `dsh.baseUrl` 端口不对（**DSH 每次重启端口会变**）
3. DSH 版本与预设不兼容（见 J 段）

**排查**：

```powershell
# 1) DSH 进程在不在、监听哪个端口
$pids = (Get-Process | Where-Object { $_.ProcessName -match 'DeepSeek|dsh' }).Id
Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } | Select-Object LocalPort
```

**解决**：把正确端口写进 `config.json`：

```json
{ "dsh": { "baseUrl": "http://127.0.0.1:<正确端口>" } }
```

然后重启桥接。或者直接用 `install.ps1`（它会自动探测）。

### C2. DSH 重启后机器人突然不回

**原因**：DSH 端口变了，但 `config.json` 还是旧端口。

**解决**（二选一）：

1. 重跑 `.\install.ps1 -OwnerQQ <号>`（自动改端口）
2. 手动改 `dsh.baseUrl` 后重启桥接

**预防**：把 DSH 的端口固定下来（如果 DSH 设置里能选固定端口）。

### C3. 日志 `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`

**原因**：DSH 0.2.1 起 agent loop 只注册 `provider` / `model` 两个变量，预设里再写 `{{cwd}}` 会 **fail loud**，模型一次都不跑 → QQ 上表现为「完全不回」。

**解决**：用仓库自带的预设（已经去掉了 `{{cwd}}`）。如果你改过：

```powershell
git checkout -- dsh/agent-presets/
```

然后重新执行 DSH 端的 preset 安装（见 `SETUP.md` 的「DSH 端安装」）。

### C4. 桥接日志 `DSH 已就绪（模式: reserved2）` 但 AI 还是不回

说明 DSH 通了，问题在唤醒/白名单/暂停，见 [E 段](#e-能连上但不回话)。

---

## D. 连 SnowLuma / QQ

### D1. 日志刷 `SnowLuma 错误：SnowLuma WebSocket closed before opening`

**原因**：3001 端口没在监听（SnowLuma 没开，或正在启动）。

**解决**：打开 SnowLuma，等它扫码登录完成，桥接会自动重连。

### D2. 日志刷 `SnowLuma 连接断开（code=1006），重连中…`

**原因**：

- SnowLuma 崩了 / 被关了
- QQ 掉线（需要重新扫码）
- token 不对（WS 和 HTTP 是**两个不同的 token**）

**排查**：

```powershell
(Get-NetTCPConnection -LocalPort 3000 -State Listen) -ne $null
(Get-NetTCPConnection -LocalPort 3001 -State Listen) -ne $null
```

**解决**：重开 SnowLuma → 重新扫码 → 桥接自动恢复。若还不行，重跑 `install.ps1`（会重读 token）。

### D3. `⚠️ token 自愈失败（error {}）：连不上 OneBot HTTP API（http://127.0.0.1:3000）`

**原因**：3000 端口不通，桥接拿不到 token。

**解决**：先修好 SnowLuma 进程（D1/D2），再重启桥接。

### D4. `The QQ connection changed. Please restart QQ and try again.`

**出现位置**：`[sticker] 同步收藏表情失败: OneBot HTTP fetch_custom_face_detail 失败: ...`

**原因**：QQ 账号在 SnowLuma 里切换/重登，旧连接句柄失效。

**解决**：在 SnowLuma 重新登录该 QQ 号 → 桥接重连后重试；表情功能会自己恢复（不影响聊天）。

### D5. `snowluma.good=false`

**含义**：桥接连上了 SnowLuma，但 QQ 号不在线（掉线/被踢/风控）。

**解决**：

1. 打开 SnowLuma，看账号状态
2. 重新扫码登录
3. 若频繁掉线：降低发送频率（`socialV2.send.maxSendPerMinute`）、别用新号狂发

### D6. 群/私聊发消息没反应（收得到，发不出）

**原因**：白名单没放行，或目标不在白名单。

**解决**：`config.json`：

```json
{ "allow": { "groups": [123456], "private": [789012] } }
```

改完重启桥接。注意 `allowAllWhenEmpty: false` 时，**空数组 = 谁都不放行**。

---

## E. 能连上但不回话

> 这一段是最高频的「机器人不理我」。

### E1. 先看这三个开关

| 检查 | 怎么查 | 正常值 |
| --- | --- | --- |
| DSH 就绪 | `verify.ps1` 的 `[OK] DSH 就绪` | true |
| QQ 在线 | `verify.ps1` 的 `[OK] QQ 在线` | true |
| AI 是否被暂停 | `verify.ps1` 的 `AI 暂停` | 未暂停 |

### E2. **`social-v2.json` 里 `paused: true`**（最阴的坑）

**现象**：一切正常，就是不回。日志没有任何报错。

**原因**：二代仿真的社交状态文件里 `paused` 被置 true（可能是手动暂停、或保护性暂停）。

**排查**：

```powershell
Get-Content .\state\social-v2.json -Raw | Select-String 'paused'
```

**解决**：把 `paused` 和 `pausedByGuard` 都改成 `false`，重启桥接。

### E3. 白名单没命中

**现象**：私聊回、群里不回（或反过来）。

**原因**：`allow.groups` 里没有这个群号，或 `allow.private` 里没有这个人。

**解决**：加进去，重启。

### E4. 唤醒配置把它自己「睡死」了

**现象**：@ 它也不理，但上一轮它还在说话。

**原因**：AI 调用了 `qq_set_wake_config` 设了很长的潜水时间，或把触发条件全关了。

**解决**：

1. 控制台看 `socialV2` 状态
2. 手动 @ 一次并等它醒；或改唤醒配置（`/api/socialV2/...`，或控制台 UI）
3. 实在不行删 `state/social-v2.json` 里对应会话的 `wake` 段，重启

### E5. 消息发出去了，但 AI 被限流

**现象**：日志有 `会话繁忙，暂存唤醒原因`、`maxWakePerMinute`。

**原因**：`socialV2.wake.maxWakePerMinute` / `maxWakePerHour` 触发。

**解决**：调大这两个值，或等一会儿。

### E6. 群里人少 + `privateLimit.dailyPerUser`

**现象**：某个非管理员私聊用着用着不回了。

**原因**：`socialV2.privateLimit.dailyPerUser`（0 = 不限）。

**解决**：调成 0 或更大，重启。

### E7. 模型侧报错（余额/额度）

**现象**：日志里有 DSH 返回的错误，或控制台显示失败。

**解决**：检查 DSH 里的 DeepSeek 账号/额度。本项目**不存密钥**，钱和额度都在 DSH。

---

## F. 人设 / 角色

### F1. 第一次说话没弹「选人设」菜单

**原因**：

- `config.json` 里 `role.firstRunChoice = false`
- `state/role-setup.json` 已经存在且 `done: true`（之前选过了）
- 只在**私聊 + 管理员**才弹

**解决**：

```powershell
# 想再看一次菜单
Remove-Item .\state\role-setup.json
# 重启桥接后，用管理员私聊发一句话
```

### F2. `/role 名字` 说「角色不存在」，但文件明明在

**原因**：角色文件名带标注（例如 `小鲸鱼（已测试）.md`），而旧版只做精确匹配。

**解决**：新版本支持简写——`/role 小鲸鱼` 会自动匹配带括号标注的文件。
若用的是老版本，写全名：

```
/role 小鲸鱼（已测试）
```

### F3. 在群里发 `/role` 没反应 / 提示只有私聊能改

**原因**：

- 早期版本：`/role` 被限制为仅私聊
- 当前版本：群聊里**管理员**可以 `/role 名字` 锁定本群人设；非管理员一律拒绝

**解决**：确认你是 `ownerQQ`；群聊锁定要用管理员号在群里发。

### F4. 群聊里的人设「突然没了」

**原因**：`role.groupEnabled = false` 且该群没有被管理员显式锁定 → 群聊不注入人设。

**解决**：

- 群里 `/role 小鲸鱼` 锁一次
- 或把 `role.groupEnabled` 改 `true` 并设 `role.groupDefaultName`

### F5. 人设太长被截断

**原因**：`role.maxInjectChars` 限制（默认 32000）。

**解决**：调大它；或者把长内容放进 `〔按需：关键词〕` 小节（只有聊到才注入）。

### F6. 角色卡里的 `〔按需：…〕` 小节一直不生效

**原因**：关键词没命中。这些标记靠上下文里的词触发。

**排查**：看日志里注入的字符数变化；或临时把关键词写得更常见一点。

### F7. 管理员权限判断错乱（群主能命令它）

**原因**：`ownerQQ` 没设或设错。

**解决**：`config.json` 的 `ownerQQ` 必须是**你自己的 QQ 号**（数字），不是群号。

---

## G. 发消息 / 工具报错

### G1. `管理命令仅管理员可用。`

**原因**：非 `ownerQQ` 发了 `/` 开头的管理命令。

**解决**：这是设计如此。要放开就把号加进 `ownerQQ`（不建议）。

### G2. 工具报 `缺少会话令牌` / `token` 无效

**原因**：AI 调工具时没带 `token`（预设提示词被改过）。

**解决**：还原预设：

```powershell
git checkout -- dsh/agent-presets/
```

### G3. `send_group_msg` 失败：`retcode` 非 0

**常见原因**：

| retcode 现象 | 原因 | 解决 |
| --- | --- | --- |
| 被禁言/无权限 | 机器人在群里权限不足 | 给它管理员或换群 |
| 消息太长 | 超过 `maxMessageChars` | 调大或让它分条 |
| 频率限制 | 发太快 | 调小 `maxSendPerMinute` |
| 目标不存在 | 群号/QQ 号错 | 核对 |

### G4. 发出去的消息是空的 / 只有一个空格

**原因**：模型输出被过滤成空（例如全是 Markdown 符号）。

**解决**：看日志有没有「过滤后为空」；必要时调预设，让它输出纯文本。

### G5. 同一个问题被回很多遍

**原因**：多条唤醒并发 + 没做去重。

**解决**：调大 `socialV2.wake.batchWindowMs`；或降低 `triggerProbability`。

---

## H. 图片 / 语音 / 表情 / 转发

### H1. 图片看不到 / 说「图片超过了大小限制」

**原因**：`socialV2.media.maxModelBytes`（默认 1 MB）等限制。

**解决**：调大 `media.maxModelBytes` / `maxLongEdge`；或让它只描述不细看。

### H2. 语音发出去「没有声音」

**原因**（我们踩过）：源音频音量太低（例如 −34 dB）。

**解决**：

```powershell
ffmpeg -i in.mp3 -af "loudnorm=I=-16:TP=-1.5:LRA=11" out.mp3
```

仓库里的语音发送已做响度归一；**自己放进 `audio/` 的文件**要注意先转成正常音量。

### H3. GIF 表情被说成「一张九宫格照片」

**说明**：这是**抽帧拼图**（动图 N 帧 → 网格）。不是 bug。

### H4. 表情包列表是空的

**原因**：

- 收藏表情同步失败（见 D4）
- SnowLuma 那边没有收藏表情

**解决**：先在 QQ 里收藏几个；重连后桥接会重新同步。

### H5. 合并转发消息看不到内容

**原因**：只支持**当前会话确实收到过**的转发 id；嵌套转发要再查一层。

**解决**：让它用 `qq_get_forward_msg(id)` 逐层展开；老的转发过期就没了。

### H6. 点歌失败

**原因**：网易云接口风控/该曲无版权。

**解决**：换歌名加歌手名；过一会儿再试；音质选「普通」比「母带」成功率高。

---

## I. 控制台

### I1. 打开 `http://127.0.0.1:3100` 显示 `未经授权` / 401

**原因**：控制台需要 `X-Console-Token`。

**解决**：

```powershell
Get-Content .\state\console-token
```

浏览器里通常通过 URL 或登录页带 token；直接 curl 时：

```powershell
$t = Get-Content .\state\console-token -Raw
curl -H "X-Console-Token: $t" http://127.0.0.1:3100/api/status
```

### I2. 控制台能开，但 `/api/status` 401（脚本里）

**原因**：你从**另一份安装目录**跑脚本，读到的是那份目录里的旧 token。

**解决**：在**桥接实际运行的那个目录**下执行；或直接用 `verify.ps1`（已把 401 降级为警告）。

### I3. 控制台页面空白

**原因**：`public/console.html` 没随仓库拿到（早期 fork 缺文件），或浏览器缓存。

**解决**：

```powershell
git pull
# 强制刷新 Ctrl+F5
```

---

## J. 升级 / 版本兼容

### J1. DSH 升级后突然全不回

**原因**：DSH 的协议/提示词变量变了（我们踩过两次：`{{cwd}}` 被移除、inbox 位置从 `values.projections[id].values.inbox` 调整）。

**解决**：

1. `git pull` 拿最新预设与适配
2. 重新执行 DSH 端 preset 安装
3. 跑 `node scripts/verify-dsh-021-adaptation.mjs`（如果存在）

### J2. `schemastery` 版本变化导致配置项读到 `{get}` 对象

**现象**：测试报 `expected string, got object`。

**原因**：`schemastery 3.18.5` 的 `.extra('volatile', true)` 会把字段变成 accessor。

**解决**：读配置时用 `Config.toJSON()` 或 `meta.default`，不要直接读字段。

### J3. ffprobe 报 `Unrecognized option 'o'`

**原因**：老版 ffprobe（4.0.x）不支持 `-o` 输出参数。

**解决**：用 `-show_entries ... -of default=nw=1` 或直接解析 WAV 头；仓库脚本已改为后者。

### J4. CI 红了：`test-audit` 失败

**原因**：改动引入了缺失文件/断言不符。

**解决**：

```powershell
node scripts/test-audit.mjs
```

按提示修；本地先跑通再 push。

---

## K. 性能 / 资源

### K1. 桥接内存一直涨

**原因**：上下文/消息快照累积。

**解决**：调小 `socialV2.context.recentLimit` / `contextWindow`；定期重启（`restart.bat`）。

### K2. DSH 每轮都很慢

**原因**：

- 上下文太长（人设 + 快照 + 记忆一起塞）
- `reasoningEffort` 设太高

**解决**：

| 参数 | 建议 |
| --- | --- |
| `dsh.reasoningEffort` | `low` 或 `medium` |
| `role.maxInjectChars` | 别超过 32000，长卡用「按需」小节 |
| `socialV2.context.wakeMaxChars` | 调小 |

### K3. 本地跑 TTS/RVC 时显存/内存爆

**现象**：RVC 推理报 `OutOfMemoryError`（有时伪装成 `AttributeError: 'tuple' object has no attribute 'dtype'`）。

**解决**：

- 推理用 CPU：`QQBOT_RVC_DEVICE=cpu`
- 训练时别同时推理（3GB 显存不够）
- 关掉占显存的壁纸/游戏

### K4. `Torch not compiled with CUDA enabled`

**原因**：装别的包（如 speechbrain）时 torch 被换成 CPU 版。

**解决**：

```powershell
pip install --force-reinstall --no-deps <torch cu121 的 wheel>
```

---

## L. 看着像 bug、其实不是

| 现象 | 真实原因 |
| --- | --- |
| 群里它**不主动**搭话 | 二代是「潜水 + 条件唤醒」，默认概率 0.05，正常 |
| @ 它之后过了几秒才回 | 有拟人延迟（`activeReplyDelay*`），故意的 |
| 它一次发好几条 | 分条发送（`sendBurst`），故意的 |
| 它有时候「已读不回」 | 判定不需要参与，`markRead` 收尾，正常 |
| 人设听起来「没在演」 | 群聊可能没锁人设（`groupEnabled=false`） |
| 同一个梗它只用一次 | 提示词里明确要求「一次最多一个梗」 |
| 它不告诉你本机路径/配置 | 安全规则写死了，故意的 |
| 群主命令它无效 | 只有 `ownerQQ` 有管理权限，故意的 |

---

## 附：三条最快的定位路径

```
完全不回      → verify.ps1 → 看 dshReady / QQ 在线 / AI 暂停
偶尔不回      → 看 social-v2.json 的 paused、唤醒次数限制、白名单
回得不对      → 看人设是否注入（role 配置 + 当前角色状态）
```

## 附：把问题贴出来时请带上

1. `verify.ps1` 的完整输出
2. `logs/` 里最近 50 行
3. 你做了什么改动（config、预设、人设）
4. DSH 与 SnowLuma 的版本号

这样别人（或 AI）能少问你五轮。
