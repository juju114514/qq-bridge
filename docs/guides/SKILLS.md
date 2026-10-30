# 技能（skills）：我们装了哪个、为什么、边界在哪

> 这份文档只回答三件事：**装了什么**、**为什么装/没装**、**用的时候不许越过哪条线**。
> 技能本体在 [`skills/`](../../skills/)，来源与许可证见 [`skills/README.md`](../../skills/README.md)。

---

## 一、当前装了什么

| 技能 | 状态 | 作用 | 装在哪 |
| --- | --- | --- | --- |
| **caveman** | ✅ 已装（2026-10-28） | "说话风格"技能：回答先行、砍客套、技术事实一个不丢 | `~/.claude/skills/caveman/` + `~/.dsh/skills/caveman/` |

装法（可重复、可回滚）：

```powershell
# 先看会写哪里（不落盘）
powershell -File scripts\install-skills.ps1 -Name caveman -DryRun
# 真装（自动探测技能目录；装完自检 SKILL.md 哈希）
powershell -File scripts\install-skills.ps1 -Name caveman
# 卸载
powershell -File scripts\install-skills.ps1 -Name caveman -Uninstall
```

装完要**重载技能目录**才生效：DSH 用 `reload-skills`；Claude Code 重启会话。
实测：装到 `~/.dsh/skills/` 后，本会话的技能目录里立刻出现了 `caveman`（不用重启）。

---

## 二、为什么只装了 1 个（其余 4 个的判断）

那支「AI 的五个老毛病」视频里推荐的 5 个技能，逐个对照**我们自己的工作方式**：

| 技能 | 装吗 | 理由 |
| --- | --- | --- |
| `caveman` | ✅ | 我的 token 大头确实是"把大块内容塞进上下文"：测试 tail、`pwsh` 输出、JSON dump |
| `last30days` | ❌ | 已有 `web_search` / `web_fetch`；我需要的是**官方文档与源码原文**，不是"这周大家在聊什么" |
| `i-have-adhd` | ❌ | 用户本来就要求"简短、表格、结论先行"，已经在做；它解决的是 Claude 那种先夸再绕 |
| `obsidian-skills` | ❌ | 文档是仓库里的普通 md，不用双链/属性/画布 |
| `emilkowalski/skills` | ⚠️ 待用 | 只在改 `console.html` / Web GUI / 做演示页时有用，占比 <5%，需要时再装 |

**为什么没装 caveman 的 CLI 运行时**（`@caveman-ai/cli`，宣传的"少读 33%"来自它）：

1. 它要 Node 22.13+ 的 npm/npx，本机没有 npm；
2. 它会往 PATH 里放二进制、可能改 agent 配置 —— 属于"装东西进系统"，得单独拍板；
3. 真正的大头收益（Blocks、Auto 路由）依赖它的代理层，和我们这套 `qq-bridge → DSH` 的调用链不是一回事。

所以现在只装了**纯 markdown 的那个技能**（零脚本、不联网、不外发数据）。

---

## 三、硬边界：**只压日志和输出，代码一个字都不许压**

这条是拍过板的（用户原话：**"压缩我赞成，但只压日志和输出吧，代码一压就找不着北了"**），
也是 caveman 自己的第 6 条规则（payload verbatim）。落到我们这个仓库就是：

| 可以压（省 token 的正当对象） | **绝不压**（压了就等于丢证据） |
| --- | --- |
| 测试输出（`audit` 的 tail、失败堆栈的重复行） | 源码片段、函数签名、类型定义 |
| `pwsh`/`git`/`ffmpeg` 的连续进度行、重复警告 | 补丁 diff、行号、文件路径 |
| 大 JSON 的结构概览（键名 + 条数，不贴全文） | 报错原文（只留最短决定性那一行，但仍然**原文**） |
| 日志里的时间戳/重复心跳 | 配置值、端口、命令、URL、cookie/token（这些根本不进日志） |

一句话记法：**"我这轮读进来的日志"可以压；"我要改的代码"和"我要引用的错误"不可以。**

---

## 四、实测：这个技能到底改变了什么

| 项 | 观察 |
| --- | --- |
| 生效方式 | 纯提示词，没有脚本；调用 `skill caveman` 后按它的规则回答，一直保持到"stop caveman" |
| 输出侧 | 客套话、复述需求、"我这就去" 全消失；技术事实保留 |
| 输入侧 | **无变化** —— 它不压缩上下文，压缩要靠 CLI 运行时或我们自己的取舍 |
| 风险 | 规则 4 说"冠词可省、否定词不可省"；中文写作里影响小，但**否定/例外/数字**是重点保护对象 |

我自己的用量体会：省得最多的地方是**长表格和长列表的重复前缀**，其次是"我先解释一遍再做"的过渡句。
真正贵的（读 4000 行 bridge.js）它帮不上忙 —— 那得靠 `grep`/`read` 的 offset 精确取段。

---

## 五、怎么再加一个技能

```powershell
# 1) 拿上游（只接受纯 markdown、零脚本、不联网的技能）
git clone --depth 1 <repo> D:\qq-bridge\.tmp\<name>-src
# 2) vendored 进仓库（带许可证 + NOTICE + 改动说明）
copy ...\skills\<name>\SKILL.md  skills\<name>\SKILL.md
# 3) 登记 skills\README.md 的表格（来源/commit/许可证/改动）
# 4) 安装并验证
powershell -File scripts\install-skills.ps1 -Name <name>
```

**不收的技能长什么样**：要联网调模型、要账号/token、要装二进制、要读你的私有文件
（比如把 `CLAUDE.md` 发到外部模型去压缩的那种 —— `caveman-compress` 就明确写了"数据离开本机"，
所以它没进仓库）。

---

## 六、给接手的 AI 的三句话

```
1. 技能是提示词，不会自动生效 —— 装完要 reload-skills（或重开会话）
2. 压缩只许针对日志/输出；代码、补丁、错误原文一律逐字保留
3. 想装新技能先看它是否"外发数据/装二进制"，是就别装，写进本文档让人自己决定
```
