# 手机当服务器：方案（只学原理，不抄代码）

> 研究日期：2026-11-02。研究对象是三个外部仓库（AstrBot 安卓 App、Android-DIY-Sandbox、
> AstrBot-android-lua），**只看做法，不复制代码**。本文所有结论都标注了依据来源。

## 0. P1 已经做过一遍了（2026-11-03 实测）

结论先放这儿：**桥接能在 Android 上跑**。做法与结果：

```
MuMu 模拟器 Android 15 / x86_64（adb 127.0.0.1:16384）
  └─ 解出 Termux 仓库的 nodejs-lts 24.22.2 + 8 个依赖 .deb
     └─ adb push 到 /data/local/tmp，LD_LIBRARY_PATH 指过去
        └─ node -v → v24.22.2
        └─ node src/bridge.js → 控制台 3100 起来，/health/detail 返回 version 0.5.43
```

暴露的三个问题与处置：

| 问题 | 处置 |
| --- | --- |
| 网关没起来时日志每 1~3 秒刷两三行 | `src/log-throttle.js` 按 key 节流，45 秒日志 61 → **27** 行 |
| 能力"点了才报错"（ffmpeg/PowerShell/Edge 都没有） | `src/platform-capabilities.js` + `GET /api/platform`，手机上一眼看到 6 项不可用 |
| DSH 连不上（要读 `~/.dsh/.credentials.yaml`） | 待办：远程 DSH 需要显式子命令里带 `dsh.authToken` |

### P0-a 也做完了（2026-11-03）

手机连远程 DSH 的真实形态：**把对端端口映射成手机的回环端口**，不是直接填局域网 IP。

```
adb reverse tcp:3080 tcp:58783          # 或 ssh -L / frp
复制对端 ~/.dsh/.credentials.yaml 里的 browser-session 密钥到手机同路径
config.json: dsh.baseUrl = http://127.0.0.1:3080

[bridge] DSH 已就绪（模式: reserved2）
health/detail: dsh=connected  console=connected   ✅
```

为什么必须走隧道：**DSH 只监听 127.0.0.1**；而桥接有一道安全闸 ——
launch token 是进程启动凭据，拒绝发往非回环地址（需显式 `dsh.allowRemote: true`）。

新增 `GET /api/dsh/probe`，把"连不上"拆成 tcp / http / auth / allowRemote 四步并给出人话提示。
手机侧实测返回：

```json
{ "ok": true, "loopback": true, "baseUrl": "http://127.0.0.1:3080",
  "steps": [{"name":"tcp","ok":true,"detail":"端口可达 127.0.0.1:3080"},
            {"name":"http","ok":true,"detail":"HTTP 401（需要鉴权）"},
            {"name":"auth","ok":true,"detail":"有浏览器会话密钥"}] }
```

### P0-b 也做完了（2026-11-03）

网关不再写死 SnowLuma，配置可切换（老配置无感）：

```
gateway: { provider: "napcat", httpUrl, wsUrl, token }   ← 新写法
snowluma: { wsUrl, accessToken }                          ← 老写法，继续有效
onebot: { http, ws, token }                               ← 历史写法，也认
```

优先级 `gateway.*` > `snowluma.*` > `onebot.*` > 预设。桥接内部仍读 `cfg.snowluma.*`，
由归一化层映射，所以**零改动**接入。

能力矩阵（差异显式化，缺的降级而不是报"未知错误"）：

| 能力 | SnowLuma | NapCat |
| --- | --- | --- |
| 文本/图片/语音/群成员 | ✅ | ✅ |
| 系统表情实体、收藏表情、QQ 空间 | ✅ | ❌ |

下一步（未做）：P2 NapCat 上手机（见第 4 节）。

## 1. 先说结论

**个人 QQ 号在手机上跑得起来** —— 这一条我之前判断错了。

我原来的依据是「SnowLuma 要挂进 Windows QQ 客户端进程，所以只能 Windows」。
但 NapCat（另一个 OneBot v11 实现）是在 **Linux QQ 客户端**上做协议的，
而 Android 能通过 **proot 跑一个 Ubuntu**，于是整条链路在手机上成立。

真正没解决的只剩一个：**agent（DSH）**。桥接只是转接器，脑子不在这儿。

## 2. 三个仓库分别是什么

| 仓库 | 性质 | 我拿到的信息 |
| --- | --- | --- |
| `zz6zz666/AstrBot-Android-App` | 产品（仓库里只有 README，APK 闭源） | 目标与形态：把 AstrBot + NapCatQQ + Ubuntu 容器打进一个 APK，装完扫 QQ 码就能用 |
| `zz6zz666/AstrBot-android-lua` | **AstrBot 安卓皮肤（Lua，纯逻辑，可直接读）** | 安装流程、端口分配、NapCat 启停、绑定适配器、登录态检测——全部在这里 |
| `zz6zz666/Android-DIY-Sandbox` | 运行时（Flutter + Lua 声明式 UI，**BSD-3**） | 容器/终端基础设施，`host.spawn / host.exec / host.ubuntu_path` 等原语，源自 Code LFA |

关键发现：**AstrBot 安卓版已经从"独立 APK"演变成了"Sandbox 里的一份 Lua 皮肤"**。
也就是说这套东西的机制是**公开可读**的（Lua + BSD 运行时），不需要反编译 APK。

## 3. 学到的原理（七条）

### 3.1 安装是「分步 + 幂等 + 可修复」

AstrBot 皮肤的安装拆成四步，每步独立可重跑：

```
base     apt-get install -y sudo git curl
uv       astral-sh/uv（拉最新版，装 Python 环境）
python   python-build-standalone（自带的解释器，不依赖系统 python）
napcat   NapCat 官方 install.sh
astrbot  git clone AstrBot → uv run main.py
```

「装没装」不靠状态位，靠**探针文件**：

```lua
env_installed("napcat") → host.exists(ubuntu .. "/root/launcher.sh") and host.exists(ubuntu .. "/root/napcat")
```

每一步都有对应的 `reinstall` 版本（先 `pkill`、备份 config、删目录、重装）。

**对我们**：手机端安装也该这么拆，且必须能"重跑修复"——手机网络比 PC 更不稳定。

### 3.2 网络：一份 GitHub 镜像列表 + 测速选最优

下载 GitHub 资源时按列表逐个测：

```
gh-proxy.com / ghproxy.net / ghfast.top / ghproxy.cc / gh.boki.moe / gh.monlor.com / …
```

测通之后所有下载都套同一前缀（`gh_prefix(url)`）；连不上就 `direct`。

**对我们**：`npm i`、`node` 下载、APK 更新都该走同一套镜像选择，而不是写死一个。

### 3.3 长任务 = 起一个终端标签 + 流式输出，绝不阻塞界面

```lua
host.spawn(脚本, "NapCat")     -- 长命令，输出流到终端 tab，key 跟踪运行态
host.nav.go(2)                 -- 立刻切到终端页让用户看
```

运行态来自 `ctx.running[key]`，UI 据此显示「运行中 / 停止」。

**对我们**：控制台里"安装/初始化"这类动作必须异步 + 日志可视，不做成转圈等待。

### 3.4 多账号 = 多实例 + 自动端口 + 一实例一 launcher

```
Dashboard 6185 / OneBot 6199 / NapCat WebUI 6099   （默认，可改）
每个账号: 独立 webUiPort、独立 OneBot 端口、独立 DISPLAY 号、独立 config 目录
launcher_<id>.sh 由模板生成（WebUI JSON 由代码写进去）
```

端口用 `host.free_port(from, to, exclude)` 在区间里找空闲，避免撞车。

**对我们**：桥接现在是"一个雪花网关"，如果要做多账号，得先把"网关 = 一个实例"抽象出来。

### 3.5 登录态检测：看文件，不看进程

```lua
NC.detect_qq(id)   -- 读实例目录里的登录信息（uin）
```

进程活着 ≠ 登录有效（这正是我们今天在 PC 上踩的坑）。桥接这边也一样：
`online:true` 才是真的在线。

### 3.6 后台存活：前台服务 + 常驻通知

README 写得很直白：

> 通知栏将显示"正在运行"常驻通知。**禁止手动清除该通知，否则服务将终止**。

**对我们**：手机端必须有这个机制，否则系统随时杀。Android 12+ 没有前台服务基本活不过几分钟。

### 3.7 首次启动允许"中断续跑"

> napcat 安装可能耗时较长且易失败……可**直接关闭 App 再次启动**，系统会从中断处继续安装。
> AstrBot 的代码仓库克隆已改为"原子操作"，避免因网络中断导致文件损坏。

**对我们**：所有下载都"临时文件 → 校验 → 原子改名"，失败重跑不脏。

## 4. 桥接这边要改什么（按依赖顺序）

### P0 — 网关抽象（2~3 天，无手机也能做）

现在写死 SnowLuma：`snowluma.httpUrl / wsUrl`。改成：

```jsonc
"gateway": {
  "provider": "snowluma",        // snowluma | napcat
  "httpUrl": "http://127.0.0.1:3000",
  "wsUrl": "ws://127.0.0.1:3001",
  "token": ""
}
```

配套 **能力探测**，因为两个网关的 API 不完全一样：

| 能力 | SnowLuma | NapCat | 探测方式 |
| --- | --- | --- | --- |
| 收发文本/图片 | ✅ | ✅ | `/get_version_info` |
| 群成员 | ✅ | ✅ | `get_group_member_list` |
| 收藏表情 | ✅（`fetch_face_entity`） | ❌ | 调用失败即降级 |
| QQ 空间 | ✅（自有接口） | ❌ | 同上 |
| 语音 SILK | ✅ | ✅（转换略不同） | 发一条测 |

原则：**能力缺失就降级并显示"这个网关不支持"，不静默失败**（今天一整天都在修这个）。

### P1 — Termux 试跑（半天，先证明能跑）

不走容器，先验证最小闭环：

```bash
pkg install nodejs-lts
# 拷 src/ public/ node_modules/ config.json
node src/bridge.js
termux-wake-lock
```

只跑**官方通道** + 控制台。这一步的产出是"桥接在 Android/ARM 上到底能不能起"，
以及缺哪些 POSIX 适配（`netstat`、计划任务、PowerShell 相关都要 seen）。

### P2 — NapCat 上手机（3~5 天）

需要容器，因为 NapCat 依赖 Linux QQ 客户端：

```
proot Ubuntu（借 Code LFA / Sandbox 的思路，BSD 允许借鉴）
  └─ apt 基础包 → NapCat install.sh → 配置 OneBot WS(6199)
桥接（Termux 或容器内 Node）→ 指向 ws://127.0.0.1:6199
```

验收标准：手机上扫码登录个人号，群里 @ 它能回，重启 App 后能自动恢复。

### P3 — APK 壳（5~8 天，可选）

只在"不想装 Termux + proot 手动折腾"时才需要：

```
前台服务（常驻通知）+ WebView 控制台 + 引导页（扫 QQ 码 / 填 key）
首次启动：下载 rootfs → 装 NapCat → 起桥接
```

## 5. 还差的那块：agent

| 方案 | 说明 | 工作量 |
| --- | --- | --- |
| 远程 DSH | 手机跑桥接，DSH 跑在角落的一台机器（旧笔记本/NAS/VPS） | 1~2 天（加远程地址 + 连接检测） |
| 直连 API 模式 | 桥接里加"不用 DSH，直接调 DeepSeek API"的降级通道 | 1~2 周（等于自带一个 mini agent） |
| 等 DSH 出 ARM 版 | 不可控 | — |

## 6. 风险与代价（诚实版）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 手机存储 | proot rootfs + QQ 客户端约 1.5~2 GB | 只在需要个人号时装 |
| 内存 | NapCat + 桥接常驻约 300~500 MB | 中端机勉强，低端机会被系统杀 |
| 后台被杀 | 断线 | 前台服务 + 电池白名单 + 常驻通知 |
| 个人号自动化 | 封号风险（与 PC 相同） | 频率限制、别主动发太多 |
| 无 DSH | 手机不能独立推理 | 见第 5 节 |

## 7. 建议的执行顺序

1. **P1 先做**（半天）：证明桥接能在手机上起来，暴露 POSIX 适配点。
2. **P0 并行**（2~3 天）：网关抽象 + 能力探测，PC 上就能测完。
3. 再决定 **P2**（要个人号）还是 **只做官方通道 + 远程 DSH**（要免折腾）。

---

## 附：法律边界

| 仓库 | 许可 | 能不能把代码搬进本仓库（MIT） |
| --- | --- | --- |
| AstrBot | AGPL-3.0 | ❌ |
| AstrBot-Android-App | 未声明（只有 APK） | ❌ |
| AstrBot-android-lua | 未单独声明（跟随 AstrBot 生态） | ❌ 只读原理 |
| Android-DIY-Sandbox | **BSD-3** | ✅ 可借鉴，需保留版权声明 |
| Code LFA | 需单独确认 | ⚠️ 用之前先查 |

本文只记录**做法**，不含任何被引用仓库的代码。
