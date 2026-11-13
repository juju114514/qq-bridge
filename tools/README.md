# 运行所需的工具（tools/）

> 这里放**仓库自己带的排查/辅助脚本**，以及「跑起来需要哪些外部工具」的清单。
> 一键体检：`node tools/doctor-tools.mjs`（末尾可加 `--json` 给脚本用）。

## 一、必须有的（缺了跑不起来）

| 工具 | 作用 | 版本 | 安装 / 备注 |
| --- | --- | --- | --- |
| **Node.js** | 桥接本体 | **≥ 22.13**（推荐 22 LTS / 24） | https://nodejs.org，或 `winget install OpenJS.NodeJS.LTS`；装完 `node -v` |
| **SnowLuma** | QQ 侧 OneBot v11 网关（第三方，必须你自己登录） | 跟随其官方 release | 装好后会占用 `:3000`（HTTP）与 `:3001`（WS）；本项目**只探测、不代启** |
| **DeepSeek Harness (DSH)** | 提供模型 | 跟随其官方版本 | 需要登录 DeepSeek 账号；**端口每次重启都会变**，配置里用自动探测 |

> 这三样缺任何一个，`node tools/doctor-tools.mjs` 会直接标 FAIL 并给出修复命令。

## 二、按功能需要的（缺了只影响对应能力）

| 工具 | 影响的功能 | 安装 |
| --- | --- | --- |
| **yt-dlp** | 群里说「发视频」时下载抖音/B站视频 | `winget install yt-dlp`，或从 https://github.com/yt-dlp/yt-dlp/releases 下 `yt-dlp.exe`，再把路径填进 `config.json` 的 `socialV2.media.video.links.ytdlpPath` |
| **ffmpeg** | 高清视频合流 / 音频转码 / 语音相关 | `winget install Gyan.FFmpeg`，或把 `ffmpeg.exe` 放进 PATH |
| **抖音登录态（cookies）** | 抖音链接解析、视频下载、评论/私信接口 | 控制台「抖音登录」→ 显示二维码 → 手机扫码 → **同步 cookies 到桥接**；或跑下面的 `export-cookies.py` |
| **Python 3**（可选） | 只有 `tools/export-cookies.py` 和 room-pet 侧的登录辅助需要 | https://www.python.org；`pip install websockets`（导出 cookies 用） |

## 三、仓库自带的排查脚本

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| `tools/doctor-tools.mjs` | **工具链体检**：Node/依赖/config/SnowLuma/DSH/yt-dlp/ffmpeg/cookies/控制台，逐项 OK-WARN-FAIL + 修复命令 | `node tools/doctor-tools.mjs` |
| `tools/doctor-tools.mjs --url <抖音链接>` | 顺带实测链接识别 | `node tools/doctor-tools.mjs --url https://v.douyin.com/xxxx/` |
| `tools/export-cookies.py` | 从已登录的调试浏览器导出抖音 cookies（Netscape 格式），写到桥接要用的路径 | `python tools/export-cookies.py --port 9237 --out state/cookies/site-cookies.txt` |
| `scripts/preflight.mjs` | 新机器第一次的全量体检（环境/仓库/依赖/config/端口/DSH/SnowLuma/人格卡） | `node scripts/preflight.mjs` |
| `scripts/test-audit.mjs` | 离线审计（改完代码跑一遍，只许增不许减） | `node scripts/test-audit.mjs` |
| `verify.ps1` | 安装后验收（12 项，退出码 0=通过 2=警告 1=致命） | `powershell -ExecutionPolicy Bypass -File .\verify.ps1` |

## 四、导出抖音 cookies（含验证码场景）

抖音的分享页解析和视频下载都要登录态，且 cookies 通常几天就过期。现场报错长这样：

```
[douyin] 下载失败（group:123456）：需要登录态（可在 socialV2.media.video.links.cookiesFromBrowser 填 edge/chrome）
```

两条路：

**① 控制台（推荐，能过验证码）**

```
控制台 → 刷抖音页 → 抖音登录
  [显示二维码]     独立浏览器（9238）里打开登录弹层并截二维码
  [抓取页面信息]   看当前网址/登录态/正文，确认有没有真的登进去
  [同步 cookies 到桥接]  把当前登录态写成 Netscape cookies.txt
  验证码：右边「验证码 / 页面」是整屏截图，直接在图上点 = 在页面同位置点（滑块/点选都这么过）
```

**② 命令行（已经有登录态的调试浏览器）**

```powershell
# 先确认调试浏览器开着（端口 9237）
python tools/export-cookies.py --port 9237 --check
python tools/export-cookies.py --port 9237 --out state/cookies/site-cookies.txt
```

> `--check` 会打印 cookie 数量、24 小时内过期的数量、以及 `sessionid / ttwid / odin_tt` 这几个关键 cookie 在不在。

## 五、常见「工具没配好」的表现

| 表现 | 缺什么 | 怎么办 |
| --- | --- | --- |
| 启动就 `ERR_MODULE_NOT_FOUND: js-yaml` | 依赖没装 | 仓库根目录 `npm install` |
| `:3000/:3001 未就绪` | SnowLuma 没开/没登录 | 自己启动 SnowLuma 并扫码登录（本项目不代启） |
| 群里说「发视频」回「下不了」 | yt-dlp 或 cookies | `node tools/doctor-tools.mjs` 看哪项 FAIL |
| 抖音链接解析全失败 | cookies 过期 | 见上一节，重新同步 |
| 桥接日志 `配置文件读取/解析失败` | config.json 坏了 | 删掉重新 `node scripts/first-run.ps1` 生成 |
