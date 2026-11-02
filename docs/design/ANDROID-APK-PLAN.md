# 一体化 APK 方案（真机验证后定稿）

> 目标：装一个 apk，打开就是控制台，不用装 Termux。
> — 以真机体检结果为依据，2026-11-03

---

## 一、决定性发现：`targetSdk` 必须 ≤ 28

真机（HONOR LYN-AN00 / Android 15）体检，同一份代码两个 targetSdk：

| targetSdk | 私有目录 exec | 结论 |
| --- | --- | --- |
| 34 | `Permission denied (error=13)` | ❌ 一体化路线当场否掉 |
| **28** | **可以 ✓** | ✅ 路线成立 |

原因：Android 10+ 对 `targetSdk ≥ 29` 的 App 禁止执行私有目录里的文件（W^X）。
Termux 之所以能在普通手机上跑 proot，就是因为它 `targetSdk = 28`。

**代价**：Play 商店不收 targetSdk 28 的包；侧载/F-Droid 不受影响。

## 二、真机环境（实测）

```
厂商 HONOR   型号 LYN-AN00 (HNLYN-M)   Android 15 (SDK 35)
ABI  arm64-v8a, armeabi-v7a, armeabi     8 核
存储 可用 27141 MB / 共 226980 MB
私有目录 exec  可以 ✓
/data/local/tmp 可写  否（所以不能像模拟器那样 adb push）
/dev/shm 存在  否（必须由我们 bind）
DNS api.deepseek.com → 111.51.158.194，TCP 443 通 87ms
```

## 三、已备好的 arm64 资产（都在 `D:\QQBot\tools\arm64`）

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `ubuntu-base-arm64.tar.gz` | 28.5 MB | Ubuntu 24.04 基础系统（跑 QQ/NapCat 用） |
| `bin/proot` | 253 KB | 用户态 chroot |
| `libexec/proot/loader` | 17.7 KB | **缺它 guest 里一切都是 `execve: No such file`** |
| `lib/libtalloc.so.2.5.0` | 32.8 KB | proot 依赖 |
| `lib/libandroid-shmem.so` | 14.1 KB | proot 依赖 |
| `bin/node` | 45 MB | Node 24.22.2（Termux 构建，bionic，可直接跑） |

来源：Termux 官方仓库 `packages.termux.dev/apt/termux-main`（aarch64 索引里逐个解析出 Filename）。

## 四、分两步做，先做“没有 QQ 也能用”的最小闭环

### 第 1 步：APK = Node + 桥接 + WebView（不含 QQ）

```
APK ≈ 80 MB
  assets/
    node                    ← arm64，45 MB
    app/src, app/public     ← 桥接（2 MB）
    app/node_modules        ← 126 个包（离线装好，避免依赖 npm）
    config.example.json
  Java:
    MainActivity          ← WebView 打开 127.0.0.1:3100
    BridgeService         ← 前台服务，exec node src/bridge.js
    首次启动：把 assets 拷到 files/，chmod 755
```

**为什么先不含 QQ**：QQ+NapCat 需要 rootfs + apt + 编译，链条长、失败点多。
先把“打开 app 就有控制台、能聊天记忆”跑通，再叠 QQ。

### 第 2 步：叠 QQ/NapCat

```
首次启动额外：
  解压 ubuntu-base-arm64.tar.gz → files/rootfs
  下载 QQ arm64 deb + NapCat zip（不塞 APK，省 200 MB）
  proot 起 guest → apt install → 解压 NapCat → 编 launcher
  起 QQ: xvfb-run + LD_PRELOAD
```

**关键参数（都已验证过）**：
- `-b <files>/shm:/dev/shm`（Android 没有 /dev/shm）
- `PROOT_LOADER=<files>/proot/libexec/proot/loader`
- `NODE_EXTRA_CA_CERTS=<files>/rootfs/etc/ssl/certs/ca-certificates.crt`
- guest 里 `/usr/bin/env -i PATH=...`，否则 Android 的 PATH 会漏进去

## 五、必须处理的 Android 侧问题

| 问题 | 处置 |
| --- | --- |
| 后台被杀 | 前台服务 + `FOREGROUND_SERVICE_DATA_SYNC` + 引导用户关电池优化 |
| targetSdk 28 的权限声明 | 存储权限按旧模型声明；不要用 scoped storage API |
| WebView 访问 127.0.0.1 | 允许明文 HTTP（`usesCleartextTraffic`） |
| 首次解压 300 MB | 放前台服务里做，带进度；失败可重试 |
| 64 位限制 | Android 15 部分机型只装 64 位——我们本来就只有 arm64 |

## 六、风险（写在前面）

1. **QQ 客户端 + NapCat 注入 = 账号风控**，和现在的 Termux 方案一样，不会因“做成 app”而变小
2. **targetSdk 28 的老包**在个别新机型上可能被系统提示“为旧版 Android 构建”
3. **APK 体积 80 MB（第 1 步）/ 300 MB（第 2 步）**，只能侧载分发
4. **首次解压 + 首次 apt** 在手机上要 3~10 分钟，用户体验差，需要进度条

## 七、工具链（已就绪，不需要 Gradle）

```
JDK 17          D:\QQBot\tools\jdk\jdk-17.0.20.1+1
Android SDK     D:\QQBot\tools\android-sdk（platform 34 / build-tools 34）
流程            javac → d8 → aapt2 link → 注入 classes.dex → zipalign → apksigner
已产出          体检 APK（20.4 KB，可跑，真机验证过）
```

体检 APK 的构建脚本就是模板，一体化包沿用它（确定可行，不依赖网络下载 Gradle）。


---

## 八、工程骨架进度（2026-11-03 05:35，可接续）

### 已存在

`
mobile/apk/
├─ AndroidManifest.xml          targetSdk 28｜前台服务｜明文 HTTP
├─ src/com/qqbridge/app/
│  ├─ MainActivity.java          WebView + 每秒探 3100，通了切界面
│  └─ BridgeService.java         前台服务：铺 assets → chmod → exec node
└─ build-apk.ps1                 javac→d8→aapt2→注入dex→zipalign→签名
`

### 已验证

| 项 | 结果 |
| --- | --- |
| javac 编译 | 通过（7 个 class） |
| 空壳构建 | 通过，产出 14.4 MB APK |
| 模拟器安装 + 启动 | 通过 |
| 前台服务 | isForeground=true，通知生效 |
| 当前卡点 | FileNotFoundException: app/src/bridge.js —— 空壳模式不带 payload，预期内 |

### 两个已修的坑

1. Theme.DeviceDefault.DarkActionBar 在 aapt2 里解析不到 → 改 Theme.Holo.Light.DarkActionBar
2. uild-apk.ps1 必须存成 **UTF-8 with BOM**，否则 PowerShell 5.1 按 GBK 读，中文乱码且 {0} 格式化报语法错

### 下一步（照顺序做，别跳）

`powershell
# 1) 打出带 payload 的完整包（node 45MB + 源码 + node_modules）
powershell -File D:\QQBot-open\mobile\apk\build-apk.ps1 -WithPayload -Out D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk

# 2) 真机装一次，看首启解压是否成功
adb install -r D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk
adb logcat -s qqb:V            # 看 [bridge] 日志

# 3) 通了之后，再叠 QQ/NapCat（第 2 步）
`

**若第 1 步报 assets 太大**：apt2 -A 对单文件有 2GB 上限，80MB 没问题；
但 ssets/payload.tar 里的 
ode_modules 建议先 
pm prune --omit=dev 再打。
