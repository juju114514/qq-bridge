# 干净克隆验证 · v0.3.1（2026-10-31）

> 目的：回答「会不会出现**本地能跑、仓库拿下来却不行**」。
> 做法：把仓库克隆到一个**全新文件夹**（不复制 `node_modules` / `config.json` / `state/`），
> 完全按新手的路径跑一遍。结论文档不写"应该没问题"，只写实际输出。

## 一、克隆结果

```powershell
git clone <repo> D:\QQBot\temp\clean-v031
```

| 检查 | 结果 |
| --- | --- |
| 文件数 | 3,389 |
| HEAD | `f47f1e6`（v0.3.1 之后） |
| `node_modules/` | ❌ 不存在（符合预期，依赖不入库） |
| `config.json` | ❌ 不存在（`.gitignore` 排除，符合预期） |
| `state/` | ❌ 不存在（符合预期） |
| `assets/beginner/` | ✅ 7 个文件（6 张占位图 + README） |

## 二、按新手路径装依赖

```powershell
node <pnpm> install --lockfile=false
```

- 用时 **14.9 秒**，退出码 **0**
- 仓库里有 `package-lock.json`（npm 口径），但机器上没有 npm，用 pnpm 装同样可行

## 三、全量审计（仓库拿下来就能跑）

```
Audit suite: 116/116 scripts passed.
```

**116/116，与工作区一致** —— 没有"只有本机能过"的测试。

## 四、新手第一条命令：体检

```
qq-bridge 环境体检
  [OK]   Node 版本          v24.21.0（>= 22.13 ✅）
  [OK]   平台               win32
  [OK]   仓库完整性          8 个关键路径都在
  [OK]   依赖               2 个关键包都在
  [FAIL] config.json       不存在：第一次用直接跑 `node scripts/first-run.ps1`（它会生成）…
         └─ 下一步：docs/guides/BEGINNER.md 第 3~4 步
  [OK]   state/ 可写
  [WARN] 端口 3100         已在监听（这台机器上真机桥接正跑着，属环境因素）
  [OK]   SnowLuma HTTP/WS  可达
  [OK]   人格卡              4 张都有 id/name
  [OK]   代理 / 系统时间
  合计 12 项：OK 10 / WARN 1 / FAIL 1
```

- **FAIL 只有 `config.json`**：全新克隆必然没有，第一次运行 `first-run.ps1` 就会生成 —— 符合预期
- **WARN 只有端口 3100**：这台机器上真机桥接正在跑，与他人无关

## 五、其它守卫

| 检查 | 结果 |
| --- | --- |
| `check-md-links.mjs` | ✅ 82 个 md 全通（含新加的 `BEGINNER.md` 与 6 张占位图） |
| `check-privacy.mjs` | ✅ 486 个被跟踪文件无私有路径/凭证/令牌 |

## 六、这一轮抓到的"文档漂移"（都已修）

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| 体检项数写错 | `AGENTS.md` 写「16 项」，实际 **12 项** | 改成「12 项，以脚本输出为准」 |
| 提示指向旧文档 | preflight 说「下一步：README『安装与配置』」，没提新的零基础指南 | 改成「`docs/guides/BEGINNER.md` 第 3~4 步」 |
| README 表格串行 | 「最近更新」的 changelog 行被插进了「你已经装了什么」表 | 归位到「最近更新」表 |
| 新手入口缺失 | 顶部只写了 QUICKSTART | 顶部加一行「第一次用（没写过代码）→ BEGINNER.md」 |

> 这四条都是「**本地看着没问题、仓库读者会撞上**」的典型 —— 正是这次克隆验证要抓的东西。

## 七、还没解决的一处（记录，不假装已修）

`scripts/first-run.ps1 -DryRun` 在**没有 config.json** 的全新克隆里退出码是 **1**：

```
DryRun（只体检 + 打印计划，不装不改不启动） → 环境体检 FAIL(config.json) → exit 1
```

技术上没错（体检确实发现了 FAIL），但对新手是误导：**"我只是演练一下，怎么报错了？"**

建议改法（下次做）：`-DryRun` 时把退出码统一成 `0`（演练成功）或 `2`（有警告），
并在结尾加一句「DryRun 不修改任何东西，真实安装请去掉 -DryRun」。

## 八、结论

**仓库拿下来能用。** 116/116 测试、82 个文档链接、隐私扫描全部通过；
唯一的 FAIL 是"还没生成配置文件"，这是设计如此，且提示已经把新手导到正确的那一步。