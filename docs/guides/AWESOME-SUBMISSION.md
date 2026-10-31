# 提交到 awesome-dsh-plugin（收录草稿）

> 目标清单：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>（CC0，7000+ 条目）
> 我们的条目文件（放到 data/plugins/juju114514__qq-bridge.yml）：

``yaml
url: https://github.com/juju114514/qq-bridge/tree/main/plugin
name: juju114514/qq-bridge-plugin
category: notify
description:
  zh: '把 QQ 接进 DSH 的插件形态：OneBot v11 双向通道（群/私聊各一会话）、进程内 qq_* 工具（发消息、引用回复、读最近/未读、等新消息）、群记忆交接（§〇 交接 ≤4KB）、与常驻 sidecar 的 4 个契约端点；带通道互斥，同一份 state 只允许一个通道收消息。'
  en: 'QQ channel for DSH as a self-contained plugin: OneBot v11 bidirectional link (one session per group/private chat), in-process qq_* tools (send, quoted reply, recent/unread reads, wait-for-message), per-chat handoff memory (≤4KB), a 4-endpoint sidecar contract, and a channel mutex so only one channel receives messages per state directory.'
``

## 门槛核对（逐条）

| 规则 | 我们 | 结论 |
| --- | --- | --- |
| 仓库里有任意 package.json 声明 dsh.bundle | plugin/package.json 有 | ✅ |
| 仓库存在、未归档 | 存在、未归档 | ✅ |
| 仓库年龄 ≥ 1 天 | 创建于 2026-10-25 | ✅（5 天） |
| 不是 DSH 本身 | 不是 | ✅ |
| 一个 PR 只加 1 条 | 只加这一条 | ✅ |

## 为什么用 	ree/main/plugin 这种 URL

清单里已经有很多 monorepo 子目录条目。市场生成安装命令的规则是：

`
dsh plugin --profile web add github:<owner>/<repo>#path:/<subdir>
`

我们这条会变成：github:juju114514/qq-bridge#path:/plugin —— 已实测可用。

> ⚠️ 注意：直接 pnpm add https://github.com/.../tree/main/plugin **不行**
> （pnpm 会忽略子目录、装成仓库根 = 桥接应用本身）。真正能装的是带 #path:/plugin 的写法，
> 市场会自动这样拼。

## 怎么提交

1. Fork 清单仓库
2. 新建 data/plugins/juju114514__qq-bridge.yml，内容用上面那段
3. 开 PR，标题例如 Add juju114514/qq-bridge (QQ channel for DSH)
4. CI 会跑 check-submission.mjs：核对 dsh.bundle、仓库年龄、是否 DSH 本身

## 影响

- 别人的「Discover → Index sources」里能直接搜到并一键安装
- 我们的 docs/guides/PLUGIN-MODE.md 里也可以写「已收录」