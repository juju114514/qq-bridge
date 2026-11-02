# 上游预演 + fork 切换：实测报告与处置

> 来源：2026-11-02 用 Docker/Linux 模拟盘做的「真装上游 → 造 state → 跑 fork 的 adopt-fork.ps1」预演。
> 本文档记录**实测发现**与**本仓库的处置**。原始日志见文末。

## 一、预演做了什么

1. 真装上游：`npm install` 拉了 128 个包，postinstall 修了 13 个 `@snowluma/sdk` 文件
   （这条链路正是本 fork 后来整套删掉的）
2. 造出"跑了一阵"的真实状态：config + state（含 6 个 state 文件）
3. 跑 `scripts/adopt-fork.ps1`：先 DryRun，再 `-Apply`

## 二、预演结果

- 清单 **52 项 = 23 覆盖 + 29 新增**（覆盖 `src docs roles scripts public assets dsh plugins` 等八个目录）
- 受保护只有 5 项：`.git .github node_modules state config.json`
- **DryRun 确实零写入**：config + 7 个 state 文件 SHA256 前后一致，`git status` 干净

## 三、四个「文档没写、真跑才露出来」的问题 → 本仓库的处置

| # | 实测现象 | 处置（0.4.122） |
| --- | --- | --- |
| 1 | 3100 被占时只警告，`-Apply` 照样 exit 0 并写完 | **端口占用时 `-Apply` 直接中止**，要硬来必须加 `-Force`；非 Windows 用 `netstat`/`ss` 兜底（原来 `Get-NetTCPConnection` 不存在会 exit 1） |
| 2 | 备份里有 `node_modules`（38 MB），连跑两次生成两份，不去重 | 备份**跳过 `node_modules`**（重装即可），只备份真正不可再生的东西 |
| 3 | `roles/` 会被覆盖却不在备份范围 → 自己写的人格卡丢了 | `roles` 加入**备份清单**（覆盖仍是设计，但先备份） |
| 4 | 同名人格卡被覆盖后缺 id 头 → `preflight.mjs` 报「人格卡缺元数据」 | 已在 `docs/UPGRADE.md` 写明：切完跑 `node scripts/migrate-roles-to-ids.mjs --apply` |

## 四、一个真实的安全回退 → 已修复

预演对比 `config.json` 键位：fork **新增 88 个键、删掉 5 个上游键**，其中
`socialV2.privacy.exposeUserId` 在 fork 源码里 **0 处引用** —— 意味着上游那套
「对模型隐藏真实 QQ 号」的脱敏**被丢了**。

实测后果：群友**没设昵称**时，`cleanSenderName` 的兜底会直接把真实 QQ 号当名字喂给模型，
模型再复述出来就等于在群里公开他人 QQ 号。

修复（0.4.122）：

- 新增 `src/privacy-mask.js`：`maskQqId()` / `senderNameForModel()`
- `cleanSenderName` 的兜底改走隐私开关，**默认脱敏**（`群友` + 后 4 位）
- `config.example.json` 补回 `socialV2.privacy.exposeUserId: false`
- 新增 `scripts/test-privacy-mask.mjs`（9 条断言）

## 五、两处对上一轮说法的更正

1. **`httpToken` 不是必须的**：代码是 `cfg.snowluma?.httpToken ?? cfg.snowluma?.accessToken`（10 处一致），
   不填会回退用 `accessToken`，还有自愈逻辑。
2. **`npm ci` 不是启动硬前提**：用上游那套 `node_modules` 直接 `node src/bridge.js` 就能起
   （`version=0.4.106 commit=b80fa51bc03f`）。文档里的 `ERR_MODULE_NOT_FOUND: js-yaml` 是**条件成立**，不是必然。

## 六、首次启动的真实行为（可复现）

```
[schema] 迁移 v1 → v2，已备份 6 个文件到 backups/schema-1-<时间戳>
[inject] 已生成外部触发令牌：state/inject-token
控制台未配置 consoleToken，已自动生成（完整值在 state/console-token）
本地控制台已启动：http://127.0.0.1:3100
```

`state/` 会多出 `backups/`、`.schema.json`、`channel-mode.json`、`heartbeat.json`、
`inject-token`、`runtime-marker.json`。上游代码不引用 `.schema.json`（0 处），
所以从 fork 回退到上游**不会**因为迁移标记而炸。

## 七、原始日志

预演时的 6 份日志（01 原样失败 / 02-03 端口两种场景 / 04 实盘 / 05 端口占用未拦 / 06 首次启动）
由操作方单独保存，不在本仓库（含绝对路径与本机标识）。
