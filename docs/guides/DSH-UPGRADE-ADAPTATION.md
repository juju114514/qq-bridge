# DSH 升级后的适配清单

> 适用：DSH（DeepSeek Harness）从 `0.2.1-rc.2` 往上升之后，本仓库要跟着改什么。
> 前置：升级**前**已经跑过 `node scripts/snapshot-env.mjs` 存了一份快照。
>
> 当前基线（2026-11-01）：DSH `0.2.1-rc.2` · 仓库 `0.4.68` · 插件 `0.1.0` · Node `v24.21.0`

---

## 〇、升级前先做这一件事

```powershell
cd D:\qq-bridge                      # 你的安装目录
node scripts\snapshot-env.mjs        # 生成 docs/validation/env-snapshot-<日期>.md
git add -A ; git commit -m "snapshot: before DSH upgrade"
```

为什么：DSH 是 **nightly 通道**，插件 API 还在动。没有升级前的可观测状态，升级后只能靠"感觉不对劲"。

---

## 一、升级后第一个命令

```powershell
node scripts\snapshot-env.mjs --compare
```

输出差异，例如：

```
~ dsh.versionFromPs: 0.2.1-rc.2 → 0.3.0
~ plugin.engines.dsh: >=0.2.1-0 <0.3.0-0 → (未变)
+ config.keys: 22 项
```

**每一条差异都要判一次**：影不影响插件？影不影响控制台？影不影响通道？

---

## 二、适配检查表（按这个顺序）

### 1. 插件能否加载（最高优先级）

```powershell
# 看插件日志里有没有这两行
Select-String -Path plugin.log -Pattern '已对 agent 应用工具白名单|agent 已建：preset=qq-chat-v2'
```

| 症状 | 可能原因 | 改哪里 |
| --- | --- | --- |
| 插件根本不加载 | `dsh.plugin.json` 的 `engines.dsh` 范围排除了新版本 | `plugin/dsh.plugin.json` 改 `engines` |
| 加载了但工具没注册 | `contributes.tools` 与 `tools.js` 导出不一致 | `plugin/dsh.plugin.json` + `plugin/tools.js` |
| 工具注册了但调用报错 | cordis / dsh-tools 的 API 变了 | `plugin/index.js`、`plugin/tools.js` |
| agent 建不起来 | dsh-agent / dsh-session 的签名变了 | `plugin/agent-driver.js` |

> 我们的 peerDependencies 全部是 `*` + `optional: true`，所以**不会因版本不匹配而装不上**——
> 反过来说，出了问题也不会报错，只会静默失效。**必须靠日志确认**。

### 2. `cordis.patch.yml` 还合不合法

```powershell
node -e "const y=require('js-yaml');console.log(y.load(require('fs').readFileSync('plugin/cordis.patch.yml','utf8')))"
```

patch 里的插件名/服务名若被 DSH 改名，这里会静默不生效。

### 3. 控制台还能不能起来

```powershell
Invoke-RestMethod http://127.0.0.1:3100/health/detail | Select version,ready
# 浏览器打开 http://127.0.0.1:3100/  看是否还有 "永远在加载"
```

控制台依赖 `window.__DSH_BOOT__`（由 DSH 注入）与 `x-console-token`。若页面白屏，
先看 CDP 有没有 JS 异常（这次教训：**一个 `querySelector(...).textContent` 就能打断整页脚本**）。

### 4. 技能目录与预设

| 路径 | 用途 | 升级后看什么 |
| --- | --- | --- |
| `skills/` | 本仓库技能 | DSH 的技能发现路径是否变了 |
| `~/.dsh/agent-presets/` | `qq-chat-v2` 等预设 | 预设 schema 是否改了字段 |
| `~/.dsh/plugins/<id>/` | 已安装插件 | 重装后版本是否对得上 |

### 5. 工具面（8 个 `qqb_*`）

```
qqb_ping · qqb_get_prompt · qqb_send_message · qqb_reply
qqb_mark_read · qqb_get_recent_messages · qqb_get_unread_messages · qqb_wait_for_messages
```

逐个在 DSH 里调一次 `qqb_ping`，能返回就说明链路通；再试 `qqb_get_recent_messages`。

### 6. 我们自己的验收（三步，缺一不可）

```powershell
node scripts\test-audit.mjs                        # 期望 152/152
powershell -File scripts\verify-qq-bridge.ps1      # 期望 18/18
node scripts\snapshot-env.mjs --compare            # 记录新的基线
```

---

## 三、需要改代码时怎么改（约束）

| 约束 | 原因 |
| --- | --- |
| 不为新 DSH 改**旧版本兼容** | 单人自用，不做多版本兼容层 |
| 先改插件，再改桥接 | 插件是薄层，改动面小、可回退 |
| 改完必须跑审计 | 152 项里有体积/路由/脱敏/文档索引守卫 |
| 大改走 `next/x.y.z` 分支 | 主分支保持可发布 |

---

## 四、回退方案

| 场景 | 方法 |
| --- | --- |
| DSH 新版插件加载不了 | 装回旧版 DSH（保留安装包），或把 `plugin/dsh.plugin.json` 的 `engines.dsh` 放宽 |
| 插件改坏了 | `~/.dsh/plugins/qq-bridge-plugin/index.js.bak-*` 是安装时留的备份 |
| 桥接本身没问题 | 插件模式与桥接模式互斥但独立，关掉插件仍可用常驻 bridge |

---

## 五、已知的"升级必查项"（历史踩过的）

| 项 | 说明 |
| --- | --- |
| `engines.dsh` 范围 | 写死 `<0.3.0-0` 会在 0.3 发布当天直接拒绝加载 |
| 工具名冲突 | DSH 若新增同名工具，`contributes` 会撞 |
| 会话 API 的 `sessionId` | 插件用 `session-<uuid>` 形式，变了会导致记忆对不上 |
| 控制台 boot 注入 | `window.__DSH_BOOT__` 若改结构，控制台会白屏而不是报错 |
| nightly 通道 | 同一天可能连推两个版本，升级后**先跑快照对比再动手** |

---

## 六、一句话

> 升级前：`snapshot-env.mjs` 存基线。
> 升级后：`snapshot-env.mjs --compare` 看差异 → 按 §二 六步查 → 审计 152 + 自检 18 全绿才算适配完。
