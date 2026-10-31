# 实测过什么（VERIFIED）

> 这份文件只写**真机验证过**的事实，每条都带日期与复现方式。
> 没验证过的东西写在这里就是撒谎 —— 所以它比 README 短得多，而且会一直短。
>
> 最近一次更新：**2026-11-01**

---

## 一、基础验证（可随时复现）

| 项 | 结论 | 复现 |
| --- | --- | --- |
| 离线全量审计 | **152/152 通过**（Node 24.21.0，Windows） | `node scripts\test-audit.mjs` |
| 真机自检 | **18/18 通过** | `powershell -File scripts\verify-qq-bridge.ps1` |
| 健康接口 | `ready=true`，`dsh / snowluma / official` 三项均 `connected` | `Invoke-RestMethod http://127.0.0.1:3100/health/detail` |
| 控制台首屏 | CDP 抓不到 JS 异常，仪表盘自动加载（无需刷新） | Chrome DevTools Protocol + `Runtime.exceptionThrown` |
| 文档一致性 | 文档索引 66 篇活文档全覆盖；176 篇 md 无坏链 | `node scripts\check-docs-index.mjs`、`check-md-links.mjs` |

---

## 二、网关兼容（2026-11-01 实测）

| 项 | 结论 |
| --- | --- |
| SnowLuma `2.1.1` | 可用（3000/3001/5099，OneBot v11 行为一致） |
| SnowLuma `2.3.2` | **可用**：应用内更新后，桥接自动重连成功，`ready=true`，未改任何代码 |
| 更新过程本身 | **它自己的坑**：更新器关掉进程后没拉起，网关离线约 5 分钟；人工重启后恢复。我们的自更新脚本因此把「重启」交给计划任务而不是自己 |

---

## 三、守护链（2026-10-31 实测）

| 项 | 结论 |
| --- | --- |
| 强杀子进程 | `taskkill /F` 后 **5 秒**由 runner 自动恢复（pid 2976 → 26972，epoch 30 → 31） |
| 恢复日志 | `runner.child_exit` + `runner.restart（delayMs:5000）` |
| 看门狗 | 每 5 分钟检查；15 分钟持续不可用才判定并处理 |
| 已知限制 | 计划任务用 `InteractiveToken`，**无人登录时开机触发器起不来**（见 `docs/WINDOWS-PROCESS-SUPERVISION.md` §十三） |

---

## 四、官方通道（**只验了一小部分，所以仓库锁着**）

| 项 | 结论 |
| --- | --- |
| 身份注入 | ✅ 已验：日志 `[official] 自我身份已设置：显示名「官方机器人」` |
| 鉴权与网关 | ✅ 已验：`[official] 鉴权成功` / `已就绪` |
| 群 @ 单条回复 | ⚠️ **未验**（没有可复现的官方群消息记录） |
| 私聊收发 | ⚠️ 部分：收到过私聊事件，但被两层白名单拦下；放行后未复验 |
| 发图能看图 | ❌ 未验 |
| 非白名单被拒 | ✅ 已验：`白名单=拒绝` + `忽略未授权的官方会话`（2026-11-01 01:30） |
| 去重（重投不重复回） | ⚠️ 代码已修（0.4.29），日志里 `重复消息，跳过` 尚未出现过 |

> 结论：四条 e2e 只过了 1 条（被拒）+ 部分身份。这正是 `LOCK.md` 存在的理由。
> 验收清单在 `docs/audits/OFFICIAL-E2E-CHECKLIST.md`。

---

## 五、工具链（在副本/沙箱里实测，不动线上）

| 项 | 结论 |
| --- | --- |
| `scripts\update.mjs --apply` | 副本上真跑：备份 676 文件 → 覆盖 158（新增 1）→ 健康检查失败 → **自动回滚成功**，新增文件被清理，`package.json` 回到旧版本 |
| `scripts\adopt-fork.ps1` | 假目录上真跑：48 项复制，`src/bridge.js` 与源一致，`config.json` / `state/` 哈希未变，无 `src\src` 嵌套 |
| 脏环境（坏 config / 缺依赖 / 端口占用 / 坏 state / 陈旧锁） | 5 个场景 fail-fast 或明确降级；坏 state 只回退默认值并**打一条告警**（0.4.62.1 修） |

---

## 六、明确**没有**验证的（别当成能用）

| 项 | 状态 |
| --- | --- |
| Linux / Docker 长期运行 | 只在干净克隆里跑过审计，没有长期运行数据 |
| 多机部署 / 集群 | 未做 |
| DSH 0.3.x | 未出，未适配（`snapshot-env.mjs` 用于升级后对比） |
| 官方通道四种 e2e | 未验（见 §四） |
| 高并发（几十个群同时刷） | 未压测 |
| 令牌计费准确性 | 有台账，但未与 DeepSeek 账单逐条对账 |

---

## 七、怎么自己复核

```powershell
node scripts\test-audit.mjs                     # 离线审计（不联网、不发消息）
powershell -File scripts\verify-qq-bridge.ps1   # 真机 18 项
node scripts\launcher.mjs --check               # 环境体检
node scripts\snapshot-env.mjs                   # 拍一份当前环境
```

任何一条不过，都是这份文件的错——以你的实测为准，不以本文为准。
