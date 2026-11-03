# 下次接手先看这里（更新于 2026-11-04 03:40）

## 一句话状态

**真机上容器跑通了**（CONTAINER_OK / aarch64 / Ubuntu 24.04），QQ 下载在跑；
产品方向已定：**做「把成熟框架装进手机的壳」**，AstrBot 当主体，我们只做容器层。

## 今天达成的里程碑

| 时间 | 事 |
| --- | --- |
| 11-03 上午 | 模拟器上 NapCat 扫码登录成功，个人号收发打通 |
| 11-03 下午 | 桥接自带大脑（provider+loop+tools）、Key 加密、记忆跨重启、原文检索进控制台 |
| 11-03 晚 | 一体化 APK：空壳 → payload → 可诊断界面 → 容器（proot+Ubuntu） |
| 11-04 凌晨 | **真机 CONTAINER_OK**：targetSdk 28 解锁 exec、硬链接修复后 rootfs 完整解压 |
| 11-04 凌晨 | 定位调整：不再和 AstrBot 比功能，改为「AstrBot + 我们的容器」 |

## 真机关键事实（别再重测）

`
HONOR LYN-AN00 · Android 15 · arm64-v8a · 8 核 · 27 GB 可用
私有目录 exec：targetSdk 28 才允许（34 会 Permission denied）
rootfs 硬链接必须实体化（toybox tar 在 App 私有目录建硬链接被拒）
/dev/shm 不存在 → 必须 bind
node 需要 NODE_EXTRA_CA_CERTS（Android 无系统 CA）
手机没有 adb（HDB 驱动问题）→ 验证靠屏幕 + 「复制」按钮
`

## 产物清单

| 文件 | 说明 |
| --- | --- |
| mobile/dist/qq-bridge-app-v7.apk | 106.2 MB，容器可跑、QQ 下载中 |
| mobile/apk | APK 工程（Gradle 布局，Studio 可开） |
| qq-bridge/mobile-apk | 上面那份的 git 镜像 |
| D:\QQBot\tools\arm64 | arm64 资产：rootfs（含 nolink 版）、proot、loader、node、cacert |
| research/AstrBot | AstrBot 源码（AGPL-3.0，只借鉴不抄） |

## 未推的提交

main 领先 origin **25 个左右**（0.5.44 ~ 0.5.59 + 文档 + APK 工程）。用户要求：验收后再推。

## 明天要做的（按优先级）

1. **等 QQ 装完 + 扫码**：出二维码后「保存到相册」→ QQ 扫一扫 → 右上角相册
2. **验证 AstrBot 能否进容器**（模拟器 x86_64 验证中，结论可外推）
3. **烤镜像**：手机装 AstrBot → 点「导出镜像」（v8）→ USB 拷到 PC
4. **预构建包**：导出的 rootfs 塞进 APK → 「装上即用」的 v9
5. **PC 侧复查**：SnowLuma 网关最近一直连不上（WS 断开 / token 自愈失败），PC 机器人目前不可用

## PC 机器人现状（用户问过）

- 代码成熟（0.5.59、审计 190/190），但运行时依赖 SnowLuma；最近它的 OneBot 3000/3001 没起来
- official 通道是通的，但那是官方 bot 号，不是个人号
- 明天先查：SnowLuma 端口 + 控制台「运维」页网关状态

## 已知坑（省得再踩）

- build-apk.ps1 必须 UTF-8 with BOM
- assets 名必须平铺（aapt2 在 Windows 写反斜杠）
- 构建用 rootfs 源在 tools/arm64/extract/，不是上一级
- 容器探针有 90 秒看门狗；node 与容器解耦
- console.html 改完跑 check-page-hooks + test-file-size
