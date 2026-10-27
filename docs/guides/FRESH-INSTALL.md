# 全新机器安装：会踩的坑与对应排查

> 场景：别人拿到这份仓库，在一台**从没跑过 qq-bridge** 的电脑上从零装起来。
> 这份文档按「阶段」把所有能踩的坑列全，并标注**有没有对应的排查入口**。
>
> 先跑一条命令再往下看：
>
> ```bash
> node scripts/preflight.mjs        # 不依赖 node_modules，装依赖前就能跑
> ```
>
> 它会逐项告诉你 OK / WARN / FAIL，每条都带「下一步看哪一节」。

---

## 阶段 0：系统准备（最容易一次性卡死的阶段）

| 可能遇到 | 现象 | 排查入口 | 覆盖 |
| --- | --- | --- | --- |
| 没装 Node | `找不到 node` / `node : 无法将"node"项识别为` | [TROUBLESHOOTING A1](../TROUBLESHOOTING.md#a1-找不到-node请先装-nodejs-22-lts) | ✅ |
| Node 版本太低 | 启动即 `WebSocket is not defined` | [A2](../TROUBLESHOOTING.md#a2-node-版本太低v18x需要--22130) | ✅ |
| **装了 Node 却没有 npm** | `npm : 无法将"npm"项识别为`（精简版/绿色版 Node 常见） | 见下方「本次新增」 | ❌→✅ |
| **PowerShell 执行策略禁止脚本** | `无法加载文件 …start-bridge.ps1，因为在此系统上禁止运行脚本` | 见下方「本次新增」 | ❌→✅ |
| 系统时间不对 | 连 DSH 401 / 签名校验失败，报错完全不指向时间 | [N2](../TROUBLESHOOTING.md#n2-系统时间不对最容易忽略的坑) | ✅ |
| 设了全局代理 | 本机 `127.0.0.1` 的请求被代理走，全连不上 | [N3](../TROUBLESHOOTING.md#n3-设置了代理桥接连不上本机服务) | ✅ |
| 杀软拦 PowerShell / 拦 node 子进程 | 语音合成失败、脚本被杀 | [R1–R6](../TROUBLESHOOTING.md#r1-自动诊断先跑这个) | ✅ |
| 仓库放在中文/空格路径 | 部分脚本路径解析失败、`.bat` 里路径被代码页吃掉 | 见下方「本次新增」 | ⚠️→✅ |
| 路径太长（Windows 260 限制） | `ENAMETOOLONG` / 文件写不进去 | 迁移文档提到换机器；无专门条目 | ⚠️ |

## 阶段 1：取代码

| 可能遇到 | 现象 | 排查入口 | 覆盖 |
| --- | --- | --- | --- |
| 用 zip 下载而不是 clone | 没有 `.git`，`check-versions.ps1` 显示版本未知（**不阻塞运行**） | [J0](../TROUBLESHOOTING.md#j0-你的仓库版本和别人上游朋友不一样) | ✅ |
| clone 到 OneDrive 同步目录 | state/ 被同步进程锁住、日志写入失败 | [B4](../TROUBLESHOOTING.md#b4-日志目录不可写eperm--eacces) | ⚠️ |
| 目录权限受管（公司电脑） | 创建 `state/` 失败 | B4 | ✅ |

## 阶段 2：装依赖

| 可能遇到 | 现象 | 排查入口 | 覆盖 |
| --- | --- | --- | --- |
| `npm install` 卡住/超时 | 长时间无输出 | [A3](../TROUBLESHOOTING.md#a3-npm-install-卡住或超时) | ✅ |
| 装完启动报 `Cannot find package 'js-yaml'` | 依赖没装全 | [A4](../TROUBLESHOOTING.md#a4-err_module_not_found-cannot-find-package-js-yaml) | ✅ |
| **看到 postinstall 输出一行提示，以为报错** | `[qq-bridge] 依赖已就绪（不再修补任何第三方包）` | 见下方「本次新增」 | ❌→✅ |
| npm 镜像/证书问题 | `SELF_SIGNED_CERT_IN_CHAIN` | 归入 A3（网络类） | ⚠️ |
| `npm audit` 报漏洞 | 一堆 advisory | [P6](../TROUBLESHOOTING.md#p6-依赖漏洞npm-audit) | ✅ |

## 阶段 3：配置 `config.json`

| 可能遇到 | 现象 | 排查入口 | 覆盖 |
| --- | --- | --- | --- |
| 没有 `config.json` | 桥接启动即退出，提示缺配置 | `preflight` FAIL + [README 安装与配置](../README.md#安装与配置) | ✅ |
| 手工改出 BOM/语法错 | `Unexpected UTF-8 BOM` / JSON 解析失败 | [A7](../TROUBLESHOOTING.md#a7-configjson-解析失败unexpected-utf-8-bom) | ✅ |
| 忘填 `ownerQQ` | 审批/管理命令/closed-agent 全不可用（**不报错**） | [G1](../TROUBLESHOOTING.md#g1-管理命令仅管理员可用) | ✅ |
| 白名单为空 | 一条消息都不回（**不报错**） | [E3](../TROUBLESHOOTING.md#e3-白名单没命中) | ✅ |
| SnowLuma 两个端口填成同一个 | 工具报 HTTP 426 | [D1](../TROUBLESHOOTING.md#d1-日志刷-snowluma-错误snowluma-websocket-closed-before-opening) | ✅ |
| `dsh.baseUrl` 端口写错 | `dshReady=false`，群里不回 | [C1](../TROUBLESHOOTING.md#c1-控制台-dshreadyfalse) | ✅ |

## 阶段 4：装两个外部依赖（DSH + SnowLuma）

> 这一阶段是**新手最容易低估的**：它们不在仓库里，必须自己装、自己登录。

| 可能遇到 | 现象 | 排查入口 | 覆盖 |
| --- | --- | --- | --- |
| 没装 DSH | 桥接一直 `dshReady=false` | [C1](../TROUBLESHOOTING.md#c1-控制台-dshreadyfalse) + [DSH_SETUP](DSH_SETUP.md) | ✅ |
| DSH 装了但没登录 | 连 DSH 401 | [N1](../TROUBLESHOOTING.md#n1-桥接连-dsh-一直-401unauthorized--invalid-session) | ✅ |
| **DSH preset 没装** | 桥接连上了，但工具/模式不对、行为怪 | 见下方「本次新增」 | ❌→✅ |
| MCP server 没挂上 | AI 没有任何 QQ 工具可用 | [O1](../TROUBLESHOOTING.md#o1-三个内置-mcp-server-起不来) | ✅ |
| DSH 升级后提示词变量报错 | `unknown prompt variable "{{cwd}}"` | [C3](../TROUBLESHOOTING.md#c3-日志-unknown-prompt-variable-cwd-in-section-deploymentpersona-suffix) | ✅ |
| 没装 SnowLuma | `SnowLuma 连接断开（code=1006）` 反复刷 | [D2](../TROUBLESHOOTING.md#d2-日志刷-snowluma-连接断开code1006重连中) | ✅ |
| SnowLuma 装了没登录 | 自愈失败、账号不在线 | [D3](../TROUBLESHOOTING.md#d3--token-自愈失败error-连不上-onebot-http-apihttp1270013000) | ✅ |
| QQ 小号被踢/换设备 | `The QQ connection changed` | [D4](../TROUBLESHOOTING.md#d4-the-qq-connection-changed-please-restart-qq-and-try-again) | ✅ |
| 新号被风控 | 发消息失败、账号异常 | [S3](../TROUBLESHOOTING.md#s3-机器人号被风控--封禁) | ✅ |

## 阶段 5：首次启动

| 可能遇到 | 现象 | 排查入口 | 覆盖 |
| --- | --- | --- | --- |
| 端口 3100 被占 | `EADDRINUSE` / 启动即退 2 | [B2](../TROUBLESHOOTING.md#b2-error-listen-eaddrinuse-1270013100) | ✅ |
| 残留锁 | `检测到过期锁文件…删除后重试` | [B1](../TROUBLESHOOTING.md#b1-启动后立刻退出日志-检测到过期锁文件pid-不存在或为空删除后重试) | ✅ |
| 双击窗口一闪而过 | 来不及看报错 | [B3](../TROUBLESHOOTING.md#b3-运行-start-bridgeps1-窗口一闪就没了) | ✅ |
| **首连报一次 1006 就"好了"** | 以为故障，其实正常（token 自愈） | [D2](../TROUBLESHOOTING.md#d2-日志刷-snowluma-连接断开code1006重连中)（文中已注明首连正常） | ✅ |
| `state/` 权限不足 | `EPERM` / `EACCES` | [B4](../TROUBLESHOOTING.md#b4-日志目录不可写eperm--eacces) | ✅ |
| 控制台打不开/401 | 需要令牌 | [I1](../TROUBLESHOOTING.md#i1-打开-http1270013100-显示-未经授权--401) | ✅ |

## 阶段 6：首次对话

| 可能遇到 | 现象 | 排查入口 | 覆盖 |
| --- | --- | --- | --- |
| **AI 处于暂停状态** | 连得上、一条不回（**不报错**） | [E.0](../TROUBLESHOOTING.md#e0-先查ai-是不是被暂停了2026-10-实测踩过最容易被忽略) | ✅ |
| 模式不是 `reserved2` | 工具不可用 | [E.0b](../TROUBLESHOOTING.md#e0b-再查是不是模式白名单挡住了) | ✅ |
| 白名单没放行 | 完全不响应 | [E3](../TROUBLESHOOTING.md#e3-白名单没命中) | ✅ |
| 唤醒配置睡死 | 只有 @ 才理人 | [E4](../TROUBLESHOOTING.md#e4-唤醒配置把它自己睡死了) | ✅ |
| 被本地限流 | 日志 `限流` | [E5](../TROUBLESHOOTING.md#e5-消息发出去了但-ai-被限流) | ✅ |
| 模型余额/额度 | 模型侧报错 | [E7](../TROUBLESHOOTING.md#e7-模型侧报错余额额度) + [O5](../TROUBLESHOOTING.md#o5-deepseek-平台级-429和本地限流是两回事) | ✅ |
| 首次说话没弹人设菜单 | 直接默认人格 | [F1](../TROUBLESHOOTING.md#f1-第一次说话没弹选人设菜单) | ✅ |

---

## 本次补上的缺口（阶段 0 / 2 / 4）

### 新增 1：Node 装了但没有 npm

**现象**：`npm : 无法将"npm"项识别为 cmdlet…`

**原因**：精简版/绿色版 Node、或只装了 `node.exe` 没装 npm；也有的是 npm 目录没进 PATH。

**处置**：

```powershell
node -v                      # 能出版本说明 node 在
where.exe npm                # 找不到就是没有
# 方案 A：装官方 Node（自带 npm）后重开终端
# 方案 B：只在当前会话补 PATH（注意版本号按实际改）
$env:Path = "C:\Program Files\nodejs;" + $env:Path
```

> 没有 npm 时**不能**用 `start-bridge.ps1`（它要 `npm install` 之后的依赖）。
> 但 `node scripts/preflight.mjs` 仍能跑——它只依赖内置模块。

### 新增 2：PowerShell 执行策略禁止运行脚本

**现象**：`无法加载文件 …\start-bridge.ps1，因为在此系统上禁止运行脚本`

**处置**（三选一，按影响面从小到大）：

```powershell
# A. 只对本次会话放行（最轻，推荐先试）
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# B. 只对当前用户放行
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# C. 不改策略，用参数绕过（脚本调用单独加）
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-bridge.ps1
```

> 桌面快捷方式已经内置 `-ExecutionPolicy Bypass`，所以**双击能跑**但你在终端里跑会报错时，
> 就是这个策略问题。

### 新增 3：DSH preset 没装

**现象**：桥接连上了 DSH（`dshReady=true`），但工具列表不对、模式判断怪、AI 行为像"没接 QQ"。

**原因**：`qq-chat` / `qq-chat-v2` 这两个 preset 装在 **DSH 自己的 home** 里，不在本仓库；
只 clone 仓库不会自动装进去。

**处置**：

```powershell
node scripts/setup-dsh.mjs                     # 幂等，装/更新 preset 到 DSH
node scripts/verify-adaptation.mjs             # 或 npm run verify:adaptation，验证适配
```

详见 [DSH_SETUP.md](DSH_SETUP.md)。换机器时这条最容易漏（见 [MIGRATION.md](MIGRATION.md)「必须重做的四件事」）。

### 新增 4：postinstall 那行提示不是错误

**现象**：`npm install` 末尾打印 `[qq-bridge] 依赖已就绪（不再修补任何第三方包）`。

**原因**：2026-10-27 起 `postinstall` 只做一行提示——`@snowluma/*` 依赖已移除，仓库不再修改任何
第三方包。**这是设计，不是警告。**

---

## 一句话总结

> 全新机器上真正会拦人的只有四件事：**Node 版本 / npm 在不在 / DSH 与 SnowLuma 装没装好 /
> config.json 填没填对**。其余都是"能启动但行为不对"，而那些恰好是 `TROUBLESHOOTING.md` 的
> E 段（能连上但不回话）覆盖得最密的地方。

先跑 `node scripts/preflight.mjs`；它绿了再启动，比对着文档猜快得多。
