# 安全策略（SECURITY）

> 本仓库是**个人 fork**（上游：`Derpyu520/qq-bridge`，MIT）。安全策略涵盖本仓库自研部分与移植部分。

## 一、怎么报告漏洞

**请不要公开开 Issue。** 用下面任一方式：

1. GitHub → **Security** 标签页 → **Report a vulnerability**（私有安全公告，推荐）
2. 或在本仓库开一个 Issue，**只写「我有一个安全问题，需要私下联系」**，不要写细节

请附上：受影响版本（`/health` 里的 `version` + `buildId`）、复现步骤、影响范围。

## 二、响应方式（据实说明）

**这是个人项目，没有 SLO，也没有值班。** 我能承诺的是：

- 看到后**尽快**确认（现实里可能几天）
- 修好会在 Release notes 里写清「影响了什么、怎么修的」
- 修不了的，会在这个文件里明确写「已知风险 + 缓解办法」

我不承诺：多快修、修成什么样、给不给 CVE。

## 三、明确在范围内（In scope）

| 类别 | 例子 |
| --- | --- |
| **提示词注入** | 群友发消息让 agent 越权执行本机操作、绕过工具白名单 |
| **工具边界绕过** | 从 QQ 会话调到 `pwsh` / 读写文件 / 桌面操控 |
| **凭证泄露** | 日志、错误信息、控制台响应里出现 token / secret / Cookie |
| **SSRF** | 让桥接去抓内网地址、非白名单端口（`safe-fetch.js` 的边界） |
| **通道互斥失效** | 同一份 `state/` 下两个实例同时收消息（双回复） |
| **权限提升** | 非管理员触发仅管理员可用的动作（审批、切角色、封闭模式） |
| **控制台鉴权** | 未带 token 能读到会话/记忆/配置 |

## 四、不在范围内（Out of scope）

- **平台封号风险**：个人号（SnowLuma/OneBot）属非官方通道，封号是已知风险，不是漏洞
- **DSH 自身的问题**：请报给 DeepSeek Harness
- **上游代码的问题**：请报给上游仓库（我们只处理移植后的实现）
- **需要攻击者已控制本机的场景**（本地提权、物理接触）
- **纯提示词质量**（"它说话不好听"、"它不肯回答"）

## 五、部署侧的硬要求（不满足就不是漏洞，是误配）

1. **`state/console-token` 不能为空** —— 控制台鉴权靠它
2. **不要 `allowAll: true` 上公网群** —— 白名单是准入边界
3. **`ownerQQ` 必须填** —— 否则管理员能力全失效（这是功能问题，不是安全问题）
4. **不要把 `config.json` 提交进仓库** —— 里面有 appid/secret
5. **插件模式必须先确认工具白名单生效**：`plugin.log` 里要有
   `已对 agent 应用工具白名单` + `agent 已建：preset=qq-chat-v2`
6. **`state/` 目录权限**：`scripts/harden-state-acl.mjs` 会收紧密码文件权限

## 六、已知风险（我们自己写下来的）

| 风险 | 现状 | 缓解 |
| --- | --- | --- |
| 官方通道（QQ 机器人）**未经完整真机 e2e** | 主仓库上锁（见 `LOCK.md`） | 别在关键场景启用 |
| 插件模式下 agent 有工具权限 | 三层边界（注册期白名单 / 执行期 guard / 插件侧 allowlist）+ 2 秒熔断 | 启用前验证白名单日志 |
| PID 被系统重用 | `ownerId` 区分进程身份（0.4.41+） | — |
| 单机部署，无多租户隔离 | 设计如此 | 不要多人共用一个 `state/` |

## 七、English summary

This is a personal MIT fork. Report vulnerabilities **privately** via GitHub Security Advisories
or by opening an issue that only says "I have a security issue, need private contact".
No SLO is promised. In scope: prompt injection, tool-boundary bypass, credential leaks,
SSRF, channel-mutex failures, privilege escalation, console auth bypass.
Out of scope: platform account bans, upstream/DSH bugs, already-compromised hosts.
Deployment requirements (empty console token, `allowAll`, missing `ownerQQ`, committed
`config.json`, unverified plugin tool allowlist) are misconfigurations, not vulnerabilities.