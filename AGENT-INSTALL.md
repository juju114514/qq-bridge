# 让 AI 帮你装：AGENT-INSTALL

> 这份文件是给**另一个 AI agent**（比如 DSH 自己）看的安装清单。
> 每一步都有：命令、期望输出、失败怎么办、什么时候必须停下来问人。

## 0. 你能做什么、不能做什么

| 能做 | 不能做 |
| --- | --- |
| 检查环境、装依赖、写配置、启动、验收 | 替人登录 DeepSeek、替人扫码登录 QQ |

**两个必须由人做的动作**（遇到就停下，明确告诉人做什么）：

1. 打开 DeepSeek Harness（DSH）并用**自己的** DeepSeek 账号登录
2. 打开 SnowLuma 并**扫码登录自己的 QQ 小号**

## 1. 前置检查（只读，不修改任何东西）

依次执行，任一失败就按「失败怎么办」处理。

### 1.1 Node 版本

```powershell
node --version
```

- 期望：`v22.13.0` 或更高（如 `v24.x`）
- 失败：没有 node 或版本低 → 让人装 Node 22 LTS：
  <https://nodejs.org/en/download>，装完重开终端再验一次

### 1.2 DSH 是否在跑

```powershell
# 找 DeepSeek Harness 进程监听的端口
$pids = (Get-Process | Where-Object { $_.ProcessName -like '*DeepSeek*' }).Id
Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } |
  Select-Object LocalPort
```

- 期望：至少一个端口（例如 `54694`）
- 失败：没有任何端口 → 让人**打开 DeepSeek Harness 并登录**，再重跑

### 1.3 SnowLuma 是否在跑

```powershell
(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) -ne $null
(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) -ne $null
```

- 期望：两个都 `True`
- 失败：让人**打开 SnowLuma 并扫码登录 QQ 小号**，再重跑

## 2. 装依赖

```powershell
npm install
```

- 期望：结束时有 `added N packages` 或 `up to date`，且 `node_modules\@snowluma\sdk` 存在
- 失败：

| 现象 | 处理 |
| --- | --- |
| 网络超时 | 换镜像重试：`npm install --registry=https://registry.npmmirror.com` |
| postinstall 报 `node is not recognized` | 把 node 目录加进本次会话 PATH 后重跑 `npm install` |
| `ERR_MODULE_NOT_FOUND js-yaml` | 依赖没装全，重跑 `npm install` |

## 3. 一条命令装好

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -OwnerQQ <管理员的QQ号>
```

- `-OwnerQQ` 必填；只有这个号能用管理命令
- 可选：`-Groups "123,456"`、`-Privates "789"`（允许的群/私聊，留空=都不放行）
- 可选：`-DshUrl http://127.0.0.1:PORT`（自动探测失败时手动指定）
- 可选：`-SnowlumaWs ws://127.0.0.1:3001`、`-Token <access_token>`
- 可选：`-NoStart`（只写配置，不启动）

脚本会自动：探测 DSH 端口 → 探测 SnowLuma 端点与 token → 从 `config.example.json`
生成 `config.json` → 启动桥接 → 轮询 `/api/status` 做健康检查。

- 期望输出包含：

```
[ok] Node v24.x
[ok] DSH 端口 54694
[ok] SnowLuma 3000/3001 可达
[ok] 已写 config.json
[ok] 桥接已启动 PID=xxxx
[ok] dshReady=true snowluma.good=true
```

- 失败：

| 现象 | 处理 |
| --- | --- |
| `[x] 探测不到 DSH` | 回到 1.2，确认 DSH 窗口开着；或用 `-DshUrl` |
| `[x] SnowLuma 不可达` | 回到 1.3，确认 SnowLuma 开着；或用 `-Token` |
| `[x] dshReady=false` | DSH 没登录，或 `config.json` 里 `dsh.baseUrl` 不对 |
| `[x] snowluma.good=false` | QQ 掉线（SnowLuma 重新扫码） |

## 4. 验收（必须真的验，不要只看日志）

最快的方式：

```powershell
powershell -ExecutionPolicy Bypass -File .\verify.ps1
```

退出码 `0` = 全通过；`2` = 有警告但可用；`1` = 有致命问题（看它标 `[FAIL]` 的那几行）。

手工方式：


```powershell
# 1) 控制台活着
curl http://127.0.0.1:3100/api/status

# 2) 两个上游都就绪（带 console token）
$tok = Get-Content .\state\console-token -Raw
curl -H "X-Console-Token: $tok" http://127.0.0.1:3100/api/status
```

- **通过标准**：JSON 里 `dshReady: true` 且 `snowluma.good: true`
- 不给 `X-Console-Token` 时返回 401 属于正常（控制台需要鉴权）

## 5. 真实对话验收

告诉人：

1. 用**管理员 QQ** 私聊机器人，随便发一句（例如「你好」）
2. 机器人应该先回：

```
第一次用，先定个人设吧（回数字就行）：
1. 用默认人设（小鲸鱼/大肥鱼）
2. 新建一个（你说性格，我写卡）
3. 不用人设，按默认说话
```

3. 回 `1` → 用仓库自带的默认角色卡
4. 再发一句普通聊天 → 机器人应正常回复

- 失败：QQ 上完全不回 → 先看 `logs/bridge-*.log`，再查 `dshReady` / `snowluma.good`

## 6. 装完要知道的三件事

| 事实 | 说明 |
| --- | --- |
| 人设按会话隔离 | 私聊和群聊各用各的；`/role` 只有管理员能用 |
| 管理命令只有管理员 | 其它人发 `/xxx` 会收到「管理命令仅管理员可用」 |
| 默认群聊不注入人设 | 想让群聊带人设：管理员在群里发 `/role 名字` 锁定 |

## 7. 出问题时的排查顺序

> 完整错误清单见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（96 条，按阶段索引）。

### 排查顺序

```
1. curl /api/status        → 桥接活着吗
2. dshReady 字段           → DSH 连上了吗
3. snowluma.good 字段      → QQ 在线吗
4. logs/ 最新日志          → 具体报错
5. node scripts/check-onebot-status.mjs  → SnowLuma 自身状态
```

## 8. 绝对不要做的事

- ❌ 不要把 `config.json`、`state/`、`logs/` 提交进 git（已有 .gitignore）
- ❌ 不要替人填别人的 QQ 号 / token
- ❌ 不要在没装 DSH 或 SnowLuma 的情况下声称「装好了」
- ❌ 不要修改 `roles/` 里的角色卡去「测试」——用 `/role` 切换
