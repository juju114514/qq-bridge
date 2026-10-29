# 路由与模块归属索引（自动生成）

生成时间：2026-10-29T00:31:55.891Z

> **动路由前先看这里。** 生成：`node scripts/map-routes.mjs`

## 一、端点归属

| 统计 | 数量 |
| --- | --- |
| 端点总数 | 59 |
| 已迁（实现全在 src/api） | 6 |
| 混合（两边都有判断） | 2 |
| **内联（实现仍在 bridge.js）** | 51 |

### 内联（值得抽）

| 路径 | 位置 |
| --- | --- |
| `/` | src/bridge.js:3929 |
| `/api/authorize/read` | src/bridge.js:5302 |
| `/api/console/notify-ai` | src/bridge.js:4369 |
| `/api/console/token` | src/bridge.js:4309 |
| `/api/dsh/effort` | src/bridge.js:4251 |
| `/api/dsh/model` | src/bridge.js:4204 |
| `/api/images/message` | src/bridge.js:5326 |
| `/api/inject` | src/bridge.js:5412 |
| `/api/mode` | src/bridge.js:3955 |
| `/api/pending` | src/bridge.js:4147 |
| `/api/preset/sim-prompt` | src/bridge.js:4018<br>src/bridge.js:4037 |
| `/api/preset/sim-prompt/backups` | src/bridge.js:4087 |
| `/api/preset/sim-prompt/restore` | src/bridge.js:4097 |
| `/api/presets` | src/bridge.js:3946 |
| `/api/restart` | src/bridge.js:5493 |
| `/api/role` | src/bridge.js:4014 |
| `/api/security` | src/bridge.js:4270<br>src/bridge.js:4287 |
| `/api/send/group` | src/bridge.js:5420 |
| `/api/send/private` | src/bridge.js:5420 |
| `/api/send/reply` | src/bridge.js:5420 |
| `/api/send/voice` | src/bridge.js:4841<br>src/bridge.js:4851 |
| `/api/slang` | src/bridge.js:4135 |
| `/api/social` | src/bridge.js:4365 |
| `/api/social/flush` | src/bridge.js:4365 |
| `/api/social/state` | src/bridge.js:4365 |
| `/api/socialV2/active-members` | src/bridge.js:5171 |
| `/api/socialV2/activity` | src/bridge.js:4621 |
| `/api/socialV2/config` | src/bridge.js:4455 |
| `/api/socialV2/forward-media` | src/bridge.js:5152 |
| `/api/socialV2/forward-message` | src/bridge.js:5060 |
| `/api/socialV2/group-members` | src/bridge.js:5200 |
| `/api/socialV2/initial-prompt` | src/bridge.js:4445 |
| `/api/socialV2/message-detail` | src/bridge.js:5009 |
| `/api/socialV2/prompt` | src/bridge.js:4658 |
| `/api/socialV2/slang/submit` | src/bridge.js:5245 |
| `/api/socialV2/song` | src/bridge.js:4779 |
| `/api/socialV2/state` | src/bridge.js:4639 |
| `/api/socialV2/sticker-image` | src/bridge.js:4449 |
| `/api/socialV2/sticker-list` | src/bridge.js:4960 |
| `/api/socialV2/tools` | src/bridge.js:5334 |
| `/api/socialV2/video` | src/bridge.js:5406 |
| `/api/socialV2/video-cookies` | src/bridge.js:5354 |
| `/api/socialV2/video-link` | src/bridge.js:5375 |
| `/api/socialV2/wait` | src/bridge.js:4993 |
| `/api/status` | src/bridge.js:3940 |
| `/api/stickers` | src/bridge.js:4989 |
| `/api/test-send` | src/bridge.js:4341 |
| `/api/tokens/summary` | src/bridge.js:5001 |
| `/api/voice/send` | src/bridge.js:4841 |
| `/api/whitelist` | src/bridge.js:4162<br>src/bridge.js:4166 |
| `/api/workspace/reset` | src/bridge.js:5426 |

### 已迁 / 混合

| 路径 | 状态 | 位置 |
| --- | --- | --- |
| `/api/session/reset` | 混合 | src/api/sessions.js:138 |
| `/api/sessions` | 混合 | src/api/sessions.js:126 |
| `/api/socialV2/dead-letter` | 已迁 | src/api/dead-letter.js:12 |
| `/api/socialV2/dead-letter/requeue` | 已迁 | src/api/dead-letter.js:24 |
| `/api/socialV2/official-proactive` | 已迁 | src/api/official-say.js:25 |
| `/api/socialV2/official-recall` | 已迁 | src/api/official-say.js:43 |
| `/api/socialV2/official-say` | 已迁 | src/api/official-say.js:74 |
| `/api/x` | 已迁 | src/http/router.js:4 |

## 二、模块装配情况

> 注意：**很多模块自己不判断 url.pathname**，是被 bridge.js 的 if 链调用。
> 所以「bridge 里有 if」不等于「没迁移」—— 判断依据是这里的「已装配」列。

已装配 18 / 19 个模块。

| 模块 | 行数 | 导出 | 装配位置 |
| --- | --- | --- | --- |
| `src/api/dead-letter.js` | 42 | createDeadLetterHandler | createDeadLetterHandler@L3859 |
| `src/api/images.js` | 96 | createImagesHandler | createImagesHandler@L3848 |
| `src/api/inject.js` | 124 | createInjectHandler, makeInjectToken | createInjectHandler@L3867<br>makeInjectToken@L11325 |
| `src/api/official-say.js` | 112 | createOfficialSayHandler | createOfficialSayHandler@L3875 |
| `src/api/roles.js` | 221 | createRolesHandler | createRolesHandler@L3629 |
| `src/api/send.js` | 151 | createSendHandler | createSendHandler@L3881 |
| `src/api/sessions.js` | 147 | createSessionsHandler | createSessionsHandler@L3678 |
| `src/api/slang.js` | 367 | createSlangHandler | createSlangHandler@L3652 |
| `src/api/social.js` | 129 | createSocialHandler | createSocialHandler@L3699 |
| `src/api/socialV2-qzone.js` | 417 | createSocialV2QzoneHandler | createSocialV2QzoneHandler@L3810 |
| `src/api/socialV2-read.js` | 316 | createSocialV2ReadHandler | createSocialV2ReadHandler@L3708 |
| `src/api/socialV2-send.js` | 948 | createSocialV2SendHandler | createSocialV2SendHandler@L3780 |
| `src/api/socialV2-wait.js` | 244 | createSocialV2WaitHandler | createSocialV2WaitHandler@L3820 |
| `src/api/socialV2-write.js` | 759 | createSocialV2WriteHandler | createSocialV2WriteHandler@L3738 |
| `src/api/status.js` | 78 | createStatusHandler | createStatusHandler@L3616 |
| `src/api/sticker-curate.js` | 68 | createStickerCurateHandler | **未装配** |
| `src/api/stickers.js` | 102 | createStickersHandler | createStickersHandler@L3832 |
| `src/api/tokens.js` | 58 | createTokensHandler | createTokensHandler@L3843 |
| `src/http/router.js` | 177 | createRouter | createRouter@L3899 |
