# 升级指南（按版本看该做什么）

> 已经装过的用户看这份；第一次装请看 QUICKSTART.md。
> 每次升级的**用户可见变化**在 CHANGELOG.md。

---

## 一、升级前 30 秒：先备份

```powershell
# Windows（Linux 把 Copy-Item 换成 cp 即可）
$ts = Get-Date -Format yyyyMMdd-HHmm
Copy-Item D:\qq-bridge\state "$env:TEMP\state-backup-$ts" -Recurse
Copy-Item D:\qq-bridge\config.json "$env:TEMP\config-backup-$ts.json"
```

**要备份的只有两样**：`state/`（会话、人物库、表情笔记、唤醒配置）和 `config.json`。
代码本身可以随时重新拉。

> 不备份的后果：`state/` 里有你的群记忆、人物关系、token 账本 —— 丢了要重新养。

---

## 二、按你的部署形态选升级方式

| 你的形态 | 怎么升 |
| --- | --- |
| **仓库直接跑**（最常见） | `git pull` → `npm ci --omit=dev` → 重启 |
| **仓库 + 部署目录分离** | 先 `git pull` 仓库，再把**新增/改动**的 `src/**`、`scripts/**` 同步到部署目录，最后重启 |
| **Docker** | `git pull` → `docker compose build` → `docker compose up -d` |

⚠️ **第二种最容易漏**：如果只 `git pull` 仓库却没同步部署目录，
新代码里的 `import './xxx.js'` 会找不到文件 → 表现是"启动即崩"或"某功能按钮 404"。
（本仓库 `start-all.ps1` 的 `$Live` 默认指向仓库目录；分离部署请在
`config.json` 里设 `launcher.liveDir`，或设环境变量 `QQBRIDGE_LIVE`。）

---

## 三、固定 7 步（每次升级都照这个走）

```
1) 备份 state/ 与 config.json
2) git pull
3) npm ci --omit=dev            # 只有 5 个运行时依赖，很快
4) 同步部署目录（若分离）：rsync/copy src、scripts、package.json
5) 重启桥接
6) 私聊发 /自检                # 看 DSH / 网关 / 队列 / 版本 是否正常
7) 群里 @ 它一句，确认能回
```

**第 6 步是这版新增的**：`/自检` 会直接告诉你哪一环没起来，不用翻日志。

---

## 四、按版本的动作清单

### 0.4.x（2026-10-31）—— 没有破坏性变更，但有一条安全修复必须升

| 版本 | 你要做什么 |
| --- | --- |
| 0.4.0–0.4.4 | 插件模式上线；**普通使用者无需任何动作** |
| 0.4.16–0.4.18 | 插件模式真机可用 + 人设卡。同样是可选项 |
| **0.4.19** | **安全修复**：插件模式下群友可越权操作本机。**用过插件模式的一定要升** |
| 0.4.20 | 新增熔断开关（`熔断-停插件.bat`）与工具调用日志 |
| 0.4.21–0.4.26 | 工具边界改成白名单、清理日志噪音、token 同步脚本、self-test 提示、僵尸认领修复 |

升级动作：

1. 照「三、固定 7 步」走（`npm install` 或 `pnpm install` 都行）
2. 如果你用过插件模式（`enabled: true`），升级后确认 `state/plugin.log` 里有
   `已对 agent 应用工具白名单` 与 `agent 已建：preset=qq-chat-v2` 两行 —— 没有就不要把通道交给插件
3. 桥接重启时如果日志只有 `⚠️ 通道被占用`，那是 0.4.24 之前的老问题（僵尸认领），升级后自动接管
4. 换过 SnowLuma 账号/token 的，用 `node scripts/sync-snowluma-token.mjs`（别再手改，WS/HTTP 两个 token 不一样）

### 0.3.0（2026-10-30）

| 需要你做的事 | 说明 |
| --- | --- |
| **无需改配置** | 新增的都是**可选**项，不填就是旧行为 |
| 可选：`socialV2.quietHours` | 想要夜间静默再填，如 `[23, 8]` |
| 可选：`socialV2.media.video.links.autoMeta` | 默认**开**（抖音链接自动附元数据）；想关填 `false` |
| 自动生成 `state/people.json` | 首次启动按白名单群存量成员标 `listed`；**不会**给老群友发"欢迎新人" |
| 快照基线变了 | 如果你用 `scripts/snapshot-prompt.mjs` 做比对，旧基线会报差异 —— 这是新增 `commands` 段导致的，属预期 |
| 升级后跑一次 `/自检` | 新增：网关重连次数、抖音 cookies 剩余 |
| 想用新工具就什么都不用做 | `/诊断` 与 `qq_people_note` 都自带，无需配置 |
| 可选：`socialV2.tools.peopleNote = false` | 不想让模型写人物笔记时关掉 |

> 数据兼容：`state/` 由 `src/state-schema.js` 自动迁移（当前 schema v2），
> 升级不需要手工改状态文件。

### 0.2.1-r1 及更早

- 0.2.1 是基线版本号，之前的变更见 CHANGELOG.md 各日期条目。
- 从更早版本升上来时，**唯一需要留意的**是 `config.example.json` 新增过的段：
  拿它和自己的 `config.json` 对比一次（`diff`/并排看），把缺的段补上即可，
  不补也能跑（代码里都有默认值），只是少一些可调项。

---

## 五、出问题怎么回滚

```powershell
# 代码回滚到上一个提交
git log --oneline -5
git revert <sha>          # 或 git checkout <sha> -- src scripts

# 状态回滚（仅当升级后状态文件损坏）
Remove-Item D:\qq-bridge\state -Recurse -Force
Copy-Item "$env:TEMP\state-backup-<ts>" D:\qq-bridge\state -Recurse
```

回滚后同样跑一次 `/自检`。

---

## 六、升级常见故障对照

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 启动即崩，日志 `Cannot find module './xxx.js'` | 部署目录没同步新文件 | 补同步 `src/`、`scripts/` |
| 机器人**在线但不回话** | 漏了 `npm ci` 或版本不匹配的旧 node_modules | 重跑 `npm ci --omit=dev` |
| `/自检` 提示 `DSH：❌` | DSH 没启动 / 端口漂移 | `npm run doctor` 看是哪一环 |
| `/自检` 提示 `抖音 cookies：❌` | cookies 过期 | 重新导出一次 cookies.txt（见 `docs/guides/VIDEO.md`） |
| 群里 @ 它没反应，但 `/自检` 正常 | 唤醒配置（潜水/概率）或该群不在白名单 | `/status` 看白名单；`/active` 恢复活跃 |
| 升级后提示词行为变了 | 快照基线差异（新增 `commands` 段） | 属预期；重新 `--save` 基线即可 |

---

## 七、给"批量维护多台机器"的人

```powershell
# 一次同步到多台（示例）
$targets = @('D:\qq-bridge-a', 'D:\qq-bridge-b')
foreach ($t in $targets) {
  git -C $t pull
  & npm --prefix $t ci --omit=dev
  # 重启：按自己的守护方式
}
```

升级脚本建议带 `-WhatIf` 先看会改动哪些文件；本仓库的拆分是"一个模块一提交"，
所以**可以只拉某几个提交**做灰度。
