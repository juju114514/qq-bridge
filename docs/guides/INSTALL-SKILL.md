# 一键安装 Skill（把这份给 AI 助手，让它替你装）

> **这是什么**：一份**写给 AI 助手看的安装手册**。你不用自己敲命令 ——
> 把下面「给 AI 的开场白」复制给你的 AI 助手（DSH / Claude / Codex / 其它能执行命令的），
> 它会按这份手册一步步装，**只在三处需要你亲自动手**：扫码登录、填白名单、点确认。

---

## 给 AI 的开场白（复制这段）

```text
请按 https://github.com/juju114514/qq-bridge/blob/main/docs/guides/INSTALL-SKILL.md
的流程，在这台 Windows 电脑上帮我安装 qq-bridge（QQ ↔ DeepSeek Harness 桥接）。

要求：
1. 每一步先告诉我「你要做什么」，做完告诉我「你看到了什么」；
2. 需要我亲手做的（扫码/填配置/点确认）请停下来等我；
3. 不要打印任何 token、Cookie、AppSecret；不要 git add -f 任何 state/ 或 config.json；
4. 卡住时按手册「自愈顺序」逐条试，别重复同一个失败命令。
```

---

## 目标（做完应该是什么样）

- 电脑上跑着三样东西：**qq-bridge**（本项目）、**SnowLuma**（登录你的 QQ）、**DSH**（跑 AI）
- 在群里 @ 机器人一次，它能回话
- `自检.bat` 双击后全部 OK

**硬性前提**：Windows 10/11 x64、**Node ≥ 22.13**、一个**小号 QQ**（别用主号）。

---

## 阶段 0：先体检（只读，不改任何东西）

```powershell
node -v          # 必须 ≥ v22.13
```

- 没有 node 或版本低 → 让用户去 https://nodejs.org 装 LTS，装完**重开终端**
- 装完仍提示找不到 → 让用户重装并勾选 "Add to PATH"

**AI 动作**：只检查，不安装。报告结论即可。

---

## 阶段 1：取代码

```powershell
cd D:\
git clone https://github.com/juju114514/qq-bridge.git
cd qq-bridge
```

- 没 git → 让用户装 Git for Windows，或下载 ZIP 解压
- 路径**不要带中文和空格**（后面 SnowLuma 会因此连不上）

---

## 阶段 2：装依赖

```powershell
npm install
```

失败时按顺序试：

1. 代理问题 → 开/关系统代理后重试
2. 权限问题 → 不要用管理员身份跑到别的目录
3. 仍是失败 → 告诉用户具体报错前 20 行，别反复重试同一命令

---

## 阶段 3：生成配置

```powershell
.\scripts\first-run.ps1
```

- 若提示「禁止运行脚本」：`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` 后重试
- 它会：体检 → 装依赖 → 生成 `config.json` → 问要不要现在启动（**先选否**）

**AI 动作**：执行并汇报；不要替用户改 `config.json` 里的账号信息。

---

## 阶段 4：填两个值（🚧 需要用户亲手）

打开 `config.json`，只改两处：

```jsonc
{
  "ownerQQ": 你自己的QQ号,        // 管理员
  "allow": { "groups": [ 群号 ] } // 要让它回话的群
}
```

**为什么必须用户来**：这是他的账号和群，AI 不该猜。

> ⚠️ **空白名单 = 谁都不回** —— 新手最常卡在这里。

---

## 阶段 5：两个外部程序（🚧 需要用户亲手）

| 程序 | AI 能做的 | 用户必须做的 |
| --- | --- | --- |
| **SnowLuma** | 告诉他在哪下载、装到哪个目录、怎么确认 3000/3001 在听 | **下载安装、扫码登录** |
| **DSH** | 告诉他在哪下载、装完怎么启动 | **安装、登录、找到本机地址** |

细节与截图见 [BEGINNER.md](BEGINNER.md) 第 5 步。

**AI 动作**：等用户说「好了/装完了」再进入下一步；可以用下面的命令帮他确认端口：

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3000,3001 } |
  Select-Object LocalPort, OwningProcess
```

---

## 阶段 6：启动

```powershell
.\start-bridge.ps1
```

或者让用户**双击 `start.bat`**（带守护，挂了 5 秒自动重启）。

**成功的样子**（三行都要有）：

```
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
[bridge] DSH 已就绪（模式: reserved2）
[bridge] 本地控制台已启动：http://127.0.0.1:3100
```

缺哪行修哪条腿：

| 缺哪行 | 先查 |
| --- | --- |
| SnowLuma | 网关没开 / 没扫码 / 路径带中文 |
| DSH | DSH 没启动；端口每次会变，桥接会自动发现 |
| 控制台 | 3100 被占 → 改 `consolePort`（必须是 1~65535 整数） |

---

## 阶段 7：验收（AI 可以全自动）

```powershell
# 1) 体检 12 项（也可以让用户双击 自检.bat）
node scripts/preflight.mjs

# 2) 控制台是否活着（401 = 活着但要令牌，正常）
$h = @{ 'X-Console-Token' = (Get-Content .\state\console-token -Raw).Trim() }
Invoke-WebRequest http://127.0.0.1:3100/api/status -Headers $h -UseBasicParsing
```

然后让用户在群里 **@ 机器人一次**，日志里应出现唤醒与发送记录：

```powershell
Get-Content .\state\bridge.log -Tail 30
```

---

## 自愈顺序（卡住时按这个顺序，别跳步）

1. `node scripts/preflight.mjs` → 按它给的「下一步」链接修
2. 看 `state/bridge.log` 最后 30 行，找第一条 `ERROR` / `401` / `ECONNREFUSED`
3. 两个外部程序是否真的在跑：`Get-NetTCPConnection -State Listen | ? LocalPort -in 3000,3001`
4. 换端口重启：`consolePort` 改一个没被占的，双击 `restart.bat`
5. 仍不行 → 把**前 20 行报错**贴给 AI，不要贴 token

---

## 风险声明（必须让用户知道）

| 风险 | 说明 |
| --- | --- |
| **账号风险** | 用第三方程序登录 QQ **不符合 QQ 用户协议**，小号可能被限制甚至封号。**别用主号** |
| **消息可见性** | 机器人能看到被授权群里的全部消息，并交给 AI 处理；群友不一定知道 |
| **密钥** | `state/` 与 `config.json` 里有令牌，**不要提交、不要外传** |
| **费用** | 模型调用按量计费，提示词每轮约几千 tokens（可用 `socialV2.roleInjectEvery` 降） |

---

## 为什么是"Skill"而不是"一键安装包"

安装包要打包 Node、两个第三方程序、模型凭据 —— 体积大、平台绑死、还没法解释"为什么卡住"。
**Skill 是让 AI 现场判断**：报错变了、路径不一样、杀毒软件拦了，它能自己读日志改动作。
代价是需要一个能执行命令的 AI 助手 —— 这恰好是本项目的前提。