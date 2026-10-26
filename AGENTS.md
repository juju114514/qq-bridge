# AGENTS.md

> 给 **AI coding agent** 的入口文件。人类看 [README.md](README.md)。
> 你（AI）被要求"装这个项目 / 修这个项目"时，**先读本文件**，再按需读链接。

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

# 4) 体检（15 项，退出码 0=通过 2=警告 1=致命）
powershell -ExecutionPolicy Bypass -File .\verify.ps1
```

参数说明与失败分支：**[AGENT-INSTALL.md](AGENT-INSTALL.md)**（那里逐步写了期望输出和失败处理）。

## 文档地图（按需读，不要一次全读）

| 文件 | 什么时候读 |
| --- | --- |
| [AGENT-INSTALL.md](AGENT-INSTALL.md) | **安装时必读**：步骤 + 期望输出 + 失败分支 + 验收标准 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | **出任何错先查这里**（57 条，按阶段索引） |
| [SETUP.md](SETUP.md) | 手动安装流程（install.ps1 失败时的手工替代） |
| [COMMANDS.md](COMMANDS.md) | 用户会问"机器人能干什么"时的指令清单 |
| [FORK.md](FORK.md) | 想知道本 fork 相比上游多了什么 |
| [roles/README.md](roles/README.md) | 要新建角色卡时的格式 |
| [docs/](docs/README.md) | 深层实现（DSH 协议适配、控制台测试等） |

## 硬性规则（违反会出事故）

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
