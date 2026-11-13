# 深夜书房 · 互动版

> 📁 **本目录包含两部分**：
> - `index.html` / `app.js` / `live_*.py` … —— 下面这份「深夜书房」互动页（纯前端）
> - `auto_*.py` / `douyin_*.py` / `safety_words.py` —— 抖音集成（自动回私信/评论、登录、导出 cookies）
>   👉 抖音部分看 [INTEGRATION.md](INTEGRATION.md)
>
> 素材（`assets/`、`unity/`、`screenshots/`）**不在仓库里**，版权原因，见 [NOTICE.md](NOTICE.md)。


把 Wallpaper Engine 的静态深夜晚安壁纸，做成**可以互动的小场景**。

- 纯前端（HTML/CSS/JS），零依赖
- 可以直接当 **Wallpaper Engine Web 壁纸**用
- 也可以单独开一个窗口跑（浏览器 / 桌面壳）

> 素材来自创意工坊（`3820189840` / `3787353838`），**仅限个人使用，请勿二次分发**。

## 交互

| 操作 | 反应 |
| --- | --- |
| 鼠标移动 | 角色视线/身体轻微跟随 |
| 点击头部 | 摸头：脸红 + 爱心 + 台词，心情 + |
| 点击左/右脸 | 捏脸：越捏越恼（annoyed 1→3），第 6 次会哭 |
| 抱抱 | 先伸手要抱，再进入拥抱姿势，心情 + |
| 喂饭 | 端碗 → 喂 → 咀嚼三段动画 |
| 陪看书 | 进入看书状态，25 分钟后变「看累了」 |
| 聊天 | 输入框，回车发送；目前是本地规则回复 |
| 深夜 1–6 点 | 额外的小声碎碎念 |

眨眼、待机呼吸、闲聊（40–80 秒随机）自动进行。

## 运行

**方式 1：直接双击 `index.html`**

浏览器打开即可（file:// 也能跑）。

**方式 2：本地服务（推荐，方便以后接 AI）**

```powershell
python -m http.server 8795
# 打开 http://127.0.0.1:8795/
```

**方式 3：Wallpaper Engine（Web 壁纸）**

1. WE 里「创建壁纸」→「网页」
2. 指向本目录的 `index.html`
3. 项目信息用现成的 `project.json`

## 接 AI（后续）

页面暴露了 `window.roomPet`：

```js
roomPet.say('今天想听什么歌？');     // 说话 + 气泡
roomPet.setState('thinking');       // idle/thinking/listening/study/crying/hugging...
roomPet.setMood(8);                 // 心情 0-10
roomPet.state;                      // 当前状态
```

桥接侧只要在收到消息 / 开始生成 / 回复完成时各调一次，就能让角色跟着对话动起来。

## 文件

```
index.html      页面结构
style.css       布局 + 动画 + 热区
app.js          状态机 + 交互 + 台词
assets/
  background.png          书房背景（1672×941）
  character/*.png         18 个表情/动作帧（1254×1254）
project.json    Wallpaper Engine 项目描述
preview.gif     预览
```

## 已知限制

- 逐帧动画（不是 Live2D），动作之间是硬切
- 台词是本地写死的，未接模型
- 热区（头/左右脸）位置是按当前素材调的，换素材要重新对齐
- 没有做分辨率自适应到超宽屏

## 下一步可以做

1. 接 `qq-bridge`：消息驱动状态（思考/说话/睡觉）
2. 换 Live2D：pixi-live2d-display + Cubism 模型，`setState` 里切动作
3. 加简单数值游戏：饱食度 / 精力 / 亲密度，落 localStorage
4. 做成桌面壳（Electron / pywebview）：无边框、置底、开机自启

---

## 三个版本

| 文件 | 说明 |
| --- | --- |
| `index.html` | 帧动画版（18 张 PNG），交互最完整 |
| `l2d.html` | **Live2D 版**（pixi + Cubism 4），动作更顺滑 |
| `server.py` | 本地服务：静态托管 + SSE 状态推送 |

## 数值系统（饱食 / 精力 / 亲密）

存 `localStorage`，带时间衰减：

```
饱食  6 小时掉完（喂饭 +25）
精力  8 小时掉完（看书 -0.6/分钟，睡觉恢复）
亲密  只增不减（摸头 +2，抱抱 +5，喂饭 +2，看书 +3）
低于 20 时进度条变橙
```

接口：

```js
roomStats.value            // {fullness, energy, affection}
roomStats.feed(); roomStats.pet(); roomStats.hug(); roomStats.study(25);
roomStats.reset();
```

## 外部驱动（接 qq-bridge）

```powershell
python server.py 8796
# 打开 http://127.0.0.1:8796/l2d.html
```

桥接侧三个时机各调一次：

```js
fetch('http://127.0.0.1:8796/state', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: 'thinking', text: '' })
});
```

状态映射：

| 推送 state | 页面表现 |
| --- | --- |
| `thinking` | 切 Idle 动作（像在想） |
| `speaking` + text | 气泡显示文字 + 口型动画 2.2 秒 |
| `listening` | 切 TapBody（像在听） |
| `sleep` | 画面变暗 |
| `idle` | 回到待机 |

## Live2D 换模型

1. 把 Cubism 3/4 模型放进 `models/<名字>/`
2. 改 `l2d.js` 里的 `MODEL_URL`
3. 如果模型有自定义动作组，在 `setState()` 里改 `play(group, index)`

当前自带的是 Live2D 官方示例模型 **Hiyori**，只用于本地测试，**不要随成品分发**。

## 已知限制（更新）

- Live2D 模型是占位（Hiyori），不是图鲸鲸
- 动作组只有 Idle / TapBody，抱抱喂饭等是复用的
- 没有表情（expressions），情绪靠气泡和数值

---

## 桌面壳（C 方案）

```powershell
python app_shell.py            # 置底模式（像壁纸）
python app_shell.py --top      # 置顶模式（像桌宠）
python app_shell.py --install  # 开机自启
python app_shell.py --uninstall
```

特性：

```
· 无边框、铺满桌面（避开任务栏）
· 默认置底：在桌面图标之上、普通窗口之下
· 不抢焦点（WS_EX_NOACTIVATE）：点角色不会把你正在用的窗口切走
· 不进任务栏 / Alt-Tab（WS_EX_TOOLWINDOW）
· 置底模式下每 1.5 秒自动压回底层
```

快捷键：

| 热键 | 作用 |
| --- | --- |
| `Ctrl+Alt+D` | 切置底 |
| `Ctrl+Alt+T` | 切置顶 |
| `Ctrl+Alt+Q` | 退出 |

配置存 `shell.json`（模式、自启状态）。

---

## 接 qq-bridge（已接好，待重启生效）

`qq-bridge` 侧已经加了 6 行接线（`src/board-bridge.js` + `bridge.js` 调用），行为：

| 时机 | 推送 |
| --- | --- |
| 收到私聊/群消息 | `thinking` |
| 准备发回复前 | `speaking` + 回复前 80 字 |
| 发完（按时长） | `idle` |

配置（`qq-bridge/config.json`）：

```json
"board": {
  "enabled": true,
  "url": "http://127.0.0.1:8796/state",
  "maxChars": 80
}
```

开关：`enabled` 为 `false` 时完全不推送（默认在 `config.example.json` 里是关闭的）。

> 桥接是长驻进程，改完要**重启 DSH / 插件**才会加载新代码。
> 推送失败只记一次日志，之后静默，不影响 QQ 收发。

---

## 和 dsh-pet 桌宠联动（自动发现）

书房看板会**自动找到**同机的 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 插件
（接口前缀 `/dsh-pet-7340`，只监听 127.0.0.1），找到就自动匹配，不用配置。

发现顺序：

```
1. qq-bridge config.json 里的 dsh.baseUrl（最准）
2. 扫本机 LISTENING 的回环端口，探测 /dsh-pet-7340/state
3. 结果缓存 30 秒；调用失败自动重新发现
```

联动行为：

| 看板状态 | 桌宠反应 |
| --- | --- |
| `thinking` | 工作状态 thinking + 播「工作状态-思考冒泡」 |
| `speaking` | 气泡显示同一句话 + 播「碎碎念-发呆碎碎念」 |
| `sleep` | 让它睡下 |
| `idle` | 工作状态 idle + 播「待机呼吸休闲」 |

右键菜单会多一项 **「书房模式」**，点它打开书房页面。

本机接口（给自己或别的脚本用）：

```
GET  http://127.0.0.1:8796/pet/status        # 是否找到桌宠 + 基址
POST http://127.0.0.1:8796/pet/say           # {"text":"...", "durationMs":8000}
POST http://127.0.0.1:8796/pet/anim          # {"name":"东张西望"}
```

> 桌宠接口需要占用锁，模块内部会自动取锁并续期；用户拖动/隐藏桌宠时锁会被撤，
> 下一次调用会重新取。

---

## 局域网自动配对（跨机器）

两台机器都跑书房看板时，会自动发现对方并配对；配好之后一边说话，另一边的桌宠也会说同一句。

### 发现机制

```
UDP 47321   每 4 秒广播一次 announce（名字 / 端口 / 配对码哈希 / 本机局域网 IP）
            同时监听同端口，收到就记进 peers（30 秒没心跳自动移除）
地址选择    读 route print -4 的默认路由 Interface 列，避开 Clash 这类 TUN 假地址
```

### 配对码（防陌生人）

```
第一次启动自动生成 6 位码，写在 room-pet/settings.json
两台机器填同一个码 → 互相可见；码不同 → 广播直接忽略
非回环地址调用 /pet/*、/peers 必须带 X-Room-Pet-Code，否则 403
```

### settings.json

```json
{
  "name": "书房 A",
  "lan": { "enabled": true, "code": "7fea85", "mirror": true }
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 对端看到的名字 |
| `lan.enabled` | 关掉就不开 UDP，也不做 0.0.0.0 绑定 |
| `lan.code` | 配对码，两端一致才互认 |
| `lan.mirror` | 说话时是否把同一句镜像给对方 |

### 接口

```
GET  http://127.0.0.1:8796/peers          # 自己 id + 在线对端
POST http://<对端 IP>:8796/pet/say        # 需头 X-Room-Pet-Code（非回环）
```

> 同一台机器开两个实例时，两个实例会抢同一只桌宠的占用锁，所以只有一个能弹气泡；
> 跨机器各有一只桌宠，互不冲突。

---

## 在线朋友（握手确认 + 互发消息 + 转头）

书房页面右上角有「在线朋友」面板，局域网自动发现后会列出来。

| 状态 | 表现 | 能做什么 |
| --- | --- | --- |
| 待确认 | 黄色「待确认」 | 点「同意」建立互信，或「忽略」 |
| 已接通 | 绿色「已接通」 | 点「说一句」→ 输入框输入 → 发送；或「断开」 |

只有**已接通**的朋友才会收到你的镜像消息，也只有他们发来的消息才会让宠物转头。

握手记录存在 `settings.json → lan.approved`（按对端 instance_key 记），重启不丢。

### 围观对方说话

对端说话时：

```
收到 /pet/say（带 X-Room-Pet-Id / X-Room-Pet-Name）
  → 服务端 push("peer_say", "名字|内容")
  → 页面 SSE 收到：角色播 peerTurn 动画（转头看向对方）+ 气泡「名字 说：内容」
```

### 接口

```
GET  /peers                # 自己 id + 对端列表（含 approved）
POST /peers/approve        # {"id":"..."} 同意
POST /peers/reject         # {"id":"..."} 断开/忽略
POST /peers/say            # {"id":"...","text":"..."} 发一句
```
