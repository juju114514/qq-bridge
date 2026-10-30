# AGENTS.md

> 给 **AI coding agent** 的入口文件。人类看 [README.md](README.md)。
> 你（AI）被要求"装这个项目 / 修这个项目"时，**先读本文件**，再按需读链接。

## 两件必须先读的事

1. **兼容与适配**：环境/版本/协议对不上时，按 [COMPAT.md](COMPAT.md) 的「硬契约 + 适配步骤」改，
   不要自由发挥。机器可读的矩阵在 [compat.json](compat.json)。
   > 这个仓库要跑在**别人的机器**上（不同 Node / DSH 版本 / 不同 OneBot 实现）。
   > `node scripts/test-compat.mjs` 会检查「COMPAT.md 写的契约」与代码是否一致。
2. **换机器**：迁移清单见 [docs/guides/MIGRATION.md](docs/guides/MIGRATION.md)（DPAPI 备份跨机不可解密、
   sessions 必须清空、DSH 端口与预设要重配）。

## 怎么把它跑起来（Windows 一键）

```powershell
.\start-bridge.ps1          # 起守护 → 起桥接；崩溃自动拉起
.\start-bridge.ps1 -Status  # 诊断：守护/桥接/3100/SnowLuma/DSH 一张表
.\start-bridge.ps1 -Stop
```

链路是 `start-bridge.ps1` → `scripts\bridge-supervisor.ps1` → `node src\bridge.js`。
**不要绕过它直接长跑 `node src\bridge.js`**（没有单实例保护、崩了没人拉起）。
`SnowLuma` 是第三方程序，必须用户自己启动并登录 —— 守护**只探测** `:3000/:3001`，
不代启、不代停（设计不变量 L6）。完整契约见 [docs/guides/LAUNCHER.md](docs/guides/LAUNCHER.md)。

## 当前状态快照（2026-10-27）

| 项 | 值 |
| --- | --- |
| 入口 | Windows：`start-bridge.ps1`（[LAUNCHER.md](docs/guides/LAUNCHER.md)）；Linux：`deploy/install-server.sh` + systemd |
| 自检（离线） | `node scripts/test-audit.mjs` → **88 套**（**以脚本输出为准**，本数字随版本更新）；另有 `test-http-layer` / `test-role-id` / `test-compat` / `test-portability` / `test-launcher-scripts` 各自可单独跑 |
| 自测（活的） | `powershell -File scripts\live-full-test.ps1` → **54 项**（只发 ownerQQ 私聊；`-MaxSends` 限流；会自动处理「AI 暂停」与 agentToken） |
| 代码结构 | `src/bridge.js`（约 1.1 万行，当前 10,771；以 `wc -l` 为准，主循环 + 唤醒状态机）、`src/api/*`（14 个域 handler）、`src/http/*`（响应/请求体/前导关/路由表） |
| 人格 | 身份在文件 front matter：`roles/<任意文件名>.md` 里 `id:` + `name:`。state 只存 id，**改名不影响绑定**（`test-role-id.mjs` 钉住） |
| 协议层 | 自带 `src/onebot-ws.js`（Node 内置 WebSocket）；**不依赖 `@snowluma/*`**，也不修改任何第三方包 |
| 契约 | [COMPAT.md](COMPAT.md)（人读）+ [compat.json](compat.json)（机器读），`test-compat.mjs` 保证两者与代码一致 |
| 首次安装 | `.\scripts\first-run.ps1`（体检→装依赖→生成 config→装 preset→可选启动；`-DryRun` 只打印计划）。**不覆盖已有 config.json、不代启 SnowLuma**（`test-first-run.mjs` 钉住） |
| 全新环境体检 | `node scripts/preflight.mjs`（不依赖 node_modules）：Node/仓库完整性/依赖/config/state 可写/端口/DSH/SnowLuma/人格卡 逐项 OK-WARN-FAIL，每条带文档锚点。清单见 [guides/FRESH-INSTALL.md](docs/guides/FRESH-INSTALL.md) |
| 模型 | `dsh.provider` 透传给 DSH。`deepseek-official` **已测试**；`openai`（GPT）**已接入但未测试**（计价/档位/工具/人格均未验证）→ [guides/MODELS.md](docs/guides/MODELS.md)，探针 `scripts/probe-dsh-providers.mjs` |

> ⚠️ 最容易误判的一件事：**AI 可能处于「暂停」状态**（`socialV2.paused=true`）。
> 此时所有 v2 工具都会 403「AI 已暂停」，群里也不会回话。先查
> `GET /api/socialV2/activity` 的 `paused`，别去翻代码。

## 这是什么

`qq-bridge` 是一个 **QQ ↔ DeepSeek Harness（DSH）** 的桥接：

```
QQ 消息 ──► SnowLuma（OneBot v11）──► 本进程 ──► DSH Web API ──► DeepSeek
                                          ▲                        │
                                          └── agent 用 MCP 工具回消息 ┘
```

- 语言：Node.js（>= 22.13），无构建步骤
- 本仓库是上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 fork（MIT，见 [FORK.md](FORK.md)）
- **不含任何账号、群号、令牌**；配置在运行时生成 `config.json`（已 gitignore）

## 两个外部依赖（不在仓库里，必须由人先装好并登录）

| 依赖 | 作用 | 你无法自动化的事 |
| --- | --- | --- |
| DeepSeek Harness（DSH） | 提供 AI | 登录 DeepSeek 账号 |
| SnowLuma | 提供 QQ 连接 | 扫码登录 QQ 小号 |

遇到这两件事**必须停下来让人做**，不要假装装完了。

## 标准流程（照做即可）

```powershell
# 1) 环境检查（只读）
node --version          # 需要 >= 22.13.0

# 2) 装依赖
npm install

# 3) 一条命令安装（自动探测 DSH 端口、读 SnowLuma token、写配置、启动、验收）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -OwnerQQ <管理员QQ号>

# 4) 体检（16 项，退出码 0=通过 2=警告 1=致命；第 16 项查「视频工具是否会注册」）
powershell -ExecutionPolicy Bypass -File .\verify.ps1
```

参数说明与失败分支：**[AGENT-INSTALL.md](AGENT-INSTALL.md)**（那里逐步写了期望输出和失败处理）。

## 文档地图（按需读，不要一次全读）

| 文件 | 什么时候读 |
| --- | --- |
| [AGENT-INSTALL.md](AGENT-INSTALL.md) | **安装时必读**：步骤 + 期望输出 + 失败分支 + 验收标准 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | **出任何错先查这里**（96 条，按阶段索引） |
| `scripts/check-versions.ps1` | 环境版本与 compat.json 不一致时先跑它 |
| [SETUP.md](SETUP.md) | 手动安装流程（install.ps1 失败时的手工替代） |
| [COMMANDS.md](COMMANDS.md) | 用户会问"机器人能干什么"时的指令清单 |
| [FORK.md](FORK.md) | 想知道本 fork 相比上游多了什么 |
| [roles/README.md](roles/README.md) | 要新建角色卡时的格式 |
| [docs/guides/SECURITY.md](docs/guides/SECURITY.md) | 提示词注入 / 花费熔断 / 远程访问 / 最小权限 / 告警 |
| [docs/guides/SERVER.md](docs/guides/SERVER.md) | Linux 服务器部署（systemd + bash 脚本） |
| [docs/REFACTOR-BRIDGE.md](docs/REFACTOR-BRIDGE.md) | 要改 bridge.js 结构时先读（分阶段拆法 + 路由清单工具） |
| [docs/](docs/README.md) | 深层实现（DSH 协议适配、控制台测试等） |

## 硬性规则（违反会出事故）

0. **不要绕过 `start-bridge.ps1` 长跑 `node src\bridge.js`**，也不要在守护里加
   「顺便启动 SnowLuma」（`test-launcher-scripts.mjs` 会拦）。这两条都是为了单实例与
   许可边界（设计不变量 L6）。
1. **角色卡的身份是文件里的 `id:`，不是文件名**。改名只改 `name:`；state 里只存 id。
   改 `id:` 等于换了一张卡（绑定会断）。
2. **HTTP 前导关只在一处**：`src/http/prelude.js`。加新接口时不要自己写鉴权分支，
   而是确认它在 prelude 的白名单/闸门里被正确覆盖。

1. **不要把 `config.json` / `state/` / `logs/` 提交进 git**（已 gitignore，别手动 `git add -f`）
2. **不要替用户填别人的 QQ 号 / token**；`ownerQQ` 必须是用户自己的号
3. **不要声称"装好了"**，除非 `verify.ps1` 退出码为 0 或 2
4. **不要改 `roles/` 里的角色卡来"测试"**——用 `/role` 切换
5. **不要改 `dsh/agent-presets/` 里的提示词**（安全边界在里面）；要改先说明理由
6. **不要用 `-NoStart` 装完后忘记启动**——用户会以为坏了

## 常见坑（你先知道，能省几轮）

| 坑 | 说明 |
| --- | --- |
| DSH 端口每次重启都变 | 所以 `install.ps1` 自动探测；手写死端口会失效 |
| SnowLuma 有 **两个不同 token** | HTTP(3000) 和 WS(3001) 各一份，桥接的 `accessToken` 存 HTTP 那份 |
| PowerShell 5.1 读无 BOM 的 UTF-8 会乱码 | 改 `*.ps1` 必须存成 **UTF-8 with BOM** |
| `config.json` 带 BOM 会让桥接解析失败 | 写配置用 UTF-8 **无 BOM** |
| 群聊默认不注入人设 | `role.groupEnabled=false`；要人设得管理员在群里 `/role 名字` 锁定 |
| `state/social-v2.json` 的 `paused: true` | 会让 AI 完全不回，且日志无报错 |
| 白名单空 = 谁都不放行 | `allow.groups` / `allow.private` 要填 |

## 验证成功的标准

```powershell
powershell -ExecutionPolicy Bypass -File .\verify.ps1
# 期望最后一行：全部通过。  退出码 0
```

以及：用 `ownerQQ` 私聊机器人发一句「你好」，它应回：

```
第一次用，先定个人设吧（回数字就行）：
1. 用默认人设（小鲸鱼/大肥鱼）
2. 新建一个（你说性格，我写卡）
3. 不用人设，按默认说话
```

## 改代码时

```powershell
# 语法检查（CI 也跑这个）
$files = Get-ChildItem src -Recurse -Filter *.js
foreach ($f in $files) { node --check $f.FullName }

# 审计测试（改了行为就跑）
node scripts/test-audit.mjs
```

CI 在 `.github/workflows/ci.yml`，PR 必须绿。

## 硬规矩（对 AI 也适用）

1. **没端到端跑过的，不写「已支持」** —— 文档里的 ✅ 必须有真机证据（命令 + 输出）。
2. **数字以脚本输出为准**：审计套数看 `node scripts/test-audit.mjs`，行数看 `wc -l`。
   文档里的数字过期不丢人，写死不更新才丢人。
3. **改 `bridge.js` 前后各跑一次** `node scripts/test-audit.mjs`，只许增不许减。
4. **拆分/迁移一律「一个模块一个提交」**，每刀都要能单独 `git revert`。
5. **日志不打印凭据片段**（含前几位）——要追踪就用不可逆标识。
