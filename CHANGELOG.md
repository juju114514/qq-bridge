# 更新日志

只记**用户能感知的变化**与**踩过的坑**。按日期倒序。

## 2026-11-02 — 0.4.117：告诉模型「官方通道支持 markdown」

用户实测发现：机器人自己在群里说「加粗这种吗，发出来就是一堆星号，QQ 不吃这套」，
然后就用纯文本回复了 —— **渲染能力是有的（0.4.115/116 已验证），但模型不知道**。

### 根因

模型对"QQ 能不能渲染 markdown"有训练期形成的错误成见，会**主动回避格式**。
我们这边做的是"技术上能发"，缺的是"让它知道能发"。

### 改法

`roleHintForMode()` 里多注入一行**通道能力**（`channelCapabilityLine`）：

| 会话 | 注入内容 |
| --- | --- |
| 官方通道 + `official.markdown=true` | 「当前是 QQ 官方机器人通道，**支持 markdown 渲染**：# 标题、**加粗**、- 列表、> 引用、[文字](链接)；想强调就用这些，不要靠堆符号或说"QQ 不支持格式"」 |
| 官方通道 + markdown 关 | 「纯文本输出」 |
| 个人号（OneBot） | 「**纯文本**：markdown 会被压成纯文本，标题/加粗不会渲染」 |

顺带解决一个反向问题：个人号那条现在会明确告诉模型"别用 markdown"，
省得它辛辛苦苦写一堆 `**` 然后被压成纯文本。

### 测试

`test-channel-hint.mjs` 4 条：官方开/官方关/个人号/空 key。

**审计 173/173。**
## 2026-11-02 — 0.4.116：控制台「markdown 测试发送」

0.4.115 加了 markdown 出站但默认关，没法验证渲染。这一版给控制台加了个测试按钮。

### 新增

- 官方通道页 →「markdown 测试发送」：openid 留空 = 用**最近一条入站会话**
  （`state/official-inbound.json`），带一段覆盖官方全部支持语法的样例
- `POST /api/official/test-markdown`：强制走 markdown（绕过配置开关），但仍走语法判断与降级
- `src/official-test-send.js`：从 bridge 抽出来的窄模块（bridge 已顶到体积上限）

### 样例里覆盖了

`## 标题`、`**加粗**`、`__下划线__`、`_斜体_`、`~~删除线~~`、无序列表、`> 引用`、`***` 分割线、`[链接]`

### 两个坑

1. **`forceMarkdown` 不能省降级**：测试时也要能看出「官方到底接受不接受」，
   所以只绕配置开关，不绕语法判断/降级/记忆化。
2. **bridge 体积又顶了**：`officialTestSend` 塞在 deps 里让 bridge +53 行 → 抽成独立模块。
## 2026-11-02 — 0.4.115：官方通道 markdown 出站（带按错误码降级）

调研结论落地：官方 2026/04/23 起群聊/单聊**自定义 markdown 全量开放**，我们之前一直只发纯文本，
等于主动放弃了标题/加粗/列表/链接的渲染。

### 做了什么

| 文件 | 作用 |
| --- | --- |
| `src/md-to-qq-markdown.js` | 标准 markdown → QQ 子集（代码块去围栏、行内 code 去反引号、HTML 删除、表格转 `· a · b`、`---`→`***`） |
| `src/qqbot-official.js` | 新增 `sendGroupMarkdown` / `sendC2CMarkdown`（`msg_type:2`，**刻意不带 content**） |
| `src/official-errors.js` | `shouldFallbackToPlain(code)` / `isLengthError(code)`，判据只用 err_code |
| `src/official-transport.js` | `sendText(..., { markdown: true })`：语法定 → 发 markdown；被拒 → 降级纯文本并**记忆 10 分钟** |

### 三个刻意的设计

1. **不复用 `sendGroupText` 改字段**：它一定带 `content`，而官方要求「传了 markdown 后 content 必须为空」，
   混用就是 22006 / 40034008 的来源。所以另开两个方法。
2. **纯文本不走 markdown 通道**：`hasMarkdownSyntax()` 判断没有标题/加粗/列表/链接就不发 markdown，
   免得为了一个标点白烧一次被动回复配额（群 5 条/5 分钟）。
3. **降级按 err_code 而不是 message**：官方明说 message 会变，AstrBot 那套字符串匹配不该学。
   `22006/40034008/40034009/40034011/40034124/304061/40034127/304036` → 降级；
   `40054007/40054018`（超长）→ 不是降级，交给上层切分；
   配额/权限类（`40034128` 等）→ 直接抛。

### 开关

`config.official.markdown`（默认 `false`，fail-closed）。打开后正常回复走 markdown，
控制台播报/降级重发仍走纯文本。

### 测试

`test-qq-markdown.mjs` 14 条：语法保留、代码块/行内 code/HTML/表格/分割线转换、
纯文本不触发、降级文本复用 `mdToPlain`、降级与切分判定。

踩到一个自己的 bug：表格分隔行的正则没要求竖线，把 `---` 当成表格分隔线整行吃掉了（测试抓到的）。

**审计 172/172。**
## 2026-11-02 — 0.4.114：官方扫码绑定 + 版本更新提示（+ markdown 调研）

两件事并行做的：主线写扫码绑定/更新提示，两个只读子代理分别逆扫码协议、查 markdown 规格。

### 1) 官方机器人扫码绑定

用户不用再去开发者后台翻 AppID/AppSecret。协议是照 AstrBot 逆出来的（`login_registration.py`）：

```
① POST https://q.qq.com/lite/create_bind_task   {"key": base64(32 随机字节)}
   → {"retcode":0,"data":{"task_id":"..."}}
② 二维码内容是一个 URL 字符串（不是图片）：
   https://q.qq.com/qqbot/openclaw/connect.html?task_id=<id>&_wv=2
③ POST https://q.qq.com/lite/poll_bind_result   {"task_id":"..."}
   → data.status: 0/1 等待、2 完成、3 过期
④ 完成时返回 bot_appid + bot_encrypt_secret，用 ① 的 key 做 AES-256-GCM 解密
   （nonce=前12字节、tag=后16字节、无 AAD），明文是**裸 AppSecret 字符串**
```

新增：`src/official-bind.js`（解密/状态/会话）、`src/api/official-bind-route.js`（start/poll/apply），
官方通道页新增「扫码绑定」区块（复用已有的 qrcode 库），成功后一键「写入配置」。

真机实测（会真的向 q.qq.com 发请求）：

```
POST /api/official/bind/start → taskId=18fedeff-f29d-415b-8515-3bb6c914f483
二维码 = https://q.qq.com/qqbot/openclaw/connect.html?task_id=18fedeff...&_wv=2
POST /api/official/bind/poll  → status=pending
```

### 2) 版本更新提示

`src/update-check.js`（子代理写的，274 行）+ `GET /api/update/check` + 控制台顶部横幅。

- GitHub Releases 最新版 vs 当前版本（semver，含预发布比较）
- 6 小时缓存（`state/update-check.json`），失败静默，绝不打扰
- 横幅「知道了」按版本号记 localStorage，不再重复弹

注：当前 GitHub 上最新是 `0.4.106`（0.4.107 之后都只在本地），所以现在显示「无更新」是**正确行为**。

### 3) 官方错误码再订正（markdown 相关）

按官方「发送群聊/单聊消息」页的码表补了 22006/40034008/40034009/40034011/40034124/
40034127/304036/40054010/40054007/40054018；并把查不到出处的码（50056/11241/11244/
304003/304023/22009/100017）挪进 `UNVERIFIED_CODES`，**不让它们驱动降级逻辑**。

### 4) 入站兜底

`text: stripMention(d.content || d.markdown?.content || '')`——
万一官方改推 markdown 事件（`content` 为空），不会变成空消息。

### 5) markdown 出站：还没做（调研结论先记下）

| 结论 | 说明 |
| --- | --- |
| 格式 | `msg_type: 2` + `markdown.content`，**且 content 必须为空**（否则 22006/40034008） |
| 权限 | 2026/04/23 起群聊/单聊自定义 markdown **全量开放**，不用申请模板 |
| 与图片互斥 | 一条消息只能一种 msg_type；图文要拆两条，或把图片 URL 写进 markdown |
| 长度 | 官方没给数字，只有 40054007；第三方按 2000 码点切（未证实） |
| 降级判据 | 按 err_code（22006/40034008/40034009/40034011/40034124 → 降级纯文本），**不要学 AstrBot 用 message 字符串** |

**审计 171/171。**
## 2026-11-02 — 0.4.113：官方通道退避重试 + 错误码订正 + 被动配额修正

起因："官方通道一直不好修"。先看了 AstrBot 的实现（`qqofficial/` 1092 行 + `login_registration.py`），
再对着官方文档逐条核对，发现我们这边**不是"没重试"这么简单**，有几个真正会丢消息的 bug。

### 1) 429 / 5xx 退避重试

`_post` 原来是一发不成就抛，官方一限流这条消息就没了。现在：

```
429/502/503/504 → 读 retry-after（没有就指数退避 400→800→1600ms，带抖动，封顶 10s）
               → 最多 3 次
其他 4xx        → 不重试（重试只会更惹限流）
```

### 2) 重试必须换 msg_seq（否则被去重直接拒）

官方规则：**相同 `msg_id + msg_seq` 重复发送会失败**（`40054005`）。
所以被动回复重试时把 `msg_seq += 1`；并且 `40054005` 视为"上一次其实已经发成功了"，当成功处理。

### 3) `res.ok` 不等于成功

官方 **201/202 是"异步成功"，响应体里仍可能带 error body**。现在用 `classifyOfficialResult`：

```
成功 = 2xx 且 err_code === 0
```

### 4) 被动回复配额：单聊不是 5 条，是 4 条

| 场景 | 有效期 | 可回复次数 |
| --- | --- | --- |
| 群聊 | 5 分钟 | 5 条 |
| **单聊** | **60 分钟** | **4 条** ← 我们以前按 5 条算，第 5 条必被拒 |

`ReplySeqTracker` 改成按 kind 取上限 + 每条 msg_id 记 TTL（群 5 分钟 / 单聊 60 分钟），
过期后不再尝试被动回复。

### 5) 错误码表订正（重要）

上一版码表里有**我自己编的四条**，官方码表根本不是那个意思：

| 旧写法 | 官方真值 |
| --- | --- |
| 11241 = markdown 权限不足 | ❌ 11241 = 参数里缺少 token |
| 304003 = 需要开通权限 | ❌ 304003 = URL 未报备 |
| 304023 = 风控拦截 | ❌ 304023 = 推送成功、等待人工审核（是**成功**语义） |
| 11244 = 被动回复用完 | ❌ 官方无此码（真码是 40034128） |

现在只保留能从官方文档确认的码（40034128 / 40034005 / 304103 / 40054005 / 40034100 /
40034006 / 40054007 / 50006 / 22006 / 50056 / 304036 / 100016 等），未知码只显示原始信息不猜。

### 6) 文件拆分

`qqbot-official.js` 顶到体积上限，把策略拆成两个新模块：

- `src/official-errors.js`（51 行）：退避、错误码表、结果分类
- `src/official-limits.js`（56 行）：被动配额常量 + `ReplySeqTracker`

### 7) 还没做的（下一步）

- **扫码绑定**：AstrBot 那套 `q.qq.com/lite/create_bind_task` → 轮询 → AES-256-GCM 解密拿 Secret，
  协议已完整逆出来（见会话记录），用户不用再手抄 AppID/Secret
- **markdown**：官方 2026/04/23 起群聊/单聊自定义 markdown 已全量开放，我们现在只发纯文本

**审计 169/169。**
## 2026-11-02 — 0.4.112：手机端两处修（导航被截断 / 记忆星图首屏全被说明占满）

来自用户真机截图（手机 APK 里打开控制台）。

### 1) 顶部导航：从"横向滚动"改成"两行 + 全部功能"

原来窄屏是 `overflow-x:auto` 单行横滑，右侧项被切掉且看不出能滑。

改法：`flex-wrap: wrap` 让所有项换行可见 → 但 21 个入口换成 6 行，把首屏吃掉了 →
再收成**两行 + 渐隐 + 「全部功能 ▾」**按钮，点开展开全部。

实测（390×844 视口）：

```
导航行数: 6（展开态）    横向溢出: 无
默认: 两行，底部渐隐，按钮在下方
```

### 2) 记忆星图：窄屏单列 + canvas 变矮 + 图例默认收起

原来 `grid-template-columns: minmax(0,1fr) 300px` 在 390px 屏上把 canvas 挤成一条，
右侧 300px 的说明/图例反而占满首屏。

改法（只在 ≤760px 生效）：

```
.mg-body   → 单列
#mgCanvas  → 520px 降到 340px
.mg-side   → 默认 display:none，点「图例」按钮展开
```

实测：`图例面板默认隐藏: none`、`画布高度: 340`、`图例按钮: 可见`。

### 说明

这两处都在 `public/console.html` 的响应式部分，**不改 APK**——手机下拉刷新就生效。
## 2026-11-02 — 0.4.111 + APK 0.5.x：二维码地址修正、手机端排版、WebView 视口

### 1) 二维码里不能再是 127.0.0.1（0.4.111）

用户在手机上扫码后报 `ERR_CONNECTION_REFUSED`——因为控制台是用 `http://127.0.0.1:3100`
打开的，二维码里就编了 127.0.0.1，而**在手机上 127.0.0.1 指的是手机自己**。

新增 `GET /api/console/addresses` 返回本机所有局域网地址：
```
http://192.168.1.2:3100   http://192.168.56.1:3100   http://172.30.16.1:3100
```
二维码上方加了下拉，默认选第一个局域网地址。

### 2) 手机端排版（0.4.112）

- 顶部导航：`overflow-x:auto` 单行横滑 → 换行；再收成**两行 + 渐隐 + 「全部功能 ▾」**
- 记忆星图：窄屏单列、canvas 520→340px、图例默认收起（点「图例」展开）

### 3) APK：卡死界面 + 视口错位（0.4.0 ~ 0.5.2）

| 版本 | 修了什么 |
| --- | --- |
| 0.4.0 | **☰ 悬浮设置**（重新加载/换服务器/复制地址）；加载失败改用**原生错误页**；载入前 3 秒探活 `/health` |
| 0.5.0 | 连接前判断网络类型：移动数据 + 192.168.x → 弹窗提醒；错误页显示"当前网络" |
| 0.5.1 | **关掉 `setUseWideViewPort` / `setLoadWithOverviewMode`** |
| 0.5.2 | 支持 `qqbridge://` deep link（系统相机扫码也能直接开） |

### 4) 视口那个坑（最值得记）

用户手机截图：整页**左右都被切掉、还偏到一边**。

原因不是 CSS（Chrome 在 390 宽下 `scrollWidth == innerWidth`，无溢出），而是 WebView：

```java
s.setUseWideViewPort(true);        // 按桌面宽度(≈980px)排版
s.setLoadWithOverviewMode(true);   // 再整体缩放
```

页面里有 `width=device-width` 的 viewport meta，两者叠加就变成"宽布局 + 缩放 + 偏移"。

改成：
```java
s.setUseWideViewPort(false);
s.setLoadWithOverviewMode(false);
```
真机尺寸（1080×2400 @420dpi）复测：导航两行、卡片满宽、无裁切。

### 5) 测试方法（记一下，免得下次又踩）

- MuMu 改分辨率：`adb shell wm size 1080x2400` + `wm density 420`，测完 `wm size reset`
- 竖屏锁定：`settings put system user_rotation 0`
- **`am start -d` 里的 `&` 会被吃掉**：验证 deep link 时要把 token 塞进 url 参数，
  只用 `?url=<encode(含token的完整地址)>` 这种单参数形式
## 2026-11-02 — 0.4.110：控制台限流 + 访问审计 + 设备签名强制

上公网/隧道之前的安全地基。

### 1) 限流

同一来源 60 秒内鉴权失败 **12 次**后返回 429（带 `retry-after`）。实测：

```
连续 15 次错令牌：401 ×12 → 429 429 429
```

### 2) 访问审计

`state/access-log.jsonl`：`{at, ip, method, path, ok, reason, device}`，最多 3000 行，只记元数据不记正文。

### 3) 设备签名强制（enforce）

prelude 在令牌校验**之前**先问 bridge：请求带没带设备签名。

| 请求（mode=enforce） | 结果 |
| --- | --- |
| 正确 secret 签名（不带控制台令牌） | **200** |
| 错误 secret | 401「签名不匹配」 |
| 不带签名 | 401 |

POST 的 body 哈希在 `readBody` 里核对：签名对但 body 被换 → 直接抛错。

### 三个坑

1. `signRequest is not defined`：deps 用了新函数却没 import。
2. `deviceNonces is not defined`：只加使用、忘了声明 `createNonceCache()`。
3. 上面两个都表现成 **headers timeout**（异常在 prelude 里外层没兜住，服务器不响应），
   不是错误码。教训：prelude 加新依赖，必须先发一次签名请求验证。

### 边界

- 限流在**单进程内存**，重启清零；多实例要换共享存储。
- 审计是追加写，无轮转压缩（3000 行上限自动裁老）。
- enforce **默认关闭**，在控制台「手机设备 → 校验模式」手动开启。

## 2026-11-01 — 0.4.103：环境感知（时间 + 天气）注入提示词

从抖音刷到的一个 DSH 同栈作品（「番狗炒茄蛋」的"大肥鱼的家"）里，作者说要接
"窗外与我同步的实时天气"。这是**最便宜的真实感**：一句「外面在下雨，16℃」就能让
"你那边冷不冷"这类对话有实感。先做这个，再做"状态层"。

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/environment.js` | 纯函数：时段桶、WMO 天气码翻译、时间行/天气行/合并行、缓存新鲜度、open-meteo 解析 |
| `src/environment-runtime.js` | 取数+缓存+配置读写（独立成文件，避免 bridge 行数棘轮） |
| `src/api/environment-route.js` | `GET/POST /api/environment` |

### 注入效果（真机实测）

```
现在：11月1日 周日 21:20（晚上）；杭州 外面 毛毛雨 16℃
```

这行会跟"外观描述"一起追加到角色提示词末尾（每隔 10 分钟刷新一次，unref 定时器）。

### 设计取舍

- **天气失败不编**：拿不到就只注入时间（`外面…` 整段消失），并写日志
- **30 分钟缓存**：天气没必要每条消息拉一次
- **不填坐标 = 不发任何网络请求**，只有时间
- 配置存 `state/env-config.json`（不写 `config.json`：那边的写入路径没有统一入口，
  而且桥接的 `cfg` 变量在函数作用域里，顶层拿不到 —— 第一次实现就踩了这个坑，
  报 `cfg is not defined`）
- 不猜城市、不做 IP 定位（隐私上更干净）

### 控制台

人格与角色页新增「环境感知（时间 / 天气）」：启用开关、城市名、纬度、经度、
「保存并刷新」/「刷新」，下面一行直接显示当前注入的句子。

### 测试

`test-environment.mjs` 9 条：时段 / 时间行 / 天气码 / 天气行空值 / 合并行 /
缓存新鲜度 / open-meteo 解析 / 脏数据。
## 2026-11-01 — 0.4.108：手机版页 + PWA（本地，未推送）

用户选了"② 手机版页面 + PWA"。目标：手机连上后用起来顺手，而不是把 19 个页面塞进 5 寸屏。

### 手机版（导航第一项）

一屏六个大按钮 + 一张状态卡：

```
┌ 版本 0.4.108 · 就绪   网关 ✅ · DSH ✅   运行 X 分钟 ┐
[ 刷新状态 ]  [ 最近日志 ]
[ 会话列表 ]  [ 重置会话 ]
[ 空间发说说 ] [ 设备配对 ]
┌ 发消息：会话下拉（15 个）+ 文本框 + 发送 ┐
└ 输出区（结果都在这里） ┘
```

- 触控尺寸：`min-height:64px`，窄屏（<480px）变单列、`72px`
- 发消息按会话类型自动走 `/api/send/group` 或 `/api/send/private`；留空 = 主人私聊
- 「重置会话」复用 0.4.91 的接口（**默认先备份**）

### PWA（可安装）

| 文件 | 作用 |
| --- | --- |
| `public/manifest.webmanifest` | 名称/图标/standalone/快捷方式（手机版、运行总览） |
| `public/sw.js` | Service Worker：**页面网络优先**，`/api/*` 一律不缓存（令牌与聊天内容） |
| `public/icons/icon-192.png` `icon-512.png` `apple-touch-icon.png` | 用 Pillow 现场画的鲸鱼图标 |

静态路由只放行这三个文件（不做通用静态目录，避免把 `state/` 之类暴露出去）；
prelude 里也放行它们（浏览器安装时不带令牌）。

### 实测

```
/manifest.webmanifest  HTTP 200  application/manifest+json   773 B
/sw.js                 HTTP 200  application/javascript     1598 B
/icons/icon-192.png    HTTP 200  image/png                  1232 B
```

CDP（390×844 手机视口）：
```
手机版页存在: true      按钮: 7      会话下拉: 15
状态卡: 版本 0.4.108 · 就绪 网关 ✅ · DSH ✅
manifest link: true     SW 注册: 已注册    JS 异常: 0
```

### 三个坑

1. **`consolePages` 插入位置错了**：我把 `mobile:` 插到了 `overview: [` 的**中括号里面**，
   结果 `overview` 的数组元素被挤到 `mobile` 后面 → 整个主脚本 `Unexpected token ':'`。
2. **`</script>` 被吃掉**：注册 SW 时我用正则替换 `</script></body>`，替换文本没包含 `</script>`，
   于是上一段脚本没有闭合，新 `<script>` 被当成 JS → `Unexpected token '<'`（第 8425 行）。
3. **Service Worker 在 http 局域网下不注册**（浏览器要求安全上下文）。所以：
   **家里 http 访问能装到桌面，但 SW 不生效**；离线壳只有 https/localhost 或 Tailscale 下才有。
   这点我在页面里做了静默降级，不影响使用。

### 下一步（仍未做）

- enforce 模式的设备签名关卡（需要把 body 哈希纳入校验）
- Tailscale 文档（0 代码）
- 「家」视图
## 2026-11-01 — 0.4.107：设备配对 + 请求签名（手机端凭证）

用户问"能不能自己研究一套加密方法，只有控制台和手机知道"。
结论：**不自己发明算法**，用标准件拼出同样的效果 —— HMAC-SHA256 签名 + 配对码 + nonce 防重放。

### 设计（全部用 Node/浏览器自带的能力）

```
① 配对（一次性）
   电脑控制台生成 6 位配对码（60 秒、一次性）
   手机 POST /api/auth/pair {code, name} → 拿到 deviceId + deviceSecret（只回这一次）

② 每个请求签名
   HMAC-SHA256(secret, method + path + timestamp + nonce + sha256(body))

③ 服务器校验
   ±60 秒时间窗（防过期重放）
   nonce 去重（5 分钟 TTL，防同窗口重放）
   timingSafeEqual 常量时间比较
   设备吊销表
```

### 新增

| 东西 | 说明 |
| --- | --- |
| `src/device-auth.js` | 签名/校验/常量时间比较/nonce 缓存/配对码/设备库（纯逻辑，可测） |
| `src/api/device-auth-route.js` | 配对码 / 配对 / 设备列表 / 吊销 / 模式开关 |
| `state/device-auth.json` | 设备库（secret 与 console-token 同级；`state/` 已 gitignore） |
| 控制台「手机设备」卡 | 生成配对码、看设备、吊销、切换校验模式 |

### 实测（真机）

```
生成配对码 → 800703
POST /api/auth/pair → deviceId=692c628f4b8c8464，secret 长度=64
GET /api/auth/devices → 1 台「测试手机」，列表里不返回 secret
```

### 明确的边界（别误解这套东西）

- **它不替代 TLS**：线路加密交给 Tailscale / HTTPS。这套只管"请求是不是你的、有没有被重放"。
- **enforce 模式还没接进入口**：模式开关（off/warn/enforce）已存进配置，
  但真正"没签名就拒绝"的拦截还没挂到请求入口——因为**要验 body 哈希就得先读 body**，
  而那一步在控制台请求管线的更下游。当前默认 `off`，功能不影响使用。
  下一步（0.4.108）：在 prelude 里加设备签名关卡 + 把 body 哈希纳入校验。
- **secret 在磁盘上是明文**（`state/device-auth.json`），和 `console-token` 同级别保护。

### 测试

`test-device-auth.mjs` 11 条：签名稳定性 / 篡改拒绝 / 时间窗（59 秒过、61 秒拒）/
nonce 重放 / 缺字段 / 配对码一次性与过期 / 设备库（列表不带 secret、吊销）/ nonce TTL。
## 2026-11-01 — 0.4.106：网关多账号面板（看见 + 选择）

用户发现 SnowLuma 可以同时注入两个号，问"控制台要不要适配，识别当前已注入账号，然后选择查看每个账号"。

### 先说清楚事实（本机实测）

| 账号 | 配置 | 状态 |
| --- | --- | --- |
| 3976372760 | `onebot_3976372760.json`，http 3000 / ws 3001 | **在线**「小鲸鱼（大肥鱼）」 |
| 1599683156 | `onebot_1599683156.json`，`networks` 是空的 | 未配端口，没在跑 |

也就是说：**能同时注入，但每个号要各自配 http/ws 端口**，而且我们的桥接只连一对端口
（`snowluma.httpUrl` / `wsUrl`），所以同一时刻只服务一个号。

### 做了什么

- `GET /api/gateway/accounts`：读 `config/onebot_*.json`，逐个打 `get_login_info`
  验证「端口通 + token 对 + 已登录」，返回账号列表 + 昵称 + 是否当前绑定
- `POST { action:'bind', uin }`：把桥接的 `config.json` 指向该号的端口（**重启后生效**）
- 控制台「调试与运维」页新增「网关账号」卡：每个号一行（号/昵称/端口/当前绑定），
  未绑定的可一键绑定

### 实测

```
发现 2 个号 · 桥接当前指向 http://127.0.0.1:3000
1599683156  http=—     ws=—     离线  未配端口
3976372760  http=3000  ws=3001  在线  小鲸鱼（大肥鱼）  （当前绑定）
```

CDP 验证：卡片存在、2 行、无 JS 异常。

### 为什么不做"同时驱动两个号"

桥接的 `state/`（会话、记忆、主人、白名单、唤醒）都是**单份**的，两号共用会串台：
- 群 A 的记忆会串到另一个号看到的群 A
- `ownerQQ` 只有一个
- 单实例锁 + 端口互斥也是按一个进程设计的

真要多号，正确做法是**每号一个桥接实例**（各自的 config/state/端口），那是另一个工程；
现在先给"看见 + 选择"。

### 一个值得注意的现状

桥接 `ownerQQ = 1599683156`，但**当前在跑的机器人号是 3976372760**。
这不冲突（主人 ≠ 机器人），但如果哪天想用 1599683156 当机器人，就得在网关里给它配端口再绑过来。

**审计 165/165。**
## 2026-11-01 — 0.4.105：天气选择改成「省 → 市 → 区/县」+ 按 IP 定位

用户反馈：
1. "搜索城市、选择站点改成选择，如 省——地级市——县级市，搜索用于辅助"
2. "我输入乌鲁木齐没有刷新到对应城市，看看是什么原因"
3. "如果可以加入自动识别 IP 来定位城市……嗯，可能有点困难，因为会有人使用代理"

### 先回答"为什么输入乌鲁木齐没刷新"

接口其实是好的——`GET /api/environment?q=乌鲁木齐` 能返回 10 个候选，第一个就是
**乌鲁木齐（51463）**。问题在前端：**搜索只在点按钮/回车时触发**，而且下拉换成了新内容
没有提示，看起来像"没反应"。

### 改法一：三级级联（数据源：中国天气网区域表）

| 层级 | 接口 |
| --- | --- |
| 省 | `city.xml` → 34 个（北京/上海/…/台湾） |
| 地级市 | `city<省>.xml` → 如新疆 16 个（乌鲁木齐/克拉玛依/石河子…） |
| 区/县 | `city<省><市>.xml` → 如乌鲁木齐 8 个（乌鲁木齐/蔡家湖/小渠子…） |

选完区县后用**名字**去中国气象局解析站点（`/api/environment/resolve?name=`），
天气数据仍走气象局（更准），区域层级走天气网（更全）。缓存 7 天到 `state/area-cache.json`。

### 改法二：搜索变成"输入即搜"

输入框加 300ms 防抖，**不用点按钮**；搜到后自动把三级下拉回填到匹配位置。

### 改法三：按 IP 定位（明确告诉用户不可靠）

新增 `GET /api/environment/detect`：走 `myip.ipip.net`（国内源），退路 `ip.sb`。
实测本机：

```
{"ip":"2409:8a7c:...","province":"新疆","city":"乌鲁木齐","source":"ipip.net",
 "station":{"id":"51463","name":"乌鲁木齐"}}
```

**但**：`ip.sb` 同一台机器返回的是「广东 广州」——正好印证用户的担心（代理/CDN 出口不一致）。
所以设计成：**只填表单、不自动保存**，页面提示"代理/VPN 会影响，请核对再保存"。
另外首次请求常因 DNS 预热失败，加了 1 次重试。

### 真机结果

```
省列表：34 个
新疆 → 16 个地级市，乌鲁木齐 code=1301
乌鲁木齐 → 8 个区县
解析站点 → 51463 乌鲁木齐
保存后注入：现在：11月1日 周日 22:00（深夜）；乌鲁木齐 外面 3℃
```

### 踩到的坑（值得记）

1. **补丁脚本的"存在性判断"被调用点误命中**：我用 `if "loadAreaOptions" not in c` 判断
   函数是否已插入，但 `bindEnvironment` 里**调用**了它 → 判断为"已存在" → 函数根本没插进去。
   CDP 一跑就报 `ReferenceError: loadAreaOptions is not defined`。改成检查 `async function loadAreaOptions`。
2. **城市名被空串覆盖**：保存时 `city: {name: ''}` 把上次的名字清掉，注入行变成"58457 外面 12℃"。
   现在空名字不覆盖，路由层也不写空串。
3. `myip.ipip.net` 返回「中国 新疆 乌鲁木齐 移动」，直接按空格切会把"中国"当省 → 要先过滤国名。
## 2026-11-01 — 0.4.103 / 0.4.104：环境感知（时间 + 天气）

从抖音刷到一个 DSH 同栈作品（「番狗炒茄蛋」的"大肥鱼的家"）——作者说要接
"窗外与我同步的实时天气"。这是**最便宜的真实感**：一句「外面在下雨，16℃」就能让
"你那边冷不冷"这类对话有实感。

### 0.4.103：先接 open-meteo（国外源），只做时间 + 天气

- `src/environment.js`：时段桶 / 天气码翻译 / 时间行 / 缓存新鲜度（纯函数）
- `src/environment-runtime.js`：取数 + 缓存 + 配置读写
- `src/api/environment-route.js`：`GET/POST /api/environment`
- 注入到角色提示词末尾，10 分钟刷新一次（unref 定时器）

### 0.4.104：换成国内官方源（用户要求"用国家的那种，方便准确"）

数据源优先级：**中国气象局 `weather.cma.cn`** → open-meteo（按经纬度）→ 只用时间。

| CMA 接口 | 拿到什么 |
| --- | --- |
| `/api/now/<站点号>` | 实况温度 / 湿度 / 风向 / 风力 |
| `/api/weather/view?stationid=` | 今天白天文字 + 高低温 |
| `/api/autocomplete?q=` | 城市搜索（用户不用自己查站点号） |

控制台改成**搜城市 → 选站点**：输入「杭州」→ 出「杭州（58457）/ 余杭（K1418）…」→ 选中保存。
换城市会**自动清掉旧缓存**（否则会继续显示上一个地方）。

### 真机实测

```
搜索「杭州」→ 杭州（58457） / 余杭（K1418） / 上杭（58918）
保存站点 58457 →
  现在：11月1日 周日 21:27（晚上）；杭州 外面 小雨 16℃（今天 15~28℃）
```

（和中央气象台当页一致：今日小雨、15~28℃。）

### 踩到的三个坑

1. **bridge 顶层的 `cfg` 不在作用域里**：`getConfig: () => cfg` 直接 `cfg is not defined`。
   最后让环境配置**只认 `state/env-config.json`**，不碰 config.json（那边的写入路径没有统一入口）。
2. **审计 harness 的 VM 里没有 `createEnvironment`** → 15 个审计全红（`ReferenceError`）。
   在 `audit-bridge-harness.mjs` 的注入表里补桩，并把 `envRuntime` 改成**懒初始化**，避免顶层副作用。
3. **`-WindowStyle Hidden` 的老教训重演**：`fs.renameSync` 被原子写守卫拦下 ——
   guard-allow 注释必须单独一行写在调用**前**，写在行尾不认。

### 测试

`test-environment.mjs` 15 条：时段 / 时间行 / WMO 码 / 天气行 / 合并行 / 缓存 /
open-meteo 解析 / **CMA now / daily / 搜索 / URL / 优先用源给的 line** / 脏数据。
## 2026-11-01 — 0.4.102：运行报告不再把"部署"当成"崩溃"

用户贴了一份 07:57 的报告：**判定 FAIL**，理由是「24h 重启 10 次」。

### 真相：那 10 次全是我在发版

每次部署都是 `schtasks /end` + `/run`，被强杀的进程退出码是 1 ——
报告把"部署"和"崩溃"算成一类，于是**每发一版报告就变红一次**，真问题反而被淹没。

### 做法

1. 新增 `src/restart-classify.js`（纯函数）：按"计划内重启标记"的时间窗口把重启分成
   计划内 / 未计划
2. 部署前写一条标记到 `state/planned-restarts.jsonl`
3. 报告的重启项改成：
   - 未计划 **0** 次 → ✅「24h 重启 10 次（都是计划内）」
   - 未计划 1–2 次 → ⚠️
   - 未计划 ≥3 次 → ❌「先查退出码与内存」

> watchdog 只给次数、不给逐次时间戳，所以按"24h 内标记条数"抵扣，不会超过总重启数。

### 效果（真机）

```
改前：❌ 24h 重启 10 次 —— 重启过于频繁，先查退出码与内存        → overall=FAIL
改后：✅ 24h 重启 10 次（都是计划内）—— 部署/手动重启，不算稳定性问题  → overall=WARN
```

WARN 的来源只剩「连续运行 0 分」（刚重启，本来就不该说稳定），这是**如实**的。

### 测试

`test-restart-classify.mjs` 7 条：纯部署 / 纯崩溃 / 混合 / 窗口内外 / 标记文件读写与上限 / 坏数据 / 文案。
## 2026-11-01 — 0.4.101：把真机仓库里 113 个 auto snapshot 合并成一个

用户："合并成一个快照提交日期我来决定" → 定在 **2026-11-01 00:00**。

### 现状（合并前）

`<repo>` 自己的 git 历史：**126 个提交，其中 113 个是**
`auto snapshot (11-01 07:40:00)` 这种每 10 分钟自动生成的检查点。

### 做法

`scripts/squash-snapshots.ps1`（默认演练，`-Apply` 才动）：

1. 要求工作区干净
2. `git bundle create state/pre-squash-<时间>.bundle --all` —— **全量备份历史**（16.4 MB）
3. 打 tag `pre-squash-<时间>` 作回滚点
4. `checkout --orphan` → `add -A` → **一个**提交（`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` 用你指定的时间）
5. 用新分支替换 `main`，并设 upstream

### 结果

```
合并前：126 个提交（113 个 auto snapshot）
合并后：1 个提交  f4b9dd3  2026-11-01 00:00  snapshot: 历史合并（日期由用户指定）
```

### 内容没变（逐个文件哈希比对）

```
compat.json          ✓ 与合并前一致
README.md            ✓ 与合并前一致
public/console.html  ✓ 与合并前一致
src/bridge.js        ✓ 与合并前一致
package.json         ✓ 与合并前一致
与 fork main 比对：无差异
```

### 回滚

```powershell
git -C "<repo>" reset --hard pre-squash-20261101-075554
git -C "<repo>" bundle unbundle state/pre-squash-20261101-075554.bundle
```

### 踩到的坑（已修进脚本）

`git checkout --orphan` 会把 **正常提示**（`Switched to a new branch …`）写到 stderr，
而脚本开头是 `$ErrorActionPreference='Stop'` → PowerShell 把它当错误**直接中断**。
现在调用原生命令的那几处临时切回 `Continue`。

> 另外要说清：这些 auto snapshot 很可能是 **DSH 工作区自己的检查点机制**（不是本仓库的脚本，
> 全仓搜不到生成器）。合并只是把历史压平，**新快照还会继续产生**；要彻底停得关掉那个机制。
## 2026-11-01 — 0.4.100：排查"偶尔跳出 PowerShell 黑框"

用户："我屏幕偶尔会跳出powershell。排查一下"

### 排查结论（有证据）

| 项 | 结果 |
| --- | --- |
| 谁在跑 | `qq-bridge-watchdog`，**每 5 分钟**一次 `keepalive.ps1` |
| 怎么跑的 | 任务动作 `powershell.exe -NoProfile -WindowStyle Hidden …`，Principal 是 **InteractiveToken**（跑在你的桌面会话里） |
| 为什么还闪 | **`-WindowStyle Hidden` 挡不住闪窗** —— 控制台窗口在 `conhost.exe` 启动那一刻就创建好了，`-WindowStyle` 是之后才生效的 |
| 还有谁帮忙闪 | `keepalive.ps1` 里用 `& schtasks /end|/run` 起子进程，`schtasks.exe` 每次又新开一个控制台 |

所以频率和"每 5 分钟"对得上。

### 修法（两处）

1. **任务动作换成 `wscript.exe //B hidden-launch.vbs "<原来的命令行>"`**
   `WScript.Shell.Run(cmd, 0, False)` 用 0 号窗口样式启动 —— 窗口**从头到尾不创建**，不是"创建后隐藏"。
2. **`keepalive.ps1` 里的 `schtasks.exe` 换成 `Start-ScheduledTask` / `Stop-ScheduledTask`**
   cmdlet 不新开控制台。

### 新增

- `scripts/hidden-launch.vbs` —— 静默启动器（纯 VBS，无依赖）
- `scripts/fix-hidden-tasks.ps1` —— 把计划任务改造成静默版；**默认演练**，`-Apply` 才改，改前把 XML 备份到 `state/task-backup-*.xml`

### 需要管理员

改计划任务要提升权限；当前会话是 UAC 中完整性（`IsInRole(Administrator)=False`），
`schtasks /create` 返回 **Access is denied**。所以这步得你手动跑一次（见下）。

### 已验证

- VBS 静默启动实测：`wscript //B hidden-launch.vbs "cmd /c timeout /t 3"` 期间**没有新控制台窗口**
- 演练输出正确识别了两个任务并给出改造后的命令行

> 另外确认：全机只有 `qq-bridge` 与 `qq-bridge-watchdog` 两个任务在跑 powershell/cmd，
> 其余是系统自带（`dsregcmd` 等，不常触发）。
## 2026-11-01 — 0.4.99：会话备份可恢复（含老的、久远的备份）

用户："11-01 05:58 994920175会话记录恢复一下，还有加上支持恢复较久的会话记录"

### 原来为什么"备份了也恢复不了"

快照只存了 `messages`，但 socialV2 的历史其实在 **`recentMessages`** 里——
所以备份出来是"0 条消息"，恢复等于没恢复。这次补上，并且兼容老备份：

| 备份里有什么 | 恢复时怎么用 |
| --- | --- |
| `recentMessages`（新备份） | 直接用 |
| `messages` | 退回用它 |
| 只有 `unread`（老备份） | **从 unread 兜底捞历史** |

### 恢复 = 合并去重，不覆盖

`mergeMessages()` 按 `messageId → seq → text` 三级去重，live 优先，补进去的按 seq 排序，最多保留 200 条。
**多老的备份都能恢复**（只看文件是否存在，不看过期时间）。

### 默认不把历史塞回"未读"

第一次实测把 12 条历史同时写进了 unread → 未读从 11 变 23，等于让机器人去回一堆旧消息。
改成默认 `includeUnread:false`，需要时才显式传 `includeUnread:true`；另加 `action:'trimUnread'`
把误加的旧消息从未读里摘掉（按 `messageId|seq` 精确匹配）。

### 实测（真机 994920175）

```
备份列表：group_994920175-20261101-064639.json  可恢复=12  未读=12
POST restore → {"ok":true,"addedRecent":12,"totalRecent":34,"note":"已恢复 12 条历史 / 12 条未读（去重后合并）"}
POST trimUnread → {"ok":true,"removed":12,"totalUnread":11}
最终：recentMessages 34 条，unread 11 条（原来的未读，一条没多）
末尾几条：454 居居 算了，我重写一下改为会话是群号 / 455 [图片]@迷城骇兔 / 456 记得保持互动…
```

### 控制台

会话备份列表每行多了 **「恢复」** 按钮（二次确认），列里显示的是**可恢复条数**（不再显示误导的 `messages` 数）。
## 2026-11-01 — 0.4.98：新页面「角色分配」——每个群用谁 + 潜水/活跃

用户："检查时是否有群聊人设卡隔离问题，如果可以出一个新的分支，看每个群接入的是哪个角色，以及角色状态 潜水 活跃"

### 先回答"隔离是否有问题"：规则层面是隔离的

| 场景 | 生效角色 | 说明 |
| --- | --- | --- |
| 群 A 单独设了角色 | `per-key` | 只影响 A |
| 群 B 没设 | 群默认 / 无 | **不会**继承 A 的角色 |
| 群聊默认关（`role.groupEnabled=false`） | 无 | 群聊不注入人设（默认行为） |
| 私聊没单独设 | 全局角色 | 跟随全局 |

以上 4 条 + "单独设置优先于群默认"都有测试（`test-role-map.mjs` 9 条）。
**也就是说：不存在"群 A 的人设串到群 B"这种串台。** 之前看不清，是因为控制台没有一页能看。

### 新页面：角色分配（导航 → 对话 → 角色分配）

每行：`会话 · 状态 · 来源 · 角色下拉 · 设置`，实测：

```
共 13 个会话 · 群默认 关 · 全局角色 emma
群 630679184        角色=xiaojingyu   来源=单独设置   潜水（条件唤醒）
群 631539503        角色=xiaojingyu   来源=单独设置   潜水（条件唤醒）
群 659013538        角色=(无)          来源=未设角色   潜水（条件唤醒）
私聊 2264537283     角色=emma         来源=跟随全局   潜水（条件唤醒）
```

来源分四种并写明：`单独设置 / 群默认 / 跟随全局 / 未设角色`。
每行可当场改：选角色 → 设置；选「（清除单独设置）」→ 恢复跟随默认。

### 端点 `GET / POST /api/roles/map`

- GET：`{groupEnabled, groupDefaultName, globalRole, paused, rows[], issues[]}`
- POST `{key, role}`：给该会话单独设角色；`role=null` 清除
- `issues` 会提示"某群单独设了角色但群默认关着"（不是错误，只是让人知道现状）

### 两个坑

1. **内存里的 `socialV2.conversations` 有时是空的**（还没 hydrate）时，页面会显示"0 个会话"。
   改成直接读 `state/social-v2.json` + `state/roles-by-key.json` —— 用户要看的就是磁盘上的事实。
2. `deps.getSocialV2` 在 extra-routes 的 deps 里并不存在，直接调用会 500（`getSocialV2 is not defined`）。
   最后统一走 `d.readFile` + 两个文件路径，不再依赖内存状态。

### CDP 实测

```
导航有「角色分配」: true
meta: 共 13 个会话 · 群默认 关 · 全局角色 emma
行数: 13
第一行: 群 official-… 潜水（条件唤醒） 未设角色 （跟随默认） 傲娇助手
JS 异常: 0
```
## 2026-11-01 — 0.4.97：人物卡可以配一张「外观照片」

用户："人物卡升级，允许引用一张照片来定义自己，照片由用户提供，具体和小鲸鱼那个实施差不多"

小鲸鱼那套的关键取舍是：**图片不进每轮提示词，只把一句话描述注入**。这里照抄：

| 做法 | 原因 |
| --- | --- |
| 原图存 `state/role-images/<roleId>.<ext>` | 图片是资产，不该塞进提示词 |
| 视觉模型生成一句描述，存 `<roleId>.desc.txt` | "你长什么样"一天问不了几次，缓存够用 |
| 提示词只加一行「你的外貌（来自用户提供的照片）：…」 | 一张图 ≈ 上千 token，每轮发会烧钱 |

### 端点 `GET / POST / DELETE /api/roles/image`

| 动作 | 行为 |
| --- | --- |
| GET `?role=x` | `{has, ext, desc}`；`&raw=1` 直接返回图片字节（控制台预览） |
| POST `{role, dataBase64}` | 保存（文件头嗅探 png/jpg/webp/gif，≤4MB；换图自动删旧图并作废旧描述） |
| POST `{role, action:'describe'}` | 让视觉模型写一句外貌描述并缓存 |
| POST `{role, action:'delete'}` 或 `DELETE` | 删图 + 删描述 |

### 控制台：人格与角色页多了「外观照片」折叠块

上传 → 预览（96×96）→ 「识别外貌」→ 显示"外貌描述：…"。切换角色卡时预览自动跟着换。

### 实测

```
GET  （无图）→ {"ok":true,"has":false,"desc":""}
POST 上传 1×1 PNG → {"ok":true,"ext":"png","bytes":66}
GET  → {"ok":true,"has":true,"ext":"png"}
POST describe → 502 {"error":"描述失败：HTTP 400"}（1×1 纯色图视觉接口拒收，符合预期）
POST action:delete → {"ok":true,"removed":true}
```

CDP 验证 UI：区块存在、空状态文案正确、没选文件点上传提示"先选一张图片文件"、JS 异常 0。

### 一个坑：DELETE 被全局 415 挡了

控制台的 `api()` 发 DELETE 时不带 `Content-Type`，而桥接要求非 GET 请求必须是 `application/json` →
**415 Unsupported Media Type**。所以补了 `POST {action:'delete'}` 这条等价路径，UI 改走它。

> 测试 9 条（`test-role-image.mjs`）：安全文件名 / 文件头嗅探 / 4MB 上限 / 换图只留一张 /
> 换图作废旧描述 / 删除清干净 / 提示词行空描述返回空串。
## 2026-11-01 — 0.4.96：页面钩子收口（把"迟早漏"堵上）

连着三次同样的坑：

| 版本 | 漏了什么 | 症状 |
| --- | --- | --- |
| 0.4.91 | `bindResetSession()` 没人调 | 会话下拉是空的 |
| 0.4.93 | `bindSessionBackups()` 没人调 | 备份列表一直「加载中…」 |
| 0.4.95 | `bindRolePick()` 挂错分支 | 人格下拉不出现、选「自定义」没反应 |

共同点：**函数写好了、语法过、单测绿，页面上就是不出现**。
根因是接线散落各处（`setConsolePage` 里 16 个 `if (page === '…')`，另有一些藏在 `if (r.ok)` 分支里）。

### 做法：一张表 + 一个执行器

```js
const PAGE_HOOKS = {
  overview: ['loadOverview'],
  sessions: ['loadHeatmap'],
  ...
  persona: ['bindResetSession', 'bindSessionBackups', 'bindRolePick']
};
runPageHooks(page);   // setConsolePage 里只剩这一行
```

- **每条钩子独立 try**：一个炸了不影响其它（以前一个异常能让整个控制台卡在"加载中"）
- 缺函数时只 `console.warn`，不抛
- 散落的 16 个 `if (page === …)` 全部删除（现在 0 处）

### 新增守卫 `check-page-hooks.mjs`

四道检查，防止倒退：

1. `PAGE_HOOKS` 与 `runPageHooks` 必须存在，且 `setConsolePage` 必须调用它
2. **不允许再出现散落的 `if (page === '…')`**（出现即红，并告诉你去表里加）
3. 表里的每个函数名必须在同文件里有定义（防止拼错 → 运行时静默 warn）
4. 表里的每个页面 key 必须在 `consolePages` 里（防止拼错 → 钩子永不执行）

### CDP 实测（切四个页面）

```
persona → {"roleOptions":6,"resetOptions":12,"backups":"共 2 份 · 目录 …"}
space   → {"visible":"space","text":"QQ 空间 四个子页…"}
report  → {"visible":"report","text":"运行报告 一键把「它现在好不好」…"}
overview→ {"visible":"overview…","text":"本程序仪表盘 数据来自 /api/ov…"}
JS 异常: 0      钩子 warn: 0
```
## 2026-11-01 — 0.4.95：人格切换改成「选已有角色卡」下拉

用户截图：切换人格那里是个**文本框**，占位符写着"选择已有角色或输入新角色名"——
可它并不能"选择"，只能手打名字，打错就是新建一张空卡。

### 改成下拉 + 自定义

```
[（未设置 · 只按仿真提示词）  ▾]
 傲娇助手（无测试）
 派蒙（无测试）
 小鲸鱼（已测试）
 樱羽艾玛（无测试）
 自定义（输入新名字）…      → 选中后右侧出现输入框
```

- 选项来自 `/api/roles`（角色卡就是 `roles/*.md`）
- **当前生效的角色**从 `/api/status` 的 `role` 字段预选（`/api/role` 没有 GET）
- 当前没设角色 → 顶部有「（未设置）」并选中，不会骗你以为已经在扮演谁
- 选「自定义…」才显示输入框（新名字=新建一张卡，内容留空，再去上面编辑）

### CDP 实测

```
下拉存在: true
选项: （未设置 · 只按仿真提示词） | 傲娇助手（无测试） | 派蒙（无测试） | 小鲸鱼（已测试） | 樱羽艾玛（无测试） | 自定义（输入新名字）…
当前选中: (空)
输入框初始隐藏: true
选自定义后输入框显示: true
JS 异常: 0
```

### 又抓到一次"接线漏了"

`bindRolePick()` 第一次只挂在一个 `if (r.ok) { … }` 分支里（保存模式成功后才执行），
**页面加载时根本没跑**，所以下拉一直是空的、选「自定义」也没反应。
现在挂进 `setConsolePage` 的 `persona` 分支 —— 这已经是本轮第三次同类问题了
（`bindResetSession`、`bindSessionBackups`、`bindRolePick`）。

> 结论：控制台的"注册式接线"必须集中在一个明确的地方（页面的加载钩子里），
> 散落各处迟早漏。三次都是同一个坑，该往这个方向重构了。
## 2026-11-01 — 0.4.94：会话下拉显示群号/私聊号（修掉"下拉里全是 0 1 2 3"）

用户截图：下拉里全是 `0 1 2 3 … 11 12`，根本不知道哪个是哪个群。

### 根因：把数组当对象取键

```js
Object.keys(r.conversations)   // conversations 是**数组** → 得到 "0","1","2"…
```

所以选项文字和 value 都是**下标**——选中 `11` 后请求会带 `key: "11"`，后端校验直接 400。
（这也解释了为什么上一版下拉"看起来有内容但重置没反应"。）

### 改法

1. 取 `conversations[].key`（数组元素里的真实 key）
2. 显示成人能读的：`group:630679184` → **群 630679184**；`private:1599…` → **私聊 1599…**
3. 同一个号出现多次时加 `（1）（2）` 区分（正常情况下不会出现）
4. 排序：**群聊在前、私聊在后**，同类按号码**数值**升序（不是字典序）

### CDP 实测

```
选项数: 13
标签（前 6）: 群 630679184 | 群 631539503 | 私聊 2264537283 | 私聊 2747277822 | 私聊 3636162819 | 私聊 2848096960
值（前 6）:  group:630679184 | group:631539503 | private:2264537283 | …
有没有纯数字标签: false
JS 异常: 0
```

> 教训：`Object.keys()` 对数组返回下标、对对象返回键。
> 接口返回结构从对象改成数组时，这类代码**不会报错**，只会静默显示错东西。
## 2026-11-01 — 0.4.93：会话备份列表（防止备份写了找不到）

用户："可以识别之前的对话备份到一个模块，防止找不到"。

0.4.91 的重置会写 `state/session-backups/`，但**写完就没人看得见**——只能去文件夹里翻。

### 新端点 `GET/DELETE /api/session-backups`

| 请求 | 返回 |
| --- | --- |
| `GET` | `{ ok, dir, count, items:[{file,key,at,size,messages,longTerm,broken}] }`（按时间倒序，最多 200 份） |
| `GET ?file=x.json` | `{ ok, item, snapshot:{ key, at, role, model, messages(最后 50 条), truncated, longTerm(前 20) } }` |
| `DELETE ?file=x.json` | `{ ok, removed }` |

安全：`isSafeBackupName()` 只允许 `[A-Za-z0-9._-]+.json` 且不含 `..` ——
`?file=../config.json` 实测返回 **400**（有测试）。

### 控制台：人格与角色页下面多一块「会话备份」

```
会话备份
共 2 份 · 目录 D:\...\state\session-backups
11-01 06:21  group:630679184   4 条  0.6 KB  [查看] [删除]
11-01 05:58  private:1599…     0 条  0.4 KB  [查看] [删除]
```

点「查看」直接在下面展开前 50 条消息（`[user] …` / `[assistant] …`），删除有确认。

### CDP 实测（真的渲染出来了，不是"应该能"）

```
会话下拉选项: 13
备份 meta: 共 2 份 · 目录 <state>/session-backups
备份行数: 2
第一行: 11-01 06:21 group:630679184 4 条 0.6 KB 查看 删除
查看后: group:630679184 · 11-01 06:21 · 4 条 / [user] 今天好累啊
JS 异常: 0
```

### 顺带修的两个"接线漏了"

- `bindResetSession()` 定义了但**从来没人调用** → 下拉是空的；现在在 `setConsolePage` 的
  `persona` 分支里调用
- 同样地 `bindSessionBackups()` 也是"写了没接"

> 这类问题的共同点：函数写好了、语法也过、单测也绿，但**页面上就是不出现**。
> 控制台这种"注册式接线"必须用 CDP 真点一遍才算数。
## 2026-11-01 — 0.4.92：重置会话改成幂等（没有活动上下文也算成功）

0.4.91 上线后真机复测发现：**连按两次会报 502**。

原因：`resetConversation()` 在"没有活动会话"时返回 `{ok:false, reason:'no-session'}`，
而第二次点重置时，第一次已经把会话清掉了 —— 用户看到红色报错，以为失败了。

### 改法

`reason === 'no-session'` 视为**幂等成功**：

```json
{ "ok": true, "note": "该会话当前没有活动上下文（可能已重置过），无需再重置" }
```

实测连按两次：

```
第 1 次: 200 {ok:true, note:该会话当前没有活动上下文（可能已重置过），无需再重置}
第 2 次: 200 {上游同}
```

> 这条是"真机复测抓到的"——单测里我假设了 resetConversation 的失败就是真失败，
> 没想到"重复操作"是最常见的用户行为。
## 2026-11-01 — 0.4.91：一键重置会话（可选先备份）

用户在控制台看到那句提示——"预设由 DSH 在会话创建时装配，正在进行的 QQ 会话需重置该会话或重启 DSH"——
但重置只能去 QQ 里发 `/reset`。要求："写个按钮一键重置会话，可以选择备份会话或者不备份"。

### 端点 `POST /api/sessions/reset`

```json
{ "key": "group:123", "backup": true }
→ { "ok": true, "key": "...", "backupPath": "state/session-backups/...", "note": "已备份并重置，下条消息会开新上下文" }
```

- `backup` 默认 **true**（丢了找不回来）；显式 `false` 才不备份
- 备份写到 `state/session-backups/<key>-<YYYYMMDD-HHmmss>.json`（会话 key 里的 `:` 变 `_`，防路径穿越）
- **备份失败就不重置**：宁可报错，也不能在没备份的情况下把上下文删掉
- 重置本身失败 → 502，但仍把 `backupPath` 回给用户

### 控制台 UI（人格与角色页）

预设保存按钮下方加一行：**会话下拉 + ☑ 先备份 + 「重置该会话」**，
结果就在旁边一行小字里显示（成功显示备份文件名，失败显示原因）。

### 实测（真机）

```
POST {"key":"private:1599683156","backup":true}
→ 200 {"ok":true,"backupPath":"...session-backups\private_1599683156-20261101-055802.json",
       "note":"已备份并重置，下条消息会开新上下文"}
备份文件 0.4 KB（会话本来就没消息，所以是小文件）
参数校验：{"key":"bad key"} → 400
```

### 测试

`test-session-reset-route.mjs` 8 条：文件名安全化 / 时间戳格式 / 默认备份 / 不备份 /
**备份失败中止重置** / 非法 key / 重置失败仍给备份路径 / GET 405。
## 2026-11-01 — 0.4.90：桌面「控制台」快捷方式带上令牌（令牌不写仓库）

用户打开控制台看到「请输入控制台访问令牌」，问"令牌是啥"。解释完他说"带，不要写仓库"。

### 做法：运行期从 state 读，不硬编码

`scripts/make-shortcut.ps1` 现在会：

1. 读 `state/console-token`（这个文件是 gitignore 的，从不进仓库）
2. 拼成 `http://127.0.0.1:3100/?token=<令牌>`
3. 写进桌面与开始菜单的「QQ 桥接控制台」快捷方式
4. **输出里打码**：`?token=****（已带上，取自 state/console-token）`，不把令牌打到屏幕上

仓库里没有令牌：`check-privacy.mjs` 通过（710 个被跟踪文件），脚本里也搜不到真令牌。

### 实测

```
.lnk 字节里含 token=：True，长度 40，与 state/console-token 完全一致
URL：http://127.0.0.1:3100/?token=VpUqm1x…
```

### 令牌是什么（顺手写清楚）

控制台能改配置、发消息、删说说，所以不能只靠"端口在 127.0.0.1"保护——
本机任何程序都能访问那个端口。令牌就是那道门：

| 不带令牌 | 带令牌 |
| --- | --- |
| `401 未经授权` | `200` |

位置：`state/console-token`，40 字符，首启生成、之后不变、不进 git、日志里脱敏。
换令牌：停服务 → 删该文件 → 启动，会自动生成新的（旧链接随即失效）。
## 2026-11-01 — 0.4.89：能力全景补 3 行（网关自动选择 / 系统资源 / 构建指纹）

第四轮核对基于 0.4.87（比上一轮的 0.4.84 新了三个版本），这次提的三条**全部成立**：

| 模块 | 代码 | 为什么算漏 |
| --- | --- | --- |
| **网关自动选择 / 降级** | `src/gateway-select.js` | 用户能感知——"为什么我的桥接自动换了网关"，但表里没这个机制 |
| **系统资源可观测** | `src/system-metrics.js` | 0.4.48 加的；报告里有内存磁盘，但没单独列这个模块的来由 |
| **运行时构建指纹** | `src/build-id.js` + `build-info.js` | 0.4.36 加的；报告抬头会显示，但表里没解释"为什么不用 commit" |

### 补进去的内容（表 17 → 20 行）

- 网关自动选择：**默认 SnowLuma，连续 3 次失败降级 NapCat，连续 5 次成功才回切，
  60 秒冷却**；探测只打 `get_login_info`（一次同时证明端口/令牌/登录）
- 系统资源：`eventLoopLagMs` / `cpuPercent` / `freeMemMb`，回答"是我们卡了还是服务器被别人吃满"
- 构建指纹：`buildId` = 运行时清单内容哈希；**不用 commit 的原因**（rsync 同步不 commit，
  commit 不变等于失效）

### 这轮顺带验证了新工具

`node scripts/bump-version.mjs 0.4.89` 一条命令改了三处（package.json / compat.json / README 标记），
`check-readme-version.mjs` 立刻通过——比手改靠谱。

> 四轮核对下来的规律：**前两轮靠"感觉漏"，后两轮才对着代码扫**。
> 这也说明那张表的价值：它让"漏没漏"变成可逐行核对的事，而不是凭印象。
## 2026-11-01 — 0.4.88：版本号收敛成一条命令 + 文档版本标记

用户问"能不能在 README 顶部写个版本，让外部核对一眼看出读的是不是最新"。加了，但**不是手写**——
手写必然再漂一次（0.4.26 vs 0.4.84 就是这么来的）。

### 1）README 顶部加「文档版本」标记

```markdown
> 📌 **文档版本：0.4.88**（与 `package.json` 一同发布；改版本用 `node scripts/bump-version.mjs <版本>`，
> 有守卫 `check-readme-version.mjs` 校验它和代码是否一致。）
```

### 2）`scripts/bump-version.mjs`：一次改全

```
node scripts/bump-version.mjs 0.4.88     # 改 package.json / compat.json / README 标记
node scripts/bump-version.mjs --check    # 只校验四处是否一致
```

以后发版的固定动作变成：`bump-version` → 写 CHANGELOG → `test-audit` → commit/tag/push。

### 3）守卫升级：标记缺失或不一致都红

`check-readme-version.mjs` 现在做两件事：
- README 里「当前 vX.Y.Z」这类**断言**必须与 `package.json` 一致（原有）
- **必须有「文档版本：x.y.z」标记**，且与 `package.json` 一致（新增；缺失也算错）

自测：把标记改成 0.4.87 → 退出码 1 并指出行号；`bump-version 0.4.88` → 恢复通过。

> 从此"文档版本落后于代码"这件事，机器会拦住，不用再靠人肉对比。
## 2026-11-01 — 0.4.87：能力全景补全（空间 / Web 搜索 / 控制台 19 个页面）

第三轮外部核对指出「能力全景」表还漏东西。逐条核实结果：

### 真漏的两行（已补）

| 模块 | 代码 | 为什么漏了 |
| --- | --- | --- |
| **QQ 空间动态** | `src/qzone-draft.js` / `qzone-styles.js` / `qzone-uploads.js` / `qzone-post-ops.js` + 3 个端点 | 0.4.77–0.4.82 才做的，写表时只想着后端模块，忘了它整块是产品功能 |
| **Web 搜索** | `src/web-search.js` / `src/mcp-web-search-safe.js` | 一直在用，但从没在 README 里单独列过 |

### 控制台行：把 19 个页面全列出来

原来只写"按能力域分五组"，现在把 `overview / sessions / people / slang / space / social-v2 /
social-v1 / persona / song / memory-graph / diagnostics / scheduler / usage / reference /
access / operations / supervisor / official / report` **逐个列出**——这样别人能直接数，不用猜。

### 核对后**不成立**的几条

外部清单把「定时任务 / 红包 / 频道模式 / 记忆交接 / 社交规则 v2 / 睡眠定时器 / 插件 sidecar」
也列为"漏写"，但这些**在 0.4.86 的表里就已经有了**（第 1、9、11、12、13、14 行）。
对方读的很可能还是旧版本，或者是把「功能清单」和「能力全景」两张表混了。

> 这轮暴露的真问题不是"漏了几个模块"，而是**文档核对必须对着同一版**。
> 0.4.85 起有 `check-readme-version.mjs` 守版本号，但没人守"克隆是否最新"——
> 以后对外核对前，先让他 `git pull` 并报 `package.json` 版本。
## 2026-11-01 — 0.4.86：README 加「能力全景（按模块）」

第二轮外部核对提了 14 个「代码里有、README 没写」的功能（定时任务引擎、token 账本、唤醒漏斗、
决策追踪、Prompt 模拟器、控制台直推 AI、黑话学习、角色卡系统、红包、睡眠定时器、频道模式、
记忆交接、社交规则 v1/v2、插件 sidecar）。

**其中大部分是 0.3.x–0.4.4x 就有的能力**，在各自的 CHANGELOG 条目和 docs/ 里有记录，
但 README 首页**从来没用一张表把它们列全**——这确实是缺口：新来的人只能靠翻 128KB 的 CHANGELOG 猜。

### 做法：加一节「能力全景（按模块）」

不是塞进「最近更新」（那是按时间线的，塞进去会变乱），而是单开一张 15 行的表：

| 列 | 内容 |
| --- | --- |
| 模块 | 定时任务 / 调度、token 账本 + 计价、唤醒漏斗、决策追踪、Prompt 模拟器、控制台直推 AI、黑话学习、角色卡系统、红包、睡眠定时器、频道模式、记忆交接、社交规则 v1/v2、插件 sidecar、总量可观测 |
| 代码 | 真实路径（`src/scheduler/`、`src/token-ledger.js`…） |
| 干什么 | 一句话 |
| 文档 | 指到具体文件或控制台页面 |

末尾给一条排查路径：找不到能力时先 `find-symbol.mjs <关键词>`，再看表。

### 同时确认：那两条「版本硬伤」已在 0.4.85 修掉

- README「版本怎么看」不再写死 `v0.4.26`
- fork 说明不再写死 `v0.4.72`
- 新增 `check-readme-version.mjs` 守卫：断言与 `package.json` 不一致就红（已自测正反两面）

> 外部核对基于 0.4.84 的克隆，所以没看到 0.4.85 —— 这也说明**发版要连 README 一起发**。
## 2026-11-01 — 0.4.85：README 补到 0.4.84（差 58 个版本）+ 加版本一致性守卫

有人把仓库 clone 下来对比，发现一处**很难自己发现**的问题：

| 位置 | 原来写的 |
| --- | --- |
| README「版本怎么看」 | **v0.4.26** |
| README fork 说明 | v0.4.72 |
| `package.json` | 0.4.84 |

三处三个数，差 58 个版本。**没人跑机器检查，所以一直没人发现。**

### 1）版本口径改成"不写死"

「版本怎么看」不再声称某个具体版本，而是讲清三处口径：
`package.json` = 代码版本、`git tag` = 发布点、CHANGELOG = 改了什么，
并给出**查自己在跑哪版**的两条命令（含控制台「运行报告」抬头）。

### 2）「最近更新」补 0.4.27 → 0.4.84 整段

新增小节「从"能跑"到"能自己起来、能自己说清状态"」，主线是可靠性：
排错程序 / 安全自更新 / 运行报告 / 断电检测 / 控制台成体系 / 空间整轮 / 导航重组 / 升级快照。

表格顶部补 6 行（2026-11-01），工程加固类（外部安全审查三批次、watchdog v3、双轨 epoch、
运行时指纹、DSH 契约测试）也点了名。

### 3）功能清单补四行

「控制台」重写为五组导航 + 深链接；新增「异常监测」（热力图/静默时段建议/断电检测）、
「排查」（运行报告）、「运维」里补排错程序与自更新。

### 4）新增守卫 `check-readme-version.mjs`

抓 README 里「当前 vX.Y.Z」这类**断言**，与 `package.json` 不一致就红；
`git log v0.4.26..v0.4.84` 这种示例命令跳过（不是断言）。
自测：插入一行 `当前 v0.4.26` → 退出码 1 并指出行号；删掉 → 通过。

> 这类"文档随代码漂移"的问题，靠人肉对比迟早再犯；能机器查的就别靠自觉。
## 2026-11-01 — 0.4.84：断电 / 异常关机检测（运行报告不再被"重启 0 次"骗）

用户提到："如果遇到断电等特殊情况……运维 → 运行报告这个是能不能应对一下"。

问题很实在：**断电时 runner 和看门狗被一起干掉**，谁都没机会记录 `child_exit`。
于是报告会显示「连续运行 0 分钟 + 24h 重启 0 次」——看起来像刚启动、从没出过事，
真相是"昨晚被拔了电"。

### 三个小文件（纯增量，不依赖外部命令）

| 文件 | 作用 |
| --- | --- |
| `state/heartbeat.json` | 每 30 秒写一次 `{at, pid}` |
| `state/runtime-marker.json` | 启动写 `{clean:false}`，正常退出改 `{clean:true}` |
| `state/incidents.jsonl` | 启动时若判定"上次没正常退出"就追加一条（保留 50 条） |

### 判定规则（宁可少报）

- 标记 clean=true → 正常退出，不算异常
- clean=false 但心跳断档 < 90 秒 → 快速重启（脚本重启），不算异常
- clean=false 且断档 ≥ 90 秒 → **非正常关闭**（断电/蓝屏/强杀）
- 只有心跳没有标记（老版本升级上来）→ 同样按断档判断
- 什么都没有（首次运行）→ 不算异常

### 报告里变成三段

1. 一条检查项：`本次启动前是非正常关闭`（WARN）或 `近 7 天非正常关闭 N 次`（≥3 次 FAIL）
2. 新小节「三·五、异常关机」：上次心跳时间、断档多少分钟、最近几次时间点
3. 每条的说明都写清"为什么 24h 重启是 0"——runner 与看门狗一起被杀，不代表没出事

### 实测（真机模拟断电）

```
伪造：心跳与标记都是 3 小时前、clean=false
重启后日志：⚠️ 检测到上次是非正常关闭（最后一次心跳 2026/11/1 02:00:33，断档 180 分钟）
incidents.jsonl：{"reason":"unexpected","gapMs":10811450,"pid":999999}
报告：本次启动前是非正常关闭 —— 上次心跳 … 之后断了约 180 分钟
```

测试后已清掉伪造事件，正常重启后报告恢复「近期没有异常关机」。

### 测试

`test-boot-watch.mjs` 11 条（首次运行 / 正常退出 / 断电 / 快速重启 / 只有心跳 / 阈值可调 /
读写 / 事件文件 / 损坏文件 / 文案），`test-report-build.mjs` 补 3 条断电场景。
## 2026-11-01 — 0.4.83：排错程序（GUI 小应用）+ 桌面快捷方式

用户说「做成一个小应用那样的，有很多按钮，每个按键代表一个指令，然后生成结果」，
后来又说「名字叫做排错程序，感觉挺实用的」。这版把入口做成一个真正的 Windows 应用。

### `排错程序.exe`（16.5 KB，无依赖）

12 个按钮，点哪个跑哪个，输出实时滚在窗口下半部分：

| 按钮 | 干什么 |
| --- | --- |
| ① 体检 | `launcher.mjs --check`：Node / 配置 / 网关 / 桥接 |
| ② 一键拉起 | `start-all.ps1`（网关 + 桥接） |
| ③ 打开控制台 | 浏览器开工作台 |
| ④ 网关扫码页 | 浏览器开 5099 |
| ⑤ 看日志 | `state/bridge.log` 末 20 行 |
| ⑥ 跑 18 项自检 | `verify-qq-bridge.ps1` |
| ⑦ 检查更新 | `update.mjs --check` |
| ⑧ 停止 | `schtasks /end` |
| ⑨ 建快捷方式 | 桌面 + 开始菜单 |
| ⑩ 打开仓库目录 | 资源管理器 |
| ⑪ 运行报告 | 控制台 `#report` |
| ⑫ 清空输出 | — |

底部状态栏显示「上次执行了哪个命令、退出码、耗时」。

### 怎么编译（不装任何东西）

```powershell
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:排错程序.exe `
  /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll scripts\launcher-src\LauncherGui.cs
```

业务逻辑仍在 JS 里（`scripts/launcher.mjs`），**改功能不用重新编译 exe**。

### 桌面快捷方式

`scripts/make-shortcut.ps1`：桌面 + 开始菜单各两个图标——「QQ 桥接控制台」（直接开工作台）
与「QQ 桥接排错程序」。首次运行排错程序会问一次要不要放桌面（问过就写标记，不再烦）。

### 踩到的两个坑（记下来）

1. **WinForms 的 Dock 是按反向 z-order 布局的**：先加的 `Fill` 会吃掉整屏，标题被挤到按钮下面。
   试了两次 `SetChildIndex` 才通，最后**放弃 Dock**，改成绝对定位 + `Anchor`，稳定。
2. **从工具里启动 GUI 会被连带杀掉**：`Start-Process` 起的进程跟着命令一起回收，
   换 `Win32_Process.Create`（WMI）脱离会话才活下来。

### 顺带修的可用性问题

- `启动器.cmd` 原来只认 PATH 里的 node（这台机器没有）→ 现在四级查找：`QQB_NODE` → PATH →
  Program Files/LocalAppData → **DSH 自带运行时**
- `.cmd` 原来是 UTF-8 + LF，cmd.exe 会逐行解析错 → 改成 **ASCII + CRLF**，中文提示全放进 JS
## 2026-11-01 — 0.4.77 ~ 0.4.82：空间模块整轮升级（AI 起草 / 配图 / 挑图 / 删除）

用户的原话是「空间只有文字很单调」「图片上传给 AI 挑」「给人点赞评论放到空间里做子分支」。
这一轮把 QQ 空间从一个"能发文字"的页面，做成了完整的一条链。

### 0.4.77 — AI 写空间（草稿，不自动发布）

- `POST /api/qzone/draft { styles, hint }`：把「空间草稿请求」投给 owner 私聊，让 agent 写
- 桥接在 `sendToQQ` 里挂钩子：owner 私聊发出的那句话顺手存成草稿（**仍照常发送**）
- `state/qzone-draft.json`：`pending / ready / expired`，10 分钟没回自动作废
- **铁律：绝不自动发布**，发布仍要人点

### 0.4.78 — 风格做成模块（可多选 / 可让 AI 定）

- `src/qzone-styles.js`：五种风格（日常 / 吐槽 / 文艺 / 技术 / 让它自己定），每条带
  hint、长度区间、表情政策
- 多选（最多 3 种）→ prompt 要求「每种一条」，回复用 `【日常】` 标签分隔 → 拆成候选卡片
- 空选 / 未知 id → 回落 `auto`；`parseStyleReply` 兼容带标签 / 带编号 / 整段三种情况

### 0.4.79 — 配图上传（存 state/qzone-uploads/）

- `POST /api/qzone/uploads { action:'upload' }`：base64 上传，**内容寻址**（同图只存一份）
- 安全：**文件头嗅探**（文本冒充 png 会被拒）、单张 6MB、最多 9 张、本地最多留 60 张
- `describe`：用 GLM-4V 生成一句话描述；`resolve`：id → 绝对路径
- 实测：网关 `send_qzone_msg` **接受本地绝对路径**（真发一条带图说说成功）

### 0.4.80 — 删除 + 挑图

- `POST /api/qzone/delete { tid }`：依次试 4 个候选 action 名
  （`delete_qzone_msg` / `del_qzone_msg` / `delete_qzone` / `qzone_delete`）
- **实测真删成功**：`{"ok":true,"deleted":1,"action":"delete_qzone_msg"}`
- `src/qzone-post-ops.js`：挑图打分（中文 2 字滑窗 / 英文按词），**最多 2 张**（产品约束）

### 0.4.81 — 空间改成四个子页

「写说说 / 我的说说 / 好友动态 / 配图库」顶部切换，`sessionStorage` 记住上次那个页；
「我的说说」每条加**删除**（二次确认）；好友动态保留点赞/评论，新增「带识图描述」开关。

### 0.4.82 — 测试与收口

- 正常环境：**审计 156/156**、真机自检 **18/18**、接口矩阵 **9/9**
- 脏环境：新增 `test-qzone-dirty.mjs`（9 条）——坏 index / 假图 / 空 base64 / 超 6MB /
  不存在 id / 空挑图 / 删除全失败 / 截断草稿 / 并发同图
- 结构收口：`qzone-endpoints.js`（四个端点收敛成一次调用）、
  `qzone-draft`/`qzone-uploads` 改用共享 `atomicWriteJson`
- 行数棘轮：`console-extra-routes.js` +55、`bridge.js` +69 —— 已 `--update` 基线，
  理由是**只加接线不加逻辑**（路由体都在各自的模块里）

### 顺手补的安全项

`.gitignore` 加 `config/`：这个目录放 `image-api.json`（视觉 API key），
之前**没有被忽略**，差点被提交。
## 2026-11-01 — 0.4.76：更新器在「别人的服务器」上会误回滚（已修）

对应用户远程服务器的场景：对方明天早上要更新，而他那台机器**不是计划任务模式**。

### 问题

`--apply` 默认 `schtasks /end` + `/run`。如果目标机器上根本没有 `qq-bridge` 这个计划任务，
它会：换完文件 → 等健康检查 60 秒 → 一直等不到新版本 → **把刚更新的文件回滚掉**。
用户看到的是"更新了，但版本号没变"——非常迷惑。

### 修法

1. 新增 `--no-restart`：只换文件，明确提示"请手动重启"，**不做健康检查、不误回滚**
2. 自动判断：`schtasks /query /tn qq-bridge` 查不到时，同样走"只换文件"路径并说明原因
3. 提示里给出三条重启方式（计划任务 / launcher / 你自己的进程管理器）

### 实测

副本上 `--apply --yes --no-restart`：
```
已备份 683 个文件 → 已覆盖 2 个（新增 1 个）
[!] 没有自动重启（原因：--no-restart）
    文件已覆盖完成。请手动重启你的服务进程…
[OK] 本次更新：文件已就位，等待你手动重启（未做健康检查，也就不会误回滚）
```
版本号停在 0.4.99（假包），新增文件保留 —— 符合预期。
## 2026-11-01 — 0.4.75：修插件安装命令（`#main&path:/plugin` 会装错）

有人在 DSH 里用 `github:juju114514/qq-bridge#main&path:/plugin` 装插件，报：「已完成」，
但提示 `main&path:/plugin` 会被整串当成 ref，**退回装仓库根的 qq-bridge 0.4.73 普通依赖**。

### 问题

`docs/guides/PLUGIN-MODE.md` 的「方式 B」还写着 0.4.4 时代的旧写法（带 `#main&`），
而新版 pnpm/DSH 不认这种 ref 组合，结果是"装上了但插件不加载"。

### 修法

1. 命令改成唯一正确的形式：

   ```
   dsh plugin --profile desktop add github:juju114514/qq-bridge#path:/plugin
   ```

2. 文档里明确写「**不要写 `#main&path:/plugin`**」并解释为什么（会被当 ref → 装根包 → 插件不加载）
3. 新增守门脚本 `scripts/check-install-commands.mjs`：
   扫 README / llms.txt / AGENT-INSTALL / docs/guides / docs/design，
   发现活的 `#main&path:/plugin` 就红；`CHANGELOG` / `docs/releases` / `docs/audits` 豁免（历史不许改）。

守卫自测：塞一条错误写法 → 退出码 1 并指出文件行号；删掉 → 恢复通过。
## 2026-11-01 — 0.4.74：运行报告（别人出问题，一键给出一段能贴的文本）

用户远程服务器上的机器人已经连续跑 3 天（唯一一次失败是云服务器 CPU 被别的程序吃满），
对方明天早上要更新一次。所以需要一个「点一下就能给出报告」的东西，更新前后各存一份做对比。

### 控制台：运维 → 运行报告

- **生成 / 复制 / 下载 .md** 三个按钮
- 内容：版本与 uptime、8 项检查（连续运行 / 24h 重启 / 网关 / DSH / 看门狗 / 内存 / 磁盘 / 消息错误）、
  三条通道状态、稳定性明细、配置摘要
- 每项检查都带 `✅ / ⚠️ / ❌` 和一句人话（例如"网关没连上 → 打开 5099 扫码"）
- 总体判定 PASS / WARN / FAIL，规则写死在 `docs/guides/RUN-REPORT.md`

### 接口：`GET /api/report`

- 默认 JSON（控制台渲染），`?format=md` 直接给 Markdown（`curl` 下来就能贴）
- 纯函数在 `src/report-build.js`，路由在 `src/api/report-route.js`（不撑爆行数棘轮）

### 脱敏（能直接贴给别人）

6 位以上数字 → `159****56`；16 位以上十六进制 → `a1b2…(32位)`；绝对路径 → `<repo>`；
`sk-…`/JWT → `<token>`。

### 测试

`test-report-build.mjs` 7 条：健康→PASS、网关断开→FAIL、重启过多分级、内存/磁盘分级、
"不足 1 天不吹稳定"、脱敏、脏数据不炸。

### 一次真实的部署事故（记在这里）

部署这次时，真机**崩溃循环 10 次**：`Cannot find module ... official-route.js`。
原因是我一直只拷单个文件，0.4.66 抽出的 `official-route.js` 从没同步到真机——
直到这次拷了新的 `console-extra-routes.js` 才暴露。

修法：改成**整目录同步** `src/` 与 `public/`（先备份 live/src 到 `_rollback/`）。
教训：单文件部署迟早漏，尤其"抽文件"这类重构。
## 2026-11-01 — 0.4.73：修外部评审指出的 4 处真问题（版本口径 / llms / AGENT-INSTALL / VERIFIED）

有人完整克隆仓库做了评估（克隆 + 读源码 + 跑离线回归 + 查 CI）并提了几条。逐条核对结果：

### 1）README 里写着上游版本号（**真问题，已修**）

`README.md` 的折叠块里写着「当前版本 `v0.2.1-r1`」，而 `package.json` 是 `0.4.x` ——
这是 fork 时把上游 README 一起带过来没清干净。已改成：

> 本 fork 当前版本 `v0.4.72`（以 `package.json` 为准）… 下面这段是 **fork 之前**（上游 `v0.2.x` 线）的适配历史，保留作背景。

### 2）`llms.txt` 太旧（**真问题，已修**）

只列了 5 个入口，且没提启动器 / 自更新 / 环境快照 / 官方通道状态。重写为：
入口、首次使用、常用命令、外部依赖、状态（个人号可用 / 官方上锁 / 插件形态）。

### 3）`AGENT-INSTALL.md` 停在 10-28（**真问题，已补**）

补了第 9 节「2026-11 之后的入口」：启动器、网关没登录怎么办、官方通道上锁与两层白名单、
自更新、环境快照、插件形态、验收三件事。

### 4）没有 `VERIFIED.md`（**真问题，已建**）

新建 `VERIFIED.md`：只写**真机验证过**的事实，每条带日期与复现命令，并单列
「明确没有验证的」（Linux 长期运行 / 多机 / DSH 0.3 / 官方四条 e2e / 高并发 / 计费对账）。

### 评审里说错或已过时的

| 评审说法 | 实际 |
| --- | --- |
| 「版本号已到 0.4.69」 | 现在是 0.4.73（评审时点的快照） |
| 「`diagnose-silent` / `diagnose-official-no-event` / `diagnose-hook-dead` 可能已加」 | **没有**这些脚本；只有一个 `scripts/diagnose-acl.mjs`（权限诊断）。诊断能力在控制台「诊断与健康」页 |
| 「`llms.txt` 可能指向 `docs/PROJECT_GUIDE.md`」 | 指向 `AGENTS.md` + `AGENT-INSTALL.md`，不是 PROJECT_GUIDE |

> 评审结论里「10k 行单文件、单作者、0 社区背书、不适合生产依赖」这几条我**认同**，没有辩解：
> `bridge.js` 仍是 10,347 行，`LOCK.md` 与 `SECURITY.md` 里也写明了「个人项目、无 SLO」。
## 2026-11-01 — 0.4.72：自更新（学别人的流程，补上它缺的三件事）

看 SnowLuma 的更新器（检查 → 下载 → 「重启后生效」→ 应用），照着做了一个，但补了三件事。

### 它做得好、我们照抄的

| 做法 | 为什么好 |
| --- | --- |
| 下载到暂存区，不动正在运行的文件 | 下载失败不影响线上 |
| 明确「重启后生效」，让用户选时机 | 不会聊着天突然重启 |
| 对话框写明「配置与数据保留」 | 用户敢点 |
| 多源回退（GitHub 失败换镜像） | 国内网络现实 |

### 它缺的、我们补上的

| 缺口 | 我们的做法 |
| --- | --- |
| 关掉进程后**没人拉起**（实测网关离线 5 分钟） | 更新器**不负责重启**，交给计划任务/runner |
| 换完没验证 | 覆盖后等 `/health/detail` 报出新版本（60 秒超时） |
| 没备份、没回滚 | 覆盖前整份备份到 `_rollback\<旧版>-<时间戳>\`；失败自动回滚**并清理本次新增文件** |

### `scripts/update.mjs`

```
--check              只对比版本（走 GitHub API + curl，支持 --proxy）
--download           下到 _update/
--apply --yes        备份 → 覆盖 → 重启 → 健康检查 → 失败回滚
--apply --dry-run    预演：只解压+统计，不写文件
```

受保护（绝不覆盖）：`config.json` / `state/` / `node_modules/` / `.git/` / `data/` / `logs/` / `audio/` / `cookies*`。

### 实测（在副本上跑真实 apply）

```
已备份 676 个文件 → 已覆盖 158 个（新增 1 个）
跳过重启 → 健康检查没过（期望 0.4.99，实际 0.4.71）→ 开始回滚
已回滚（并清掉新增的 1 个）→ package.json 回到 0.4.71，FAKE-MARKER 已删除
```

> 写的时候踩到一个 BOM 坑：PowerShell 写的 `package.json` 带 BOM，`JSON.parse` 直接失败，
> 于是「读不到包内版本」被误判成「包里没有 package.json」。已统一走剥 BOM 的读法。

启动器菜单第 8 项「检查更新」也接上了。
## 2026-11-01 — 0.4.71：把「网关」摆到明面上（控制台卡 + 启动器入口）

用户问了一个很合理的问题：**5099 是网关，那它到底算谁的？** 答案是 —— 网关是别人的软件
（SnowLuma / NapCat），我们的东西只是「说话的那层」。但用户不该记两个端口。

### 控制台：仪表盘加第 10 张卡「网关（QQ）」

- 状态取 `/health/detail` 的 `services.snowluma`（connected / starting / 其它）
- **未连接时给一个「打开网关扫码页」按钮**（指向 `http://<当前主机>:5099`，远程访问也能用）
- 副标题写清 `/health/detail · snowluma`，卡片 tooltip 注明「网关是独立软件，未登录时它不会把消息转给我们」

### 启动器：菜单第 7 项「打开网关扫码页」

体检里发现「网关界面在 5099 但 OneBot 没起来」时，除了原有的提示，还会多一行
`（菜单选 7 可以直接打开它）`；菜单第 3 项也改成「打开控制台（我们的，3100）」，避免和网关混淆。

### 不合并进程的理由（写在这里备查）

SnowLuma 是 QQ 协议层（登录、风控、OneBot 接口），我们是「说什么」那层（拟人、记忆、工具、控制台）。
早期试过把 `@snowluma/*` 当依赖塞进进程内，后来撤了（`docs/design/decisions/0002-drop-snowluma-npm-deps.md`）：
它的更新比我们快、依赖面大、出问题时分不清是谁的错。
**能合的是体验（一个入口、一个控制台），不能合的是内核。**
## 2026-11-01 — 0.4.70：最小启动器（双击就能用）

看别人的部署视频（大肥鱼：PC 启动器 + 内置教程）想到的 —— 我们最大的门槛不是能力，是
「第一次用的人不知道该跑哪个脚本」。补一个入口。

### `启动器.cmd` + `scripts/launcher.mjs`

双击或 `node scripts\launcher.mjs`，先体检再给菜单：

| 菜单项 | 做什么 |
| --- | --- |
| 1 体检 | Node / config.json / ownerQQ / 白名单 / 网关(3000·3001) / 网关界面(5099) / 桥接 health |
| 2 一键拉起 | 交给 `scripts/start-all.ps1`（它自己判断用 SnowLuma 还是 NapCat） |
| 3 打开控制台 | 按 `config.consolePort` 打开浏览器 |
| 4 看最近日志 | `state/bridge.log` 末尾 15 行 |
| 5 跑 18 项自检 | 交给 `verify-qq-bridge.ps1` |
| 6 停止 | `schtasks /end /tn qq-bridge` |
| 0 退出 | — |

**只编排，不重造**：拉起/自检都复用已有脚本，避免两套逻辑打架。

### 设计取舍

- **用 Node 而不是 PowerShell 写**：PowerShell 5.1 读无 BOM 的 .ps1 会把中文读成乱码（踩过），
  Node 读 UTF-8 没这个问题；而且仓库本来就依赖 Node。
- **每一步都给「看到了什么 / 该做什么」**：体检不通过时直接指到对应动作，
  例如「网关界面在 5099 但 OneBot 没起来 → 去扫码」。
- **`--check` 可非交互运行**：退出码 = 有问题的项数是否 > 0，便于排障/后续接 CI。

实测（本机）：
```
[OK]   Node v24.21.0
[OK]   config.json 可读
[OK]   管理员 QQ：1599683156
[OK]   白名单：群 0 个 / 私聊 1 个
[!]    网关界面在（5099），但 OneBot 没起来 —— 去 http://127.0.0.1:5099 扫码登录
[OK]   桥接在跑：v0.4.65 ready=false
[!]    ready=false —— 桥接起来了但网关/DSH 没连上
```
正好复现了「重启后网关没登录」这个真实场景。
## 2026-11-01 — 0.4.69：DSH 升级前的环境快照 + 升级后适配清单

用户侧 DSH 还是 `0.2.1-rc.2`（nightly 通道），准备升级。为「升级后怎么适配」做的准备：

### 1）`scripts/snapshot-env.mjs`

一条命令把当前环境拍成快照（`docs/validation/env-snapshot-<本地日期>.md`）：
DSH 安装路径/更新通道/exe 大小与时间、Node 版本、仓库版本与 HEAD、插件版本（仓库 + 已安装）、
插件声明的 `engines.dsh`、配置键清单（**只记键名与布尔，不落任何凭证**）、官方通道开关状态。

`--compare` 会与上一份快照做差异对比，输出 `+ / ~ / -` 三类变化。

> 踩了个小坑并修掉：`toISOString()` 是 UTC，东八区凌晨会把日期写成前一天 —— 改成本地日期。

### 2）`docs/guides/DSH-UPGRADE-ADAPTATION.md`

升级后照做的六步：插件能否加载（看 `plugin.log` 两行）→ `cordis.patch.yml` 是否合法 →
控制台是否白屏（附"看 CDP 异常"的做法）→ 技能/预设路径 → 8 个 `qqb_*` 工具逐个 ping →
审计 152 + 自检 18 + 再拍一次快照。

还写了：改代码的三条约束、四类回退、五条"升级必查项"（`engines.dsh` 写死范围、工具名冲突、
`sessionId` 形式、`window.__DSH_BOOT__` 结构、nightly 一天两推）。

### 基线

| 项 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.2`（exe 2026-10-17，nightly） |
| 仓库 | `0.4.68` |
| 插件 | `0.1.0`（本机已装仍是 `0.0.1`） |
| Node | `v24.21.0` |
## 2026-11-01 — 0.4.68：插件版本 0.0.1 → 0.1.0（要进市场了）

`plugin/package.json` 与 `plugin/dsh.plugin.json` 两处版本号同步提到 **0.1.0**。

理由：`0.0.1` 看起来像半成品，而这个插件已经可用（通道互斥、8 个 `qqb_*` 工具、
群记忆交接、sidecar 契约都跑过）。按 [CONTRIBUTING.md](CONTRIBUTING.md) 的版本约定
「新能力 +0.1.0」，这次是首次对外发布，取 0.1.0 而不是 1.0.0 —— 接口还会随 DSH 插件 API 调。

> 仍然 `private: true`：市场走 `github:juju114514/qq-bridge#path:/plugin` 安装，不依赖 npm 发布。
> 将来真要发 npm，再改成 `false` 并 `npm publish`。
## 2026-11-01 — 0.4.67：补 18 篇漏索引的文档 + 加索引守卫；官方通道仍上锁但补了「报错调整方案」

### 1）文档索引：一次查出 18 篇没进索引（同一个疏漏反复发生）

| 类别 | 漏了 |
| --- | --- |
| guides | KASPERSKY · ONEBOT-ACTIONS · PRIVACY · SECURITY · SERVER · TOPOLOGY |
| design | dsh-plugin-api-notes · OFFICIAL-CHANNEL-INTEGRATION · plugin-mode-2026-10-31 · decisions/0001 · decisions/0002 |
| docs 顶层 | OPERATIONS · UPSTREAM-SECURITY-REGISTER · REFACTOR-BRIDGE · bridge-map · routes-map · plan-2026-10-31-plugin · plan-split-console-server |

全部补进 `docs/README.md`，并新增顶层文档小节。

**根因不是「忘性」，是没有守卫** —— 所以加了 `scripts/check-docs-index.mjs`：
`guides/ design/ 顶层` 必须索引，`audits/ releases/ reports/ validation/ sessions/` 豁免（历史归档）。
现在 64 篇活文档全绿。

### 2）官方通道：**依旧上锁**，但补上「报错调整方案」

`docs/guides/OFFICIAL-TROUBLESHOOTING.md`：8 类**实测**报错 + 逐条调整
（两层白名单 / not-friend / 被动回复窗口 / 鉴权 / 重复消息 / 闸门 probe …），
开头给「最快定位顺序」（4 条命令）。

LOCK.md 加了一节指向它，但**锁的状态没变**：🔒 上锁 + 🧪 EXPERIMENTAL。
仓库**依旧不合并**上游、也不把官方通道写成"已支持"。

### 3）仓库介绍同步

README 顶部加了两行：踩到报错看哪份文档、插件形态已提交 DSH 插件市场（PR #10986）。
## 2026-11-01 — 0.4.66：官方通道「预留接入位」（等验证通过直接接入）

官方通道代码早就实现了，但接入状态一直散落在 LOCK.md 与几个条件判断里。这一版把它收敛成
**一个闸门 + 一个控制台页 + 一份契约文档**：

### `src/official/gate.js`

纯函数，五项清单：`enabled` / `appid` / `secret` / `allow` / `probe`。
返回 `allowed`（全绿）、`readyToFlip`（只差开关）、`missing[]`（缺什么 + 怎么补）、`state`（状态文案）。

`probe` 项接受两种证据：跑过 `scripts/official-probe.mjs`（写 `state/official-probe.json`），
**或者当前已连接** —— 已连上比探针更强，不认它会让在跑的实例显示"未就绪"。

### `GET /api/official` + 控制台「运维 → 官方通道」

顶部状态、五项清单、缺什么、`readyToFlip` 时提示"只差一个开关"。
**不提供一键启用**：开关留给人手动改（符合 LOCK.md 的风险口径）。

### `docs/design/OFFICIAL-CHANNEL-INTEGRATION.md`

接入契约：字段、闸门、页面、接入步骤（探针 → 看清单 → 改 enabled → 重启 → 验）、回退。

### 测试

- `test-official-gate.mjs` 7 条（含"运行时已连接算通过"）
- `test-official-route.mjs` 4 条：直接用假 deps 调路由 handler，校验字段与 probe 读取，
  **不需要启动桥接**

> 本轮工作在**独立副本**（`_official-staging`）里完成并验证，验证通过后才搬回主仓；
> 真机部署未动（仍 0.4.64），等确认再上。
## 2026-11-01 — 0.4.64：首屏「永远在加载」的根因找到并修掉（不是网络问题）

之前一直以为是「`?token=` 第一跳的 fetch 会挂住」，加了个有限重试（0.4.58.1）压着。
这次用 **CDP 直接抓页面异常**，一次就定位：

```
Uncaught TypeError: Cannot read properties of null (reading 'textContent')
    at console.html:5933:63
```

那一行是搜索索引：`section.querySelector('h2').textContent`。
我在 0.4.50 加「记忆星图」时，这个 section 用的是 `<strong>` 而不是 `<h2>`，
于是 `querySelector` 返回 null → 抛异常 → **整个 script 块的后半段被打断**：
后面所有的 `refresh()` 轮询、首屏加载**一行都没跑**。

所以现象才对得上：页面能渲染（DOM 已经在了）、但状态停在「正在连接…」、仪表盘停在「（加载中…）」，
而点一次「刷新」是**另一条路径**（用户手势触发的单独调用），所以又正常了。

### 修法（两处，缺一不可）

1. **容错**：`const heading = section.querySelector('h2')`，取不到就退回 `section.id`
   —— 一个 section 的标记错误不该打死整页脚本
2. **补标记**：记忆星图段补上真正的 `<h2>`（28 个 section 现在全都有标题了）

### 验证（CDP，不是"我觉得好了"）

```
异常数: 0
状态: {"status":"DSH 已连接","dash":"运行模式reserved2/api/status · 00:59:50…"}
```

首屏自动加载成功，不再需要点刷新。

### 回归测试

新增 `scripts/test-console-boot.mjs`（4 条）：
每个 section 必须有 h2、那行代码必须保持容错写法、兜底重试还在、`bootConsolePage()` 之后
`refresh()` 仍在（说明脚本块没被截断）。

> 同时也说明：0.4.58.1 那个"有限重试"是**在错误的层打补丁** —— 真正的问题是异常中断了初始化。
> 重试代码保留（对网络抖动仍有用），但根因已经不在那里。
## 2026-11-01 — 0.4.63：上游用户迁移路径（文档 + `adopt-fork.ps1`）

「已经装了上游、想换成本 fork」这条路径之前完全没有材料。补上：

### `scripts/adopt-fork.ps1`

```
默认只预演（DryRun），必须 -Apply 才写盘
只覆盖程序文件；config.json / state / node_modules / .git / data / logs / audio / cookies 一律不碰
先备份到 _backup_switch_<时间戳>\（含 config/state + git-head.txt）
预检：3100 是否被占、计划任务是否存在
```

实测（假目录）：预演列出 48 项将复制、受保护清单正确；`-Apply -Force` 后
`src/bridge.js` 与源一致、`config.json` 与 `state/` 哈希未变、无 `src\src` 嵌套。

> 脚本自己也踩过一个坑：`Copy-Item -Recurse` 拷到**已存在的目录**会再套一层
> （变成 `src\src\...`）。已改成"拷内容"。

### `docs/guides/SWITCH-FROM-UPSTREAM.md`

三条路径（脚本 / 手工覆盖 / 新目录并行装）、三个真坑（配置键缺失、任务动作路径仍指旧目录、
plugin/skills 要重挂）、验证四步（18 项自检 → health → 仪表盘 → 让 AI 回一句）、回退表。

明确写了：**不要 `git pull` 上游分支**（历史已分叉，本 fork 是超集，覆盖即可）。
## 2026-11-01 — 0.4.62.1：三层测试跑出来的三个真问题（全修）

按「回归 → 环境 → 脏环境」三层跑了一遍，每层都抓到东西。

### 层 1：回归（全量审计）
148/148 通过，101 秒。

### 层 2：环境（真机自检 + 接口矩阵）
`verify-qq-bridge.ps1` **18 项里 2 项失败** —— 失败的不是机器，是**脚本自己过时了**：

1. `RestartOnFailure 已完全消失` —— 0.4.57.1 已改成"有且只重启一次"，断言没跟上
2. `主任务只保留 LogonTrigger` —— 现在有 BootTrigger
3. 顺带发现 `只有一个 bridge 进程` 用的是 `-le 1`，**进程数为 0 也判通过**（假通过），
   而且靠 `CommandLine` 找进程在**提权运行的桥接上读不到命令行**（永远 0）

改法：断言改成当前策略；进程检查换成「3100 只有一个监听者」+「health 报的 pid 就是监听者」互证。
重跑 **18/18 全绿**。接口矩阵 10/10 通过。

### 层 3：脏环境（沙箱 3199 端口，不碰生产）
| 场景 | 结果 |
| --- | --- |
| 坏 config.json | 明确报错退出：`配置文件读取/解析失败 ... position 30`，不静默用默认值 ✅ |
| 锁端口被别的程序占 | `{ok:false, reason:'held'}`，端口释放后立刻能拿 ✅ |
| 缺 node_modules | `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'`，fail-fast ✅ |
| 控制台端口被占 | `控制台端口 3199 已被占用（可能已有实例在运行），退出` ✅ |
| 坏 state 文件 | 不崩，但**静默回退成默认值** ❌ → 已修 |
| 陈旧实例锁文件（pid 已死 + 端口空闲） | 正常启动，不被陈旧锁挡住 ✅ |

坏 state 的修法：`readJsonSafe` 在"文件存在但解析失败"时打一条去重告警：

```
⚠️  state 文件损坏，已回退默认值（原文件保留，未覆盖）：state/mode.json —— Expected property name ...
```

只打文件名（打全路径会被脱敏成 `***`）。

> 测试过程中还发现：**PowerShell 5.1 的 `Start-Process` 没有 `-Environment` 参数**，
> 以及 `python -c` 在 PowerShell 里传参会被拆开 —— 两处都改用环境变量 + TcpListener 占位解决。
## 2026-11-01 — 0.4.62：新增「守护进程」页（存活以进程为准，日志只补历史）

第三个补入口的页面。这个页面最容易做错的地方是**拿日志文件当存活证据**：
`watchdog.log` 里写着"昨天重启过"不代表现在在跑，反过来日志为空也不代表没问题。

### 分层

| 层 | 数据源 | 权威性 |
| --- | --- | --- |
| 存活 | `/health/detail.process`（pid / uptimeMs / ready） | **权威** |
| 重启/退出 | `state/runner.log` 的 `child_exit` / `restart` 事件 | 历史 |
| 看门狗 | `state/watchdog.log` 的 `[ISO] 句子` | 历史，页面上直接标「非权威」 |

### 冲突检测（这是页面真正的价值）

两个信号对不上时**显式提示**，而不是各显示各的：

- 日志里有重启/退出事件发生在**当前进程启动之后** → 「日志与当前进程不一致（可能是旧日志或另一个实例）」
- 进程未存活但看门狗 24 小时内有健康告警 → 「需要人工确认守护链是否还在工作」

### 页面结构

- 四张卡：进程存活（pid/uptime）· 24h 重启次数（含上次退出码）· 看门狗事件数 · 判定口径
- 冲突提示条（有才显示，橙色）
- 事件时间线：runner 与 watchdog 合并，按时间倒序，最近 20 条，逐条标注来源

### 测试

`scripts/test-supervisor-view.mjs`（6 条）：存活只看进程信息、24h 窗口计数、事件合并顺序、
矛盾检测（正例 + 反例不乱报）、脏数据。
## 2026-11-01 — 0.4.61：新增「点歌 / 唱歌」页

后端 `POST /api/socialV2/song` 一直在，但控制台没有入口。补上：

| 控件 | 说明 |
| --- | --- |
| 会话下拉 | 从 `/api/socialV2/states` 取，免得手打 `group:` 前缀 |
| 歌名 | 可带歌手（`晴天 周杰伦`） |
| 时长 | 滑杆 10~300 秒，可勾「整首」 |
| 音质 | 普通 / 高清 / 无损 / 母带 |

### 明确提示"这是真实操作"

按钮文案是「点歌并发送」，确认框写清：

> 即将点歌并**真实发送**到 `group:xxx`；后端会下载并截取，约 10~20 秒后对方收到语音条。

提交后显示后端返回的 `note`，失败原样透出（含 `501`：非 Windows 且未设 `QQBOT_SONG_SCRIPT`；`403`：静默模式/工具未启用/会话不在允许范围）。

### 一个诚实标注

页面下方「本次页面发起的点歌」只记**本页操作**（含成功/失败原因），不是引擎历史——
`logs/song.log` 目前没有读端点，我没为了这个再开一个新接口。
## 2026-11-01 — 0.4.60：新增「空间动态」页（本 fork 的社交入口）

后端早就有 5 个 qzone 端点（`/api/socialV2/qzone`、`-feeds`、`-user-posts`、`-like`、`-comment`），
但控制台**一个入口都没有** —— 这一版把它补上。

### 页面能力

| 区块 | 能力 | 契约 |
| --- | --- | --- |
| 发说说 | 正文 ≤300，实时计数，二次确认后发布 | `POST /api/socialV2/qzone { action:'publish' }` |
| 我的说说 | 列出自己的动态（时间/图片数） | 同端点 `{ action:'list' }` |
| 好友动态 | 拉取 5 条，带作者/预览/图片 | `POST /api/socialV2/qzone-feeds` |
| 点赞 | 点赞 / 取消赞，显示"今日第 N 次" | `POST /api/socialV2/qzone-like` |
| 评论 | ≤120 字，二次确认 | `POST /api/socialV2/qzone-comment` |

### 写操作的三条纪律（按评审要求）

1. **二次确认**：发布/点赞/评论都先 confirm，文案写清"会真实出现在对方空间"
2. **结果反馈**：成功 toast（含配额"今日第 N 次"），失败在列表顶部插错误条 + alert
3. **失败可见**：不用 `catch {}` 吞错；后端 429（配额）原样透出

### 权限与边界（如实呈现给用户）

- 所有 qzone 接口**仅 `reserved2` 模式**可用；页面顶部会显示当前模式与身份
- 发说说要求 `key === private:<ownerQQ>`（管理员私聊），页面自动取 `/api/status.ownerQQ` 拼出来
- 每日配额由后端限制：说说 5 / 评论 20 / 点赞 50

控制台测试三套通过，审计 147/147。
## 2026-11-01 — 0.4.59：导航按「本程序能力域」重组

上游的导航分组是通用的（工作空间 / 聊天行为 / 管理）。本 fork 的能力面早就不一样了，改成按域：

| 分组 | 页面 |
| --- | --- |
| 总览 | 运行总览（含本程序仪表盘） |
| 群聊 | 会话与审批 · 人物库 · 黑话词库 |
| 对话 | 二代仿真 · 一代仿真 · 人格与角色 |
| 记忆 | 记忆星图 |
| 运维 | 诊断与健康 · 定时任务 · 令牌与花费 · 工具参考 · 访问与安全 · 调试与运维 |

**只改 DOM 顺序与分组**：`data-view` / `data-page` / hash / `consolePages` 的 key 全部不变，
所以旧书签（`#memory-graph` 等）、外部链接、已有操作习惯都不受影响。

验证：14 个导航项与 14 个 `consolePages` 一一对应，无遗漏；
`test-console` / `-static` / `-ui` / `-encoding` 四套全部通过。
## 2026-10-31 — 0.4.58.1：仪表盘首屏兜底（有限重试）

首屏打开时偶尔停在「（加载中…）」：控制台通过 `?token=` 进来时，第一批 fetch 可能赶在
鉴权/连接就绪之前发出，静默挂着不 settle（手动点「刷新」就正常）。

修法：`scheduleOverview()` 做**有限重试**（最多 2 次、间隔 900ms），只在容器仍是「加载中」时重试，
不会掩盖真实错误（`loadOverview` 失败会渲染错误态）。
## 2026-10-31 — 0.4.58：总览「本程序仪表盘」（9 格，一个端点）

### 为什么要一个聚合端点，而不是前端拼 5 个接口

1. **统一时间戳**：8~9 个指标来自不同来源，各自刷新时间不同，用户会把"5 分钟前的花费"当成现在
2. **避免 N+1**：记忆条数要遍历所有会话，前端做就是十几次请求
3. **失败语义统一**：任一来源失败只能标 `unavailable`，**绝不能用 0 冒充"没有"**

`GET /api/overview` 返回 `{ generatedAt, metrics: { ... } }`，每项带 `status` 与自己的 `at`。

### 九格（口径写死）

| 格 | 来源 | 口径 |
| --- | --- | --- |
| 运行模式 | `/api/status.mode` | |
| DSH 连接 | `/api/status.dshReady` | |
| 官方通道 | `officialTransport.ready` | disabled / disconnected / connected |
| 最近 24h 花费 | `/api/tokens/series(hours=24)` | **最近 24 小时**（不是自然日） |
| 未读 | 各会话 `unread.length` 求和 | |
| 长期记忆 | 各会话原子数 | **条数 + 有记忆会话数 + 会话总数**；缺原子时用 `migrateFromLegacy` 同源合成 |
| 静默时段 | `cfg.socialV2.quietHours` | null = 未启用 |
| 守护进程 | `runner.log` / `watchdog.log` | 24h 重启数、上次退出码；**日志来源，非权威存活** |
| 异常 | `watchdog.log` | **当前 = 15 分钟内 / 历史 = 全部**，旧日志不能说"现在还坏" |

### 前端的三个硬要求

- 每格标「来源 · 时间」
- 取不到 → 「暂不可用」+ 原因，**不出 0**
- 单源失败不拖垮整页（后端逐项 try/catch，前端逐格渲染）

### 测到两个真 bug（都修了）

1. `official` 一开始读 `officialState`（不存在）→ 永远 unavailable；改用 `officialTransport.ready`，与 health 口径一致
2. `memory` 一开始读裸 `longTermMemories` → 显示 0 条，但星图有 58 条 —— 因为读端点会用 `migrateFromLegacy` 现场合成。现在同源，实测 **58 条 / 7 个会话 / 14 总**，与星图一致

新增 `scripts/test-overview.mjs`（7 条：全可用 / 全失败不出 0 / 单源失败不拖垮 / 日志解析 / 当前与历史 / 脏数据）。
## 2026-10-31 — 0.4.57.1：三层守护补齐（运维加固，无代码变更）

### 补了两个缺口

| 缺口 | 修法 |
| --- | --- |
| `qq-bridge` 只有登录触发器 → 重启后没人登录就不启动 | 加 `BootTrigger`（延迟 30s） |
| `RestartOnFailure` 早年被关掉 → 崩溃后最坏等 5 分钟 | 恢复 `Count=1 / PT1M`（动作已 `-WindowStyle Hidden`，不会弹窗） |

### 实测：kill 掉桥接进程后 5 秒恢复

```
before pid=2976 epoch=30
taskkill /PID 2976 /F   → 成功
after  pid=26972 epoch=31 ready=True
```

恢复来自 **runner 自己**（`run-bridge.ps1` 的 `child_exit → delayMs=5000 → restart`），
不是计划任务 —— 说明**崩溃恢复本来就是秒级**，`RestartOnFailure` 是第二层（防 runner 死）。

### 现在的三层

| 层 | 触发 | 响应 |
| --- | --- | --- |
| runner | 子进程退出 | 5 秒重启（实测） |
| 计划任务 RestartOnFailure | runner 失败退出 | 1 分钟后重启一次 |
| watchdog | 进程在但健康持续不可用 | 15 分钟窗口 + 15 分钟冷却的受控恢复 |

局限写进文档：`InteractiveToken` + Boot 触发器在"无人登录"时启动不了；`Count=1` 只自动重启一次（避免无限重启掩盖故障）。

改动前任务 XML 备份：`_rollback/task-20261031-2350/qq-bridge.before.xml`。
## 2026-10-31 — 0.4.57：补 `docs/guides/QUIET-HOURS.md`

0.4.55/0.4.56 做的静默建议，决策逻辑此前只活在 UI 文案里。补成文档：

- **语义**：消息照收、不唤醒；管理员指令与 bootstrap 例外；`[x,x]` = 关闭
- **什么时候该开 / 不该开**：按热力图判断，不靠感觉
- **口径**：只算入站（实测 275 条里 110 条是自己发的）；进阶口径为什么没做
- **护栏为什么存在**：`05:00–13:00` 那种"白天全静默"的选法，用真实分布说明问题
- **一键采用的四道保护**：重算 / 确认 / 原子写 / 回读+回滚
- **手动配置要重启**（控制台按钮才是热更新）
- **排查表** + 建议的使用节奏

`docs/README.md` 已加索引，`TROUBLESHOOTING.md` 顶部加了速查并指过去。
## 2026-10-31 — 0.4.56：静默建议可一键采用（默认护栏，可关）

### 口径修正（先修数据，再给按钮）

实测：热力图样本 275 条里 **110 条是机器人自己发的（40%）**。自己的回声被算成"群活跃"，
会让"值不值得改"的数字夸大 2.6 倍（23–8 窗口：全部 114 条 → 仅入站 43 条）。

现在只统计**入站消息**（排除 `isSelf` 与斜杠命令），并在界面上写明样本量与时间跨度。

### 护栏是「看得见的开关」

```
[✓] 只推荐覆盖深夜（02:00–06:00）的窗口
    开：候选窗口必须完整包含 02–06 点，避免算法挑出「白天全静默」（上午有人 @ 也不醒）
    关：不限深夜，只看消息最少 —— 可能选出白天窗口，机器人会在上班时间保持沉默
```

默认开启，取消后立即重算候选（偏好记在 localStorage）。这解决了一个真实问题：
按当前数据，不限深夜的最优解是 `05:00–13:00`（1 条），但那只说明**上午没人说话**，
不是"该静默"。

### 一键采用（四道保护）

1. **点击时重新拉数据重算**，不写页面打开时的旧建议；建议变了就提示"已更新，再看一眼"
2. **二次确认**：显示 `[旧值] → [新值]`、影响面、样本量
3. **原子写 + 热更新**：复用 `POST /api/socialV2/config`（内部已是 `atomicWriteJson`）
4. **回读校验 + 失败回滚**：写入后 GET 复核，不一致或失败就把旧值写回去并报错

### 测试

`test-quiet-suggest.mjs` 从 6 条扩到 8 条：新增「护栏开关生效」「coversDeepNight 边界」。
依然是把 `console.html` 里的函数抽出来跑，测的是线上那份代码。
## 2026-10-31 — 0.4.55：热力图给出「静默时段建议」

热力图下面多一块：

```
静默时段建议
建议 02:00 – 10:00（该窗口共 0 条）
口径：按最近消息统计，窗口内消息越少越适合静默
```

算法：把 7×24 压成 24 列，滑窗找**连续 N 小时（默认 8）消息最少**的窗口，跨零点也算。
不是"猜一个整点"，是从真实消息分布里选。

### 测试方式

`scripts/test-quiet-suggest.mjs` 把 `console.html` 里的 `suggestQuietWindow` / `quietWindowScore`
**原样抽出来**在 Node 里跑 —— 测的是发布出去的那份代码，而不是另写一份"应该一样"的实现。
6 条用例：全空、单点繁忙、跨零点、窗口长度 4/8/12、当前窗口计分、脏数据。
## 2026-10-31 — 0.4.54：修深链接（/#页面 打不开对页）+ 记住上次停留页

原来首屏只有一句 `setConsolePage(location.hash.slice(1))`：

- hash 在 token 重定向 / 令牌 prompt 流程里丢过一次，就静默落回总览，且没有恢复路径
- 刷新后也回不到刚才那页

改成 `bootConsolePage()`：

1. 优先 `location.hash`
2. 其次 `sessionStorage.consolePage`（上次停留的页）
3. 都没有才总览
4. `load` 事件里再对齐一次（防止浏览器晚填 hash）

实测 `/#sessions` 直开「会话与审批」，热力图正常渲染。
## 2026-10-31 — 0.4.53：控制台四张图（漏斗 / 热力图 / 花费结构 / 工具体检）

按"只给有时序、有分布、有拓扑的数据画图"的原则，补了四块。

### ① 唤醒漏斗（诊断页）

从既有 `decision-trace` 聚合（**不新增埋点**）：收到 → 过闸门 → 唤醒命中 → 进模型，
每段显示流失数，下面列「主要流失原因」（闸门拦截 / 未命中 / 已暂停 / 命令分支）。

纯函数 `buildWakeFunnel()` 在 `src/api/console-diagnostics.js`，有 6 条单测（含脏数据）。
口径写死在标题上：**最近一窗（缓冲 80 条）**，不是全量。

### ② 会话活跃热力图（会话页）

7×24 网格（行=星期，列=小时，对数色阶），右侧给每个会话「最活跃的三个小时」。
用来定静默时段、发现半夜活跃的群。

### ③ 花费结构（令牌页）

走势图旁边补：按会话 Top 8 横向条（谁烧钱）+ 高峰/空闲占比环（错峰能省多少）。
数据来自现成的 `/api/tokens/summary`，零后端改动。

### ④ 工具体检（工具参考页）

每个工具一行 p50/p95 耗时条 + 失败数（红条），按 p95 排序。
耗时由 `tool-calls.jsonl` 的 call→result 配对**估算**，样本量写在标题上。
## 2026-10-31 — 0.4.52.2：人物印象是对象，不是字符串

`memberImpressions` 的值是 `{ traits:[...], interactionCount, lastSeenAt }`，早先直接
`String()` 就变成 `[object Object]`。现在按 `traits.join('、') + 交互 N 次 + 最近日期` 格式化，
兜底再按 key:value 展开，不会再出现 `[object Object]`。
## 2026-10-31 — 0.4.52.1：修「星图看得到、改权重 404」

读端点 `/api/socialV2/memory` 在没有 `longTermMemories` 时，会用 `migrateFromLegacy` **现场合成**
一份长期记忆（保证"升级即可见"，只读不落盘）。而新写的 `/api/socialV2/memory-weight` 只查
`st.longTermMemories` —— 于是旧会话会出现**星图里有这条、点改权重却 404**。

修法：写端点同样调用 `migrateFromLegacy`，并**顺手落盘完成迁移**（写时升级），之后按文本匹配。

> 另一种 404 是测试脚本自己的锅：Windows PowerShell 5.1 的 `Invoke-WebRequest -Body "<字符串>"`
> 默认不是 UTF-8，中文被改写导致文本匹配失败。用 `[Text.Encoding]::UTF8.GetBytes()` 发即可。
> 浏览器端不受影响。
## 2026-10-31 — 0.4.52：星图可改权重 + 遗忘时间轴

### 1. 权重可编辑（新增写端点）

`POST /api/socialV2/memory-weight` `{ key, text, weight }`：

- 只允许操作者：带 `x-agent-token` 的会话级主体**一律 403**（否则 A 群的 AI 能改 B 群的记忆）
- `weight` 必须在 `(0, 3]`，越界 400；找不到该条记忆 404（可能已被合并/归档）
- 写 `manualWeightAt` 标记"人工调过"，方便以后审计
- 星图右侧点星点即可 −0.3 / +0.3 / 设为 1 / 2 / 3

### 2. 遗忘时间轴

工具栏「时间」滑杆：T+0 → T+120 天。

- 星点大小/颜色按**投影后的有效权重**重算：`weight × 0.5^((已过天数 + T)/30)`
- 投影权重 < 0.05 的星点变成**虚线圈 + 变暗**，右侧实时显示「将淡出 N/58」

这比口头讲"艾宾浩斯曲线"有用：拖到 T+30 就能看到这个月不说话的群，记忆会掉成什么样。
## 2026-10-31 — 0.4.51：记忆星图加「人物层」

星图从两层（会话 → 记忆）变成三层：**会话 → 人物 → 记忆**。

### 新图层

| 元素 | 含义 |
| --- | --- |
| 紫色菱形 | 人物（来自 `memberImpressions`），**菱形越大 = 关联记忆越多** |
| 紫色细线 | 人物 ↔ 他/她被提到的记忆（正文含名字或 tag 命中） |
| 两个开关 | 「人物层」「记忆层」可单独关掉，只看其中一层 |

点人物看：印象文字 + 关联记忆条数 + 前 5 条摘要。底部 chip 也变成「记N 人M」。

### 为什么把人物单独画一层

人和事是两种记忆：**人**是长期稳定的（`memberImpressions` 跨会话累积），**事**是有半衰期的
（`longTermMemories` 30 天衰减）。混在一起看不出"这个人我记得多深"。

现在能一眼看出：这 13 个人里谁被记得最多（菱形最大）、他关联的是哪几条记忆。
## 2026-10-31 — 0.4.50：控制台新增「记忆星图」

把 `longTermMemories` 画成星图：**一个会话 = 一团星，一条记忆 = 一个星点**。

### 视觉语义（刻意对齐"遗忘曲线"）

| 元素 | 含义 |
| --- | --- |
| 星点大小 | 有效权重 `weight × 0.5^(天数/30)` —— log 尺度，避免 weight=1 全一样大 |
| 星点颜色 | 新鲜 = 暖金，陈旧 = 冷蓝紫（60 天线性退到最暗） |
| 连线 | 原子 ↔ 会话；原子 ↔ 原子（共享 ≥2 个 tag，或 1 个 tag 且双方权重都高） |
| 亮度 | 最近被命中（`lastHitAt`） |

### 交互

- 悬停看摘要、点击看详情（权重 / 命中次数 / 时间 / 标签 / 来源）
- 拖节点、拖空白处平移、滚轮缩放
- 底部「会话 chip」：点一下就把该会话居中放大（星点在动的时候也能点中）
- 「最低权重」滑杆：只显示值得留意的记忆

### 实现

- **零后端改动**：复用 `GET /api/socialV2/states` + `GET /api/socialV2/memory?key=`
- 纯 canvas 力导向布局（斥力 O(n²)，单会话上限 200，规模够用）
- 无第三方图表库

### 与"外挂提示词记忆系统"的区别

网上那套（提示词里让 AI 自己记）没有真实存储：换对话就没了，权重由模型口头承诺。
我们是**落盘 + 半衰期 + 命中强化 + Jaccard 合并**，星图只是这份真实数据的可视化。
## 2026-10-31 — 0.4.49.3：官方通道实例锁改用 OS 端口互斥 + 修红了的 audit CI

> 承接三轮独立复核。**锁的实现整体换掉**：文件协议（含 .guard sidecar）做不出严格互斥。

### 为什么换实现

三轮复核的结论是一致的：任何「读-判断-删」的文件锁都有 TOCTOU；而且 Node 在 Windows 上
以共享模式打开文件（`FILE_SHARE_READ|WRITE|DELETE`），连"句柄还在所以不能 rename"这个证明
都不成立（实测：`rename` 成功）。

### 现在的做法：回环端口绑定

- 同一端口只能被一个进程 `listen` —— **内核保证**，没有协议层竞态
- 进程崩溃/被 kill → 内核立即释放端口 → 下一个实例直接拿到锁（**不需要人工删锁**）
- 状态文件只做诊断（pid/token/beatAt/port），删了也不影响互斥
- 端口：`QQB_LOCK_PORT` 显式优先，否则 `31200 + sha256(instanceId) % 2000`
- 失败按错误码区分：`EADDRINUSE=held` / `EACCES|EPERM=permission` / `EADDRNOTAVAIL=unavailable` / `timeout` / `error`
- 显式端口非法 → **直接失败（invalid-port）**，不静默回退

### 顺带修掉的 CI 红灯

`audit` workflow 自上线起**每次 push 都失败**（核实：最近 10 次全 failure）。
原因：ubuntu-latest 上没装依赖，而审计里有些测试需要 js-yaml / zod /
`@modelcontextprotocol/sdk` / `@deepseek-ai/schemastery`（**测试依赖**，不是运行时依赖）。
`audit.yml` 已补 `npm ci`。

### 测试

- `scripts/test-instance-lock-os.mjs`（新，14 条）：独占、崩溃 kill -9 后自动接管、
  并发只有一个成功、删状态文件骗不到锁、release 后再取、timeout 注入 4 条、
  非法端口 fail-closed、错误码分类
- `scripts/test-instance-lock.mjs`：改成新 API（同 instanceId 互斥 / 不同 bot 可并存）
- 删除 `test-instance-lock-atomic.mjs` / `test-instance-lock-toctou.mjs`（guard 语义已不存在）

### 已知边界（写进 DOCKER.md）

宿主机多进程、同容器多进程、Linux `--network host` → 互斥成立；
普通 Docker bridge / Docker Desktop 默认网络 / 两台机器 → **不互斥**（容器回环是容器自己的）。
## 2026-10-31 — 0.4.49.2：guard 回收协议（第二轮复核 P2-1/P2-2 + P3）

> 复核结论：heartbeat/release 修复有效，但 **guard 自身的回收协议**被指出两个新缺口。本版只修这两个 + 两个 P3。

### P2-1：并发回收会删掉别人刚新建的 guard

旧代码检查 stale 后直接 `rmSync(guardFile)`，**没有验证删的还是刚才检查的那个文件**。

现在：`rename` 抢占 → 比对 `ino/dev/birthtime` → 是自己检查过的才删；不是就**原样还回去**。

```js
try { fs.renameSync(guardFile, parked); } catch { return 'gone'; }   // 抢占（同名只有一个人成功）
const st1 = fs.statSync(parked);
if (st1.ino !== st0.ino || st1.dev !== st0.dev) { fs.renameSync(parked, guardFile); return 'raced'; }
```

### P2-2：空/损坏 guard 被当作死持有者

两处改动：

1. **创建也原子化了**：先把 pid 写进临时文件，再 `linkSync` 挂到 guard 名上 —— 不再有"文件已存在但内容为空"的窗口
2. **读不到 pid 就不再回收**：`holderPid <= 0` 一律保守拒绝（复核明确要求：未知状态应拒绝，不是回收）

代价：guard 文件真损坏时会一直等。已在 `TROUBLESHOOTING.md` 写明**手工删除步骤**与"先确认没有第二个实例"。

### P3-1：beat 抢不到 guard 时不再静默

新增 `stats()`：连续失败计数 + 限流日志（第 3 次、之后每 30 次）+ "锁被接管"事件。

### P3-2：发送失败日志脱敏

`.catch((e) => log('❌ 发送失败 …' + (e?.message ?? e)))` → `describeError(e)`。

### P3-3：verbose 开关写进文档

`TROUBLESHOOTING.md` 补：开关设置、风险提示、**用完必须删 `plugin.log` 与 `plugin.log.1`**。

### 测试

`test-instance-lock-toctou.mjs` 从 5 条扩到 **9 条**，新增：

- **真实双进程屏障**：A 在 guard 内忙等（`onAcquired` 钩子），B 的认领必须失败
- 空/损坏 guard → 不回收、不夺锁
- 并发回收场景不误删新 guard
- beat 计数可观测（占住 guard 后累积，恢复后清零）

并把上一版命名不准确的用例改成「A 子进程持有实例锁时 B 认领被拒」（复核指出原注释与实现不符）。

### 质量门

审计 **145/145**；原子写守卫 5 处 guard-allow 例外；体积基线更新（instance-lock 227 行）。
## 2026-10-31 — 0.4.49.1：锁租约 TOCTOU + 日志脱敏残留（独立复核 R49-01/02/04）

> 承接 v0.4.49 独立复核。复核确认 5 项修复有效，同时指出 3 处残留。本版只修这 3 处，**不混入 0.4.50**。

### R49-01：heartbeat / release 与认领的 TOCTOU

复核给出的**准确**竞态序列（比我自审时描述的更精确）：

```
1. A 的 heartbeat/release 读到"锁还是我的"
2. A 在写入/删除**之前**被暂停
3. B 在 A 心跳过期后接管，写入 B 的锁
4. A 恢复，按旧状态写/删 → 覆盖/删除 B 的锁
```

修法（3 处）：

| 改动 | 说明 |
| --- | --- |
| `beat()` 进 guard | 「读取身份 → 写入」在同一个临界区内 |
| `release()` 进 guard | 同上；删之前必须比对 token |
| **generation token** | 每次认领生成 `crypto.randomUUID()`；beat/release 必须比对该 token，**不再只比 pid + instanceId** |
| guard 回收 | 从"只看 mtime > 5s"改为"mtime 超时 **且** 持有者 pid 已死" —— 进程被冻结也不能被夺走临界区 |

新增 `test-instance-lock-toctou.mjs`（5 条，含**真实双进程屏障**与"心跳不得覆盖新锁"的确定性用例）。

### R49-02 / R49-04：日志脱敏残留

| 位置 | 旧 | 新 |
| --- | --- | --- |
| `agent/error` | 直接写 `error.message` | `describeError()`：默认只记 `name`/`code` + **message 长度**；`QQ_PLUGIN_LOG_VERBOSE=1` 才给首行 |
| 工具结果 `error` 字段 | 原样输出首行 | 默认 `err:N字`；verbose 才给首行 |
| 发送成功日志 | `message_id ?? JSON.stringify(r).slice(0,60)` | 只取明确 `message_id`，否则 `(none)` |

`test-plugin-log-redaction.mjs` 从 8 条扩到 **13 条**，新增用例用唯一正文标记断言**默认日志里不出现**。

### 质量门

- 审计 **145/145**（+1 测试文件 / +10 条断言）
- 真机：待部署验证

### 未做（按复核意见单列）

- **R49-03**：宿主是否保证调用 `setup` 的契约测试 —— 需要宿主版本契约，属 0.4.50
- **R49-05**：宿主/Docker 跨 state 目录锁契约 —— 单独设计任务
- `wake-config`：复核判为**设计内能力**，保留（补会话隔离测试放入 0.4.50）
## 2026-10-31 — 0.4.49：外部审查第一批（P1-1 + P2-1/2/3/4）+ 文档一致性（P2-5）

> 基线 `4bd29d2`（v0.4.48）全仓外部审查报告 → 逐条核实后按批准范围修。**P0 = 0**。

### 安全与互斥（5 项）

| # | 问题 | 修法 | 测试 |
| --- | --- | --- | --- |
| **P1-1** | 插件工具白名单 **fail-open**（`?.restrict?.()` + 无条件成功日志） | 抽出 `applyToolAllowlist()`：缺 `restrict`/抛错/空名单**一律抛错**（宿主建 agent 失败）；并置 `toolsUnsafe`，入站再拒一次 | `test-plugin-tool-allowlist.mjs`（6 条） |
| **P2-1** | `/api/socialV2/initial-prompt` 只拒 GET，**POST 可被有效 agent token 改写** | 并入管理端集合，**与 method 无关**一律 403 | `test-prelude-agent-denied.mjs`（6 条，用**有效**令牌 + 先过 CSRF） |
| **P2-2** | 通道锁把 `process.kill` **所有异常**当"进程已死"（EPERM 也会接管 → 双实例） | `classifyKillError()`：只有 `ESRCH` 算死；`EPERM/EACCES/未知` 保守当活着；`killFn` 可注入 | `test-pid-alive.mjs`（8 条，含 EPERM 不接管 / ESRCH 接管） |
| **P2-3** | instance-lock 非原子（read→判断→write），且同 instanceId 换 PID 可覆盖 | sidecar `.guard` + `openSync('wx')` 串行化；**同实例不同 PID 按持有者存活性决定**（活着拒绝 / 死了允许） | `test-instance-lock-atomic.mjs`（6 条，含三子进程并发只 1 个成功） |
| **P2-4** | `plugin.log` 落工具参数/结果原文 → **QQ 正文长期驻留磁盘** | `describeToolArgs()` / `describeToolResult()`：只记工具名、键名、长度、状态；正文不落盘；`QQ_PLUGIN_LOG_VERBOSE=1` 才原样记 | `test-plugin-log-redaction.mjs`（8 条，唯一标记正文断言不出现） |

### 兼容性处理

- `channel-mode-store.js` 里的 PID 判定改为**内联**：审计 harness 以源码文本注入 VM，`stripExports` 只剥行首 `export `，re-export 语法会炸（实际踩到，15 个测试红）
- 两份实现（`src/pid-alive.js` 与内联）由 `test-pid-alive.mjs` 的**行为对照**守住，防止漂移
- `plugin/vendor/channel-mode-store.js` + `pid-alive.js` 已同步（vendor 守卫 4/4）

### 文档一致性（P2-5）

| 文件 | 改了什么 |
| --- | --- |
| `CONTRIBUTING.md` | 删除"hotfix 可直接在 main"，改为**一律 `next/<版本>`** |
| `SECURITY.md` | "个人 fork" → "独立维护分支（定向回移植）"，中英文都改 |
| `AGENTS.md` | 审计数量不再写死（"以脚本输出为准"） |
| `docs/UPSTREAM-SECURITY-REGISTER.md` | 401 → **429**（并注明以命令输出为准） |
| `docs/WINDOWS-PROCESS-SUPERVISION.md` | §三/§四 标注为**历史章节**，指向 §十二 的现状 |

### 质量门

- 审计 **144/144**（新增 5 个测试文件，共 +34 条断言）
- `test-file-size` 基线更新（`instance-lock.js` +52 行 = 原子认领 + guard，属真实增长）
- vendor 守卫 4/4、链接检查通过
## 2026-10-31 — 0.4.48：资源可观测性（`system` 段）

> 起因：有用户的服务器上跑网页版抖音自动化把机器吃满，QQ 侧表现为"慢/不回"。
> 当时我们**拿不出任何资源证据**，只能靠猜。

### `/health/detail` 新增 `system`

```json
"system": {"cpuPercent":0.9,"rssMb":77.9,"heapUsedMb":24,
  "freeMemMb":4739.5,"totalMemMb":16255,"memUsedPercent":70.8,
  "loadavg":null,"eventLoopLagMs":9,"eventLoopLagMaxMs":39,
  "cores":8,"platform":"win32","warn":[]}
```

### 三个判读要点

| 指标 | 说明 |
| --- | --- |
| `eventLoopLagMs` | **最能说明"我们被拖累"**（>500ms 说明主线程被抢） |
| `cpuPercent` | 只算本进程；**它低但 lag 高 → 是别的进程在抢 CPU** |
| `freeMemMb` | 系统剩余内存，<200MB 触发 `low-memory` |

- `loadavg`：Windows 上恒为 `null`（如实标注，不假装有值）
- `warn` 数组：`event-loop-lag:*` / `low-memory:*` / `high-cpu:*`
- **`warn` 不参与 `ready` 判定** —— 它描述"环境变差"，不等于"我们坏了"

### 实现

- `src/system-metrics.js`：事件循环延迟监控（1s 采样、保留 60 个）+ CPU 采样 + 快照
- 延迟超过 500ms 时打一条限流日志（60s 一次）
- 新增 6 条测试（含"阻塞 250ms 能被捕到"与"空闲时应该很低"）

审计 139/139。
## 2026-10-31 — 0.4.47：第二次弹窗根因（watchdog 任务漏了 -WindowStyle Hidden）

> 0.4.43 修好主任务后，窗口**仍然**每隔几分钟弹一次。这次找到真凶。

### 根因对比

| 任务 | 参数 | 隐藏 |
| --- | --- | --- |
| `qq-bridge` | `… -WindowStyle Hidden …` | ✅ |
| **`qq-bridge-watchdog`** | `-NoProfile -ExecutionPolicy Bypass -File keepalive.ps1` | ❌ |

watchdog 触发器是 `PT5M`（每 5 分钟）→ 表现成"**隔几分钟弹一次**"。
主任务那次的"1 分钟一次"是 `RestartOnFailure`。**两个根因，两条任务，都要修。**

### 改了什么

- 新增 `scripts/harden-watchdog-task.ps1`（管理员；只改参数，触发器/设置保持原样，先备份）
- **已提权执行**：watchdog 任务现在带 `-WindowStyle Hidden`
- `verify-qq-bridge.ps1` 新增 3 条：watchdog 带 Hidden / 无 RestartOnFailure / 仍每 5 分钟触发
- 手动触发一次 watchdog 验证：进程起来后**无窗口句柄**（handle=0），健康时秒退

### 真机结果

```
verify-qq-bridge.ps1 → 19 项通过 / 0 失败
/health/detail → version=0.4.46  buildId=sha256:e492691a…  epoch=12  ready=true
```

⚠️ 注意：`/health` 显示 0.4.46 是因为**该进程是在 0.4.47 之前启动的**（只同步了文件没重启）。
下次重启即为 0.4.47，指纹机制本身工作正常。
## 2026-10-31 — 0.4.46：补工程规范文档 + 移植 DSH_WEB_URL 优先

> 和上游（v0.2.1-r1 + #131）做了一次**双向对比**后，补齐我们缺的、移植他们更好的。

### 补的（我们缺，他们有）

| 文件 | 内容 |
| --- | --- |
| `SECURITY.md` | 报告渠道、**据实说明**（个人项目没有 SLO）、In/Out of scope、部署硬要求、已知风险 |
| `CONTRIBUTING.md` | 环境/启动/测试门槛（`test-audit` 必须全绿）、PR 规则、合并方式、许可、安全 |
| `.github/ISSUE_TEMPLATE/` | bug / feature / config 三份（bug 模板强制要求 `/health` 指纹、模式、脱敏日志） |

README 顶部加了入口。

### 移植的（他们有，我们更好，但这条确实缺）

`src/dsh-port.js` 新增 `dshUrlFromEnv()`：**优先使用 `DSH_WEB_URL`**（DSH 注入给子进程的精确地址），
比"按进程名扫监听端口"更准。发现顺序变成：环境变量 → 已配置 → 系统报的端口 → 常见默认。

- 只接受本地回环 http(s)，拒绝外部地址（避免把外网当本机 DSH）
- `discoverDshBaseUrl` 新增 `opts.env`，便于测试隔离
- 新增 `scripts/test-dsh-port-env.mjs`（5 条）

### 顺手修的两个测试脆弱点

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| `test-dsh-port` 在真机上失败 | 环境里真有 `DSH_WEB_URL`，把"全探不通"的前提破坏 | 测试显式 `env: {}` 隔离 |
| `test-dsh-port` 拖住审计 | 探测残留 socket 不退出 | 末尾显式 `process.exit` |
| `test-first-run` 在审计里失败 | `stdio:'inherit'` + 重定向时 PowerShell 中文变 mojibake | 断言兼容 `1/5` 形态；审计对慢测试放宽超时 |

审计 **138/138**。
## 2026-10-31 — 0.4.45：watchdog v3（冷却期 / port_conflict / 时钟回拨）+ 实施包

> 主任务 XML 不再改（保留 `UseUnifiedSchedulingEngine=true`）。本次只动 watchdog 与工具脚本。

### watchdog v3

| 规则 | 实现 |
| --- | --- |
| `ready=false` 不重启 | 只有 `live=false` 或连不上才算故障 |
| 15 分钟持续窗口 | **持久化时间戳**判断（5 分钟 × 3 次实际只跨 10 分钟） |
| 恢复冷却期 | 失败后 `cooldownUntil = now + 15min`，期间不再 `/end` |
| `port_conflict` | 占端口的不是 node → 记录并进冷却，**不重启** |
| 时钟回拨 | `firstFailureAt > now` → 重置窗口 + `clock_adjusted` |
| 孤儿检查 | `/end` 后须「旧 PID 不存在 **且** 端口释放」才启动 |
| 恢复验证 | 60 秒内要求 `live && ready`，打印新旧 pid/epoch/buildId |

### 实施包（新增）

- `scripts/install-qq-bridge.ps1`：管理员注册任务（备份 + `schtasks /create /xml`）
- `scripts/verify-qq-bridge.ps1`：11 条验收标准自动检查（实跑 16 项全通过）
- `scripts/keepalive.ps1`：v3（可被环境变量覆盖，便于隔离演练）

### 受控演练（未触碰生产）

隔离端口 3199 + 假任务名 + 3 秒窗口：

```
第 1 次：consecutiveFailures=1，不恢复
第 2 次：超过窗口 → 进入恢复 → 目标不存在 → recovery_failed
        → cooldownUntil=+20s，recoveryAttempts=1
```

演练还抓到一个真 bug：日志里硬编码「3100 已释放」，改用 `$PORT`。

### 真机验收

`verify-qq-bridge.ps1` → **16 项通过 / 0 失败**：
RestartOnFailure 消失、Hidden 生效、IgnoreNew、PT0S、仅 LogonTrigger、
watchdog 无 start.bat、状态持久化、15 分钟判定、单进程、health 可访问、
live=true、buildId/ownerId/epoch 齐全、runner.start 有记录。
## 2026-10-31 — 0.4.44：修掉 0.4.43 引入的两处守卫问题

> 小补丁。0.4.43 真机执行后，审计红了两项，都是我自己引入的。

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| `start.bat 必须保持纯 ASCII` | 我加的注释写了中文 | 注释改英文；并去掉 BOM（守卫查原始字节） |
| `隐私守卫：含本机私有路径` | 文档里写了 `<部署根>` | 换成 `<部署目录>` 占位 |

审计恢复 137/137。
## 2026-10-31 — 0.4.43：Windows 启动链修复**已执行**（窗口不再弹）

> 承接 0.4.42 的根因定位。这次是**真机执行 + 验证**，不是文档。

### 执行了什么

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `RestartOnFailure` | `Count=999 / PT1M` | **节点删除**（不是 Count=0 —— 那是非法值） |
| 启动参数 | `-NoProfile -ExecutionPolicy Bypass` | 加 `-WindowStyle Hidden` |
| `MultipleInstancesPolicy` | IgnoreNew（本来就对） | 保持 |
| `ExecutionTimeLimit` | PT0S（本来就对） | 保持 |
| 触发器 | 仅 `LogonTrigger` | 保持 |

原来列的 6 项里**只有 2 项真的需要改**，其余要么已满足、要么该改脚本。

### 验证证据（16:46 实测）

```
读回 XML：RestartOnFailure 不存在 / 含 -WindowStyle Hidden
进程：node 4528 ← powershell 17128（16:46:43）← svchost
       powershell 17128 MainWindowHandle=0、MainWindowTitle=''  ← 无可见窗口
健康：/health/detail → ready=true, epoch=11, 四个服务全 connected
```

### 启动器收敛

- `run-bridge.ps1`：改成 **JSON 行日志**（`runner.start` / `runner.child_exit` / `runner.restart` / `runner.shutdown`）
- `keepalive.ps1`：**不再启动 `start.bat`**；改为「连续 3 次（15 分钟）health 不可用 → `schtasks /end` → 等 5 秒 → `/run`」
  （因为 `IgnoreNew` 会让"任务 Running 但服务已死"时的 `/run` 变成空操作）
- `start.bat`：去掉 `pause`（窗口不再卡住等人按键）

### 备份与回滚

`state/task-backup-20261031-164631.xml`
回滚：`schtasks /create /tn "\qq-bridge" /xml <备份> /f`

### 文档

`docs/WINDOWS-PROCESS-SUPERVISION.md` 补三处纠正：
`Count=0` 非法、`Hidden` ≠ 隐藏窗口、`IgnoreNew` 需显式声明；并附改前后对照与验证证据。
## 2026-10-31 — 0.4.42：生命周期规范 + 结构化启动摘要 + Windows 重启根因

> 只有文档、摘要与少量日志/脚本改动，**不拆 bridge.js**。

### ① `docs/STARTUP-LIFECYCLE.md`

六个阶段（启动 / 认领 / 连接 / 就绪 / 运行 / 关闭），每阶段写清：谁负责、失败怎么办、允不允许 ready。
**顺序是按代码实际跑出来的**（指纹先于认领；释放所有权必须在保存状态之后）。

关键原则写进文档：`ready` 只看「持有通道 + DSH + 该通道连接」，**不是**「所有服务都 connected」。

### ② 结构化启动摘要（`startup.summary`）

```json
{"event":"startup.summary","bootId":"43c26da5","version":"0.4.42",
 "buildId":"sha256:…","sourceCommit":"…","startupDurationMs":826,
 "process":{"pid":21892,"ownerId":"…","uptimeMs":1316},
 "channel":{"mode":"bridge","epoch":9,"status":"active"},
 "services":{"dsh":"connected","snowluma":"connected","official":"stopped","console":"connected"},
 "live":true,"ready":true,"stages":[{"name":"channel-claim","status":"ok","durationMs":0}]}
```

- 第一次 `ready=true` 时打；10 秒兜底一次；只打一次
- 失败也留证：`startup.incomplete`（带 reason + 已执行阶段 + aborted 标注）
- **不含任何凭证**（只记 buildId / ownerId / epoch）

### ③ 关闭顺序规范化

```
draining（先失去 ready）→ saveState → shutdown.summary → 释放通道 → releaseLock → exit
```

**释放所有权必须是最后一步** —— 否则另一个进程可能立刻接管，而旧进程还在写 `state/`。

### ④ Windows「窗口自动重启」根因（`docs/WINDOWS-PROCESS-SUPERVISION.md`）

实测证据：

| 证据 | 结论 |
| --- | --- |
| 父链 `node ← powershell ← svchost` | 由计划任务拉起 |
| 任务 `RestartOnFailure=PT1M × 999`、无隐藏窗口 | **每次任务实例结束都会 1 分钟后重拉可见窗口** |
| `state/runner.log` 只有启动行、**没有**「bridge 退出（code X）」 | 不是脚本循环重启，是整进程被结束 |
| 间隔 42–49 秒 ≈ 1 分钟 | 与 `PT1M` 吻合 |

修法：`scripts/harden-scheduled-task.ps1`（关掉 RestartOnFailure / `-WindowStyle Hidden` / `IgnoreNew` / 无超时）。
**需要管理员执行一次**（普通权限 `Register-ScheduledTask` 会 `Access is denied`）。

### ⑤ 退出诊断

`run-bridge.ps1` 现在每次 node 退出写 `state/exit.log`：

```
[2026-10-31 16:40:12] exit code=0（主动退出） 运行 123.4s
[2026-10-31 16:41:03] exit code=2（发现已有实例） 运行 0.8s
```

### 测试

`test-boot-report.mjs`：summary 只打一次 / incomplete 留证 / **摘要里不得出现凭证** / shutdown 单独成事件。
审计 137/137。
## 2026-10-31 — 0.4.41：buildId + ownerId + 健康聚合（可观测性升级）

> 不动 `bridge.js` 主体结构；只补「运行时到底跑的是什么、是谁、活着没」。

### ① buildId 取代「commit 当指纹」

真机实测：同步文件后 `.git HEAD` 不变 → 指纹失效（截图里显示 0.4.38 就是这么来的）。

```json
{ "buildId": "sha256:<64 hex>", "sourceCommit": "929f29a7de1a", "version": "0.4.41" }
```

- `buildId` = 运行时清单（`src/`、`plugin/`、`dsh/agent-presets/`）的**内容哈希**，路径+内容一起进哈希
- 排除：`state/`、`logs/`、`node_modules/`、`.git/`、文档
- 跨仓库同内容 → 同 buildId；改文档 → 不变；改代码 → 必变
- `sourceCommit` 保留，只作追溯线索

### ② ownerId + procStart：PID 会被重用

```json
{ "schemaVersion": 2, "mode": "bridge", "pid": 24668,
  "ownerId": "6f998021-…", "procStart": 1793435403385, "epoch": 6, "status": "active" }
```

- 同一进程 heartbeat：ownerId / epoch 都不变
- 新进程接管：新 ownerId + epoch 递增
- **同 PID 不同 ownerId → 判定为 `pid-reused`，视为新持有者，epoch +1**
- v1 记录（无 ownerId）**平滑升级**：续期时补上 ownerId，不误判死亡、不重置 epoch

### ③ 健康聚合：`/health/detail`

`/health` 保持兼容；新增聚合视图，把**连接状态与所有权状态分开**：

```json
{ "process": { "status": "running", "pid": 14532, "ownerId": "…", "uptimeMs": 24550 },
  "channel": { "mode": "bridge", "epoch": 6, "status": "active" },
  "services": { "dsh": "connected", "snowluma": "connected",
                "official": "connected", "console": "connected" },
  "live": true, "ready": true }
```

- 状态取值：`starting | connected | reconnecting | degraded | stopped | failed`
- **`live`** = 进程活着；**`ready`** = 持有通道 + DSH 连上 + 当前通道连接正常
- Official 连接着但没持有通道时：`services.official=connected`，`ready` 仍按通道判定

### 测试 8 条（全绿）

```
① 相同代码不同 Git HEAD → buildId 相同
② 只改运行代码 → buildId 变
②-b 只改文档 → buildId 不变
②-c state/ 与 node_modules 不进 buildId
③ 同一 PID、不同 ownerId → 旧进程不能继续持有（epoch+1）
③-b v1 记录平滑续期（不误判死亡）
④ DSH connected → reconnecting → connected，ready 跟随
④-b 通道未持有 → ready=false（连接与所有权分离）
```

真机 `/health/detail` 已返回完整结构；通道记录 `schemaVersion: 2`、`ownerId`、`epoch` 生效。

审计 136/136。
## 2026-10-31 — 0.4.40：6 条集成测试（含 epoch × 重试交叉）

> 只加测试与它暴露的必要修复，**不拆 bridge.js**。

### 集成测试发现 2 个真问题（都已修/钉住）

| # | 发现 | 处置 |
| --- | --- | --- |
| 1 | **重复投递没去重**：同一 `message_id` 连投两次 → 两条未读、两次唤醒（0.4.29 只给官方通道加了去重） | 去重提升为**全通道通用**（10 分钟 TTL、有界） |
| 2 | `sendToQQ` 失败时**返回 undefined 且不重试**（失败记在 `lastSendFailed`，由调用方收尾） | **钉住现状**，避免"失败被当成功"悄悄回归；是否自动重试留给上层 |

### 6 条测试

```
① 同一 message_id 连投两次：只入账一次（至少一次投递 + 幂等去重）
①-b 不同 message_id 不受影响（去重不能吃掉正常消息）
② 两群交错投递：prompt / 会话键 / 未读 / 回复目标都不串
③ DSH 未就绪时排队、恢复后照常投递（队列不丢）
④ 发送失败：不重复发送、失败不被吞成成功、可显式重试
⑤ 伪造系统标记仍作为用户数据，不新增可信系统段
⑥ 切换通道后，旧 epoch 任务在发送前被拦截（重试不能绕过 fencing）
```

### 语义声明（不吹 exactly-once）

本系统提供 **至少一次投递 + message_id 幂等去重**。
QQ 发送成功后、记录"已处理"之前崩溃仍可能重复回复一次 —— 外部副作用与本地状态无法原子提交，
这是固有限制，测试只保证"同一 message_id 不重复入账"。

### 顺带修的一个跨 realm bug

`epochGuard` 原来用 `error instanceof StaleEpochError` 判断，在 VM / 多模块实例下类身份不同会失效
（harness 里实测逃逸）。改成按 `error.code === 'STALE_EPOCH'` 判定 —— 这类判断本来就该跨 realm 安全。

### 质量门

审计 135/135；0.4.38 的 9 条基线、0.4.39 的 7 条 epoch 测试、store 9 条全绿。
## 2026-10-31 — 0.4.39：双轨 epoch（fencing token）+ 副作用边界守卫

> 只做 epoch / 所有权 / fencing，**不拆 bridge.js、不改 prompt 行为**。

### 状态结构（`state/channel-mode.json`）

```json
{ "schemaVersion": 1, "mode": "bridge", "pid": 24668,
  "epoch": 1, "status": "active", "at": 1793434238476, "note": "sidecar 通道" }
```

- `epoch` 是 **fencing token**：每次「重新取得所有权」+1；同一持有者**续期不 +1**
- 新文件 `state/channel-mode-epoch` 保存**只增不减的水位** —— 这样即使认领文件被删，
  epoch 也不会从 12 退回 1，旧任务永远无法「碰巧匹配」
- `release()` 不再删文件，改为写 `status: "released"`（保留 epoch，pid 清空）

### 原子更新与跨进程互斥

- 复用仓内唯一实现 `src/atomic-write.js`（唯一临时名 + EPERM/EBUSY 退避重试）
- 新增 `state/channel-mode.lock`：`wx` 创建；残留锁按 mtime（>5s）判定后抢占；最多重试 200ms
- `claim / heartbeat / release` 全部走 `withLock(read → 改 → 原子写)`，避免「读旧快照再递增」

### 副作用边界守卫（`channelStore.assertCurrent`）

| 位置 | 行为 |
| --- | --- |
| DSH 提交前 | 过期则**不提交**（返回 `{stale:true}`） |
| QQ 发送前 | 过期则**不发送**，并标记该 key 失败 |
| 记忆写入前 | 过期则**不写记忆** |

> 诚实说明：校验到副作用之间仍有**毫秒级竞态窗口**（一次读文件）。它不是原子操作，
> 只是把窗口从「整段处理」压到最小；真正的串行化靠「单通道持有」这个前提。

### 测试（7 条，全部通过）

```
① 旧 epoch 任务在模式切换后被拒绝
② 旧 epoch 任务不会提交 DSH 请求（次数=0）
③ 旧 epoch 任务不会发出 QQ 消息（次数=0）
④ 进程崩溃重启后，旧 epoch 不能重新有效
⑤ 并发认领：只有一个赢家，epoch 单调递增（4 个真实子进程）
⑥ 旧 epoch 任务不会写入记忆
⑦ 旧 epoch 任务不会执行工具
```

### 真机验证

```
通道模式：bridge（free，epoch 1）
当前状态: {"mode":"bridge","epoch":1,"status":"active","pid":24668}
✅ 当前 epoch 通过校验
✅ 旧 epoch 被拒: STALE_EPOCH
✅ 错误 mode 被拒: STALE_EPOCH
```

0.4.38 的 9 条行为基线仍全绿；审计 134/134。
## 2026-10-31 — 0.4.38：Characterization Test（3 条 P0 行为基线）

> 为后续「拆 bridge.js」「改 epoch」提供**可复用的行为边界**。
> 原则：只钉外部可观察的不变量，不钉 prompt 全文、不钉内部调用顺序 ——
> 测试若因重构而红就是写错了，只有行为真的变了才该红。

### 三条 P0（9 个断言）

| 组 | 断言 |
| --- | --- |
| **P0-1 群消息 → prompt** | ① 伪造的「【系统指令】」**不会制造新系统段**（身份/角色/令牌段计数不增）② 不同群上下文不串线 ③ 用户内容没被整体吞掉（防止把加固做成截断） |
| **P0-2 工具权限** | ① 非管理员不能消费审批（权限在副作用前生效）② 管理员可以消费 ③ **两层白名单必须覆盖插件暴露的全部 qqb_ \* 工具** |
| **P0-3 双轨互斥** | ① 活持有者不可被抢占 ② 死持有者可接管（重启不卡死）③ 释放后另一通道才能拿到 |

### 写测试时抓到 4 个「我以为的行为 ≠ 实际行为」

1. `store.claim` **不做**死 PID 接管 —— 接管在 `startBridgeChannelGuard` 里（我的断言打错层）
2. `store.release(mode, { pid })` 需要两个参数，只传 pid 是空操作
3. 审批消费要求 pending **挂在回复者所在会话键**上（不是全局）
4. `plugin/tools.js` 的工具名解析要用 `matchAll` 捕获组，`replace` 会把名字吃掉

这 4 条本身就是价值：说明「凭印象改代码」会踩什么。

### 用法

```bash
npm run test:characterization     # 单独跑
node scripts/test-audit.mjs       # 已挂进审计
```

审计 133/133。
## 2026-10-31 — 0.4.37：DSH 契约测试（`npm run test:contracts`）

> 对应外部评审第 6 条：**11 个 bug 里 4 个来自 DSH 静默升级**，而 DSH 没有公开契约。

### 做了什么

新增 `scripts/test-dsh-contracts.mjs`，把我们**真正依赖的 4 个接口**变成可执行断言：

```
settings.describe   形状（namespaces / writable）
sessions.create     接受 cwd、返回 sessionId
events.mux         能订阅；session.prompt 被接受；回合以 completed 结束
archiveSession     能归档临时会话
```

### 两个设计取舍

1. **连不上 DSH 就跳过**（exit 0）—— CI 里没有 DSH，不能因此变红
2. **不进 `test-audit`** —— 单独跑 `npm run test:contracts`，因为它会建临时会话（约 10~20 秒）

### 真机实测（DSH 63262）

```
ok   settings.describe 返回可解析对象
ok   sessions.create 接受 cwd 并返回 sessionId
ok   events.mux 可订阅 + session.prompt 被接受 + 回合能结束
ok   workspace.archiveSession 能归档临时会话

结果：全部通过
```

### 顺带

`package.json` 增加 `test:contracts` 与 `build:presets` 两个脚本，减少「命令靠记忆」。
## 2026-10-31 — 0.4.36：运行时指纹（version / commit / presetHash）

> 对应外部评审第 2 条：「运行时到底执行什么」。一天 32 个版本 + 三份 preset 副本，
> 出问题时**没法从日志判断跑的是哪套代码**。

### 现在有了什么

```json
GET /health
{
  "ok": true, "mode": "bridge", "version": "0.4.36",
  "commit": "929f29a7de1a",
  "preset": "qq-chat-v2",
  "presetHash": "bc836a15c8c9",
  "presetSource": "dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs"
}
```

启动横幅也打一行：

```
运行时指纹：version=0.4.36 commit=929f29a7de1a preset=qq-chat-v2@bc836a15c8c9
```

### 实现

- 新增 `src/build-info.js`：读 `.git/HEAD`（不打子进程）+ 算 preset 文件 sha256
  （放在 `src/` 而不是 `src/core/`，因为 core 有「禁止 IO import」的纯度守卫）
- `/health` 与启动日志都带上
- 新增 `scripts/test-build-info.mjs`（5 条，含「没有 .git 时降级不抛错」）
- 顺手修好 `docs/ROUTES.md` 漂移（`gen-route-index --write`）

### 为什么这条便宜又值钱

排查真机问题时，「你说的是哪个版本」从猜变成查：
commit 能定位代码、presetHash 能定位**实际加载的那份 preset**（正是 0.4.35 修的静默故障）。

审计 132/132。
## 2026-10-31 — 0.4.35：独立维护 + preset 单一真源（外部评审落地 ①②）

> 采纳外部评审里**成本最低、收益最高**的两条：宣布独立维护、preset 去掉多份权威源。

### ① 正式独立维护

- 新增 `docs/UPSTREAM-SECURITY-REGISTER.md`：职责边界 + 13 项补丁登记 + 每月审查节奏 + 移植规则
- README 顶部加「维护模式」声明
- 明确：**上游修了 ≠ 我们安全了**；移植即接手

### ② preset 单一真源（消除静默故障）

```
真源  plugins/qq-agent-presets/qq-tool-restrict.mjs
  │  node scripts/build-presets.mjs
  ├── dsh/agent-presets/qq-chat/qq-tool-restrict.mjs      ← DSH 实际加载
  └── dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs   ← DSH 实际加载
```

- 产物首行写入 `// source-sha256: <hash>`
- 新增 `scripts/check-preset-fresh.mjs`：校验**运行的那份 == 真源**，且两份产物正文一致
- 已挂进审计；反向测试有效（改真源不 build → 2 项 FAIL）
- `check-privacy` 对生成产物放行（首行哈希不是凭证）

审计 131/131。
## 2026-10-31 — 0.4.34：fork 现状与已知问题清单（供外部评审）

> 纯文档。把仓库的**结构性问题**写成一份可直接贴给外部 AI/评审的文件。

新增 `docs/reports/fork-issues-2026-10-31.md`：规模事实、9 个已知问题（按严重度）、已做过的缓解、
7 个希望外部回答的问题（分叉漂移 / 单文件 8743 行 / preset 三副本 / 双轨切换 / e2e 自动化 / 测试金字塔 / 文档过期）。

一句话结论：**功能够用，问题都在长期可维护性上。**
## 2026-10-31 — 0.4.33：上游 #131 差异审计 + 补上唯一真缺口（端口白名单）

> 代码改动很小，主要是把「我们和上游差在哪」查清楚并落成文档。

### 事实核对

| 说法 | 核实 |
| --- | --- |
| 上游 PR #131 已合并 | ✅ `f6242d6`（2026-10-30，31 文件 +2242/−126） |
| 上游没发新 Release | ✅ 最新仍是 v0.2.1-r1（10-22） |
| **我们的 fork 包含它** | ❌ **不包含**；我们领先 401 个提交、落后 92 个 |

### 逐项核对（#131 的安全批次）

9/10 我们都有等价实现（净化 / 令牌片段 / 不可信外壳 / 发送链 / 幂等 / 提问 owner 门 / 黑话隔离 / 人格卡 / DSH 端口自愈）。

**真正缺的只有两条**：

| 上游 | 内容 | 我们的处置 |
| --- | --- | --- |
| #85（一半） | 媒体抓取**端口白名单** | ✅ **本次补上** |
| #88 | agent 视角隐藏 QQ 号 | ❌ 不改，记为**已知权衡**（我们要让模型知道"@小鲸鱼"就是自己，否则会已读不回） |

### 本次代码改动：端口白名单

```js
export const SAFE_PORTS = [80, 443, 8080, 8443, 3000, 3001, 3100];
export function assertSafePort(url) { ... }
```

- 主入口校验 1 处
- **三处重定向重新校验**（30x 跳转不能绕过）
- 新增 `scripts/test-safe-fetch-ports.mjs`（6 条）+ 挂进审计

### 影响

| 项 | 结论 |
| --- | --- |
| Official 通道 | 上游这批**没碰** official 相关文件，不受影响 |
| 是否整体 merge 上游 | ❌ 不建议（401 vs 92，两边 `bridge.js` 已不可合并） |
| 后续 | 定向 backport；本次只取了唯一真缺口 |

文档：`docs/audits/upstream-delta-2026-10-31.md`
## 2026-10-31 — 0.4.32：官方通道移到分仓库开发，验证后一次性合并

> 纯文档。承接 0.4.30/0.4.31 的上锁。

### 决定

- 主仓库继续保持 🔒 上锁（不宣传、不承诺）
- 官方通道的后续开发与真机验证放到分仓库：<https://github.com/juju114514/qq-bridge-official>（public）
- **合并策略：一次性** —— 不在主仓库做零散提交，避免"改一半又锁回去"的反复

### 分仓库里有什么

```
src/qqbot-official.js        事件解析
src/official-transport.js    WS 传输 / 被动回复 seq / 媒体
src/official-media.js        图片/文件
src/official-proactive.js    定时播报 + 撤回
docs/audits/                 审计报告
docs/validation/official-e2e.md   e2e 验证清单（7 条，带证据栏）
```

> 这些是从主仓库提取的**副本**，依赖主仓库上下文，不是独立可运行项目；
> 最终以主仓库为准。

### 解锁流程（不变）

1. 分仓库 e2e 七条全绿（@ / 私聊 / 发图 / 白名单拒绝 / 身份 / owner / 去重）
2. 一次性合并回主仓库
3. 改 LOCK.md 为已解锁 + 发版本附证据
4. 归档分仓库

### 为什么分仓库

主仓库要维持「可发布、可验证」的口径；未验证的迭代放在独立仓库，
主仓库只接收验证过的**整体**变更 —— 这比"在主仓库里反复锁/解锁"干净得多。
## 2026-10-31 — 0.4.31：把「正在调试与维修 + 预计时间」写进仓库口径

> 承接 0.4.30 的上锁。锁要说明白：**不是坏了，是在收尾；期间建议等。**

### 加了什么

| 位置 | 现在写着 |
| --- | --- |
| `LOCK.md` 状态行 | 🔧 **调试与维修中** / 🧪 EXPERIMENTAL / 🔒 上锁，**预计 3~5 天内更新（2026-11-03 前）** |
| `LOCK.md` 新增「一·五」 | 时间窗表 + **期间你该做什么**（想用官方→等；已在用→风险自负；只用个人号→不受影响） |
| `README.md` 横幅 | 「正在调试与维修，预计 3~5 天内更新，期间建议先等一等」 |
| `config.example.json` | `_locked` 注记同样带时间窗 |
| `OFFICIAL-QQ.md` | 顶部提示带时间窗 |

### 「修好了」会怎么通知

1. LOCK.md 状态行改成 `✅ 已解锁`
2. 发一个版本，Release 里写明 **e2e 通过的四条证据**
3. README 顶部去掉 🔒 横幅

**三件事同时出现之前，请按「未验证」对待。**

### 守卫

`check-lock.mjs` 新增一条：上锁期必须出现「调试/维修 + 预计时间」，
README 与 LOCK.md 都要有。审计仍全绿。
## 2026-10-31 — 0.4.30：Official 通道上锁 + 免责声明（只锁仓库，不锁本地）

> 纯文档 + 一个守卫脚本。不改任何运行期行为。

### 背景

0.4.29 修完了官方通道审计的三个缺口（owner openid / 按通道身份 / message_id 去重），
但**还没有真机 e2e**。在验证之前，仓库不能声明它可用。

### 做法：仓库口径上锁

| 位置 | 做法 |
| --- | --- |
| `LOCK.md`（新增） | 锁定范围、原因、解锁条件、**免责声明**、"只锁仓库不锁本地"的边界 |
| `README.md` 顶部 | 🔒 横幅 + 指向 LOCK.md + 风险自负一行 |
| `config.example.json` | `official.enabled: false` + `_locked` 注记（措辞是"已实现未验证"，不是"不支持"） |
| `docs/guides/OFFICIAL-QQ.md` | 顶部提示 |
| `docs/audits/…audit.md` | 尾注「锁定状态」 |

### 守卫：`check-lock.mjs`（已挂进审计）

上锁期检查 5 条，解锁后反向检查 2 条（防止"说是解锁了但横幅没清"的自相矛盾）：

```
上锁期：状态行 / config.example / README 横幅 / 审计记录 / 免责声明在位
解锁后：README 不得再有 🔒 / official 段仍在
```

实测两个方向都有效（故意改成「已解锁」但不清理横幅 → 守卫报红）。

### 免责声明要点

- MIT「现状（AS IS）」提供，无任何担保
- 官方通道标 **EXPERIMENTAL（未验证）**，启用是使用者自主决定，**后果自负**
- 平台风险（封号）自负
- **不要把"上锁"理解成技术防护** —— 代码开源，我们无法也不打算阻止任何人启用
- 一句话：**问题已经提前说明，选择权在你，后果也在你。**

### 明确不做的事

- 不拆仓库（官方通道只有 ~30KB，拆开收益低于成本）
- 不加运行期开关（不会因为锁而让本地失效）
- 不删代码（随时可解）
## 2026-10-31 — 0.4.29：修 Official 通道的三个缺口（审计落地）

> 对应 `docs/audits/official-channel-audit-2026-10-31.md` 的缺口 1/2/3。

### 缺口 2（先修）：管理员在官方通道不再"永远不是 owner"

- 新增 `official.ownerOpenid`（openid，不是 QQ 号）
- `incoming-guards` 与拍一拍路径的 owner 判定同时支持：
  - 个人号：`event.user_id === cfg.ownerQQ`
  - 官方通道：`event.user_id`（`official-<openid>`）→ 去掉前缀后比对 `official.ownerOpenid`
- 顺带修掉 `&&` 链返回 `''` 导致 `isOwner` 不是布尔的历史隐患

### 缺口 1：官方通道有正确的自我身份

- `selfIdentityTextV2(isOfficial)`：官方通道用 `official.botName` + appid，**不再借用 SnowLuma 的个人号**
- 官方通道启动后写 `officialSelfName/officialSelfOpenid` 并打日志：
  `[official] 自我身份已设置：显示名「…」（官方通道无 QQ 号）`
- prompt 里的 @ 提示按通道区分（官方写 `@你`，个人号写 QQ 号）

### 缺口 3：官方入站按 `message_id` 去重

官方重连会重投同一 `msg_id`，而入站没有 seq 可用。新增 10 分钟 TTL 的有界去重表，
命中时打 `[official] 重复消息，跳过`。

### 测试

`test-incoming-guards.mjs` 新增两条：

- `openid 命中 official.ownerOpenid → isOwner=true`
- `不在名单 → isOwner=false`

审计 128/128，体积检查通过。
## 2026-10-31 — 0.4.28：Official 通道专项审计

> 纯文档版本（+ 索引）。回答一个问题：**官方通道到底是不是同一套系统？**

### 结论

**是同一套核心**，不是"只共用 DSH API 的两套系统"：

```
官方消息 → handleIncoming(kind, id, oneBotEvent)  ← 与 SnowLuma 同一个函数
        → convKey → socialV2 状态 → 会话/记忆/prompt/人设/黑话/控制台 全部共用
```

代码证据：`bridge.js` L9869 分派点、`official-transport.js` L38 `toOneBotEvent()`。

### 但有 3 个真实缺口

| # | 缺口 | 后果 |
| --- | --- | --- |
| 1 | prompt 的「你的身份」用的是 SnowLuma 的号（官方通道从不设置 `selfDisplayName/selfUserId`） | 模型拿错身份说话；只跑官方通道时身份行整段消失 |
| 2 | `ownerQQ` 是数字 QQ 号，官方 `user_id` 是 openid → 永不相等 | **管理员在官方通道没有任何管理能力**（审批/切角色/封闭模式全失效） |
| 3 | 官方入站 `msgSeq` 恒为 0，且没有按 `message_id` 去重 | 重连重投时**可能重复处理、重复回复** |

### 修复优先级

1. 官方通道写入正确身份（半天）
2. `official.ownerOpenid` → owner 判定支持 openid（半天）
3. 按 `message_id` 去重（2 小时）
4. 文档补「记忆键是 openid，与个人号是两份」（1 小时）

**上线前必须修 1 与 2。**

文档：`docs/audits/official-channel-audit-2026-10-31.md`## 2026-10-31 — 0.4.27：文档全面对齐（README / 升级 / AI 指南）

> 纯文档版本。把今天 25 个版本带来的东西补进所有入口文档。

### README

- 版本行 `v0.4.1` → **`v0.4.26`**（原来落后 25 个版本）
- 新增「**两条路：谁收 QQ，你自己选**」对照表 + `switch-mode` 命令
- 「出问题了先看哪」补：**2 秒熔断**、`plugin.log`、`tool-restrict.log`、token 同步脚本、守护脚本
- 「最近更新」补今天一整段（插件模式可用 + 安全修复 + 僵尸认领）
- 顶部导航加「想自己选谁收 QQ？」入口

### 升级指引（旧版本用户）

- `docs/UPGRADE.md` 新增「0.4.x」段：**没有破坏性变更，但 0.4.19 是安全修复，用过插件模式必须升**
- `docs/guides/UPGRADE-FROM-OLD.md`：配置项表补 `snowluma.homeDir` / `agentPreset` / 工具白名单；
  新增「0.4.x 的新东西（可选）」四条

### AI 指南

- `AGENTS.md` 新增「今天学到的四条硬规则」：安全先于功能、preset 三副本、`fetch failed` 要换成人话、僵尸认领两侧都要判
- `RULES.md` 硬边界一节补「落地位置」（preset + 插件 allowlist + 熔断）
- `docs/guides/INSTALL-SKILL.md` 补四条执行补充（pnpm 回退、装完自测、插件模式可选、工具边界必须验证）

### 全量检查

扫了全部 `docs/**/*.md` + 根目录 md，修掉 4 处过期示例：

| 文件 | 问题 | 修法 |
| --- | --- | --- |
| `BRANCHING.md` | 示例还用 `next/0.3.3` | 改成当前 `next/0.4.27` 并注明 0.3.3 是历史 |
| `RELEASE.md` | 示例 `v0.3.1→v0.3.2` 容易被当现状 | 顶部加「当前版本 v0.4.26，下面是示例」 |
| `README.md` | `git log v0.3.0..v0.3.1` 示例过期 | 换成 `v0.4.19..v0.4.26` |
| `QUICKSTART.md` | 完全没提插件模式 | 新增「A0. 已经在用 DSH？」一段（含安全提醒） |
## 2026-10-31 — 0.4.26：清理 preset 的旧 deny 名单（纯日志噪音）

> 小更新。0.4.21 之后白名单已经接管，旧黑名单只剩噪音。

### 之前

每次建 agent 都会先跑一遍 78 个必然失败的 `restrict({deny})`：

```
[qq-tool-restrict] restrict 失败 78/82：unknown global tool "pwsh"; known global tools: desktop_control, …
（3 秒后再重试一遍，再失败 77 个）
allow-restrict ok 保留=4/10：…
```

日志被两屏噪音盖住，真正的结论（保留了几个）反而看不见。

### 现在

顺序改成 **先白名单，失败才退回黑名单**：

```js
let allowApplied = false
try { ctx.tools.restrict({ allow: keep }); allowApplied = true } catch {}
if (!allowApplied) { /* 历史 deny 名单 + 3s 重试，作为兜底 */ }
ctx.tools.guard(...)      // 执行期白名单，始终生效
```

效果：正常路径只打一行 `allow-restrict ok 保留=N/M`；拿不到工具清单时才回退老逻辑。

### 验证（mock ctx）

```
allow 调用: 1  deny 调用: 0  guard: 1
保留: mcp__snowluma__qq_ping, todo_write
```
## 2026-10-31 — 0.4.25：self-test 连不上时给可操作提示

> 小更新。来自干净环境实测：只有 `fetch failed` 三个字，什么也说明不了。

### 之前

```
❌ 自测失败: fetch failed
```

### 现在

```
❌ 连不上 DSH：http://127.0.0.1:3999
   可能是：① DSH 没在跑  ② 端口变了（DSH 每次启动可能换端口）
   排查：
     · 看 config.json 的 dsh.baseUrl 是不是当前端口
     · 或直接指定：node src/self-test.js http://127.0.0.1:<端口>
     · 桥接在跑的话，它启动时会自动探测并写回正确端口
```

- 端口优先级：命令行参数 → `config.json` 的 `dsh.baseUrl` → 旧默认 3080
- 401 单独识别：提示检查 `dsh.authToken` 或跑 `setup-dsh.mjs`
- 其他错误仍然抛出（不掩盖真 bug）

### 实测

| 场景 | 结果 |
| --- | --- |
| 死端口 3999 | 给出上面的排查清单，exit 1 |
| 真机端口 63262 | `🎉 自测通过 —— DSH 侧链路可用`，agent 回复「收到」 |
## 2026-10-31 — 0.4.24：干净/脏环境实测发现的两个问题

> 小更新。用「全新克隆」和「现有部署」各跑了一遍，抓出两个只有真实环境才暴露的问题。

### 干净环境（git clone + pnpm install）

| 发现 | 处置 |
| --- | --- |
| `pnpm install` 会生成 `pnpm-lock.yaml`，而 packaging 守卫硬性要求"只能有一个锁文件" → **全新克隆直接红** | 守卫改成"必须有 package-lock.json，额外的 pnpm 锁只提示"；`.gitignore` 加 `pnpm-lock.yaml` |
| 全新 state 起服正常；DSH 端口自动漂移（3080 → 63262）也自动修好了 | 无需改动 |
| `self-test.js` 在桥接没跑时只报 `fetch failed` | 记入待办（提示可更友好） |

### 脏环境（现有部署重启）

| 发现 | 处置 |
| --- | --- |
| **僵尸认领**：旧进程被杀了，认领文件还在 60s 心跳窗口内 → 新 bridge 判"被另一个 bridge 占着" → **不连 QQ**，日志只有一行 warning | 桥接侧补上「按 pid 存活性接管」（插件侧早就有） |
| 快照一度报 2 处差异 | 是认领冲突导致 API 返回不完整；修好后 `行为一致 ✓` |

### 测试

`test-channel-mode-store.mjs`：「被占用」用真实存活 pid（`process.pid`）+
新增「死持有者接管」用例。9/9 通过。
## 2026-10-31 — 0.4.23：一天的工作纪要

> 纯文档版本。

新增 [docs/reports/2026-10-31-session.md](docs/reports/2026-10-31-session.md)：

- **11 个静默失败**的完整清单（症状 → 根因）
- **越权事故**的经过、后果、根因、处置（4 个版本的加固）
- **凭据轮换**记录（GitHub / TLS / console-token / SnowLuma）
- 两条路的切换方式、排障入口、遗留待办

一句话总结：**插件模式从设计推到群里能回话，代价是踩完 11 个静默坑 + 一次越权事故。**## 2026-10-31 — 0.4.22：`sync-snowluma-token` 的 token 语义修正

> 小更新。轮换 SnowLuma token 时发现的真机结论。

### 结论

`config.json` 里两个字段各管一条链路，**写反了不会报错，但会"连上却发不出消息"**：

| 字段 | 用途 |
| --- | --- |
| `snowluma.accessToken` | **WS 连接**（3001）——动作也走这条 |
| `snowluma.httpToken` | HTTP 调用（3000，发语音/取图/查状态） |

之前脚本把 HTTP token 写进了 `accessToken`，实测后果：

```
3001 连上了，但 send_group_msg 一律返回 unauthorized
```

### 修法

脚本拆成两处分别写，并新增 `snowluma.httpToken`。

### 附带

轮换流程也验证了一遍：改 SnowLuma 的 `config/onebot_<QQ>.json` 里两个 token → watchdog 自动重启 →
`node scripts/sync-snowluma-token.mjs` → 重启桥接。**不需要重新扫码登录 QQ。**
## 2026-10-31 — 0.4.21：桥接的工具限制改成「按真实工具名算的白名单」

> 安全加固。上一版的 deny 名单在 DSH 0.2.1 上几乎全失效。

### 现象（一直存在，没人注意到）

```
[qq-tool-restrict] restrict ok=4 failed=78
  unknown global tool "pwsh"; known global tools: desktop_control, desktop_sequence, …
```

名单是按 **DSH 0.1.7** 的工具名写的；现在实际工具叫 `desktop_control` / `desktop_sequence` 之类，
**78 个名字全部 unknown** → `restrict()` 全部静默失败。

真正兜底的只剩 `tools.guard()`（执行期白名单）——那是最后一道，schema 里工具仍在。

### 修法

在 restrict 之前，先枚举**当前真实存在**的工具名，只保留白名单内的，再用 `allow` 一次性限制：

```js
const schemas = ctx.tools.schemas()
const names = schemas.map(s => s?.name).filter(Boolean)
const keep = names.filter(n => SAFE_EXACT.has(n) || SAFE_PREFIXES.some(p => n.startsWith(p)))
if (keep.length < names.length) ctx.tools.restrict({ allow: keep })
```

- **不再依赖写死的名字**：新增/改名的工具默认被挡
- 拿不到工具清单时**退回原 deny + guard**，不静默失效
- 诊断写进 `state/tool-restrict.log`：`allow-restrict ok 保留=N/M：…`

### 验证方式

preset 的 apply 在**建 agent 时**才跑（≈第一条 QQ 消息到达时）。
消息来之后看 `state/tool-restrict.log` 有没有这行：

```
allow-restrict ok 保留=3/20：ask_user_question, todo_write, mcp__snowluma__qq_ping, …
```
## 2026-10-31 — 0.4.20：熔断开关 + 工具调用取证

> 小更新，来自那次越权事故的两条教训。

### ① 插件日志现在记工具名（取证缺口）

之前只有一行 `会话事件：tool/call`——**看不出调的是什么**。
真机事故里就是 `desktop_sequence` + `win+r` + `powershell`，日志里完全看不见。

现在：

```
工具调用：desktop_sequence [{"action":"key","key":"win+r"},{"action":"type","text":"powershell"}]
工具结果：{"ok":true,...}
```

### ② 熔断开关（2 秒生效，不用重启 DSH）

插件跑在 DSH 进程里，出事时"改配置 + 重启"太慢，也没有外部手段叫停正在跑的 agent。
新增文件开关：

```powershell
# 双击
熔断-停插件.bat
```

等价于写入 `state/plugin-kill`。插件每 2 秒轮询，一旦发现就：

- 断开 QQ 通道（`channel.close()`）
- 释放通道认领（`channelGuard.stop()`）
- 日志写 `🔴 已熔断`

恢复：双击 `恢复-插件.bat`（删标记）+ 重启 DSH。

### 为什么这样设计

- **不用重启**：DSH 重启要几十秒，熔断要秒级
- **不依赖 UI**：出事时你可能连界面都点不动
- **可审计**：熔断事件本身留在 plugin.log
## 2026-10-31 — 0.4.19：**安全修复** — 插件模式下群友可越权操作本机

> ⚠️ 这是安全修复，请尽快升级。

### 漏洞

插件模式早期版本建 agent 时**没挂 `agentPreset`**，于是 agent 拿到的是 DSH 默认工具集
（`pwsh` / `read` / `write` / `edit` / `subagent` …），**权限等于用户本人**。

群聊消息来自陌生人 —— 任何群友 @ 它一句，就能让它读写本机文件、执行命令。

真机已发生：群友要求"管理员级操作"，agent 照做。

### 为什么桥接模式没这个问题

桥接走 `qq-chat-v2` preset，里面有 `qq-tool-restrict`：

- 注册期 `tools.restrict()` 把本地工具从 schema 隐藏
- 执行期 `tools.guard()` 白名单兜底（`ask_user_question` / `todo_write` / `mcp__snowluma__*` / `mcp__web-search-safe__*`）

插件模式绕过了整条链路。

### 修法（两层，缺一不可）

| 层 | 位置 | 效果 |
| --- | --- | --- |
| 工具白名单（注册期） | 插件 `tools.restrict({ allow: [...] })` | 只留 `qqb_*` + `todo_write` + `ask_user_question`；本地工具不出现在 schema |
| 执行期 guard | `agentPreset: qq-chat-v2` | 越界调用直接拒绝 |

启用插件模式后必须确认 `plugin.log` 有这两行，否则不要交出通道：

```
已对 agent 应用工具白名单（10 个；本地工具全部不可见）
agent 已建：preset=qq-chat-v2 cwd=…
```

### 文档

- `README.md` 顶部加安全警告
- `docs/guides/PLUGIN-MODE.md` 新增「〇·一、安全边界（必读，先于一切）」
## 2026-10-31 — 0.4.18：插件模式没有人设（角色卡没挂上）

> 小更新。群里说话不像"小鲸鱼"，像通用助手。

### 现象

插件模式下它回话是这样的：

> 「不过有个情况得跟你说一声：我刚试着往 QQ 群里回话，结果报错……」
> 还带 Markdown 表格 `| 调用 | 返回 |`。

**没有人设卡，也没有 QQ 场景规则**（简短、不用 Markdown、只在被 @ 时说话）。

### 根因

桥接模式的人设来自 DSH 的 **agent preset**（`qq-chat-v2`：persona + 场景规则 + 工具面）。
插件建 agent 时只给了 `sessionId / meta.cwd / 模型`，**没给 `agentPreset`** ——

```js
meta: { chatKey, cwd }        // ← 少了 agentPreset
```

于是拿到的是 DSH 默认系统提示，与 QQ 聊天无关。

### 修法

```js
meta: { ..., agentPreset: config.agentPreset }   // 默认 'qq-chat-v2'
```

并新增配置项 `agentPreset`（可改 `qq-chat` / 自定义）。
建好后日志会打印实际生效的 preset：

```
agent 已建：preset=qq-chat-v2 cwd=…\state\agents\group_994920175
```

### 顺带

`mdToPlain` 的表格分隔符 `|` 换成 `·`：QQ 里 `a | b | c` 很难读。
## 2026-10-31 — 0.4.17：工具只回"最近 N 条"，把正文丢了

> 小更新。读消息类工具真机一测就露馅。

### 现象

```
qqb_get_recent_messages(group:994920175)  → "最近 9 条"
qqb_get_unread_messages(...)              → "9 条未读"
```

**有计数、没正文** —— 工具对模型等于没用。

### 根因

`OUTPUT.render` 只渲染了 `v.message`（那句摘要），把 `messages` 数组整个丢掉：

```js
const text = v.message;      // "最近 9 条"
return [{ type: 'text', text }];   // ← 数据没了
```

工具**执行**返回的是完整对象（`messages`、`handoff`、`role`、`wake` 都在），
只是 render（决定模型看到什么）把它们扔了。

### 修法

render 改成把数据也渲成文本：

```
最近 2 条
  #1 1599683156: 在吗？
  #2 我: 在的，我在。
```

同时补上 `handoff`（交接记忆）、`role`（角色卡字数）、`wake`（唤醒配置）、
`readThroughSeq`（已读水位）、`timeout`（等待超时）。

### 教训

工具要测**渲染结果**，不是只测 execute 的返回值——模型看到的是 render 的产物。
## 2026-10-31 — 0.4.16：插件模式在真机跑通（一次性修掉 10 个静默失败）

> 这是插件模式第一个**真能用的版本**：群里 @ 它 → 它回话。

### 里程碑

```
[qq-plugin] 入站投递 group:994920175 uid=…
[qq-plugin] 会话映射建立 session=qqbridge:group:… → group:994920175
[qq-plugin] agent 初始：status=running seq=6
[qq-plugin] 助手回复 → group:994920175（422 字，转纯文本 380 字）
[qq-plugin] 发送成功 group:994920175 message_id=…
```

### 10 个坑（全部"不报错、只是不动"）

| 环节 | 症状 | 根因 |
| --- | --- | --- |
| 工具注册 | `schema … got 'type': null` | `register()` 不编译，编译在 `defineTool()` |
| sidecar | 快照全 401 | token 空；`/health` 免鉴权所以看着正常 |
| 通道独占 | 一条消息回两次 | sidecar-only 仍建 WS 连接 |
| @ 判定 | @ 它没反应 | 事件无 `self_id` |
| 认领 | 重启后不连 | 僵尸认领未判 pid 存活 |
| 发送 | `client.action is not a function` | 方法名是 `call()` |
| 投递 | 会话建了没消息 | 新 agent 的 `whenIdle()` 永不 resolve |
| Agent | 无 turn、无报错 | 没给模型（`agentOptions:{}`） |
| Agent | 同上 | `meta` 缺 `cwd` |
| **Windows** | `mkdir …group:994920175: ENOENT` | **文件名不允许 `:`** |
| 转发 | 模型答了群里没有 | fallback session id 与监听 id 不一致 |

### 新增（可用性）

- 插件日志落盘 `<stateDir>/plugin.log`（512KB 轮转）——桌面版看不到 stdout
- 回复前 `mdToPlain()`：QQ 不渲染 Markdown，去掉围栏/反引号/粗体
- agent 创建时 `tools.restrict({ deny: [...] })` 禁掉所有发送类工具：文本走自动转发，避免模型先试工具白烧 30+ 步
- 只 @ 不带文字 → 当成一次"戳"（原来判 `empty` 丢掉）

### 文档

`docs/guides/PLUGIN-MODE.md` 新增「真机踩坑清单」：12 行症状→根因→修法对照表。## 2026-10-31 — 0.4.13：两条路都开放，一键切换

> 小更新。插件模式和原来的 bridge 模式**并存**，用户按需选。

### 为什么

插件模式能跑，但不是所有场景都合适（长期挂机还是独立进程更稳）。
之前切换要手改两个文件、还要记住重启顺序，容易出错。

### 新增

`scripts/switch-mode.mjs` + Windows 上两个 bat：

```powershell
node scripts/switch-mode.mjs status   # 看现在谁在收
node scripts/switch-mode.mjs bridge   # 路线 A：常驻 bridge
node scripts/switch-mode.mjs plugin   # 路线 B：DSH 插件
```

```
切换-桥接模式.bat
切换-插件模式.bat
```

脚本改两处：

| 文件 | 字段 | A | B |
| --- | --- | --- | --- |
| `config.json` | `channel.enabled` | `true` | `false` |
| `<DSH profile>/cordis.patch.yml`（`qq-bridge`） | `enabled` | `false` | `true` |

并打印**正确的重启顺序**：

- 切到 A：先重启 DSH（插件释放通道）→ 再重启 bridge
- 切到 B：先重启 bridge（让出通道）→ 再重启 DSH

### 文档

`docs/guides/PLUGIN-MODE.md` 开头加「两条路怎么选」对照表 + 「怎么切（一键）」；
顺手修掉重复的 `## 二·五` 标题。## 2026-10-31 — 0.4.12：插件里 @ 判定失效（事件没有 self_id）

> 小更新。真机第一次端到端发消息就踩到了。

### 现象

群里 `@小鲸鱼 在吗` → **完全没反应**，日志不报错，事件流也没有新记录。
但通道确实被插件认领了（`channel-mode.json` = plugin），3001 上也只有插件一条连接。

### 原因

SnowLuma 推送的消息事件里**没有 `self_id` 字段**。而插件是这么判定的：

```js
const r = gate(event, { selfId: event?.self_id });   // ← undefined
// inbound.js
const target = String(selfId ?? event?.self_id ?? '');  // → ''
if (!target) return false;                              // → 永远"没 @ 我"
```

结果 `requireMention: true` 下，**每一条群消息都被判成 no-mention 丢掉**。
桥接没这个问题，因为它在启动时调 `get_login_info` 拿到了自己的 QQ 号。

### 修法

通道启动后主动问一次网关：

```js
const info = await channel.call('get_login_info', {});
state.selfId = String(info?.data?.user_id ?? '');
// 之后
gate(event, { selfId: state.selfId ?? event?.self_id });
```

取不到时会打一行警告（`@` 判定可能失效），而不是静默失败。

### 教训

`requireMention` 这类"静默丢弃"的判定，失败时不报错 —— 只能靠**真实发一条消息**才能发现。## 2026-10-31 — 0.4.11：sidecar-only 时**真的**不连网关（否则两边各收一份）

> 小更新。真机实测发现：日志写着"让出通道"，实际却还连着 3001。

### 现象

```
[bridge] sidecar-only 模式（channel.enabled=false）：不连接 QQ 网关，也不占用通道认领
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001      ← 说好的不连呢
```

`Get-NetTCPConnection -RemotePort 3001` 能看到**两条**：DSH 插件一条 + bridge 一条。
后果是**同一条群消息被消费两次**，插件和桥接可能各回一句。

### 修法（两层兜底）

```js
if (!channelModeClaimed) {
  bot.reconnect = false;          // 禁自动重连
  bot.connect = async () => {};   // 把 connect 变成空操作（真机第二次踩到：close 之后仍有连接建立）
  bot.close(1000, 'sidecar-only');
  log('已断开 SnowLuma 连接并禁用重连（本实例只作 sidecar）');
}
```

同时自愈路径里的重连也受 `bot.reconnect !== false` 约束。

### 验证

```
3001 连接: DeepSeek Harness.exe(12708)      ← 只剩插件
bridge 日志: sidecar-only 模式 … / 已断开 SnowLuma 连接并禁用重连
```

### 顺带

`src/bridge.js` 体积基线更新（本轮 N3 通道闸 + sidecar 兜底，增量 59 行、真实无法再拆）。## 2026-10-31 — 0.4.10：插件自动读 sidecar console-token（原来全 401）

> 小更新。真机测试暴露的问题：工具通了，但**读快照一律 401**。

### 现象

```
qqb_get_prompt → { "ok": false, "status": 401, "error": "unauthorized" }
```

### 原因

sidecar 的 `/snapshot`、`/events`、`/intents` 都要 Bearer token，
而插件配置里 `sidecarToken: ""` 意味着**不带 Authorization** → 401。

之前"能用"只是因为在同一台机器上、且我们只测了 `/health`（免鉴权）。

### 修法

`sidecarToken` 为空时，自动读 `<stateDir>/console-token`：

```js
let sidecarToken = config.sidecarToken;
if (!sidecarToken) {
  const f = path.join(config.stateDir, 'console-token');
  if (fs.existsSync(f)) sidecarToken = fs.readFileSync(f, 'utf8').trim();
}
```

同机部署下开箱即用；跨机部署显式配 `sidecarToken` 即可。

### 验证（真机 group:631539503）

```
role: xiaojingyu   角色卡 9012 字
wake: diving / infinite / 关键词 11 个 / probability 0.05
recent: 0 条（沉睡中）
```

之前 401，现在 200 且有真实数据。## 2026-10-31 — 0.4.9：真正的根因 —— 工具没经过 `defineTool()` 编译

> 小更新，修的是"改名也没用"的那个 schema 错。

### 现象

```
Invalid schema for function 'qqb_get_prompt':
schema must be a JSON Schema of type: 'object', got 'type: null'
```

改名之后**还是同样的错**，说明名字不是原因。

### 根因

宿主 `ctx.tools.register()` **不做 schema 编译**，它只校验 `output`。
编译发生在 `defineTool()` 里：

```js
// @deepseek-ai/dsh-tools
function defineTool(options) {
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters);  // ← 这里才补上 type: 'object'
  ...
}
```

而我们一直把**裸对象**（`{ chat_id: { type:'string', required:true } }`）直接丢给 `register()`，
于是供应商收到的函数 schema 是 `{ chat_id: {...} }` —— 没有 `type`，被读成 `type: null`。

**这解释了为什么 0.4.5（撞名跳过）和 0.4.7（改名）都没治本。**

### 修法

`plugin/index.js` 顶层动态取 `defineTool`，注册前包一层：

```js
let defineToolImpl = null;
try { ({ defineTool: defineToolImpl } = await import('@deepseek-ai/dsh-tools')); } catch {}

// registerTool 里
ctx.tools.register(defineToolImpl ? defineToolImpl(tool) : tool);
```

- 取不到（离线测试）就退回裸对象，不影响挂载
- 实测编译结果：`parameters.type = "object"`，`required: ["chat_id"]` 正常

### 守卫

`test-plugin-mount.mjs` 增加一条：`index.js` 必须同时出现 `defineToolImpl ? defineToolImpl(tool)` 与
`import('@deepseek-ai/dsh-tools')` —— 防止以后又把裸对象直接注册。## 2026-10-31 — 0.4.8：`sync-snowluma-token.mjs`（HTTP/WS token 别手改）

> 小更新。加一个脚本，避免"手改 token 改错那一个"。

SnowLuma 的 **HTTP token 与 WS token 是两个不同的值**，重新扫码后都会变：

| 位置 | 字段 | 用哪个 |
| --- | --- | --- |
| `config.json` | `snowluma.accessToken` | **HTTP**（桥接的 API 调用） |
| DSH profile 的 `cordis.patch.yml`（`qq-bridge` 条目） | `accessToken` | **WS**（插件连 3001） |

```powershell
node scripts/sync-snowluma-token.mjs --dry   # 先看会改什么（token 默认打码）
node scripts/sync-snowluma-token.mjs         # 真改
```

- 自动从 SnowLuma 的 `config/onebot_<QQ>.json` 读两个 token
- 多账号时用 `config.json` 的 `selfQQ` 固定；没配会告警并取第一个
- 只在必要时写文件；改完提示要重启 DSH（插件启动时加载）## 2026-10-31 — 0.4.7：插件工具改名 `qqb_*`，彻底避开 MCP 同名

> 小更新。修的是桌面版"每一轮都报 schema 错"的根因。

### 之前为什么没修好

0.4.5 加的「同名就跳过」依赖 `ctx.tools.get(name)` 能看见 MCP 注册的工具。
真机上它**看不见**（MCP 工具在另一层），于是插件照样注册了 `qq_get_prompt`，
冲突还在 → 供应商侧 schema 仍是 `type: null`。

### 现在

插件工具统一加 `qqb_` 前缀：

| 旧名 | 新名 |
| --- | --- |
| `qq_ping` | `qqb_ping` |
| `qq_send_message` | `qqb_send_message` |
| `qq_reply` | `qqb_reply` |
| `qq_get_prompt` | `qqb_get_prompt` |
| `qq_mark_read` | `qqb_mark_read` |
| `qq_get_recent_messages` | `qqb_get_recent_messages` |
| `qq_get_unread_messages` | `qqb_get_unread_messages` |
| `qq_wait_for_messages` | `qqb_wait_for_messages` |

- **MCP 的 `qq_*` 工具一个没动**，两边可以并存
- 撞名跳过逻辑保留（对那些真的能看见的同名工具仍然有效）
- 名字变化不影响功能：参数、返回、降级语义都没变## 2026-10-31 — 0.4.6：提交到 awesome-dsh-plugin 的收录草稿

> 纯文档版本。

新增 [docs/guides/AWESOME-SUBMISSION.md](docs/guides/AWESOME-SUBMISSION.md)：

- **条目 YAML**（可直接放进 `data/plugins/juju114514__qq-bridge.yml`）
- **门槛逐条核对**：`dsh.bundle` ✅、仓库 5 天 ✅、未归档 ✅、不是 DSH 本身 ✅、单 PR 单条目 ✅
- **为什么用 `tree/main/plugin` 这种 URL**：市场会把子目录 URL 拼成
  `github:<owner>/<repo>#path:/<subdir>`，那才是能真正装上的形式；
  而直接 `pnpm add .../tree/main/plugin` 会**忽略子目录**、装成仓库根（桥接应用本身）

清单现状（实测）：7,924 条，其中 41 条与 QQ 相关；我们不在其中。## 2026-10-31 — 0.4.5：同名工具冲突（真机整轮失败）

> 小更新，修的是"插件装上之后每一轮都报错"。

### 现象

```
本轮运行失败 Invalid schema for function 'qq_get_prompt':
schema must be a JSON Schema of type: 'object', got 'type: null'
```

### 原因

桌面版同时还挂着 `mcp-snowluma`，它也有 `qq_get_prompt` 等 45 个工具。
**同名工具并存**时，供应商侧拿到的那个函数 schema 变成 `type: null`，整轮直接失败。

我们自己的 schema 是合法的（已用宿主同版本的 `dsh-tools` 实测编译，`type: 'object'` 正常）。

### 修法

注册前先查 `ctx.tools.get(name)`：

- 已存在 → **跳过**并记一行日志（该功能走 MCP 那份）
- 不存在 → 正常注册

冲突时插件仍然提供那些**不撞名**的工具（如 `qq_ping`），不会整段失效。

### 说明

这条只在"插件 + MCP 同时挂"的环境出现（桌面版就是）。纯净插件环境不会触发。## 2026-10-31 — 0.4.4：插件自包含 + 可以直接从仓库安装

> 小更新。让"填个地址就能装"成立。

### 三个改动

| 改动 | 为什么 |
| --- | --- |
| `plugin/vendor/` 打进 9 个依赖模块（onebot-ws + 通道闸） | 之前插件用 `../src/...`，单独安装后找不到文件——装得上、跑不起来 |
| DSH 相关 peer 标 `optional` | 它们不在公共 npm 上；不标的话从 git 安装会去 npm 拉，直接失败 |
| 移除仓库根的 `postinstall` | pnpm 会因此报 `ERR_PNPM_IGNORED_BUILDS`，**git 方式安装被拦** |

### 现在三种安装方式

| 方式 | 填什么 | 说明 |
| --- | --- | --- |
| 本地路径（推荐） | `<仓库>\plugin` | 最稳 |
| GitHub 子目录 | `github:juju114514/qq-bridge#main&path:/plugin` | 实测 `pnpm` 直接成功 |
| npm 包名 | ❌ 404 | 插件是 `private`，未发布 |

### 守卫

新增 `scripts/check-plugin-vendor-fresh.mjs`：vendor 副本必须与 `src/` 源头**逐字节一致**，
并检查插件里没有跨包相对导入——防止"装走之后用的是旧逻辑"。## 2026-10-31 — 0.4.3：插件模式真机跑通（三个必需项）

> 小更新。修的是"插件装上了但连不上 QQ"这类只在真机上出现的问题。

### 三个修复

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| 插件 `inject` 少了 `agents` | 报 `cannot get property "agents" without inject`，通道启动直接失败 | `inject = ['tools', 'agents']` |
| 挂载时探 sidecar 只给 1.5s | 宿主启动忙 → 明明开着却报「sidecar 未连接」 | 超时改 5s，并把失败原因打进日志 |
| 认领文件写到了相对路径 | `stateDir` 默认 `./state`，cwd 不是 sidecar 的 state → **通道互斥形同虚设** | 新增 `stateDir` 配置项；文档写明必须与 sidecar 一致 |

### 真机验证（隔离 DSH_HOME，未碰桌面版）

```
[qq-plugin] 通道模式：plugin（free）
[qq-plugin] OneBot 已连接：ws://127.0.0.1:3001
[qq-plugin] QQ 通道已启动
[qq-plugin] 已挂载；sidecar 在线（mode=bridge）
```

`state/channel-mode.json` 显示 `mode: plugin`，sidecar 处于 sidecar-only。

### 文档

`docs/guides/PLUGIN-MODE.md` 增加「三个真机才会暴露的必需项」：
`accessToken` 要用 **WS** token、`stateDir` 必须与 sidecar 一致、`inject` 要含 `agents`；
另加一条：杀进程后 60 秒内重启会被心跳 TTL 拒绝，删 `channel-mode.json` 即可。## 2026-10-31 — 0.4.2：升级指南（给还在用 0.2.x / 0.3.x 的人）

> 纯文档版本，没有代码改动。

新增 [docs/guides/UPGRADE-FROM-OLD.md](docs/guides/UPGRADE-FROM-OLD.md)：

- **30 秒版**：备份 → 拉代码 → `npm install` → `restart.bat` → `自检.bat`
- **配置项对照表**：0.3.1 的 `notifyAgentErrors` / `roleInjectEvery`、0.4.1 的 `channel.enabled`，
  标明"默认值都等于旧行为，一个都不改也能跑"
- **行为变化**：角色卡改 `isOwner`、`consolePort` 启动校验、`/api/voice/send` 修复、通道认领
- **从 0.2.x 上来要额外做的**：Node ≥22.13、DSH ≥0.2.1-rc.2、preset 名 `qq-chat-v2`、跑一次 `setup-dsh.mjs`
- **state 兼容性**：只增不改；新增 `state/memory/`、`channel-mode.json`、`plugin-events.jsonl`
- **回滚方法**：换回旧代码 + `state.bak-*` 覆盖回去
- **升级后自查清单** 5 条

README 顶部与 docs 索引都加了入口。## 2026-10-31 — 0.4.1：`channel.enabled` —— 让 sidecar 把通道让给插件

> 小更新（+0.0.1）。默认行为不变（`channel.enabled` 默认 `true`，照常连网关）。

### 解决什么问题

0.4.0 的插件模式发布后有个卡点：**插件和常驻 bridge 只能有一个收消息**，
但 bridge 没有"我不收消息、只当 sidecar"的开关 —— 想试插件就得把 bridge 整个关掉，
而那意味着记忆、记账、控制台全都没了。

### 现在怎么做

```jsonc
// sidecar 机器上的 config.json
{ "channel": { "enabled": false } }
```

启动日志：

```
[bridge] sidecar-only 模式（channel.enabled=false）：不连接 QQ 网关，也不占用通道认领
```

- 控制台、sidecar 契约、定时器**全部照常**
- `state/channel-mode.json` 不再生成 → 插件可以拿到通道（`claim(plugin) → ok=true`）
- 想切回：改回 `true` 并重启

### 验证

- 真机实测：sidecar-only 启动后 `channel-mode.json` 不存在，插件侧 `claim` 成功（`reason=free`）；
  改回 `true` 后 bridge 重新认领（`reason=free`）
- 审计 127/127## 2026-10-31 — 0.4.0：qq-bridge 可以装进 DSH 了（插件模式）+ 群记忆交接

> 这一版是**新增形态**，不是替换：`start.bat` 的常驻模式完全没变，行为一致。
> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。无破坏性变更。

### 新形态：插件模式

- 插件装进 DSH（`plugin add`），**消息通路跟宿主同生命周期**，不用再单独守护一个通道进程
- 工具从 MCP 改成**进程内注册**：少一跳、少一个进程
- 已提供 8 个工具：发消息 / 引用回复 / 最近记录 / 未读 / 等新消息 / 提示词快照 / 标记已读 / 自检
- **默认 `enabled: false`**：装上不等于连 QQ，必须显式打开

### 群记忆交接（§〇）

- 每个会话一份 `state/memory/<key>.md`，`## §〇 交接` 覆盖写，**≤4 KB**
- 四个固定子项：上次聊到哪 / 当前话题 / 记忆变更 / 下一步想聊
- 解决"换模型、重启之后像失忆"：**记忆在文件里，不在会话里**

### sidecar 契约

- `GET /health`、`GET /snapshot?key=`（带 ETag）、`POST /events`、`POST /intents`
- 插件只读快照、只发意图；`state/` 仍由常驻进程单写

### 通道互斥（安全）

- `state/channel-mode.json` 带心跳认领：同一份 `state/` **只允许一个东西收 QQ 消息**
- bridge 被占用时**不连网关**（控制台与工具照常），日志直说要先停插件
- 心跳过期（崩溃残留）可被新实例抢占

### 验证

- 审计 126 个脚本全绿（新增 8 个插件相关测试）
- 一致性闸：入站判定（会话 key / 文本抽取 / 白名单 / @ / 去重 / 自己发的）在两种形态下一致
- 真机：`/health`、`/snapshot`（ETag 304）、`/intents`（交接落盘）、通道认领冲突全部实测

### 已知限制

- 表情包 / 语音类工具还在 MCP 侧，插件模式暂未覆盖（下一版）
- 插件模式下**主动消息 / 定时提醒 / 控制台需要 sidecar 在跑**；不开只有被动回复
## 2026-10-31 — 0.3.2：新手开箱（零基础指南 / 自检.bat / 占位截图）+ 角色卡按节奏注入

> 无破坏性变更。新增 1 个配置项 `socialV2.roleInjectEvery`（默认 `1` = 行为不变）。

### 新手开箱

- **零基础八步指南** `docs/guides/BEGINNER.md`：从空电脑到「她在群里回话」，
  每步都写「做什么 / 应该看到什么 / 没看到怎么办」+ 卡点速查表 + 术语小抄
- **`自检.bat`**：双击就能跑环境体检（12 项），末尾 `pause` 不闪退，按退出码给结论
- 第 5 步拆成 6 个带**截图位**的子步骤；`assets/beginner/` 已放入占位图（覆盖同名文件即可换真图）
- README 顶部与「什么都没有」两条路径都指向零基础指南

### 省 token：角色卡按节奏注入

- `socialV2.roleInjectEvery`（默认 `1` = 每轮全量，行为不变）
- 设成 `8`：首次/换卡全量，其后每 8 轮一次 —— 实测提示词 **33,473 → 10,282 字节**
  （≈15K → 4.7K tokens），**每轮省约 10K**
- 只影响提示词，不影响服务端权限判定；脏配置（0/负数/字符串）一律退化成每轮全量

### 验证

- **干净克隆**（新文件夹、无 node_modules/config/state）→ 审计全绿、文档链接全通
- 顺带修掉 4 处「本地没事、仓库读者会撞」的文档漂移：
  体检项数写错（16→12）、体检提示没指向新手文档、README 表格串行、README 缺新手入口

### 已知未做

- `scripts/first-run.ps1 -DryRun` 在全新克隆里 exit=1（体检 FAIL: 无 config.json），
  对新手有误导；下次改成 0/2 并加说明
## 2026-10-31 — 0.3.1：波次 4 收官（bridge.js 11.2k → 10.0k）+ 三条外部模型路线验证

> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。**没有破坏性变更**；
> 新增 1 个配置项（`socialV2.notifyAgentErrors`），其余行为不变。

### 用户能感知的变化

- **回复更快、更稳**：`bridge.js` 从 11,236 行降到 **10,050**，内联路由从 41 条降到 **1 条** ——
  以后加接口只能写进 `src/api/*.js` 并接进派发链（有棘轮守着，不会再长回去）。
- **技术报错不再刷屏**：新增 `socialV2.notifyAgentErrors`（默认 `true`）。
  换成第三方模型时 `No API key` / `context overflow` 这类消息不再推到 QQ，只进日志。
- **换模型不再静默失败**：非 DeepSeek 的 provider（如千问、Bedrock）若模型不支持"思考强度"，
  桥接会自动去掉该字段重试一次，并在日志里写明原因 —— 以前是失败两次然后**静默退回默认模型**。
- **`/api/voice/send` 修好了**：这个操作者通道此前一直是 500（三个依赖没注入），现在能正常发语音。
- **角色卡可以"按节奏注入"**：新增 `socialV2.roleInjectEvery`（默认 `1` = 每轮全量，行为不变）。
  设成 `8` 之后：首次/换卡全量，其后每 8 轮一次 —— 实测提示词从 **33,473 → 10,282 字节**
  （≈15K → 4.7K tokens），**每轮省约 10K tokens**。只影响提示词，不影响权限判定。

### 修复

- **角色卡不再写死管理员 QQ**：改用 `isOwner` 标记（号码由服务端校验）。
  之前隐私脱敏把号码换成了占位值，导致机器人**不认老板** —— 这是一次真实的回退。
- **`consolePort` 现在会校验**：写成 `"abc"` / `99999` 会在启动时直接报错并说清范围，
  以前是 `listen EACCES` 之后控制台静默打不开。
- **干净克隆 113 → 116 个测试套全绿**（新增：`check-privacy` / `test-config-dirty` /
  `test-model-effort-fallback`）。

### 外部模型路线（实测记录）

| 路线 | 文本 | 工具调用 |
| --- | --- | --- |
| DeepSeek（默认） | ✅ | ✅ |
| 千问 `qwen-max` | ✅ | ✅ |
| 千问 `qwen-flash` / `qwen-plus` | ✅ | ❌ 工具参数传错 |
| 暴喵网关（实际是小米 MiMo） | ✅ | ✅ 但窗口小、常空收尾 |

细节见 [docs/guides/GPT-ROUTE-STATUS.md](docs/guides/GPT-ROUTE-STATUS.md)。
**生产配置仍是 `deepseek-official / deepseek-flash`。**

### 踩过的坑（写下来免得再踩）

- 按**缩进**切代码 → 误删了相邻的 `/api/security` 整块；必须按大括号配平 + 复核 diff。
- 按**命令行**过滤进程 → 误杀了真机；要按端口归属（3100 真机 / 3199 沙箱）。
- 自定义 provider 不写 `contextWindow` → 一上来就 `context overflow`。
- 中转站先问一句"你是哪个模型"再付钱。
## 2026-10-30 — 0.3.0：拆到 10.7k 行 + 三件新功能 + 十个测试护栏

> 升级方式见 [docs/UPGRADE.md](docs/UPGRADE.md)。这一版**没有破坏性变更**，
> 但新增了几个配置项与一次自动生成的 `state/people.json`，升级后建议跑一次 `/自检`。

### 新功能（用户能感知）

- **`/自检`（管理员）**：一条指令看清 网关 / DSH / 队列 / 会话表 / 数据量 / 最近错误 /
  **网关重连次数** / **抖音 cookies 剩余**。命令由桥接直接执行、不经过模型，零 token。
- **抖音轻量档**：`qq_open_video(mode="meta")` 与"消息里出现抖音链接自动附元数据"——
  只取 作者/标题/文案/封面，**不下载视频**（下载才是风控高危动作），同会话 10 秒冷却。
  可用 `socialV2.media.video.links.autoMeta=false` 关掉自动附加。
- **静默时段**：`socialV2.quietHours = [23, 8]`，夜里不主动搭话；消息照常记录，
  `admin` / `bootstrap` 不受限。默认关闭。
- **人物库**（`src/people.js`）：身份只认 QQ 号（改群名片不再断成两个人），
  关系升档要求"消息数 + 活跃天数"同时达标（一天刷 500 条也不算熟人）。
  首次启动会按白名单群存量成员标 `listed`，不会把老群友当新人欢迎。
- **命令清单进提示词**：模型不再答"我没有自检功能"，被问起会直接告诉你发什么命令。

- **`/诊断`（管理员）**：回答"这条消息为什么没回我"。桥接记下每条消息的决策链
  （闸门 → 暂停 → 唤醒命中/未命中 → 投递），环形缓冲 80 条、只记截断文本。
  `/诊断` 看本会话最近 8 条，`/诊断 全部` 看全局，`/诊断 #12` 查单条。
- **`qq_people_note` 工具**：模型终于能"记事"和"纠错"——以前人物库只读，
  记错只能 `/reset` 全清。`op=add/list/clear`，作用域可到群或全局；
  档位太低（陌生人/仅名单）时笔记暂不注入，`list` 会明确告诉你有几条被隐藏。

### 重构（bridge.js 11,236 → 10,728 行，−4.5%）

一晚十刀，每刀一个模块一提交、都能单独回滚：
`console-dsh` / `socialV2-video` / `console-ops` / `incoming-commands` /
`incoming-status-commands` / `session-registry` / `session-reset` / `incoming-guards` /
`preset-sim` / `workspace-reset` / `group-members` / `slang-submit` / `mux-learner` / `mux-tools`。

### 按公开 issue 核对后的修复（2026-10-30 收尾）

拿上游公开 issue 清单逐条对照**当前代码**核，不照抄结论。结果：#110 / #114 / #115 成立并已修；
#112 在本仓库不复现；#80 / #109 / #111 仍待验证（见下）。

**已修复**

- **DSH 凭据读取恢复（#110）**：不再把一次瞬时读取失败永久缓存成"匿名可用"。
  成功值才缓存；失败按 2s / 4s / 8s…（上限 30s）退避重试。
  以前 DSH 还没写出 `.credentials.yaml` 时，一次失败就要重启进程才能恢复。
- **限频重试定时器（#114）**：真正开始一次新的唤醒时清掉仍在排队的限频重试定时器。
  否则它到点会**再起一个回合**（重复调模型、可能重复回复）。
- **令牌日志脱敏（#115）**：移除 4 处令牌片段日志（控制台令牌前 6 位、
  SnowLuma WS / HTTP 令牌前 4 位、连接探测结果前 4 位）。现在只说明"已生成 / 已更新"。

**验证**

| 项 | 结果 |
| --- | --- |
| 审计套件 | **88/88** 通过 |
| 干净克隆 | `git clone` → **85/88**（3 个失败的含义见下，不是"全过"） |
| 重启后运行状态 | 已验证（SnowLuma / DSH / 官方通道全就绪，日志无令牌片段） |
| 黄金快照 | 一致（`snapshot-prompt.mjs --diff 2026-10-29T17-13-36`） |

**仍待验证（不要当成已解决）**

- **#80 / #79 提示词注入**：目前只有部分防线（`slang-learner` 对群聊文本做标签转义与控制字符剔除；
  工具守卫拒绝未知工具）。**主聊天提示词的段落伪造边界尚未系统验证**，列为下一轮 P0。
- **#109 mark_read 水位语义**：`pendingWakeKeys` / `unread` / `markReadCalledKeys` 三者的
  "已收到"与"已处理"语义尚未统一验证，需要专门一轮追踪，不做猜测式修改。
- **#111 Clash TUN / fake-ip**：需要在真实代理环境复现；**不得以修复兼容性为由削弱 SSRF 防护**。
- **#112 干净克隆 ENOENT**：本仓库 `docs/guides/VOICE.md` 已纳入版本控制，不复现。

### 已知不稳定项（如实记录）

`scripts/test-reply-wait.mjs` **偶发失败**：单独跑 10/10 通过，全量审计时偶尔红一次
（本轮 3 次全量里红 1 次）。原因是它依赖真实的静默窗口计时，机器负载高时会被挤压。
**这不是功能回归**，但会让人误判。下一轮处理方向：
要么把窗口改成可注入的假时钟，要么在审计里给它单独的重跑一次。

### 文档一致性修复（2026-10-30 夜间）

一次完整的文档复核抓到 5 类问题，全部已修：

| 问题 | 修法 |
| --- | --- |
| TROUBLESHOOTING 有两个 `S` 节、`R` 跑到 `S` 后面 | 官方通道排错整段搬到 [OFFICIAL-QQ.md 第九节](docs/guides/OFFICIAL-QQ.md)，原文只留指针；`R` 回到 `Q` 之后 |
| 目录漏列官方通道 | 目录补一行，直接跳 OFFICIAL-QQ 第九节 |
| 审计套数三个数字（43 / 69 / 73→78） | 统一为 **88**，并写明"以脚本输出为准" |
| bridge.js 行数三种说法（10,940 / 约 1.2 万 / 11,236→10,940） | 统一为 **约 1.1 万（当前 10,771，以 wc -l 为准）** |
| 真机器人号 / 群友昵称 / 群 openid 未脱敏 | 全部替换为 `<你的机器人QQ号>` / `<群友昵称>` / `official-<openid>` |
| OFFICIAL-QQ 第六节标题写"下一步"、状态表写"已接入" | 改为「接入设计（已落地）」+ 每行标 ✅ |
| ttl=86400 的结论容易被误读成"依赖 86400" | 补一句"不要用 ttl 做任何超时/缓存决策" |
| 端口示例数字会被误当固定值 | 三处改为 `<旧端口>` / `<新端口>` 并注明每次启动不同 |
| 作者本机代理写死 | 标注"作者本机，按需替换" |

另：TROUBLESHOOTING 顶部新增**症状 → 节号**索引表（19 行），AI 和人都不用读全文。

### 干净克隆实测（2026-10-30 收尾，如实记录）

在 `git clone` 出来的目录里跑审计：**85/88**。三个失败的归因：

| 脚本 | 原因 | 是否代码缺陷 |
| --- | --- | --- |
| `test-qq-model-view.mjs` | 依赖复制不全（缺 `zod-to-json-schema` 等传递依赖；本机无 npm 可装） | 否（环境） |
| `test-qq-mode-plugin.mjs` | 同上（缺 `@deepseek-ai/cosmokit`） | 否（环境） |
| **`test-first-run.mjs`** | **它直接读仓库根目录的 `config.json`，而该文件被 gitignore** | **是** |

最后一条是本轮新发现，与 #112 同源：**审计脚本不应假设本地状态文件存在**。
修法（下一轮）：让该脚本自己写一份临时 `config.json` 到沙箱目录再跑，
而不是读工作区里那份。**在此之前，不要把"干净克隆全绿"写进任何发布说明。**

> 本次验证的局限：本机打包环境没有 npm，`node_modules` 是从开发目录复制的，
> 所以**没有覆盖"全新安装（npm ci）"这条路**。

### 修复（都是"线上会静默坏掉"的那类）

| 现象 | 根因 |
| --- | --- |
| 机器人在线但**一条消息都不回** | 拆分后漏 import（`node --check` 查不出、VM 审计按名注入还掩盖） |
| 私聊全部 `cfg is not defined` | 把 `main` 的局部变量写进 `main` 之外的函数 |
| `/like` `/song` 报 `cmdText is not defined` | 半截搬迁：搬走定义、留下用法 |
| 控制台启动即炸 | TDZ（引用了后文 `const`），改惰性创建 |
| 抖音解析第一次就"冷却 9 秒" | cooldown 把"没有记录"当成"上次在 0 时刻" |
| `/status` 一按就 ReferenceError | 只写了调用、没写实例定义 |
| 真机 500 `agentTokenOk is not defined` | 新 handler 建在了 `main` 层，而它依赖 console 作用域的 const |
| `/诊断` 被人设菜单吞掉 | 管理命令放在了公开命令之后（与 `/自检` 同源） |

### 测试（73 → 84 个脚本）

新增护栏：`test-bridge-imports`（静态扫"用了但没来源"的工厂）、`test-file-size`（体积棘轮，
新文件 >800 行直接失败）、`test-incoming-guards`、`test-session-registry`、`test-selfcheck`、
`test-workspace-reset`、`test-douyin-meta`、`test-mux-pump`（假 mux 喂帧）、`test-mux-learner`、
`test-mux-tools`。

### 文档

- 运维指南新增 §20「拆分期最危险的五个坑」；`docs/sessions/2026-10-30.md` 交接记录；
  `docs/validation/linux-run-2026-10-30.md`（另一台 Linux 独立复跑，审计 84/84）
- **新增 [docs/UPGRADE.md](docs/UPGRADE.md)**：按版本写"升级要做什么"

## 2026-10-29 — 网关可替换：NapCat 实测通过 + 登录体验修复

- 实测 NapCat（OneBot v11）替代 SnowLuma：桥接零改动，只改 `snowluma.wsUrl`
- 踩坑记录写进 QUICKSTART：HTTP+WS 都要开、不能与 QQ 客户端同时登录、二维码要放大
- `scripts/napcat-login.ps1`：一键拉起 + 二维码放大 4 倍（147px 手机扫不动）
- 登录助手里的示例账号是占位符，仓库不含真实 QQ 号与 token

## 2026-10-29 — 装机体验：体检 + 一键安装 + 一页版快速开始

- `npm run doctor`：逐条诊断四大卡点（Node / DSH 路径 / SnowLuma / 官方凭证），**每条失败都带修法**
- `scripts/setup.ps1`：一键装（便携 Node、官方凭证当场验证、自动打开扫码页、绝不覆盖已有 config）
- `QUICKSTART.md`：一页版，读完就能判断自己该走哪条路线
- README「装起来」改成三条路线对照 + 四大卡点表

## 2026-10-28

### 新增

- **视频理解**：`qq_get_message_video` / `qq_open_video` —— 视频降维成「一张 3×3 故事板（每格烧时间戳）+ 音轨转写」。模型第一次能"看视频"。见 [docs/guides/VIDEO.md](docs/guides/VIDEO.md)
- **视频链接识别**：B站 / 抖音 / 快手 / 小红书 / YouTube 五站白名单；yt-dlp 只下前 180 秒（实测 84MB/8s → 1.5MB/3s）
- **抖音专用解析器**（`src/douyin-resolve.js`）：yt-dlp 的 Douyin extractor 要 a_bogus 签名（无签名 403，**登录也无效**），改走分享页 `play_addr` + `playwm→play` 去水印；实测 97 秒 / 6.2MB
- **cookies.txt 兜底**：`socialV2.media.video.links.cookiesPath`（优先级高于 `cookiesFromBrowser`）—— Chrome/Edge 127+ 的 app-bound 加密让 `--cookies-from-browser` 读不出
- **cookie 体检**：`GET /api/socialV2/video-cookies` → `ok` / `cookie-aging` / `cookie-expired` / `cookie-missing` + `remaining`（人话剩余时间）。抖音链接成功时若即将过期会附提醒；失败时直接说「重导一次」而不是「视频不存在」
- **技能**：vendored `caveman`（Apache-2.0，纯 markdown）+ `scripts/install-skills.ps1`；边界是「**只压日志和输出，代码逐字**」。见 [docs/guides/SKILLS.md](docs/guides/SKILLS.md)
- 排障脚本：`verify-video-live.ps1`（真机验证视频）、`probe-video-cookies.ps1`（探测哪个浏览器能出 cookie）、`set-video-cookies.ps1`（自动发现并接上导出的 cookies.txt）

### 新增（长期记忆 · LivingMemory 式结构）

- `src/memory-store.js`：记忆原子 `{text,tags,weight,createdAt,lastHitAt,hits,source}`，
  有效权重 = `weight · 0.5^(天数/30)`（半衰期 30 天）；命中 `weight += 0.3`（封顶 3）；
  打分 = `0.6·关键词覆盖 + 0.3·归一化权重 + 0.1·新鲜度`；Jaccard≥0.6 合并；有效权重<0.05 归档
- 接线：`memory-append` 落长期层（话题/群友印象；临时想法不落），`GET /api/socialV2/memory`
  注入 top-K（6 条 / 800 字预算，支持 `?q=` 按查询排序）；**老会话现场迁移**，升级即可见
- **合并留原文**：被 Jaccard 吞掉的文本进 `atom.variants[]`（每条最多 5 份），
  新增 `POST /api/socialV2/memory-split` 把任一条拆回独立原子（幂等）
- `scripts/test-memory-store.mjs`：13 项契约测试（分词/衰减/强化/打分/预算/合并/容量/归档/迁移/接线）

### 新增（官方通道 · 协议层）

- **QQ 官方机器人客户端** `src/qqbot-official.js`：AppID+AppSecret → access_token（缓存/提前刷新）、
  gateway、WebSocket（op10 HELLO / op2 IDENTIFY / op6 RESUME / op1 心跳）、事件翻译（群 @ / 群全量 / 单聊）、
  被动回复自动分配 `msg_seq`（**官方上限 5 次**，超了抛错而不是静默丢）
- `scripts/official-probe.mjs`：端到端验证（票据 → gateway → 收事件 → 回复一条）
- `scripts/test-official-client.mjs`：11 项离线契约测试（`<@!id>` 清洗、openid 不当 QQ 号、seq 上限、路由）
- `docs/guides/OFFICIAL-QQ.md`：两条腿的差异、加群前置（个人主体只能加自己管理的群）、协议要点、接入设计与**诚实状态表**

> **2026-10-28 端到端已实测通过**（真机器人 + 真群）：
> token ✓ → gateway ✓ → WS 鉴权 ✓ → 收到群 @ 事件（「测试」）✓ → **被动回复成功** ✓。
> 复现：`node scripts\official-probe.mjs --creds <state/official.json> --seconds 180`

### 修复（官方通道 · 端到端打通）

一条「群里 @ 了却不下话」的排查，连续挖出 6 个坑，全部修掉并各自有测试/日志兜底：

- **@ 标记**：官方 @ 由网关在事件层剥掉 → 唤醒判定认 `__official.atBot`
- **配置登记**：`loadConfig()` 逐字段装配，漏登记 `official` 段 → 启用等于没启用（且零日志）
- **会话 key 正则**：`canonicalV2Key` / `isSessionAllowedInCurrentMode` 只认数字 → 官方 `official-<openid>` 被静默丢弃
- **空 @**：只 @ 不打字时 `content` 为空，被"空消息"分支丢掉 → 合成上下文让模型自己应
- **发送分流**：`sendToQQ` 直连 OneBot，官方 id 被 `Number()` 打成 NaN → 按前缀分流走官方 API
- **id 守卫短路**：`!Number.isFinite(id)` 对字符串恒真，压根没走到白名单 → `typeof id !== 'string' &&`
- **首回复闸门**：模型被唤醒先做 5 分钟"沉睡前观察"，群里 5 分钟没回复 → 未发言时观察请求直接 409
- **中止回合**：`⏹️ 已停止` 顶替了模型已生成的正文 → 有正文时发正文

另修：**DSH 搬目录后 MCP 区块被改名 `.disabled`** → QQ 会话完全没有 `qq_*` 工具（已恢复并写进 docs/guides/OFFICIAL-QQ.md 第九节 9.2）。

### 修复

- **排队消息落盘**：队列原来只在内存里，桥接重启就丢（真实吞过一条消息）。现在写
  `state/pending-queue.json`（临时文件 + rename 原子替换），启动时按「24 小时 / 每会话 50 条」剪枝恢复，
  DSH 就绪后自动补投；坏文件/旧版本一律降级成空队列并写日志，不会把桥接拖死
- **DSH 端口漂移自愈**：DSH 每次重启都换随机端口（54694 → 65452 → 50075），以前 QQ 侧只会回「⏳ 消息已排队」。
  现在桥接连不上时会问系统「DSH 在听哪个端口」（`Get-NetTCPConnection` + HTTP 探活），
  找到就写回 `config.json` 并重建客户端；日志有 `[dsh] 端口漂移：… → …`

- **`package.json` 的 postinstall 坏了**（少一个右引号 + 中文 mojibake）→ 任何人 `npm install` 都会在 postinstall 阶段失败。已修，并用 `test-packaging` 真跑一遍钉住
- 视频以 **`image` 段 + `.mp4`** 到达（不是 `video` 段）导致识别不了 → 按扩展名兜底识别
- 双 BOM 的 `.ps1` 会让 PowerShell 5.1 解析失败（`param()` 报"赋值表达式无效"）→ 加断言：所有 `.ps1` 必须恰好一个 BOM
- 视频链路曾因缺 `import fs` / `probeVideo` / 变量名写错，**把桥接打死**（守护自动拉起）→ 加「导入完整性」静态断言
- 抖音解析分支漏挂 `cleanup` → 临时目录永远删不掉（`r.cleanup is not a function`），已修并钉住

### 安全 / 稳定性

- **播放地址域名白名单**：解析出来的 `play_addr` 属于"数据不是信任"——下载器现在**每一跳**都校验
  `snssdk.com` / `douyinvod.com` / `amemv.com` / `byteimg.com` 等媒体域，跳数上限 3。
  只校验第一跳等于没校验（一个 302 就能带走）。
- **解析器 fixture 回归**：`scripts/fixtures/video/*.html` 存脱敏页面快照，
  上游改版时 `test-video-resolve.mjs` 直接红，而不是等用户发链接失败。
- 新增 [docs/guides/VIDEO-SOURCES.md](docs/guides/VIDEO-SOURCES.md)：**站点 → 路径 → 为什么**。
  实测结论：B 站 HTML 会 412（同一 URL 两个 IP 两种结果，按 IP 判定），公开 API 无 cookie 也通；
  抖音必须爬分享页（yt-dlp 缺 a_bogus 签名，登录也 403），而且**爬也要 cookie**（无 cookie 页面没有 `play_addr`）。

- **体检包含「视频工具就绪」**：`verify.ps1` 新增第 16 项，调用 `diag-tools.mjs` 判断三件套会不会注册
  （`[OK] 视频工具` / `[WARN]` 附原因与改法）；新人不必等到模型说"没这个工具"才发现
- **修掉一个假 FAIL**：`verify.ps1` 的依赖检查还硬编码着 `node_modules/@snowluma/sdk`，
  而该依赖在 `8f65bac` 就移除了（自带 OneBot 客户端）——全新机器体检会稳定报「缺 node_modules」，
  其实什么都不缺。现在改为读 `package.json` 的 `dependencies` 逐个核对
- **一条命令查工具可见性**：`node scripts\diag-tools.mjs` —— 桥接侧 / 代码侧 / 运行侧三条线索
  一次摊开并给结论（`0` 全注册 / `1` 有缺失且指出改什么 / `2` 连不上），支持 `--json`、`--skip-mcp`
- **工具可见性可诊断**：MCP 启动时打印「工具注册完成：N 个｜视频/图片：…✓…」与被关闭的工具清单
  （以前 `disabledTools` 收完就丢，模型看不到某个工具时只能靠猜）；桥接新增只读端点
  `GET /api/socialV2/tools`，直接告诉你三个视频工具会不会注册、以及 `getImages=false` 的后果

### 测试

- 审计 **50/50**；新增 `test-video-frames`（12 项）、`test-video-link`（12 项）、`test-video-resolve`（13 项）
