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
| M. 数据损坏与恢复 | [M](#m-数据损坏与恢复) |
| N. 鉴权与环境 | [N](#n-鉴权与环境) |
| O. 外部组件故障 | [O](#o-外部组件故障) |
| P. 运维与安全 | [P](#p-运维与安全) |
| Q. 升级迁移检查单 | [Q](#q-升级迁移检查单) |
| R. 杀软 / 安全软件干扰 | [R](#r-杀软--安全软件干扰) |
| S. 维护 / 隐私 / 风控 | [S](#s-维护--隐私--风控) |
| T. 安全事件与越权 | [T](#t-安全事件与越权) |

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

### A5b. `npm install` 末尾打印 `[qq-bridge] 依赖已就绪（不再修补任何第三方包）`

**这不是错误。** 2026-10-27 起 `postinstall` 只打印这一行：
`@snowluma/*` 依赖已移除（改用自带的 `src/onebot-ws.js`），仓库不再修改任何第三方包。

判断标准：**只要退出码是 0 就没问题**。真出错时 npm 会打印 `ELIFECYCLE` / `ERR!`。

### A8. `npm` 本身不存在（`npm : 无法将"npm"项识别为`）

**原因**：精简版/绿色版 Node 只带 `node.exe`；或 npm 目录没进 PATH。

```powershell
node -v          # 有版本 → node 在
where.exe npm    # 找不到 → 没有 npm
```

装官方 Node（自带 npm）后**重开终端**；临时救急只补 PATH：

```powershell
$env:Path = "C:\Program Files\nodejs;" + $env:Path
```

注意：`node scripts/preflight.mjs` 只依赖内置模块，没有 npm 也能跑。

### A9. PowerShell 拒绝执行脚本（`因为在此系统上禁止运行脚本`）

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass      # 只影响本次会话（推荐先试）
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned  # 影响当前用户
# 或者不改策略，调用时绕过：
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-bridge.ps1
```

> 桌面快捷方式内置了 `-ExecutionPolicy Bypass`：**双击能跑、终端里跑报错**就是这条。

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

### B3. 运行 `start-bridge.ps1` 窗口一闪就没了

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

### B5. 开机后机器人一直不回，日志里是 `[WAIT]/[FAIL] SnowLuma 还没起来`

**现象**：`state\logs\supervisor.log` 里有

```
[supervisor] [WAIT] SnowLuma 还没起来（:3000/:3001）。等它就绪，最多 600 秒…
[supervisor] [FAIL] 等了 600 秒 SnowLuma 仍未就绪。先把 SnowLuma 起来并登录…
```

**原因**：SnowLuma 没在跑（它是第三方程序，本项目**不代启** —— 设计不变量 L6），
而旧版守护等满 600 秒就 `exit 4`，偏偏它是由启动文件夹的 vbs 拉起的、没人重试 →
于是机器人一直不回，直到你手动跑一次。

**处置**：

1. 启动 SnowLuma 并扫码登录（WebUI `:5099`）。确认这两个端口在听：

   ```powershell
   Test-NetConnection 127.0.0.1 -Port 3000 -InformationLevel Quiet
   Test-NetConnection 127.0.0.1 -Port 3001 -InformationLevel Quiet
   ```

2. 如果守护已经退了，重新拉起：`powershell -File .\start-bridge.ps1 -StartDeps`
   （`-StartDeps` = 先把 SnowLuma/DSH 拉起来再起守护；默认不开，见 [LAUNCHER.md](docs/guides/LAUNCHER.md) 二·四）
3. **2026-10-27 起不需要这么麻烦了**：守护超时后不再退出，而是每 60 秒慢探一次，
   SnowLuma 一登录就自动启动桥接（`-SnowlumaPollSeconds 0` 可恢复旧行为）
4. DSH 端口在 SnowLuma 起来之前也可能变过 —— 顺手核对 `config.json` 的 `dsh.baseUrl`
   与 DSH 实际监听端口（本例：54694 → 65452，见 C1/C2）

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

### C3b. `dshReady=true` 但工具不对 / 行为像没接 QQ（preset 没装）

`qq-chat` 与 `qq-chat-v2` 这两个 preset 装在 **DSH 自己的 home** 里，不在本仓库：
只 clone 仓库、不装 preset，表现是「连得上、模式判断怪、AI 没有 QQ 工具」。

```powershell
node scripts/setup-dsh.mjs          # 幂等安装/更新 preset
node scripts/verify-adaptation.mjs  # 或 npm run verify:adaptation
```

换机器时最容易漏这一步（见 [docs/guides/MIGRATION.md](docs/guides/MIGRATION.md)）。

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

### E.0 先查「AI 是不是被暂停了」（2026-10 实测踩过，最容易被忽略）

```powershell
$h = @{ 'X-Console-Token' = (Get-Content .\state\console-token -Raw).Trim() }
(Invoke-RestMethod 'http://127.0.0.1:3100/api/socialV2/activity' -Headers $h).paused
```

- `True` ⇒ **群里/私聊都不回话是正常的**：暂停会停掉所有唤醒与 v2 工具调用
  （日志 `控制台：二代 AI 已暂停（唤醒/等待任务已停止）`，所有 v2 工具返回
  403「AI 已暂停，当前不允许执行 v2 工具」）。
- 恢复：控制台「二代 AI」页点继续，或 `POST /api/socialV2/activity {"paused":false}`。

> 为什么值得单列：这个状态**不报错、不写 WARN**，只看 `/api/status` 也看不出来
> （`dshReady` / `ws.connected` / `accountOnline` 全绿）。真实案例：机器人「沉默」
> 了一个多小时，排查方向全错在链路上。

### E.0b 再查「是不是模式/白名单挡住了」

`/api/status` 里的 `mode` 必须是 `reserved2`；`allow.groups` 里必须有那个群。
两者任一不对，表现同样是「连得上但一句话不说」。



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

### E.8 日志反复「会话繁忙，暂存唤醒原因」，AI 一句不回

**先分清是哪一种**（短时间反复出现 ≠ 故障）：

| 现象 | 判定 |
| --- | --- |
| 「会话繁忙」后几秒~几分钟内出现 `唤醒` / `工具统一发送` | ✅ **正常背压**：AI 这一回合还没结束，新唤醒在排队（不丢） |
| 10 分钟以上**没有任何**发送动作，`/api/status` 里 `dshReady` 却是 true | ⚠️ 回合卡住了，会话会一直忙到 30 分钟租约到期 |

一条命令拿事实（**别靠猜**）：

```bash
node scripts/diag-session-busy.mjs
```

输出会列出每个忙着的会话：忙的原因、回合已跑多久、`pendingWakeKey` 上锁多久、
30 分钟租约还剩多久、暂存了几条唤醒；「看起来卡住」时退出码为 1。

处置（副作用从小到大）：

1. **等**：30 分钟租约自动解除，日志会打「已按 30 分钟租约强制解除」（零副作用）
2. **切一次模式**：`reserved2 → chat → reserved2`，会清空全部 busy 标记与排队投递
3. **重启桥接**：`-Stop` 再起（内存队列会丢，`state/` 不受影响）

> ⚠️ 不要删 `state/social-v2.json`——那里是记忆/唤醒配置/未读水位。

完整机制、逐行日志解释、根因清单与预防：**[docs/guides/SESSION-BUSY.md](docs/guides/SESSION-BUSY.md)**。

## F. 人设 / 角色

### F.0 切人格报 400「角色「X」不存在」

2026-10 角色卡改成 **身份在文件里**（front matter 的 `id:`），历史上这里出过两类问题：

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `角色「小鲸鱼已测试」不存在` | 旧代码用 `sanitizeRoleName` 洗掉全角括号再拼文件名 | 已修（`POST /api/role` 走 `resolveExistingRole`）；确认代码是你当前的版本 |
| 切成功了但「不像那个人」 | state 里存的是显示名而不是 id → 注入时解析不到 | 跑 `node scripts/migrate-roles-to-ids.mjs --apply`，然后 `GET /api/status` 看 `roleId` 是否有值 |
| 改了文件名后绑定失效 | 文件里没有 `id:`，只能退回按文件名哈希 | 给卡补 front matter（`id:` + `name:`），再迁移一次 state |

判断依据：`GET /api/status` 同时给 `role`（显示名）与 `roleId`（id）。
`roleId` 为空 = state 里存的是名字，需要迁移。



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

### J0. 你的仓库版本和别人（上游/朋友）不一样

**现象**：同一份配置，别人能用你不能；或者你 clone 的版本比仓库说明的旧/新。

**为什么要专门查**：本项目依赖三个外部版本（DSH、SnowLuma、@snowluma/sdk），
任意一个差得远都可能报错；而 `compat.json` 记录的是**被验证过**的组合。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-versions.ps1
```

输出会逐项标 OK / WARN / FAIL：

| 结果 | 含义 | 处理 |
| --- | --- | --- |
| 全 OK | 与验证点一致 | 继续排查别的原因 |
| WARN | 能用但未验证（例如 DSH 小版本不同） | 留意 inbox 投影、提示词变量等变化 |
| FAIL | 不满足最低要求 | **先对齐版本**，否则别的排查都是白费 |

对齐方式：`git checkout <tag>` + `npm install`（会跑 postinstall 补 sdk）+ 按 SETUP.md 重装 DSH preset。

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

**解决**：调小 `socialV2.context.recentLimit` / `contextWindow`；定期重启（`.\start-bridge.ps1 -Stop` 再 `-Start`）。

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

---

## M. 数据损坏与恢复

> 这一段的思路统一是：**先备份 → 再验证 → 才修**。桥接对损坏文件是「只读不写」保护，不会静默覆盖。

### M1. 写接口返回 503：`xxx处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接`

**现象**：控制台/接口改黑话、改表情备注、改会话时返回 503，日志有
`⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘`。

**原因**：以下文件在**启动时**加载失败（JSON 语法坏、编码坏、被别的程序占用），桥接进入**只读降级**：
保留原文件不动，但拒绝写回，防止把「读失败的空对象」覆盖掉真实数据。

涉及文件（按用途）：

| 文件 | 用途 |
| --- | --- |
| `state/slang.json` | 群聊黑话库 |
| `state/stickers.json` | 收藏表情备注/标签 |
| `state/sessions.json` | 会话映射（DSH sessionId ↔ QQ 会话） |
| `state/initial-prompts.json` | 首次唤醒的初始提示缓存（存在时） |

**排查**（Windows PowerShell）：

```powershell
# 1) 找出哪个文件坏了
node -e "for (const f of ['slang','stickers','sessions','initial-prompts','social-v2','current-role','roles-by-key']) { const p=`state/${f}.json`; try { JSON.parse(require('fs').readFileSync(p,'utf8')); } catch(e) { if (require('fs').existsSync(p)) console.log('BAD', p, e.message); } }"
```

> 注意：**带 BOM 也会失败**。`Unexpected UTF-8 BOM` 就是这种。

**解决**：

1. 先备份坏文件：`Copy-Item state\slang.json state\slang.json.broken`
2. 三种修法，按代价从低到高：
   - **修语法**：用编辑器打开，删掉末尾多余逗号 / 补全括号 / 另存为「UTF-8 无 BOM」
   - **回退备份**：如果之前有 `.bak`（例如 `social-v2.json.bak-204831`），复制回去
   - **弃车保帅**：把坏文件改名挪走，让桥接重建一个空库（**会丢这部分数据**，聊天记录不受影响）
3. 重启桥接，确认日志里没有 `只读降级`

### M2. 磁盘写满（ENOSPC / `no space left on device`）

**为什么严重**：代码里对 `state/` 的处理原则是「**一次写满就变成永久丢失**」——所以宁可降级只读也不写半个文件。
但如果你在磁盘满的状态下重启，可能连新的 `state/` 都建不出来。

**排查**：

```powershell
Get-PSDrive D | Select-Object Used,Free
# state 目录里谁最大
Get-ChildItem state | Sort-Object Length -Descending | Select-Object -First 6 Name,Length
```

**常见的占空间项**：

| 文件 | 说明 |
| --- | --- |
| `state/token-usage.jsonl` | 逐次调用记录，会一直长（可清） |
| `state/bridge.log` / `.log.1` | 已自动轮转，但两份都不小 |
| `state/qq-activity.log` / `.log.1` | 同上 |
| `state/social-v2.json` | 会话状态 + 唤醒记录，可能很大 |
| `logs/`、`audio/` | 语音文件 |

**解决**：

```powershell
# 清调用记录（不影响运行）
Remove-Item state\token-usage.jsonl
# 清旧日志（保留当前）
Remove-Item state\*.log.1, logs\*.log.1 -ErrorAction SilentlyContinue
# 清过期语音（自行确认目录）
Get-ChildItem audio -Recurse -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item
```

**预防**：定期跑一次 `verify.ps1`（它会报日志目录不可写），并给 D 盘留 5 GB 以上。

### M3. 升级后 state 文件结构变了（未知字段 / 字段缺失 / 行为异常）

**现象**：升级桥接后，要么某些功能不生效，要么日志里出现「未知的配置字段」提示。

**原因**：桥接对 state/ 的读取是**宽松**的（缺字段取默认值），但**旧结构里被删掉的字段不会自动清理**，配置类字段还可能被 `clamp` 回合法范围（见 P4）。

**解决顺序**：

1. **先备份**（见 M4）
2. 启动一次，看日志有没有「未知字段 / 非法值」提示
3. 若只是配置项，改 `config.json` 对应值即可（无需删 state）
4. 若是 state 结构问题：把可疑文件改名挪走，让桥接重建，再手动把**关键内容**（例如 `roles-by-key.json` 里的角色分配）补回去

### M4. 备份与恢复（升级前必做）

**升级/大改前的备份清单**：

| 类别 | 路径 |
| --- | --- |
| 配置 | `config.json` |
| 人设 | `roles/*.md` |
| 会话状态 | `state/current-role.json`、`state/roles-by-key.json`、`state/role-setup.json`、`state/social-v2.json` |
| 数据 | `state/slang.json`、`state/stickers.json`、`state/sessions.json` |
| 鉴权 | `state/console-token` |
| 语音 | `audio/`（可选，可能很大） |
| 日志 | `logs/`、`state/*.log`（一般不用备） |

**一条命令备份**（PowerShell）：

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
$dst = "..\qq-bridge-backup-$ts"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item config.json $dst -Force
Copy-Item roles $dst -Recurse -Force
New-Item -ItemType Directory -Path "$dst\state" -Force | Out-Null
foreach ($f in 'current-role.json','roles-by-key.json','role-setup.json','social-v2.json','slang.json','stickers.json','sessions.json','console-token') {
  if (Test-Path "state\$f") { Copy-Item "state\$f" "$dst\state\" -Force }
}
Write-Host "备份到 $dst"
```

**恢复**：

1. 停桥接
2. 把备份文件复制回原位（**只覆盖你想恢复的**，别整目录覆盖，避免把新版本需要的文件冲掉）
3. 启动 → 跑 `verify.ps1` → 抽查：`/role` 列表、黑话查询、表情列表

> 备份目录建议放在**仓库外**，否则会被 `git status` 看到。

### M5. 怎么判断「我的数据到底丢没丢」

| 现象 | 结论 |
| --- | --- |
| 日志出现「只读降级 / 未覆盖原文件」 | **没丢**，原文件还在，只是不能写 |
| 你自己把文件改名挪走让它重建 | 那部分数据**丢了**（但有 `.broken` 副本可恢复） |
| `social-v2.json` 被写坏 | 会话状态会重建，**QQ 聊天记录本身不受影响**（在 QQ 侧） |
| 磁盘写满后重启失败 | 先腾空间再启动，通常能恢复 |

---

## N. 鉴权与环境

### N1. 桥接连 DSH 一直 401（`Unauthorized` / `invalid session`）

**桥接的鉴权方式**（理解这个才能排错）：

| 项 | 值 |
| --- | --- |
| 方式 | 用本机持久化签名密钥**离线铸造**一个会话 Cookie |
| Cookie 有效期（桥接铸造的） | **1 小时**，到期前主动重铸（纯本地 HMAC，不花网络往返） |
| DSH 侧允许的上限 | **30 天**（`issuedAt <= now < expiresAt`，且跨度 ≤ cookieMaxAgeDays） |
| 校验依赖 | Host 头（authority）必须和 `dsh.baseUrl` 一致 |

**排查顺序**：

```powershell
# 1) 端口对不对（DSH 重启会换端口）
node -e "const c=require('./config.json');console.log(c.dsh.baseUrl)"
# 2) 直接探一下
curl -i http://127.0.0.1:<端口>/
```

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 401 且端口正确 | 签名密钥变了（**DSH 重装/换用户目录**会换密钥） | 重跑 `install.ps1`（会重新发现 token / 重新铸造） |
| 401 且 Host 不符 | 用 `localhost` 配的，但 DSH 只认 `127.0.0.1`（或反之） | 统一成 `http://127.0.0.1:<port>` |
| 401 只在重启后出现一次 | Cookie 过期后重铸的瞬间 | 正常，重试即可 |
| 一直 401 | `config.json` 里 `dsh.authToken` 是旧的 | 清空它，让桥接自己发现 |

### N2. 系统时间不对（最容易忽略的坑）

**为什么致命**：Cookie 的校验逻辑是 `issuedAt <= now < expiresAt`。**本地时钟快/慢 10 分钟以上**就会：
- 铸出来的 Cookie 立刻「未生效」或「已过期」→ 401
- 访问 HTTPS 外部服务（搜索、TTS）时报证书错误

**排查**：

```powershell
w32tm /query /status
Get-Date
```

**解决**：

```powershell
# 管理员 PowerShell
w32tm /resync
# 不行就重新指定时间源
w32tm /config /manualpeerlist:"time.windows.com,0x8" /syncfromflags:manual /update
Restart-Service w32time
```

### N3. 设置了代理，桥接连不上本机服务

**现象**：`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 设了代理，之后所有 `127.0.0.1` 请求都被送进代理 → 超时或 502。

**原因**：Node 的某些 HTTP 客户端会读这些环境变量（`NO_PROXY` 没配就会代理 localhost）。

**解决**：

```powershell
# 临时：本次会话排除本机
$env:NO_PROXY = "127.0.0.1,localhost,::1"
$env:no_proxy = $env:NO_PROXY
# 永久（用户级）
setx NO_PROXY "127.0.0.1,localhost,::1"
```

然后**重启桥接**（环境变量在进程启动时读）。

### N4. Windows 防火墙 / 杀软拦截

**现象**：本机 `curl` 通、但桥接连不上；或 Node 首次运行时弹窗被点了「阻止」。

**排查**：

```powershell
# 端口是否真的在监听
Get-NetTCPConnection -LocalPort 3000,3001,3100 -State Listen -ErrorAction SilentlyContinue
# 防火墙规则里有没有拦 Node
Get-NetFirewallRule -Enabled True -Direction Inbound | Where-Object DisplayName -like '*node*'
```

**解决**：给 `node.exe` 放行（专用网络即可），杀软把项目目录加白名单。

### N5. IPv6 / DNS 解析问题

**现象**：`ECONNREFUSED ::1:3001`，但 `127.0.0.1:3001` 是通的。

**原因**：`localhost` 可能先解析成 `::1`，而 SnowLuma/DSH 只监听 IPv4。

**解决**：**配置里一律写 `127.0.0.1`，不要写 `localhost`**（仓库默认值就是这样）。

---

## O. 外部组件故障

### O1. 三个内置 MCP server 起不来

桥接会挂三个 MCP server（`src/` 下）：

| 文件 | 作用 | 起不来会怎样 |
| --- | --- | --- |
| `mcp-snowluma-safe.js` | QQ 相关工具（发消息、看图、表情…） | AI 没有 QQ 工具，只能空谈 |
| `mcp-host-server.js` | 宿主能力（控制台/远程调用） | 控制台部分功能失效 |
| `mcp-web-search-safe.js` | 联网搜索 | 搜索类问题答不了 |

**排查**：

```powershell
# 单独起一个看报错
node src\mcp-snowluma-safe.js
```

**常见原因**：

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `ERR_MODULE_NOT_FOUND` | 依赖没装全 | `npm install` |
| 启动即退出、无输出 | 端口/stdio 被占用 | 关掉重复进程 |
| DSH 里看不到工具 | preset 没装 / MCP 没挂 | 重跑 DSH 端安装（见 SETUP.md） |

### O2. 联网搜索失败

**现象**：问实时问题，AI 说「搜不到」或工具报错。

**排查顺序**：

| 检查 | 命令/位置 |
| --- | --- |
| 有没有配 key | `config.json` → `webSearch.apiKey` / 环境变量 `DEEPSEEK_API_KEY` |
| key 是否有效 | 日志里找 401 / `invalid api key` |
| 是否被限流 | 日志里找 429 / `rate limit` |
| Bing 兜底是否可用 | 断网/被墙时兜底也会失败 |

**解决**：

- key 失效 → 换新 key，或让用户自己在 DSH 侧配置
- 限流 → 降低 `webSearch.maxUses`，等一会儿再试
- 完全连不上外网 → 属网络问题，不是本项目能修的

> 说明：搜索失败**不会**影响聊天，只是那一类问题答不了。

### O3. ASR（语音转文字）不工作

**现象**：QQ 语音条只显示 `[语音]`，没有转写文字。

**原因**：ASR 是**可选**组件（`scripts/asr_server.py` + 本地 faster-whisper），不装就退回 `[语音]`。

**排查**：

```powershell
python --version
pip show faster-whisper
```

**解决**：

```powershell
pip install faster-whisper
# 启动（如果项目有守护脚本就按脚本启动）
python scripts\asr_server.py
```

失败也不致命：聊天照常，只是语音转不了文字。

### O3b. 长图 OCR 不出文字 / 报 `no-lang`

**现象**：模型说「图片里的字看不清」，或日志里 `[ocr] 图片N 未取到文字（no-lang）`。

**为什么**：OCR 用的是 Windows 自带引擎（`Windows.Media.Ocr`），需要系统装**对应语言的识别包**。
不装的话引擎创建失败，桥接会自动退回切片（不崩），但长图会多花好几倍 token。

**查**：

```powershell
# 看装了哪些 OCR 语言
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }
```

**修**：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 确认装了「光学字符识别」/
「基本键入」组件；装完重启桥接（引擎在进程内缓存过一次探测结果）。

**如果系统就是装不上**：接受降级即可 —— 长图会自动切片，模型照样能看图，只是更贵。
也可以用 `mode=image` 显式要求"只看图"，省掉一次 OCR 尝试。

### O4. 外部语音工具（仓库外）坏了没人兜底

**说明**：语音合成/翻唱这类重活可能被拆到仓库外的独立目录（例如 `../voice-tool/`）。
**它不在本仓库里**，所以：

- 装不上/报错 → 到那个目录单独排查
- 不想用 → 关掉相关功能（`socialV2.voice.enabled` 或对应命令），不影响聊天

### O5. DeepSeek 平台级 429（和本地限流是两回事）

**区分**：

| 429 来源 | 特征 | 处理 |
| --- | --- | --- |
| **本地唤醒限流** | 日志有 `会话繁忙`、`maxWakePerMinute` | 调大 `socialV2.wake.*` |
| **平台限流** | 日志里有 DSH 返回的错误体、`429 Too Many Requests` | 降频、等额度恢复、换 key/账号 |

**解决方向**：减少主动发言（`proactiveProbability` 调低）、缩短上下文、错峰。

---

## P. 运维与安全

### P1. 两个桥接抢同一个 SnowLuma / 同一个 QQ

**现象**：消息时有时无、回复重复、`The QQ connection changed`。

**原因**：跑了两个桥接实例（例如旧进程没死 + 新进程），或者两份安装目录各起一个。

**排查**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge.js*' } |
  Select-Object ProcessId, CommandLine
```

**解决**：

1. 只留一个（其余 `Stop-Process`）
2. 需要多实例时，**每个实例必须用不同的 QQ 号 + 不同的 SnowLuma token**
3. 想固定端点不被自愈覆盖：

```json
{ "snowluma": { "followDiscoveredEndpoint": false } }
```

> 语义：`false` = 只更新 token、**不改 URL**。适合你手动指定了 ws/http 地址、不希望被自动发现改掉。

### P2. 日志无限增长

**现状**：`state/bridge.log`、`state/qq-activity.log` 会**自动轮转**成 `.log.1`（保留上一份）。
`state/token-usage.jsonl` **不会轮转**，会一直长。

**清理**：

```powershell
# 清调用记录（安全，不影响运行）
Remove-Item state\token-usage.jsonl -ErrorAction SilentlyContinue
# 清上一代日志
Remove-Item state\*.log.1, logs\*.log.1 -ErrorAction SilentlyContinue
```

**预防**：把这条加进计划任务，每周跑一次。

### P3. 进程崩溃后怎么恢复

**现状**：桥接有未捕获异常处理器（会记日志再退出），但**不会自动重启**。

**恢复**：

```powershell
# 1) 看最后发生了什么
Get-Content state\bridge.log -Tail 60
# 2) 起回来
.\start-bridge.ps1
# 3) 体检
powershell -ExecutionPolicy Bypass -File .\verify.ps1
```

**要自动拉起**：用 `start-bridge.ps1 -InstallStartup`（计划任务 / 启动文件夹），或直接用
`start-bridge.ps1` —— 它的守护本身就会退避重启（不需要再写看门狗）。契约见
[docs/guides/LAUNCHER.md](docs/guides/LAUNCHER.md)。

### P4. 配置值被「静默收敛」，你以为生效了其实没有

**现象**：`config.json` 里写了很大的值，行为却没变。

**原因**：启动时会做**合法化**（clamp）：

| 字段类 | 规则 |
| --- | --- |
| 毫秒/次数类 | 非负取整 |
| 概率类 | 收敛到 0~1 |
| `media.maxBytes` / `maxPixels` / `maxCount` | 有默认上限（8 MB / 6400 万像素 / 5），缺失或非法会回落到默认 |
| `voice.maxSeconds` / `maxBytes` | 非法值回落到 300 秒 / 20 MB |
| `role.maxInjectChars` | 超长会被截断到该值 |

**怎么确认**：启动后看控制台 `/api/status` 或日志里打印的生效值；也可以让你的模型报一下当前配置。

**解决**：把值改到合法范围内，再重启。

### P5. 安全事件处置

| 事件 | 立即做 | 之后 |
| --- | --- | --- |
| **token 泄露**（发到群里/截图里） | 控制台/配置里换 `consoleToken`；SnowLuma 换 access token；重启 | 查 `logs/` 有没有异常调用；必要时把机器人踢出相关群 |
| **机器人被拉进恶意群刷屏** | 从 `allow.groups` 移除该群；重启 | 观察是否有异常 token 消耗 |
| **被人冒充管理员下指令** | 确认 `ownerQQ` 只有自己；查看命令日志 | 在群里说明「只有管理员能改设置」 |
| **配置文件外泄**（含 QQ 号） | 换 token；检查 git 历史有没有提交 | `git log -S <token>` 排查 |

> 本仓库安全默认：群友**没有**任何管理权限；只有 `ownerQQ` 能改配置/换人设/发动态。

### P6. 依赖漏洞（npm audit）

```powershell
npm audit
npm audit fix          # 小心：可能升级大版本
```

**原则**：

- 生产环境（自己天天用）**先备份再升级**
- 升级后必须跑 `node scripts/test-audit.mjs` + `verify.ps1`
- 高危且无法修的，评估是否真的用到那个依赖路径

---

## Q. 升级迁移检查单

升级前：

```
[ ] 按 M4 备份（config / roles / state 关键文件）
[ ] 记录当前 commit：git rev-parse --short HEAD
[ ] 记录 DSH 版本、SnowLuma 版本
[ ] 跑一次 verify.ps1，留一份「升级前」的输出
```

升级：

```
[ ] git pull
[ ] npm install（依赖可能变）
[ ] 若有 DSH 端改动：重跑 preset/MCP 安装
[ ] 重启桥接
```

升级后：

```
[ ] verify.ps1 → 期望退出码 0
[ ] /role 列表正常、当前人设没丢
[ ] 群里 @ 一次能回
[ ] 抽查：看图 / 表情 / 语音 / 搜索 各一次
[ ] 看日志 5 分钟，无反复报错
```

出问题回滚：

```
[ ] git checkout <升级前的 commit>
[ ] 从 M4 的备份恢复 config 与 state
[ ] npm install && 重启
```

---

## 附：这次审计补进来的缺口（自查表）

| 缺口 | 现在在哪 |
| --- | --- |
| state JSON 损坏 / 只读降级 503 | M1 |
| 磁盘写满 ENOSPC | M2 |
| 升级后 state 结构迁移 | M3 |
| 备份 / 恢复 | M4 |
| Cookie 生命周期 / 密钥轮换 / 持续 401 | N1 |
| 系统时间错误 | N2 |
| 代理变量污染 localhost | N3 |
| 防火墙 / 杀软 | N4 |
| IPv6 / DNS | N5 |
| 三个 MCP server 故障 | O1 |
| 联网搜索失败 | O2 |
| ASR（Python） | O3 |
| 仓库外语音工具 | O4 |
| 平台级 429 | O5 |
| 多实例 / 多账号冲突 | P1 |
| 日志增长 | P2 |
| 崩溃恢复 | P3 |
| 配置被静默收敛 | P4 |
| 安全事件处置 | P5 |
| npm audit | P6 |
| 升级检查单 | Q |

---

---

## R. 杀软 / 安全软件干扰

> **典型症状：关掉卡巴斯基（或 360/火绒）就正常，开着就不正常。**
> 目标不是关杀软，而是**给本项目加排除项**。
> 完整图形界面步骤见 **[docs/guides/KASPERSKY.md](docs/guides/KASPERSKY.md)**。

### R1. 自动诊断（先跑这个）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\kaspersky-diagnose.ps1
```

它会打印：杀软是否在跑、各端口是否可达、外网 HTTPS 延迟，以及**该加进排除项的具体路径**（自动探测的）。
退出码：`0` 正常、`2` 需要补排除项、`1` 有失败项。

### R2. 该排除哪些

| 路径 | 原因 |
| --- | --- |
| DSH 安装目录（如 `D:\DEEPSEEK`） | 实时扫描拖慢启动与资源加载 |
| `C:\Users\<你>\.dsh` | 会话/附件高频读写 |
| 项目目录（桥接） | 日志与状态文件高频写 |
| 所有 `node.exe` | DSH 运行时、系统 Node、SnowLuma |
| `ffmpeg.exe` / `ffprobe.exe` | 常被启发式误判 |
| SnowLuma 目录、`QQ.exe` | QQ 协议端 |

**比排除项更有效的是「受信任应用程序」**：给这些 exe 勾上
「不扫描所有流量 / 不监控应用程序活动 / 允许所有网络活动」。

### R3. 症状 → 大概率原因

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| DSH 启动慢、界面卡 | 实时扫描安装目录 | 排除 DSH 目录 |
| DSH 页面能开但 AI 不回 | localhost 流量被扫 / 防火墙拦 | 受信任应用 + 放行 node.exe 网络 |
| `dshReady=false` 但 DSH 明明开着 | 同上 | 同上 |
| 偶发证书错误（`self signed certificate`） | 「加密连接扫描」解密 | 受信任地址加 `127.0.0.1`，或关掉该功能 |
| 语音/视频处理被拦或极慢 | ffmpeg 被误判 | 排除 ffmpeg/ffprobe |
| 弹「程序行为可疑」 | 系统监视器/入侵防御 | 把 node.exe 加受信任 |
| **卡巴免费版根本找不到排除项** | 免费版不提供该功能 | 见 [docs/guides/KASPERSKY.md](docs/guides/KASPERSKY.md#️-重要前提kaspersky-免费版没有排除项)：升级 / 换 Defender / 取消自动删除 |

### R4. 命令行能做什么、不能做什么

`avp.com`（Kaspersky 21）**不支持命令行加排除项**：

```
HELP SCAN UPDATE ROLLBACK RENEW FEATUREFLAGS START STOP
STATUS STATISTICS EXPORT IMPORT AcceptEULA REPORT FASTFAIL SHOWTM PROXYAUTH EXIT TRACES
```

所以排除项必须**图形界面加一次**。脚本能做的是诊断 + 冒烟测试 + 打印路径。

### R5. 验证「不关杀软也能跑」

```powershell
# 1) 确认杀软在跑
Get-Service AVP21.25

# 2) 诊断（期望退出码 0）
powershell -ExecutionPolicy Bypass -File .\scripts\kaspersky-diagnose.ps1

# 3) 真实聊天：管理员私聊机器人发「你好」，应能回复
```

通过标准：杀软 Running + `dshReady=true` + `snowluma.good=true` + 外网 HTTPS < 3s + 发消息有回复。

### R6. 排不掉怎么办

1. 卡巴托盘 → **暂停保护 15 分钟**做对照：
   - 暂停后正常 → 100% 是杀软，回到 R2 补路径
   - 暂停后仍异常 → 不是杀软，去看 [C](#c-连-dsh) / [E](#e-能连上但不回话)
2. 卡巴 → 报告 → 找被拦条目，看它拦的是哪个 exe / 路径 / 端口
3. 把三样贴出来：诊断输出 + 拦截报告 + `logs/` 最近 50 行

---

---

## S. 维护 / 隐私 / 风控

> 完整运维手册见 **[docs/OPERATIONS.md](docs/OPERATIONS.md)**。这里只列会「突然出问题」的几条。

### S1. 备份里有明文令牌

**现象**：你把 `state/` 或整目录压缩发给了别人 / 传上网盘。

**风险**：`state/console-token`、`config.json` 的 `snowluma.accessToken` 都是明文，等于把控制台和 QQ 网关交出去。

**正确做法**：

```powershell
.\scripts\maintain.ps1 -Apply -Backup    # DPAPI 加密备份，只有本机+当前用户能解密
```

跨机灾备（DPAPI 解不开）见 [OPERATIONS.md#跨机器灾备](docs/OPERATIONS.md#跨机器灾备换电脑--重装系统)。

**已经泄露了怎么办**：立刻 `.\scripts\maintain.ps1 -Apply -RotateConsoleToken` → 在 SnowLuma 重置 OneBot token → 重启。

### S2. 日志里有群友聊天内容

**现象**：想发日志求助，但里面全是群友原话和 QQ 号。

**解决**（脱敏后再发）：

```powershell
$log = Get-Content state\bridge.log -Raw
$log = $log -replace '\b\d{6,12}\b', '<QQ>' -replace '你的管理员号', '<OWNER>'
$log | Set-Content state\bridge.redacted.log -Encoding UTF8
```

**保留期**：建议 7 天，用 `.\scripts\maintain.ps1 -Apply -TrimLogs -KeepLogDays 7`。

### S3. 机器人号被风控 / 封禁

| 现象 | 性质 | 处理 |
| --- | --- | --- |
| 频繁掉线、`snowluma.good=false` 反复出现 | 会话失效或轻度风控 | 重新扫码；把 `send.maxSendPerMinute` 降到 2~3 |
| 登录要验证码/滑块 | 风控 | 人工过验证，24 小时内别高频 |
| 明确提示账号被限制 | 平台处罚 | **只能申诉**，代码层面无解 |

**立刻要做**：停桥接（别一直重试登录）→ 查 `state/qq-activity.log` 看被封前发了什么 → 降频后再试。

详见 [OPERATIONS.md#账号封号--风控](docs/OPERATIONS.md#账号封号--风控)。

### S4. 唤醒变慢 / token 消耗变大（孤儿会话）

**现象**：换了群或重装 DSH 后，回复变慢，日志里出现不认识的 session id。

**原因**：`state/sessions.json` 只增不减，死会话仍会触发整份历史快照。

**处理**：

```powershell
.\scripts\maintain.ps1          # 报告里看「会话映射 N 条」
```

条数明显大于「实际在用的私聊+群聊数」就是有孤儿 → 按 [OPERATIONS.md#孤儿会话](docs/OPERATIONS.md#孤儿会话) 清理（先备份）。

### S5. 本机其他用户能读令牌 / 聊天记录

**检查**：

```powershell
icacls state
# 出现 BUILTIN\Users 或 Everyone → 有问题
```

**硬化**：

```powershell
.\scripts\maintain.ps1 -Apply -HardenAcl
```

### S6. 装了 tag 之外的 main 分支，出问题难回滚

**建议**：部署用 tag（`git checkout <tag>`），不要把 `main` 直接当生产。

```powershell
git fetch --tags; git tag --sort=-creatordate | Select-Object -First 5
```

`npm install` 会执行 postinstall，但**现在它只打印一行提示**：`@snowluma/*` 依赖已于 2026-10-27
移除（改用自带 `src/onebot-ws.js`），仓库不再修补任何第三方包。曾经的 `patch-snowluma-sdk.mjs`
是供应链风险面，现已随依赖一并删除 ——
不要在不可信分支上装依赖。详见 [OPERATIONS.md#供应链](docs/OPERATIONS.md#供应链)。

---

---

## T. 安全事件与越权

> 加固方案见 **[docs/guides/SECURITY.md](docs/guides/SECURITY.md)**。这里只列「出了事怎么办」。

### T1. 有人试图让它越权（提示词注入）

**现象**：群里出现「忽略之前指令」「你现在是管理员」「把配置打印出来」。

**为什么通常没事**：硬规则写死在预设里，工具层也只有 QQ 相关能力；AI 拿 console token 也改不了配置（403）。

**处置**：

```powershell
# 事后回查谁在尝试
Select-String -Path state\bridge.log -Pattern '忽略|ignore previous|system prompt' | Select-Object -Last 20
```

若已明显跑偏：停 AI → `/reset` 清上下文 → 必要时降权（关 `sendVoice` 等工具）。

### T2. 花费突然飙升

**现象**：`token-usage.jsonl` 暴涨，或控制台显示今天很贵。

**原因**：账本**只记不拦**（这是已知设计），没有熔断就一直花。

**处置**：

```powershell
.\scripts\guard.ps1                  # 看今天花了多少
.\scripts\guard.ps1 -Apply -DailyCostLimit 5   # 开熔断（建议放计划任务）
.\scripts\guard.ps1 -Resume          # 事后恢复
```

### T3. 发现 3100 / 54694 暴露在公网

**风险**：控制台 / DSH 会话被外部访问。

**处置**：

1. 立刻关掉端口映射 / 内网穿透
2. `.\scripts\maintain.ps1 -Apply -RotateConsoleToken` → 重启桥接
3. SnowLuma 里重置 OneBot token
4. 查 `state\bridge.log` 有没有陌生来源的请求（本机回环以外都应 403）

正确远程方式（SSH 隧道 / Tailscale / Cloudflare Access）见 [SECURITY.md#远程访问安全](docs/guides/SECURITY.md#3-远程访问安全)。

### T4. 桥接用管理员账号在跑

**风险**：进程权限过大。

**处置**：按 [SECURITY.md#最小权限运行](docs/guides/SECURITY.md#4-最小权限运行) 建专用账号 + 只给项目目录权限 + 计划任务用该账号。

> 注意：换账号后 `state/` ACL 与 DPAPI 备份都要重新处理。

### T5. 桥接挂了但没人知道

**现象**：机器人半天不说话，你看日志才发现进程早退了。

**处置**：配外部看门狗（走 SnowLuma OneBot HTTP，不依赖桥接进程），见 [SECURITY.md#主动告警](docs/guides/SECURITY.md#5-主动告警)。

### T6. Linux 上装完就 DSH 401（curl 打 DSH 却是通的）

**现象**：`systemctl status qq-bridge` 正常、`curl http://127.0.0.1:3080` 也通，但桥接日志里是 DSH 鉴权失败 / 「铸造 cookie 失败」/ 会话起不来。

**根因**：桥接默认用 DSH 的**本机签名密钥**离线铸造 cookie：

```
$DSH_HOME/.credentials.yaml        # DSH_HOME 默认 = ~/.dsh
```

`install-server.sh` 把服务降权成 `qqbridge` 后：

| 连带问题 | 后果 |
| --- | --- |
| 服务进程 `HOME=/home/qqbridge` | 去 `/home/qqbridge/.dsh` 找凭据，不存在 |
| `.credentials.yaml` 是 `600 root:root`、`/root` 是 `700` | 路径指对了也读不到 |

所以「**curl 通、桥接 401**」是典型指纹：curl 用你的身份，桥接用 `qqbridge`。

**先确认**：

```bash
sudo ./deploy/verify-server.sh | grep 'DSH 凭据'
# 好的：[OK]   DSH 凭据   qqbridge 可读 .dsh/.credentials.yaml
# 坏的：[FAIL] DSH 凭据   qqbridge 读不到 /root/.dsh/.credentials.yaml（…）
```

**处置**（最小授权，别整目录 777）：

```bash
sudo setfacl -m u:qqbridge:--x /root            # 只给穿越，不给 ls
sudo setfacl -m u:qqbridge:--x /root/.dsh
sudo setfacl -m u:qqbridge:r-- /root/.dsh/.credentials.yaml
systemctl show -p Environment --value qq-bridge | tr ' ' '\n' | grep DSH_HOME   # 应为 /root/.dsh
sudo systemctl restart qq-bridge
```

或直接重跑 `sudo ./deploy/install-server.sh --owner-qq <号> --dsh-home /root/.dsh`（脚本会探测、授权、并**以 qqbridge 身份实测**）。

**例外**：DSH 不在本机（`dsh.baseUrl` 非回环）时，本机密钥铸造本来就不成立 —— 别改权限，改填 `dsh.authToken`。

详见 [SERVER.md#降权之后必须补的那份访问dsh-凭据](docs/guides/SERVER.md)。

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
