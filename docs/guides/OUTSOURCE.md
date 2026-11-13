# 把活外包给别的 AI（Doubao / 其它 agent）怎么交

> 给「不想让主 agent 干、想换一个工具/模型来跑」的人看。
> 这个仓库已经把**能自动跑的部分**都做成了脚本，所以外包不需要它读源码，只需要跑命令 + 读输出。

## 一、一句话结论

**能外包的是「跑命令 + 读结果 + 写文档」这类活；不能外包的是「账号、登录、发布」这类需要人的活。**

| 适合外包 | 为什么 | 交给它的命令 |
| --- | --- | --- |
| 环境体检 | 纯只读，输出自带修复建议 | `node tools/doctor-tools.mjs` |
| 离线审计 | 195 个脚本，跑完看通过数 | `node scripts/test-audit.mjs` |
| 隐私守卫 | 纯静态扫描 | `node scripts/check-privacy.mjs` |
| 日志排错 | 把 `state/bridge.log` 尾部贴给它，让它对照 [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) 定位 | 让它读日志 + 手册 |
| 文档翻译 / 润色 | 只改 `.md`，不碰代码 | 给它 `docs/` 下的文件 |
| 代码审查 | 只读 diff，输出问题清单 | `git diff main~5..main` 之类 |
| 写 CHANGELOG 条目 | 输入是提交记录 | `git log --oneline -20` |

| 别外包 | 原因 |
| --- | --- |
| QQ / 抖音扫码登录 | 需要人拿手机扫；agent 拿到二维码也没用 |
| 填 `config.json` 的 `ownerQQ` / 白名单 / 令牌 | 属于账号隐私，[SECURITY.md](SECURITY.md) 有边界 |
| 提交、推远端、打 tag | 可以给它做，但**必须由人先看 diff**；分支规则见 [BRANCHING.md](BRANCHING.md) |
| 动 `dsh/agent-presets/` 的提示词 | 安全边界在里面，改了要说明理由 |
| 杀进程 / 停服务 | 现场有真实 QQ 会话，误杀会掉线 |

## 二、交给它之前，先跑一条命令

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\handoff-check.ps1
```

它会依次跑：**工具体检 → 隐私守卫 → 离线审计 → 关键端口/进程**，把结果写成
`state/handoff-report.txt`，并把最后 20 行打到屏幕上。

> 这条命令**只读**，不会改代码、不会重启桥接、不会碰账号。

## 三、给外包 agent 的「投喂模板」

直接把下面这段连同仓库路径发给它（Doubao 的「本地电脑」/「技能」模式可用）：

```
你在 Windows 上，仓库在 <仓库路径>，Node 在 <node.exe 路径>。
只做只读检查，不要改代码、不要提交、不要重启任何服务。

请按顺序执行并汇报：
1. node tools/doctor-tools.mjs
   —— 把 OK/WARN/FAIL 逐项列出；FAIL 项给出你建议的修复命令（不要执行）
2. node scripts/test-audit.mjs
   —— 只报「Audit suite: X/Y」和失败脚本名；不要贴全文
3. node scripts/check-privacy.mjs
   —— 只报通过/失败 + 失败文件
4. 读 state/bridge.log 最后 200 行，对照 TROUBLESHOOTING.md 找异常关键词：
   is not defined / ReferenceError / 事件流中断 / 启动不完整 / 429 / 401
   —— 找到就给出「现象 → 手册里的对应小节」

输出格式：
## 结论（一句话）
## 失败项（表格：项 / 现象 / 建议命令）
## 需要人做的事（扫码/填号/审批 之类）
```

## 四、它跑出来的结果怎么判断真伪

外包最容易出的问题是「看起来跑过了」。三条硬标准：

1. **审计数字**以 `node scripts/test-audit.mjs` 的输出为准，不接受「大概都过了」
2. **体检项**要有 `OK/WARN/FAIL` 逐项，不接受「环境正常」
3. 涉及「已修复」的结论，必须能给出**命令 + 输出片段**（见 [AGENTS.md](../../AGENTS.md) 的硬规矩）

## 五、常见外包翻车点

| 翻车 | 表现 | 防法 |
| --- | --- | --- |
| 它顺手 `npm install` 改了锁文件 | `pnpm-lock.yaml` / `package.json` 变动 | 明确要求「只读」；交付后 `git status` 看一眼 |
| 它以为端口通就等于能用 | `:3000` 在听，但 QQ 没登录 | 体检里 `SnowLuma 端口` 只是端口；登录态看桥接日志 `snowluma.connected=true` |
| 它把 `state/` 里的锁删了当"重置" | 双实例 / 掉线 | 禁止它动 `state/`；手册已写明锁的语义（[LOCK.md](../../LOCK.md)） |
| 它用旧版本号写文档 | README 里版本对不上 | 推之前跑 `node scripts/check-readme-version.mjs` |

## 六、想让它做「定时巡检」

Doubao 有「定时任务」，但**别让它直接操作服务**。推荐做法：定时任务只跑那条只读命令，
把 `state/handoff-report.txt` 的变化贴回来，由人决定要不要动手。

```powershell
# 每天 09:00 跑一次，输出追加到报告
powershell -ExecutionPolicy Bypass -File .\tools\handoff-check.ps1
```
