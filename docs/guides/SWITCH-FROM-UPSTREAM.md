# 从上游仓库切到本 fork：怎么换、换什么、换完怎么验

> 适用：你**已经装好上游 `qq-bridge` 并跑起来了**，现在想换成这个 fork（多了攻略模板、点歌/唱歌、
> 斗图、空间、记忆、官方通道、守护进程等能力）。
>
> 核心原则一句话：**程序换新，数据不动。**

---

## 一、先看清两边的差别（这决定了迁移方式）

我对比过两边的顶层结构：

| 项 | 结果 |
| --- | --- |
| 共有顶层条目 | 24 个（程序骨架基本一致） |
| 仅本 fork 有 | `FORK.md`、`start-bridge.ps1`、`setup.ps1`、`verify.ps1`、`install.ps1`、`deploy/`、`docker/`、`plugin/`、`skills/`、`COMPAT.md` 等 28 项 |
| 仅上游有 | `_snowluma-catalog.json`（1 个） |

**结论**：这不是"另一套程序"，而是**同一套程序 + 我们加的东西**。
所以迁移不是"搬数据库"，而是"覆盖程序文件，保留 `config.json` 与 `state/`"。

> ⚠️ **不要 `git pull` 上游分支**。两条历史已经分叉，合并会变成大量无意义冲突。
> 正确做法是覆盖文件（本 fork 是超集）。

---

## 二、三条路径，按人群挑

### 路径 A：用脚本（推荐，可预演）

```powershell
# 1) 先把本仓库放到任意位置（不要放进旧目录）
git clone https://github.com/juju114514/qq-bridge.git D:\下载\qq-bridge-fork

# 2) 预演：只报告，不写任何文件
.\scripts\adopt-fork.ps1 -Source D:\下载\qq-bridge-fork -Target D:\deepseek工作区\qq-bridge

# 3) 停掉旧实例
schtasks /end /tn qq-bridge

# 4) 实盘（会先自动备份 config.json / state 到 _backup_switch_<时间戳>\）
.\scripts\adopt-fork.ps1 -Source D:\下载\qq-bridge-fork -Target D:\deepseek工作区\qq-bridge -Apply

# 5) 补依赖 → 重装任务 → 自检 → 起服务
cd D:\deepseek工作区\qq-bridge
npm ci --no-audit --no-fund
powershell -File scripts\install-qq-bridge.ps1
powershell -File scripts\verify-qq-bridge.ps1     # 期望 18/18
schtasks /run /tn qq-bridge
```

脚本的边界（写在代码里，不是口号）：

| 行为 | 说明 |
| --- | --- |
| 默认只预演 | 不加 `-Apply` 一个字节都不写 |
| 受保护清单 | `config.json`、`state/`、`node_modules`、`.git`、`data/`、`logs/`、`audio/`、`cookies*`、`*.log` |
| 只覆盖不删除 | 目标里多出来的旧文件不会被删（宁可留着，也不误删） |
| 先备份 | `_backup_switch_<时间戳>\` 里放 config/state + `git-head.txt` |
| 预检 | 3100 是否被占、计划任务是否存在，会明确提示 |

### 路径 B：手工覆盖（不想跑脚本）

1. **停**：`schtasks /end /tn qq-bridge`，确认 3100 没在监听
2. **备份**：整个目录复制一份 `qq-bridge.bak-日期`（至少含 `config.json` + `state\`）
3. **换**：把本仓库的文件解压覆盖到同一目录，**跳过** `config.json`、`state\`、`node_modules`、`.git`
4. **补**：`npm ci`（fork 多了测试依赖；缺了会在启动时报 `ERR_MODULE_NOT_FOUND: js-yaml`）
5. **重装任务**：`powershell -File scripts\install-qq-bridge.ps1`
6. **验**：`scripts\verify-qq-bridge.ps1`

### 路径 C：全新目录并行装（最安全，代价是要重配路径）

新目录装本 fork → 从旧目录**只拷** `config.json`、`state\`、`cookies.txt` → 重装计划任务。
好处是旧目录原封不动，随时可以回退。

---

## 三、三个真正会踩的坑（不是文件问题）

### 坑 1：配置键缺失

上游的 `config.json` 一般是**缺**本 fork 新增键的（例如 `socialV2.quietHours`、
`socialV2.media`、人格卡、官方通道相关）。程序会用默认值补齐，**不会崩**；
但你会看到一些"我没配过"的默认行为。

想看清差异：

```powershell
.\scripts\adopt-fork.ps1 -Source <fork> -Target <旧目录>   # 预演会列出新增/覆盖项
```

或者直接对比 `config.example.json` 与自己的 `config.json` 的键集合。

### 坑 2：计划任务的**动作路径**还指向旧目录

如果你是"新目录并行装"，旧任务的动作仍指向老路径 —— 于是你改的是新目录、跑的还是旧程序。

```powershell
schtasks /query /tn qq-bridge /fo LIST /v | Select-String 'Task To Run'
```

重装任务即可：`powershell -File scripts\install-qq-bridge.ps1`。

### 坑 3：`plugin/`、`skills/` 要重新挂一次

上游没有这两个目录。覆盖后文件有了，但 DSH 那边**需要重新挂载**：

- 插件模式：见 [PLUGIN-MODE.md](PLUGIN-MODE.md)
- 技能：见 [SKILLS.md](SKILLS.md)

---

## 四、换完怎么验（按顺序，任一步失败就别往下走）

```powershell
# 1) 自检脚本：期望 18/18
powershell -File scripts\verify-qq-bridge.ps1

# 2) 健康接口
Invoke-RestMethod http://127.0.0.1:3100/health/detail | Select version,buildId,ready

# 3) 控制台打开一次，看「运行总览 → 本程序仪表盘」九格是否都 ok
#    http://127.0.0.1:3100/   （令牌见 state\console-token）

# 4) 让 AI 在群里回一句话（验证 DSH 链路通）
```

`/health/detail` 的 `version` 应该是本 fork 的版本号（例如 `0.4.62.1`），
`buildId` 非空。如果还是老版本号，说明你启动的是旧目录。

---

## 五、回退（比迁移更重要）

| 场景 | 怎么退 |
| --- | --- |
| 用了脚本且失败 | 把 `_backup_switch_<时间戳>\` 里的 `config.json`、`state\` 拷回目标目录，然后用旧程序覆盖回去 |
| 手工覆盖 | 从你复制的那份 `qq-bridge.bak-日期` 整目录还原 |
| 全新并行装 | 停掉新任务，起旧目录的任务即可（旧目录没动过） |
| 只想回退程序版本 | `git checkout v0.4.6x`（本仓库有 tag），再 `npm ci` |

---

## 六、迁移之后建议做的三件事

1. **看一眼静默时段**：控制台「会话与审批 → 活跃热力图 → 静默时段建议」，
   上游默认不启用静默，本 fork 会给数据建议（见 [QUIET-HOURS.md](QUIET-HOURS.md)）
2. **检查记忆**：控制台「记忆星图」——上游没有长期记忆层，这里会从你的旧 state 现场合成
3. **补一次自检**：`scripts\verify-qq-bridge.ps1` 的 18 项里有 4 项是任务/看门狗配置，
   迁移后必须重新对齐

---

## 七、一句话总结

> 上游用户切过来 = **覆盖程序 + 保留 config/state + 重装任务 + 跑一遍 18 项自检**。
> 不要 merge 上游、不要删 state、不要在 3100 被占的时候写盘。
