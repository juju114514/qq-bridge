# 视频来源：每个站点走哪条路、为什么、失败时是什么码

> 这份文档回答一个具体问题：**为什么 B 站不用爬页面，而抖音必须爬页面。**
> 结论是实测出来的（2026-10-28），不是偏好。想看能力/用法去 [VIDEO.md](VIDEO.md)。

---

## 一、总表（这就是当前的策略，别随便改）

| 站点 | 走哪条路 | 为什么是这条 | 实测 |
| --- | --- | --- | --- |
| **B站** | **yt-dlp（走公开 API）** | HTML 页面会被反爬（412），而 API 不用 cookie 也 200 | 故事板 10.8s / 196KB |
| **YouTube** | yt-dlp（youtube extractor） | 成熟 extractor | 23s 内出结果 / 0.5MB |
| **小红书** | yt-dlp（XiaoHongShu extractor） | 有专用 extractor；多数笔记要 cookie | 图文笔记回「没有视频」 |
| **抖音** | **自研爬虫**（`src/douyin-resolve.js`） | yt-dlp 的 Douyin extractor 打 `aweme/v1/web/aweme/detail/`，需要 **a_bogus 签名**，无签名一律 403 —— 登录也一样 | 97s 视频 6.2MB |
| **快手** | 尽力而为（无 extractor） | 上游没有 kuaishou extractor，只能走 generic | 失败时明确说"不是视频" |
| **兜底** | **让用户直接发视频文件** | 零风控、零脆弱 | 18s 录屏 / 97s 视频都验证过 |

## 二、为什么 B 站**不能**改成爬页面（群里那条 412 就是证据）

同一个 URL，同一天，两个 IP 两种结果：

| 请求方 | 请求 | 结果 |
| --- | --- | --- |
| 群友 | `GET https://www.bilibili.com/video/BV…`（HTML） | **412 拦截页，一个字不给** |
| 本机 | 同一 URL（HTML，无 cookie） | 200 / 43,439 B |
| 本机 | `api.bilibili.com/x/web-interface/view?bvid=…`（**无 cookie**） | **200 / `code=0` / 标题+时长** |

**结论**：抓 HTML 的成败取决于**出口 IP 是否被风控**——同一份代码在你机器上红、在我这儿绿。
这种 bug 最难排查（用户以为"机器人坏了"，其实是他家 IP 被标记了）。

而公开 API 不需要 cookie，yt-dlp 走的就是这条路。所以对 B 站：
**用 API，别用 HTML。** 想自己实现也行，但 `x/player/wbi/playurl` 需要 wbi 签名（还要处理 buvid），
维护成本比"依赖 yt-dlp"高得多，收益为零。

## 三、为什么抖音**必须**爬页面

| 方案 | 结果 |
| --- | --- |
| yt-dlp 的 Douyin extractor | `ERROR: [Douyin] …: Fresh cookies (not necessarily logged in) are needed`（打 detail 接口 → 无 a_bogus 签名 → 403） |
| 带**真实 cookie** 直接打 detail 接口 | 仍然 **403**（`mstoken`/`a_bogus` 都缺） |
| `--cookies-from-browser edge/chrome` | Edge 锁库 / Chrome 127+ app-bound 加密 → DPAPI 失败 |
| **抓分享页** `iesdouyin.com/share/video/<id>/` | ✅ 页面内嵌 `play_addr.url_list` |

而且**爬也要 cookie**（这点很反直觉，实测）：

| 请求 | 返回 | 有 `play_addr` |
| --- | --- | --- |
| 无 cookie | 200 / 32,383 B | ❌ |
| 无 cookie + Referer | 200 / 32,383 B | ❌ |
| 带 cookie（扩展导出） | 200 / 37,866 B | ✅ |

所以"改成爬虫就不用管 cookie"是错的。抖音这块真正的稳定性来源是
**cookie 体检**（`GET /api/socialV2/video-cookies`）+ **fixture 回归**，不是换形态。

## 四、范围限制清单（爬虫必须窄，已落地的打 ✅）

| 限制 | 状态 | 落在哪 |
| --- | --- | --- |
| 入口 URL 命中站点白名单（host 精确匹配） | ✅ | `video-link.js` `isAllowedVideoUrl()` |
| 只接受 id 形态，不抓主页/列表/评论 | ✅ | `extractAwemeId()` 只认 `/video/<id>`、`modal_id` 等 |
| 不递归、不跟随页面内链接 | ✅ | 解析器只发 1~2 个请求（短链重定向 + 分享页） |
| **解析出的播放地址也校验域名**（每一跳） | ✅ | `video-download.js` `isAllowedMediaHost()`，跳数上限 3 |
| cookie 只挑目标域（`douyin.com`），不外发别的站 | ✅ | `douyin-resolve.js` `cookieHeaderFor()` |
| 大小 / 超时 / 片段上限 | ✅ | `links.maxBytes` / `timeoutMs` / `maxSeconds` |
| 失败原因翻译成人话 + 稳定 `code` | ✅ | `cookie-missing` / `cookie-expired` / `cookie-invalid` / `no-play-addr` |
| 页面结构变更能被 CI 抓到 | ✅ | `scripts/fixtures/video/*.html` + `test-video-resolve.mjs` |
| 每站独立开关 | ✅ | `links.sites`（关掉某站即整体拒） |
| 不登录站点、不存用户资料、不抓评论 | ✅ | 设计上就没有这些代码路径 |

> 播放地址是**数据、不是信任**：它是从 HTML 里正则抠出来的，页面被投毒就能把我们引到任意 host。
> 所以下载器每一跳都校验域名——只校验第一跳等于没校验（一个 302 就带走了）。

## 五、失败码 → 怎么办

| code | 出现在 | 含义 | 该做什么 |
| --- | --- | --- | --- |
| `cookie-missing` | 抖音 | 没配 `links.cookiesPath` | 跑 `scripts\set-video-cookies.ps1` |
| `cookie-expired` | 抖音 | cookie 全过期 | 重导一次 |
| `cookie-invalid` | 抖音 | 分享页变成验证页 | 重导；仍不行就是 IP 被风控 |
| `no-play-addr` | 抖音 | 页面里没有播放地址 | 视频可能已删/仅粉丝可见；换源或发文件 |
| `Unsupported URL` | 快手 | 没有 extractor | 发文件 |
| `No video formats found` | 小红书 | 图文笔记 | 发视频版或发图 |
| `This video is unavailable` | YouTube | 区域/登录限制 | 配 `cookiesFromBrowser` 或换源 |
| `412`（HTML 页面） | B站 | 反爬，按 IP 判定 | **不要重试**，走 yt-dlp 的 API 路径 |

## 六、想加一个新站点时

1. 先在 `yes/no` 两个问题上做实测，别凭印象：
   - 它的**公开 API** 能不能不登录拿到播放地址？能 → 走 yt-dlp/API。
   - 不能（要签名/要 cookie）→ 才考虑写爬虫。
2. 写爬虫就按上面的清单逐条落地，尤其**媒体域名白名单**。
3. 存一份**脱敏的页面快照**到 `scripts/fixtures/video/`，并在 `test-video-resolve.mjs` 里加断言。
4. 把这一行的结论补进本文档总表（含实测数字与日期）。

## 七、给接手的 AI 一句话

> **B 站别爬 HTML（会 412 靠 IP 运气），抖音必须爬（yt-dlp 缺 a_bogus 签名）；
> 爬就要带 cookie，cookie 过期要能被提前发现；解析出的地址每一跳都要校验域名。**
