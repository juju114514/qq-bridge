# 上游安全补丁登记表（UPSTREAM SECURITY REGISTER）

> **本仓库自 2026-10-31 起正式独立维护**，不再以"追平上游"为目标。
> 上游（`Derpyu520/qq-bridge`）作为**安全与技术情报来源**，有价值的修复走本表登记后定向移植。
>
> 维护人：仓库所有者。每次移植必须更新本表。

## 一、职责边界（谁负责什么）

| 范围 | 归属 |
| --- | --- |
| 上游原有代码的安全问题 | 上游作者 |
| **本仓库自研代码**（官方通道 / 插件模式 / 控制台 / 分叉后新增） | **我们** |
| **移植进来的补丁**（即使来自上游） | **我们**（移植即接手） |
| 部署系统（计划任务 / 守护脚本 / 熔断） | 我们 |
| DSH 适配层（`defineTool` / `agents.create` / `tools.restrict` / `session/event`） | 我们 |

**重要**：不要因为「上游修了」就认为「我们也安全了」。移植前一律视为未修。

## 二、登记表

| 上游 | 内容 | 本地状态 | 本地位置 | 验证 | 风险 |
| --- | --- | --- | --- | --- | --- |
| #78 | 群友可控文本入模前结构净化 | ✅ 已实现 | `src/roles.js` | `test-audit-security.mjs` | 无 |
| #79 | 会话令牌闸门改片段匹配 | ✅ 已实现 | `src/socialV2-prompt.js` L160 | `test-audit-security.mjs` | 无 |
| #82 | 搜索/抓取结果套「不可信」外壳 | ✅ 已实现 | `src/bridge.js` L1832 | `test-audit-security.mjs` | 无 |
| #83 | 发送队列按会话分链 | ✅ 已实现 | `src/bridge.js`（`sendChain`） | `test-audit-regressions.mjs` | 无 |
| #84 | messageId 幂等 + 撤回事件 | ✅ 已实现 | `src/socialV2-write.js` L284 | `test-audit-regressions.mjs` | 无 |
| #85 | forward-media 会话校验 | ✅ 已实现 | `src/bridge.js` | `test-audit-security.mjs` | 无 |
| #85 | **媒体抓取端口白名单** | ✅ **0.4.33 移植** | `src/safe-fetch.js`（`SAFE_PORTS`/`assertSafePort`） | `test-safe-fetch-ports.mjs`（6 条） | 无 |
| #86 | 提问通道 owner 门 | ✅ 已实现 | `src/bridge.js` L2987 | `test-audit-security.mjs` | 无 |
| #87 | 表情备注/黑话按会话隔离 | ✅ 已实现 | 会话键即隔离维度 | `test-audit-*.mjs` | 无 |
| #88 | agent 视角隐藏 QQ 号 | ❌ **不移植（已知权衡）** | — | — | 与"让模型知道 @自己"冲突（issue #29 类问题），见 `docs/audits/upstream-delta-2026-10-31.md` |
| #100/#118 | 唤醒注入完整人格卡 + 节奏注入 | ✅ 已实现 | `src/roles.js` L26 | `test-preset-prompt.mjs` | 无 |
| #63 | DSH 随机端口发现 + rebind | ✅ 已实现 | `src/prelude.js` L8 | 真机日志「端口漂移」 | 无 |
| 596626f | sendChain 严格模式 ReferenceError | ✅ 无此问题 | `src/bridge.js` L4303（声明在位） | 审计严格模式通过 | 无 |

## 三、审查节奏

**每月一次**（日期记在下面），只查四件事，不做机械 merge：

1. 上游新增的**安全**修复（含依赖漏洞）
2. 上游对 **DSH API 兼容性**的适配（`defineTool` / `agents.create` 等契约变化）
3. 上游的**架构变更**是否影响我们的实现方式
4. 是否有我们**已经踩过、上游也踩了**的坑（互相印证）

| 日期 | 审查人 | 结论 |
| --- | --- | --- |
| 2026-10-31 | 首次建立 | 上游 #131 差异已核：9/10 已覆盖，端口白名单已补，其余为文档/测试 |

## 四、移植规则

1. **一次一个补丁**，不夹带其他改动
2. 移植前先写「本地现状」（我们是否已有等价实现，在哪一行）
3. 移植必须带**测试**；没有测试的移植不算完成
4. 移植后更新本表（状态 + 验证编号 + 风险）
5. 行为有变化的，必须在 CHANGELOG 里写清"上游也这样改"还是"我们选了另一条"

## 五、为什么不整体追平

```
git rev-list --count upstream/main..origin/main   → 401   （我们独有）
git rev-list --count origin/main..upstream/main   → 92    （落后）
```

401 vs 92 的规模下，`git merge upstream/main` 合的不是"92 个独立更新"，
而是"92 个更新 × 我们 401 个提交"的交互 —— 冲突不一定表现为 Git 冲突，
更可能是**行为冲突**（尤其 `bridge.js` / preset / 会话状态都已高度定制）。

结论：**独立维护 + 定向移植**。