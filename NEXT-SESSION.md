# 下次接手先看这里（更新于 2026-11-05 00:35）

## 一句话状态

**0.5.62 已发布**（代码与 Release 都在远端）；桥接线上三路全通（dsh / gateway / official）。
**下一步只剩手机端 v9 真机验收** —— 验过之后才做「预装版 APK」和挂附件。

## 今天（11-04 晚 ~ 11-05 凌晨）做完的

| 版本 | 内容 |
| --- | --- |
| 0.5.60 | 网关启动自检（配置与实际不符时给可照做的提示）+ `scripts/doctor-gateway.mjs` |
| 0.5.61 | 模型繁忙重试（429/5xx 退避 + 401 不重试 + 群里看人话）；控制台网关体检（中枢页 + 运维页，含一键修复）；排障手册 |
| 0.5.62 | **DSH 端口识别修复**（`/api/ping` 三态判定）+ 0 帧看门狗；Release 已发布 |
| 仓库 | `public/vendor|icons|manifest|sw.js` 之前被 gitignore 排除（clone 缺件），已入库 + 加守卫 `check-public-assets.mjs` |
| APK | v9（一键装 AstrBot + 打开 WebUI），未真机验收 |

## 远端状态

```
main == origin/main            （无未推提交）
最新标签 / Release  v0.5.62    （Release 只有源码，未挂 APK —— 用户明确要求）
审计               191/191
```

## 下次要做的三件事（按顺序）

### 1. 手机 v9 真机验收（唯一阻塞项）

```
装 D:\QQBot-open\mobile\dist\qq-bridge-app-v9.apk（245.7 MB）
→ 等「容器可用（CONTAINER_OK）」（~60 秒）
→ 点「安装 AstrBot」→ 等 1~2 分钟（离线 wheelhouse，151 个包）
→ 成功标志：按钮变「打开 AstrBot」，屏幕出现绿字
     AstrBot WebUI http://127.0.0.1:6185 / 用户名 astrbot / 密码 xxxx
→ 点「打开 AstrBot」能进登录页
```

已知风险：`dashboard/dist` 没进包，AstrBot 首次启动会自己联网拉前端；拉不到则 6185 通但页面 404。
出现这种情况 → 把 dist 打进 v10。

### 2. 验过之后：挂 APK 到 Release

用户要求「先别挂」。验通后再挂，文件名标注 experimental 或 verified。

### 3. 烤镜像 → 预装版 v10

v9 装通后点「导出镜像」（v8 起就有）→ 产物落在手机「下载/qq-bridge」→ USB(MTP) 拷回 PC
→ 把导出的 rootfs 塞进 APK assets → 别人装上即用，不需要再装 AstrBot。

## 真机关键事实（别再重测）

```
HONOR LYN-AN00 · Android 15 · arm64-v8a · 8 核 · 27 GB 可用
私有目录 exec：targetSdk 28 才允许（34 会 Permission denied）
rootfs 硬链接必须实体化（toybox tar 在 App 私有目录建硬链接被拒）
/dev/shm 不存在 → 必须 bind
node 需要 NODE_EXTRA_CA_CERTS（Android 无系统 CA）
手机没有 adb（HDB 驱动问题）→ 验证靠屏幕 + 「复制」按钮
```

## 产物清单

| 文件 | 说明 |
| --- | --- |
| mobile/dist/qq-bridge-app-v9.apk | 245.7 MB，一键装 AstrBot（未真机验收） |
| mobile/dist/qq-bridge-app-v8.apk | 106.2 MB，带「导出镜像」按钮 |
| mobile/apk | APK 工程（Gradle 布局，Studio 可开） |
| qq-bridge/mobile-apk | 上面那份的 git 镜像（14 文件 / 147 KB） |
| D:\QQBot\tools\arm64 | arm64 资产：rootfs（含 nolink 版）、proot、loader、node、cacert |
| D:\QQBot\tools\astrbot-wheels | 151 个 arm64 wheel + MANIFEST + INSTALL.md（137.8 MB） |
| research/AstrBot | AstrBot 源码（AGPL-3.0，只借鉴不抄） |

## 这一轮踩到的坑（复用价值高）

- **DSH 对裸 `GET /` 不响应**，只认 `/api/ping`（200/401/403）；而同一 DSH 进程可能同时监听
  多个端口，其中有的返回 404 —— 所以「端口归 DSH 进程」不能作为采信依据，404 必须排除
- `probeDshSignature` 用裸 TCP 拿不到 62822 的响应，**必须用 `http.get`**
- 连续未鉴权探测会触发 DSH 超时/RST → 三态里保留 `unknown`，别把真身误杀
- `bridge.js` 行数棘轮很紧（10522 基线 +50），加功能要「合并 import / 就地改写日志行」而不是新增行
- `console-extra-routes.js` 同理（131 基线 +50）
- 审计 harness 会剥掉 import 再在 vm 里跑：`hub-route.js` 顶部别写花哨的多行结构

## 常用命令

```bash
# 网关体检（也可以直接在控制台点按钮）
node scripts/doctor-gateway.mjs
node scripts/doctor-gateway.mjs --fix

# 全量审计
node scripts/test-audit.mjs

# 构建 APK（PowerShell 执行策略是 Restricted，必须带 Bypass）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\QQBot-open\mobile\apk\build-apk.ps1 -WithPayload -Out D:\QQBot-open\mobile\dist\qq-bridge-app-vN.apk

# 线上桥接
schtasks /end /tn "qq-bridge" ; schtasks /run /tn "qq-bridge"
```

## PC 侧注意

- DSH 端口每次启动都变，现在能被自动发现并写回 `config.json`
- SnowLuma 的 HTTP(3000) 与 WS(3001) 是**两个不同 token**，在 `snowluma/config/onebot_<QQ号>.json`
- 线上目录 `D:\deepseek工作区\qq-bridge` 不是 git 仓库，改完要手动从 dev 仓库 robocopy 过去
