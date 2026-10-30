# 与上游的安全批次差异审计（2026-10-31）

> 触发：有人提醒「上游 2026-10-30 合了 PR #131（34 个提交），`f6242d6`」，
> 建议做一次 `9bc56ce → origin/main` 的差异审计。下面是实际核查结果。

## 一、先纠正三件事

| 说法 | 实际情况 |
| --- | --- |
| 「你的本地版本是 `9bc56ce`，可能落后」 | `9bc56ce` **在**我们的历史里，但当前 HEAD 是 `7c4ab80` |
| 「`git pull --ff-only origin main`」 | **不要执行**。我们的 `origin` 是 fork `juju114514/qq-bridge`，上游是另一个 remote |
| 「先 fetch 再 pull 就行」 | **不能 merge**：与 `upstream/main` 相比**领先 306 / 落后 92**，且 `merge-base` 为空（上游历史被重写过） |

结论：**只能"按项移植"，不能"合并上游"。** 上游那 92 个提交里有真东西，但我们的 `bridge.js`
从 11,236 行改到 10,050、路由全搬进 `src/api/*`，**同一处代码长得完全不一样**，cherry-pick 必然冲突。

## 二、逐项核查（我们有没有）

用关键词在 `src/` 里实检：

| 上游的安全/机制项 | 我们 | 证据 |
| --- | --- | --- |
| 发送队列按会话分链 `sendChain` | ✅ **有** | `bridge.js` 的 `let sendChain = Promise.resolve()` + 16 处使用 |
| `messageId` 幂等入库 | ✅ **有** | 9 处（bridge / snowluma-conn / state-schema / socialV2-write） |
| 撤回事件处理 | ✅ **有** | 20 处（bridge / official-*） |
| 唤醒时注入完整人格卡 | ✅ **有** | `socialV2-prompt.js` / `role-card.js` |
| 群聊文本结构净化（防伪造系统提示） | ⚠️ **部分** | `bridge.js:1822` 有注释与转义，但没有上游那种"整段标记为不可信"的统一处理 |
| 搜索/网页结果标记为不可信数据 | ⚠️ **部分** | 仅 `slang-learner.js` 有明确约束，搜索链路没有 |
| `forward-media` 只读本会话见过的媒体 | ⚠️ **部分** | 3 处，未确认是否按会话过滤 |
| **执行期会话绑定** | ❌ **缺** | 只有 `role-card.js` 一处字样，不是真正的绑定校验 |
| **agent 视角隐藏 QQ 号/管理员身份** | ❌ **缺** | 0 处 |
| **媒体抓取端口白名单** | ❌ **缺** | 0 处 |
| **角色卡按节奏注入** | ❌ **缺** | 0 处。现在**每轮都注入完整 23KB 人格卡** → 每轮多花约 10K tokens |
| **DSH 随机端口自动发现**（`src/dsh-endpoint.js`） | ❌ **缺** | 0 处。现在靠"端口漂移后自动更新 config"，DSH 重启会短暂 401/5xx |
| **控制台 preset 同步到已安装 bundle**（`src/preset-sync.js`） | ❌ **缺** | 0 处 |
| 隐私扫描（含历史提交 + CI） | ✅ 我们更强 | `scripts/check-privacy.mjs`，已进审计 |

## 三、建议的移植顺序

### P0 — 安全（各约半天）

1. **媒体抓取端口白名单** —— SSRF 面：`fetchMediaData` 现在接受任意 URL
2. **agent 视角隐藏 QQ 号 / 管理员身份** —— 提示词里出现真实号码等于给注入者一个靶子
3. **群聊文本 / 搜索结果统一标记为不可信** —— 覆盖上面两处"部分"

### P1 — 稳定性（各半天）

4. **执行期会话绑定** —— 会话与 `agentToken`/mode 绑定，拒绝跨会话调用（上游 #89）
5. **DSH 端口发现** —— 从进程/日志发现真实端口，替代"漂移后改 config"

### P2 — 体验/成本（各 2 小时）

6. **角色卡按节奏注入** —— **同时省钱**：现在每轮 15K tokens 里 10.6K 是人格卡；
   按上游做法"首次/换卡全量、其后每 N 次唤醒一次"，大多数轮次的固定开销能砍一半以上
7. **preset 同步** —— 控制台改的 preset 要落到已安装 bundle，否则改了不生效

## 四、明确不做

- ❌ `git pull upstream/main` / `git merge`：历史无关，必炸
- ❌ 直接 `cherry-pick f6242d6`：648 行 `bridge.js` 改动落不到我们的结构上
- ❌ 为对齐版本号去追踪上游：我们是 fork，版本独立（见 [releases/v0.3.1.md](../releases/v0.3.1.md)）

## 五、下次开工第一条命令

```powershell
git -C D:\qq-bridge log --oneline HEAD..upstream/main |
  Select-String 'security|绑定|幂等|分链'
```

按 P0 → P1 → P2 逐项移植，**每项单独提交 + 真机验证 + 棘轮**，与波次 4 的做法一致。