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


## 八、工程骨架进度（2026-11-03 06:40，可接续）

### 已存在

```
mobile/apk/
├─ AndroidManifest.xml          targetSdk 28｜前台服务｜明文 HTTP
├─ src/com/qqbridge/app/
│  ├─ MainActivity.java          WebView + 每秒探 3100，通了切界面
│  └─ BridgeService.java         前台服务：铺 assets → 解 tar → chmod → exec node
├─ build-apk.ps1                 javac→d8→aapt2→注入dex→zipalign→签名→校验assets名（7 步）
└─ tools/fetch-node-libs.py     抓 Termux 的 node 运行库（9 个 .so，45 MB，按 NEEDED 裁剪）
```

APK 里的 assets（**全部平铺**，见坑 3）：

| asset | 大小 | 落盘位置 |
| --- | --- | --- |
| `node` | 44 MB | `files/bin/node`（chmod 755） |
| `payload.tar` | 243 MB | 解到 `files/app`（src / public / node_modules，35569 个文件） |
| `libs.tar` | 45 MB | 解到 `files/lib`（node 的 .so，靠 `LD_LIBRARY_PATH`） |
| `bridge.js` `package.json` `config.example.json` | 小 | `files/app` 下的对应位置 |

### 已验证（2026-11-03 06:40）

| 项 | 结果 |
| --- | --- |
| javac / d8 / aapt2 / 签名 | 通过 |
| 完整包构建 | 通过，**77.0 MB**（payload 243 MB + libs 45 MB，压缩后） |
| 首启解压（模拟器 Android 15） | 通过：`files/app` 326 MB、35569 个文件、0 个软链、`payload.tar` 解完自动删 |
| 幂等 | 通过：`.payload-ok` / `lib/.ok` 存在就跳过 |
| node 运行库 | 通过：`node -p process.version` → `v24.22.2`（`LD_LIBRARY_PATH` 生效） |
| **当前卡点** | node 读 `package.json` 报 `ERR_INVALID_PACKAGE_CONFIG`，模拟器疑为 ARM 转译假阳性，**待真机复验** |

### 五个已修的坑

1. Theme.DeviceDefault.DarkActionBar 在 aapt2 里解析不到 → 改 Theme.Holo.Light.DarkActionBar
2. build-apk.ps1 必须存成 **UTF-8 with BOM**，否则 PowerShell 5.1 按 GBK 读，中文乱码且 {0} 格式化报语法错
3. **aapt2 在 Windows 上把子目录 asset 存成反斜杠**（`assets/app\src\bridge.js`），
   AssetManager 只认 `/` → 真机 `FileNotFoundException`。解法：asset 全平铺，脚本第 7 步自检
4. **toybox 的 tar 解不了长链接**：>100 字节的软链目标会变成 `././@LongSymLink` 死链，
   也不认 pax `linkpath`；Windows 自带 bsdtar 只写得出 ustar/pax，写不出 GNU longlink。
   解法：payload 里把 pnpm 链接实体化（26 MB → 243 MB），换「解出来就是对的」
5. node 是 Termux 构建的 bionic 二进制，NEEDED 里有 libz/libcares/libsqlite3/libcrypto/libssl/libicu*，
   Android 系统里没有 → 自带 `libs.tar` + `LD_LIBRARY_PATH`（targetSdk 28 才不被链接器忽略）

### 下一步（照顺序做，别跳）

```powershell
# 1) 打完整包
powershell -NoProfile -ExecutionPolicy Bypass -File D:\QQBot-open\mobile\apk\build-apk.ps1 -WithPayload `
  -Out D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk

# 2) 真机装 + 看日志
adb install -r D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk
adb logcat -s qqb:V            # 看 node 的 stdout

# 3) 通了之后，再叠 QQ/NapCat（第 2 步）
```

**如果真机也报 `ERR_INVALID_PACKAGE_CONFIG`**：那是 Node 24 的 C++ package.json 读取（simdjson）
在 Android 上的问题，不是我们的打包问题。排查入口：`node:internal/modules/package_json_reader:126`；
已确认 `JSON.parse(fs.readFileSync(...))` 对同一份文件永远成功。可能的方向：换 node 版本（22 LTS 的
package.json 读取还是 JS 实现）、或者给 node 加 `--no-experimental-...`。**先别动 payload**。

**如果要瘦 payload**：只有在 Linux/macOS 上打包（那边的 tar 能保留软链）才能把 243 MB 降回 ~30 MB；
Windows 上别绕，见坑 4。
