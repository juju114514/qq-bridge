# 下一步路线（2026-10-31，分支 `next/0.4.0`）

> 现状：P0（核心纯函数拆分）与 P1（插件骨架 + 真机挂载）已完成，
> 分支领先 main **9 个提交**，main 仍停在 v0.3.2（读者不受影响）。
> 本文件只写**接下来做什么、怎么算做完**，不写愿景。

## 0. 已经确认的事实（别再重新论证）

| 项 | 结论 | 出处 |
| --- | --- | --- |
| 插件能被 DSH 装并在真机挂载 | ✅ | `docs/design/dsh-plugin-api-notes.md` 第 9 节的真机日志 |
| `output` 必须 `schema` + `render` | ✅ | 同上（真机报错） |
| `schema.type` 不能是 `'json'` | ✅ | 同上 |
| 需要 `package.json` 的 `dsh.bundle.patch` | ✅ | 同上 |
| `createUserMessage` 在 `@deepseek-ai/dsh-llm` | ✅ | `plugin/user-message.js` 注释 + 第 7 节 |
| 临时 profile 必须用独立 `DSH_HOME` | ✅ | 第 10 节（踩过一次，导致桌面版弹窗） |

## 1. 下一步的四个任务（按依赖排序）

### N1 · 工具面：先把 10 个高频 `qq_*` 搬进插件（P2 前半）

**为什么先做它**：插件目前只有 `qq_ping`。没有工具，"AI 能用它干活"这件事就没验证过；
而工具是"进程内注册"最大的收益点（省掉 MCP 那一跳）。

| 工具 | 依赖 | 难度 |
| --- | --- | --- |
| `qq_get_prompt` | core/prompt.js + sidecar 快照 | 中 |
| `qq_get_unread_messages` / `qq_get_recent_messages` | OneBot action + 会话缓存 | 中 |
| `qq_send_message` / `qq_reply` | channel.send（已有） | **小** |
| `qq_wait_for_messages` | 事件缓冲 | 中 |
| `qq_mark_read` | sidecar | 小 |
| `qq_list_stickers` / `qq_send_sticker` | core/stickers.js + OneBot | 中 |
| `qq_memory_append` / `qq_memory_query` | sidecar（写意图） | 小 |

**验收**：假 ctx + 假 OneBot 下 10 个工具全部可调用；每个都有"参数非法"测试；
真机装一次，`qq_ping` 与 `qq_send_message` 出现在工具列表。

### N2 · sidecar 契约落地（P3 前半）

现在插件是"能发消息"，但记忆/记账/控制台都没接。契约在设计文档第 6 节：

```
GET  /snapshot?key=    （带 ETag，每轮都拉，不能每次回 30KB）
POST /events           （入站/出站/工具事件）
POST /intents          （memory.append / note.people / ledger.record / activity）
GET  /health
```

**做法**：先在 sidecar（现在的 `bridge.js`）里加这 4 个路由 + bearer 校验，
用 `state/console-token` 同级的新 token；再让插件调。

**验收**：sidecar 没开时插件 `degraded=true`（已有）；开了之后 `/snapshot` 返回人格卡与人物库；
控制台能看到"插件模式"标记。

### N3 · 降级与互斥（P3 后半，安全相关）

| 要做 | 为什么 |
| --- | --- |
| 同一 `state/` 只允许一种模式（bridge 或 plugin） | 否则两边都写 `state/*.json`，静默互相覆盖 |
| 插件启动日志 + 控制台横幅显示当前模式 | 用户得知道"为什么没有主动消息" |
| `/health` 暴露 `mode` 与 `version` | 排查时第一眼看这个 |

**验收**：手动同时启动两种模式 → 第二个启动时**明确拒绝**并给出怎么切回去。

### N4 · 一致性闸门 + 发版（P4）

| 要做 | 怎么算过 |
| --- | --- |
| 录制回放对比 | 同一份 inbox.jsonl，bridge 模式与插件模式产出的 prompt 与发送序列**逐字一致** |
| 快照基线 | `snapshot-prompt.mjs --diff` 行为一致（或差异被逐条解释） |
| 文档 | `docs/guides/PLUGIN-MODE.md`（怎么装、怎么切、降级表） |
| 发版 | 合并 `next/0.4.0` → main，bump 到 **0.4.0**，tag + Release |

**为什么放最后**：前三个任务都会改行为，最后一次性对比才有效。

## 2. 明确不做（这一版）

- ❌ 多 IM 通道（那是 dsh-im 的赛道）
- ❌ 官方 Bot 通道插件化（`qqbot-official.js` 留在 sidecar）
- ❌ 把控制台搬进插件（109 条路由 + 12 页前端，搬了没收益）
- ❌ 调度器搬进插件（定时器跟着 DSH 生命周期会丢任务）

## 3. 时间预估

| 任务 | 估时 | 可中断点 |
| --- | --- | --- |
| N1 工具面 | 2 天 | 每 3 个工具一个提交 |
| N2 sidecar 契约 | 1.5 天 | 路由 / 插件调用分开提交 |
| N3 降级互斥 | 0.5 天 | 一个提交 |
| N4 闸门 + 发版 | 1 天 | 对比报告 → 发版 |
| **合计** | **≈5 天** | |

## 4. 每一步都要过的门（不因为是分支就放松）

1. `node --check` 改动的每个文件
2. `node scripts/test-audit.mjs` 全绿（现在 120）
3. `node scripts/check-md-links.mjs`、`check-privacy.mjs` 通过
4. 真机验证：要么跑一次临时实例（**用独立 `DSH_HOME`**），要么说明为什么不需要
5. 快照 `--diff` 行为一致，或差异逐条解释

## 5. 第一个动作

N1 的第一批三个工具（`qq_send_message` / `qq_reply` / `qq_mark_read`）——
它们依赖最少、能最快在真机上验证"工具真的能发消息"。