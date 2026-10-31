# 升级指南：从旧版本升到 0.4.x

> 写给**还在用老版本**的人（0.2.x / 0.3.x）。
> 结论先放这：**0.4.x 没有破坏性变更**，老配置直接能用；新东西都是可选的。

## 一、30 秒版

```powershell
# 1) 先备份（配置 + 状态，出问题能回滚）
Copy-Item config.json "config.json.bak-$(Get-Date -Format MMdd-HHmm)"
Copy-Item state "state.bak-$(Get-Date -Format MMdd-HHmm)" -Recurse

# 2) 拿新代码（git 或解压 zip 都行）
git pull

# 3) 装依赖 + 重启
npm install
# 双击 restart.bat
```

然后**双击 `自检.bat`**（或 `node scripts/preflight.mjs`），12 项全绿就是好了。

## 二、各版本新增的配置项（缺省值都等于旧行为）

| 版本 | 配置项 | 默认 | 作用 | 要不要动 |
| --- | --- | --- | --- | --- |
| 0.3.1 | `socialV2.notifyAgentErrors` | `true` | 技术报错是否推到 QQ | 建议设 `false`（换模型时不再刷屏） |
| 0.3.1 | `socialV2.roleInjectEvery` | `1` | 角色卡每 N 轮注入一次（省 token） | 想省钱设 `8` |
| 0.4.1 | `channel.enabled` | `true` | `false` = 不连网关、只当 sidecar | 只有用插件模式才要设 |

> **一个都不改也能正常运行** —— 这些默认值就是老行为。

## 三、行为变化（不需要改配置，但你会感觉到）

| 版本 | 变化 | 影响 |
| --- | --- | --- |
| 0.3.1 | 角色卡里的管理员号码改成 `isOwner` 标记 | 换号/迁移机器不用再改角色卡；**升级后请重启一次**让角色卡重新加载 |
| 0.3.1 | `consolePort` 写错会在启动时直接报错 | 以前是静默打不开控制台；现在会告诉你范围（1~65535 或 0） |
| 0.3.1 | `/api/voice/send` 修好了 | 以前一直是 500 |
| 0.3.2 | 干净克隆可跑（116→127 个审计脚本） | 不影响运行时 |
| 0.4.0 | 新增 `state/memory/` 与 `state/channel-mode.json` | 自动创建，不用管 |
| 0.4.1 | bridge 启动认领通道 | 正常单实例无感；**如果启了两个实例**，第二个会被拒绝（以前会互相抢消息） |

## 四、从 0.2.x 升上来要额外注意

| 检查 | 为什么 |
| --- | --- |
| Node ≥ **22.13** | 内置 WebSocket，低了桥接起不来 |
| DSH 版本 ≥ **0.2.1-rc.2** | 预设与模型选择接口对不上会报错 |
| preset 名是 `qq-chat-v2` | 老版本可能还在用 `qq-chat` |
| 跑一遍 `node scripts/setup-dsh.mjs` | 重新装 preset 与 MCP 挂载 |

## 五、旧 state 会被改坏吗？

不会。`state/` 里的结构都是**只增不改**：

- `sessions.json` / `social-v2.json` / `people.json`：字段只加不删
- 新增 `state/memory/`（群记忆交接）、`state/channel-mode.json`（通道认领）、`state/plugin-events.jsonl`
- 读旧文件时会补默认值

如果真出问题，回滚就是：换回旧代码 + 把 `state.bak-*` 覆盖回去。

## 六、要不要顺便试试 0.4.x 的新东西

两个都是**可选**，不装不影响：

| 功能 | 怎么开 | 文档 |
| --- | --- | --- |
| 角色卡按节奏注入（省 token） | `"socialV2": { "roleInjectEvery": 8 }` | `CHANGELOG.md` 0.3.1 |
| 插件模式（把通道装进 DSH） | `channel.enabled=false` + 装插件 | [PLUGIN-MODE.md](PLUGIN-MODE.md) |

## 七、升级后自查清单

- [ ] `自检.bat` 12 项全绿
- [ ] 控制台能打开（`http://127.0.0.1:3100`）
- [ ] 群里 @ 一次有回复
- [ ] 日志里没有 `is not defined` / `ReferenceError`
- [ ] 迁移过机器的话：角色卡里没有写死的管理员号码了

## 八、卡住了看哪

| 现象 | 先看 |
| --- | --- |
| 启动就退出 | `state/bridge.log` 最后 30 行；`自检.bat` 的 FAIL 项 |
| 群里不回 | `allow.groups`；控制台「暂停」开关；`channel.enabled` 是不是被设成 false 了 |
| 报「通道被占用」 | 有另一个实例在跑（`state/channel-mode.json` 里有 pid） |
| 控制台打不开 | `consolePort` 是否被占；令牌在 `state/console-token` |