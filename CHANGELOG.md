# 更新日志

只记**用户能感知的变化**与**踩过的坑**。按日期倒序。

## 2026-10-28

### 新增
- **视频理解**：qq_get_message_video / qq_open_video —— 视频降维成「一张 3×3 故事板（每格烧时间戳）+ 音轨转写」。模型第一次能"看视频"。见 [docs/guides/VIDEO.md](docs/guides/VIDEO.md)
- **视频链接识别**：B站 / 抖音 / 快手 / 小红书 / YouTube 五站白名单；yt-dlp 只下前 180 秒（实测 84MB/8s → 1.5MB/3s）
- **抖音专用解析器**（src/douyin-resolve.js）：yt-dlp 的 Douyin extractor 要 a_bogus 签名（无签名 403，**登录也无效**），改走分享页 play_addr + playwm→play 去水印；实测 97 秒 / 6.2MB
- **cookies.txt 兜底**：socialV2.media.video.links.cookiesPath（优先级高于 cookiesFromBrowser）—— Chrome/Edge 127+ 的 app-bound 加密让 --cookies-from-browser 读不出
- **技能**：vendored caveman（Apache-2.0，纯 markdown）+ scripts/install-skills.ps1；边界是「**只压日志和输出，代码逐字**」。见 [docs/guides/SKILLS.md](docs/guides/SKILLS.md)
- 排障脚本：erify-video-live.ps1 / probe-video-cookies.ps1 / set-video-cookies.ps1

### 修复
- **package.json 的 postinstall 坏了**（少一个右引号 + 中文 mojibake）→ 任何人 
pm install 都会在 postinstall 阶段失败。已修，并用 	est-packaging 真跑一遍钉住
- 视频以 **image 段 + .mp4** 到达（不是 ideo 段）导致识别不了 → 按扩展名兜底识别
- 双 BOM 的 .ps1 会让 PowerShell 5.1 解析失败（param() 报"赋值表达式无效"）→ 加断言：所有 .ps1 必须恰好一个 BOM
- 视频链路曾因缺 import fs / probeVideo / 变量名写错，**把桥接打死**（守护自动拉起）→ 加「导入完整性」静态断言

### 测试
- 审计 **50/50**；新增 	est-video-frames（12 项）、	est-video-link（12 项）、	est-video-resolve（8 项）
