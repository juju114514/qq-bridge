# 下次接手先看这里（更新于 2026-11-03 05:36）

## 一句话状态

桥接 0.5.59；手机端真机已验证「私有目录 exec 可用」（targetSdk 28 是关键），
一体化 APK 的骨架已能编译并跑起前台服务，**只差打进 payload 和装真机验证**。

## 立刻要做的事（按顺序）

```powershell
# 1) 打完整包（node 45MB + 桥接源码 + node_modules）
powershell -File D:\QQBot-open\mobile\apk\build-apk.ps1 -WithPayload `
  -Out D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk

# 2) 真机装 + 看日志
adb install -r D:\QQBot-open\mobile\dist\qq-bridge-app-full.apk
adb logcat -s qqb:V
```

预期：首启解压 → 起 node → WebView 打开 `http://127.0.0.1:3100`。
卡点参考 `docs/design/ANDROID-APK-PLAN.md` 第八节。

## 已有的东西（别重复造）

| 资产 | 位置 |
| --- | --- |
| arm64 rootfs / proot / loader / node | `D:\QQBot\tools\arm64\` |
| JDK 17 + Android SDK（无 Gradle 构建链） | `D:\QQBot\tools\jdk\`、`D:\QQBot\tools\android-sdk\` |
| 便携 npm | `D:\QQBot\tools\npm\package\bin\npm-cli.js` |
| 体检 APK（真机验证过 targetSdk 28 可 exec） | `D:\QQBot-open\mobile\dist\qq-bridge-diag-v2.apk` |
| 手机安装包（Termux 路线，备选） | `D:\QQBot-open\mobile\dist\qq-bridge-mobile-kit-0.5.56.zip` |

## 未推的提交

`main` 领先 `origin/main` **18 个**（0.5.44 ~ 0.5.59 + 文档 + 移动端修复）。
用户要求：**测试完成后再推**。

## 已知未完成

- 一体化 APK：payload 未打、真机未验
- 一体化 APK 第 2 步（QQ/NapCat 进包）：未开始
- 真机 Termux 路线：`bootstrap.sh` 的 arm64 分支未在真机跑过
- 控制台：中枢页四张卡已可用；`agent.mode` 切换需重启生效（有意为之）
- 交接包在「真实 QQ 消息」场景下未验证（外部注入路径不写 recentMessages）

## 两个容易再踩的坑

1. `build-apk.ps1` 必须存成 **UTF-8 with BOM**（PowerShell 5.1 否则按 GBK 读，中文乱码 + `{0}` 报语法错）
2. `web/console.html` 改完要跑 `check-page-hooks.mjs` 和 `test-file-size.mjs`；`bridge.js` 有 +50 行/次棘轮
