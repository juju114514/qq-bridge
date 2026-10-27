# 0002 · 移除 `@snowluma/*` 依赖，改用自带 OneBot 客户端

- **状态**：✅ 已实施（2026-10-27）
- **相关**：[0001 SnowLuma 许可询问](0001-snowluma-license-inquiry.md)、[NOTICE.md](../../../NOTICE.md)
- **改动**：`src/onebot-ws.js`（新增）、`package.json`（删两个依赖 + 去掉 postinstall 补丁）
- **回滚**：`git checkout pre-native-ws`（tag）或 `git revert <sha>` + `npm install`

## 一、为什么动这个

`@snowluma/sdk` 与 `@snowluma/mcp` 同时带三个问题：

| 问题 | 事实 |
| --- | --- |
| **许可不可判定** | 两个包的 `package.json` 都声明 `SEE LICENSE IN LICENSE`，但**发布的 npm 包里没有 LICENSE 文件** |
| **受同一份非商业许可约束** | 它们住在 SnowLuma 仓库的 `packages/` 下；按 SnowLuma LICENSE §1 对 "Software" 的定义（"in this repository"），文本上确实受那份许可约束 |
| **我们还得改它才能跑** | 上游发布的 dist 里相对导入缺 `.js` 扩展名，纯 Node ESM 解析不了 ⇒ 上游 qq-bridge 用 `postinstall` **修改** `node_modules/@snowluma/*/dist/**/*.js` |

第三点是决定性的：SnowLuma 维护者在 [K0nd1us/QQ-agent#71](https://github.com/K0nd1us/QQ-agent/issues/71) 里明确把「**安装过程中改写 SnowLuma 程序**」列为需要书面授权的行为之一。我们的补丁改的是 npm 包不是应用本体、只在本机、不重新分发，靠 LICENSE §2(c)「为自己的非商业使用而修改」兜得住——但那是**解释**，不是**事实上的干净**。

而同一个 issue 里也写明：**「普通 OneBot 接口兼容本身并非本通知的侵权认定依据」**。所以只要协议层自己实现，就能把这一整类问题从"需要解释"变成"不需要解释"。

## 二、两条路，选了后一条

| 方案 | 效果 | 代价 |
| --- | --- | --- |
| A-lite：保留依赖，`postinstall` 只在缺扩展名时**提示**、不自动改 | 从"自动改"降为"用户显式改" | 许可不明的依赖仍在；少数用户装完要手动跑一次 |
| **A-full：自带客户端，删依赖 + 删补丁** | 不依赖、不修改、不分发 → **暴露面归零** | 要手写 ~330 行协议层 |

选 A-full 的实测依据（这是关键，不是拍脑袋）：

- `@snowluma/sdk` 在 `bridge.js` 里只用到 **21 个成员**（生命周期 2、事件 6、动作 13）
- `text()` 的实现就是 `chain().text(value)` —— 即 `{ type:'text', data:{ text } }`
- `@snowluma/mcp` **运行时零引用**（只有 1 个诊断脚本用到，已随依赖删除）
- Node ≥ 22 自带 `globalThis.WebSocket` ⇒ 不需要引入任何新依赖

协议语义照 SDK 实现抄（不是猜的）：鉴权走 URL `?access_token=`、动作 `{action, params, echo}` + echo 配对、事件按 `post_type/message_type/notice_type` 分发、`call()` 在 `retcode!=0` 时抛错、断线指数退避重连（1s→30s，成功即重置）。

## 三、怎么保证没换坏

| 手段 | 内容 |
| --- | --- |
| **单元回归** | `scripts/test-onebot-ws.mjs`（18 项）：echo 配对、并发不串台、`retcode!=0` 抛错、超时 reject、6 类事件分发、`bot_status` 判定边界、脏帧不崩、断线重连、主动关闭不重连、21 个成员的 API 面存在 |
| **审计** | 全套 38/38（含新增这项）；harness 里的桩从 `SnowLumaWebSocketClient` 同步改成 `OneBotWsClient` |
| **活体验证（最硬的一条）** | 直接在运行目录 **物理删除 `node_modules/@snowluma`** 后重启：`dshReady=True`、`ws.connected=True`、`accountOnline=True`、心跳正常、`/api/test-send` 真发成功（拿到 `message_id`） |

也就是说：现在就算 node_modules 里从来没有过这两个包，桥接照样跑。

## 四、踩到的坑（留给后来人）

1. **`setTimeout(...).unref()` 不能用在动作超时上**：unref 之后，一个"只在等响应"的进程会在超时前直接退出，表现为 `await` 永不 settle。重连定时器可以 unref（不该拖住退出），动作超时必须让进程活着。
2. **WebSocket 的 error 事件不是 Error**：浏览器风格的事件对象上 `message` 常是 undefined，直接透传会打成 `SnowLuma 错误：{}`（排障时等于没信息）。已加 `normalizeWsError()`。
3. **首连 1006 是既有的自愈路径**，不是这次引入的：token 过期时先失败、后台刷新 token 再连上（日志会打「自愈完成」）。第二次重启就一次连上。

## 五、现在还剩下的（与本案无关，但仍属风险）

- `postinstall` 已不再修改任何第三方包；仓库也不再依赖许可不明的包
- 但**内容类**风险仍在：角色卡（派蒙/樱羽艾玛）、`assets/deepseek娘.png`、以及不在仓库里的点歌/edge-tts 脚本
- 平台风险（QQ 用户协议）不可消除，只能靠使用姿势降低
