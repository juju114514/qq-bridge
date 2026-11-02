# 下次接手先看这里（更新于 2026-11-03 06:40）

## 一句话状态

payload 已经打进包了：**77 MB 的完整 APK**，模拟器上「首启解压 → chmod → exec node」全部走通，
只剩最后一步没过：node 起来了，但读 `package.json` 报 `ERR_INVALID_PACKAGE_CONFIG`。
怀疑是模拟器的 ARM 转译（`ro.dalvik.vm.nativebridge=libnb.so`）造成的假阳性，**要真机复验**。

## 立刻要做的事（按顺序）

```powershell
# 1) 打完整包（这步现在 3~5 分钟，payload 243MB + libs 45MB）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\QQBot-open\mobile\apk\build-apk.ps1 -WithPayload `
  -Out D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk

# 2) 真机装 + 看日志
adb install -r D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk
adb logcat -s qqb:V
```

预期：首启解压 → 起 node → WebView 打开 `http://127.0.0.1:3100`。

**两个必须盯的点**：
1. 真机如果也报 `ERR_INVALID_PACKAGE_CONFIG`，那就不是模拟器问题，看下面「模拟器怪现象」里的排查记录。
2. 真机如果报 `CANNOT LINK EXECUTABLE`，说明 `LD_LIBRARY_PATH` 在 targetSdk 28 上没生效，
   退路是把 .so 放进 `jniLibs`（`lib/arm64-v8a/`）走 APK 原生库目录。

## 今天做完的（06:00 ~ 06:40）

- payload 打包整条链修通：素材 243 MB → `payload.tar`，解到 `files/app` 共 **35569 个文件、0 个软链**
- node 的运行库自带：`D:\QQBot\tools\arm64\termux-libs\`（9 个 .so，45.4 MB，用
  `mobile/apk/tools/fetch-node-libs.py` 从 Termux 仓库抓，按 NEEDED 递归裁剪）
  → 打成 `libs.tar` 解到 `files/lib`，Java 里设 `LD_LIBRARY_PATH`
- 模拟器实测：`node -p process.version` → `v24.22.2`（能 exec、依赖库都找得到）
- 顺带合入 parallel session 的 CA 证书（`cacert.pem` → `NODE_EXTRA_CA_CERTS`）

## 模拟器上的怪现象（别在模拟器上继续耗）

x86_64 模拟器带 ARM 转译（`getprop ro.dalvik.vm.nativebridge` = `libnb.so`，abilist 里有 arm64-v8a）。
arm64 的 node 能跑，但 Node 24 的 C++ `package.json` 读取（`modulesBinding.readPackageJSON`，simdjson）
对**同一份文件**（md5 一致）时好时坏：

- `zod` 的 4142 B 版本：早几次过，后来连续 6 次全挂；`js-yaml` 2281 B 同理
- 纯 `{"type":"module"}`、以及 pad 到 20 KB 的单字符串 JSON 一直能过
- `JSON.parse(readFileSync(...))` 永远成功 → 不是文件坏了，是那一层 C++ 读

基本判定是转译层的 SIMD 问题，不是我们的打包问题。真机 arm64 上应该正常——但要真机确认。

## 已有的东西（别重复造）

| 资产 | 位置 |
| --- | --- |
| arm64 rootfs / proot / loader / node / **termux-libs** | `D:\QQBot\tools\arm64\` |
| 打包好的完整 APK（77 MB，含 payload + 运行库） | `D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk` |
| JDK 17 + Android SDK（无 Gradle 构建链） | `D:\QQBot\tools\jdk\`、`D:\QQBot\tools\android-sdk\` |
| 便携 npm | `D:\QQBot\tools\npm\package\bin\npm-cli.js` |
| 体检 APK（真机验证过 targetSdk 28 可 exec） | `D:\QQBot-open\mobile\dist\qq-bridge-diag-v2.apk` |
| 手机安装包（Termux 路线，备选） | `D:\QQBot-open\mobile\dist\qq-bridge-mobile-kit-0.5.56.zip` |

## 未推的提交

`main` 领先 `origin/main` **18 个**（0.5.44 ~ 0.5.59 + 文档 + 移动端修复）。
用户要求：**测试完成后再推**。

## 已知未完成

- 一体化 APK：真机未验（就卡在 node 读 package.json 那一步；模拟器疑为转译假阳性）
- payload 体积：243 MB（pnpm 链接农场实体化的代价）。想瘦回 30 MB 得在 Linux/macOS 上打包
- 一体化 APK 第 2 步（QQ/NapCat 进包）：未开始
- 真机 Termux 路线：`bootstrap.sh` 的 arm64 分支未在真机跑过
- 控制台：中枢页四张卡已可用；`agent.mode` 切换需重启生效（有意为之）
- 交接包在「真实 QQ 消息」场景下未验证（外部注入路径不写 recentMessages）

## 容易再踩的坑（五个）

1. `build-apk.ps1` 必须存成 **UTF-8 with BOM**（PowerShell 5.1 否则按 GBK 读，中文乱码 + `{0}` 报语法错）
2. `web/console.html` 改完要跑 `check-page-hooks.mjs` 和 `test-file-size.mjs`；`bridge.js` 有 +50 行/次棘轮
3. **assets 文件名必须平铺**：aapt2 在 Windows 上会把 `assets/app/src/x` 存成 `assets/app\src\x`（反斜杠），
   Android 的 AssetManager 只认 `/`，真机首启直接 `FileNotFoundException`。脚本第 7 步会自检这一条
4. **别让 tar 里出现长链接**：Android toybox 的 tar 解不了 >100 字节的软链目标（变成 `././@LongSymLink` 死链），
   也不认 pax `linkpath`；Windows 自带 bsdtar 又写不出 GNU longlink。所以 payload 里是把 pnpm 链接实体化的
5. 直接 `powershell -File ...` 会被执行策略拦住（这台机器如此），要加 `-ExecutionPolicy Bypass`
