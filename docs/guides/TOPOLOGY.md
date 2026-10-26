# 部署拓扑（TOPOLOGY）—— 桥接该放哪台机器

> 先给结论：**桥接是整个系统里最轻、最不该单独上服务器的组件。**
> 决定拓扑的不是桥接，而是两个硬依赖能不能无头跑：
> **DSH（能否 headless）** 与 **QQ 网关（有无 OneBot 无头实现）**。
>
> 之前 [SERVER.md](SERVER.md) 直接给了 Linux 脚本，但没把这件事讲清楚——这里补上。

## 一、三个组件，三种「能不能无头」

| 组件 | 角色 | 形态 | 能否无头 |
| --- | --- | --- | --- |
| **qq-bridge** | 转发器（QQ ⇄ DSH） | Node 进程 | ✅ 天生无头 |
| **DeepSeek Harness（DSH）** | 提供 AI | **Electron 桌面应用**（GUI 登录） | ⚠️ **有 CLI**：`@deepseek-ai/dsh` 的 `bin` 是 `lib/bin.js`，支持 `dsh --profile web` 以 profile 方式启动；但**需要在目标机上实测** |
| **QQ 网关** | 提供 QQ 连接 | SnowLuma = **Electron 桌面应用**（扫码） | ❌ 本身不能无头；但**可换实现**：NapCatQQ / Lagrange.OneBot（OneBot v11，可无头、有 Docker） |

所以「上服务器」这件事的价值，完全取决于后两个能不能搬走。

## 二、三种可行拓扑

### A. 全 Windows（家里一台常开 PC）—— **当前你的方案，推荐**

```
┌──────────────────────────────────────────┐
│ 家里 Windows（常开）                      │
│  DSH(桌面)   SnowLuma(桌面)   qq-bridge   │
│      └────────── 127.0.0.1 ──────────┘   │
└──────────────────────────────────────────┘
```

| 优点 | 缺点 |
| --- | --- |
| 零网络链路、零暴露面 | 家里电费/噪音/断网就停 |
| Cookie 铸造是本机（天然合规） | 机器要能一直开 |
| 一条 `install.ps1` 就完事 | Windows 更新可能重启 |

**判断**：如果你本来就有一台常开的家用 PC，这就是最优解。**多一台服务器只会增加链路，不会减少那台 PC。**

### B. 全 Linux 服务器（真正省掉家里机器）—— 需要两个替代

```
┌───────────────────────────────┐
│ 云服务器 / 软路由 / NAS        │
│  DSH 无头(--profile web)      │
│  NapCatQQ 或 Lagrange(无头)   │
│  qq-bridge                   │
└───────────────────────────────┘
```

需要同时成立：

| 前提 | 说明 |
| --- | --- |
| **DSH 能在 Linux 无头启动** | `node <dsh>/lib/bin.js --profile web --port <port>`；需实测该 profile 是否依赖 Electron/桌面 API |
| **QQ 侧换无头网关** | SnowLuma 是桌面程序，Linux 上一般用 NapCatQQ（Docker 友好）或 Lagrange.OneBot 顶替；桥接只要求 OneBot v11，不绑死 SnowLuma |
| 扫码登录的替代 | NapCat 用扫码/密码登录后 token 落盘；一次性人工 |

**判断**：只有当你**确实没有常开 PC**（或不想为它付电费）时才值得做。工程量：换网关 + 验证 DSH 无头 + 反向隧道做控制台访问。

### C. 混合：桥接在服务器，DSH/SnowLuma 在家 —— **不建议**

```
家里 Windows: DSH + SnowLuma  ←──公网/隧道──→  服务器: qq-bridge
```

这正是你指出的尴尬架构。具体代价：

| 问题 | 原因 |
| --- | --- |
| **Cookie 跨机铸造不可行** | 桥接用 DSH 的**本机持久化签名密钥**离线铸造会话 Cookie（`dsh-client.js` 的 `discoverDshLaunchToken` / `mintBrowserSessionCookie`）。密钥在 DSH 那台机器的 `$DSH_HOME` 里；跨机就得把密钥复制过去 → 等于把 DSH 的登录凭据外借 |
| 多一段链路 | 每条 QQ 消息都要 服务器→家 再回来，延迟 ×2 |
| 暴露面变大 | 要么把 DSH(54694)/SnowLuma(3000/3001) 暴露公网，要么建隧道；两种都比单机麻烦 |
| **没有省掉任何机器** | 家里那台还是得常开（DSH 和 SnowLuma 都在它上面） |

**结论**：这套组合唯一合理的用法，是「家里 PC 换成家里的软路由/NAS（Linux），三个组件同机」——也就是拓扑 B，而不是 C。

## 三、决策表

| 你的实际情况 | 建议 |
| --- | --- |
| 有常开 Windows PC，人在家里用 | **A（单机）**：`install.ps1`，别上服务器 |
| 没有常开 PC，但会 Linux | **B**：先验证 DSH 无头，再换 NapCat，最后 `deploy/install-server.sh` |
| 想「服务器跑桥接 + 家里跑 DSH」 | **不要**。合并到同一台机器（A 或 B） |
| 只想远程看控制台 | 家用机上开 SSH 隧道即可，不需要服务器 |

## 四、如果坚持要 B：验证顺序

```bash
# 1) 先确认 DSH 能无头起来（在服务器上，用 DSH 自带的 runtime）
node <DSH安装目录>/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --help
#    能打印 usage 说明 CLI 可用；再试着真正启动并 curl 它的端口
node .../lib/bin.js --profile web &
curl -s http://127.0.0.1:<port>/ | head

# 2) 装无头 QQ 网关（NapCat 示例，Docker）
docker run -d --name napcat -p 3000:3000 -p 3001:3001 \
  -v /opt/napcat:/app/napcat/config mlikiowa/napcat-docker:latest
#    首次进容器扫码登录，然后在它的配置里开 OneBot v11 HTTP + WS

# 3) 桥接按服务器方式装
sudo ./deploy/install-server.sh --owner-qq <QQ号> \
  --snowluma-http http://127.0.0.1:3000 --snowluma-ws ws://127.0.0.1:3001

# 4) 自检
sudo ./deploy/verify-server.sh
```

> 步骤 1 是**门槛**：DSH 无头跑不起来，B 就不成立，应该回到 A。

## 五、为什么桥接本身不值得单独上服务器

| 资源 | 实测 |
| --- | --- |
| 内存 | 几十 MB 级（Node 单进程） |
| CPU | 空闲时几乎为 0 |
| 磁盘 | 代码 ~30 MB + 日志/状态 |
| 依赖 | 只依赖 Node + 两个**本机**服务 |

真正吃资源、需要一直在线、还带 GUI 的是 DSH（Electron + 模型会话）和 QQ 客户端——它们在哪，桥接就该在哪。

## 六、给 SERVER.md 的定位

`deploy/*.sh` 不是「把桥接搬到云上」的方案，而是：

1. **拓扑 B 的执行工具**（DSH 无头 + NapCat，全在 Linux）；
2. 或者**家里已经有 Linux 机器**（NAS/软路由/迷你主机），三个组件同机时的部署方式。

如果你的场景是「家里 Windows + 想加一台服务器」，请直接用 Windows 的 `install.ps1`，**不要**绕这一圈。
