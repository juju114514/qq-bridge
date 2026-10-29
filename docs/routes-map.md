# 路由与模块归属索引（自动生成）

生成时间：2026-10-29T01:29:17.585Z

> **动路由前先看这里。** 生成：`node scripts/map-routes.mjs`

## 一、端点归属

| 统计 | 数量 |
| --- | --- |
| 端点总数 | 59 |
| 已迁（实现全在 src/api） | 6 |
| 混合（两边都有判断） | 7 |
| **内联（实现仍在 bridge.js）** | 46 |

### 内联（值得抽）

| 路径 | 位置 |
| --- | --- |
| `/` | src/bridge.js:3933 |
| `/api/authorize/read` | src/bridge.js:5012 |
| `/api/console/token` | src/bridge.js:4313 |
| `/api/dsh/effort` | src/bridge.js:4255 |
| `/api/dsh/model` | src/bridge.js:4208 |
| `/api/images/message` | src/bridge.js:5036 |
| `/api/inject` | src/bridge.js:5122 |
| `/api/mode` | src/bridge.js:3959 |
| `/api/pending` | src/bridge.js:4151 |
| `/api/preset/sim-prompt` | src/bridge.js:4022<br>src/bridge.js:4041 |
| `/api/preset/sim-prompt/backups` | src/bridge.js:4091 |
| `/api/preset/sim-prompt/restore` | src/bridge.js:4101 |
| `/api/presets` | src/bridge.js:3950 |
| `/api/restart` | src/bridge.js:5203 |
| `/api/role` | src/bridge.js:4018 |
| `/api/security` | src/bridge.js:4274<br>src/bridge.js:4291 |
| `/api/send/group` | src/bridge.js:5130 |
| `/api/send/private` | src/bridge.js:5130 |
| `/api/send/reply` | src/bridge.js:5130 |
| `/api/slang` | src/bridge.js:4139 |
| `/api/social` | src/bridge.js:4369 |
| `/api/social/flush` | src/bridge.js:4369 |
| `/api/social/state` | src/bridge.js:4369 |
| `/api/socialV2/active-members` | src/bridge.js:4881 |
| `/api/socialV2/activity` | src/bridge.js:4565 |
| `/api/socialV2/config` | src/bridge.js:4399 |
| `/api/socialV2/forward-media` | src/bridge.js:4862 |
| `/api/socialV2/group-members` | src/bridge.js:4910 |
| `/api/socialV2/initial-prompt` | src/bridge.js:4389 |
| `/api/socialV2/prompt` | src/bridge.js:4602 |
| `/api/socialV2/slang/submit` | src/bridge.js:4955 |
| `/api/socialV2/song` | src/bridge.js:4723 |
| `/api/socialV2/state` | src/bridge.js:4583 |
| `/api/socialV2/sticker-image` | src/bridge.js:4393 |
| `/api/socialV2/sticker-list` | src/bridge.js:4803 |
| `/api/socialV2/tools` | src/bridge.js:5044 |
| `/api/socialV2/video` | src/bridge.js:5116 |
| `/api/socialV2/video-cookies` | src/bridge.js:5064 |
| `/api/socialV2/video-link` | src/bridge.js:5085 |
| `/api/socialV2/wait` | src/bridge.js:4836 |
| `/api/status` | src/bridge.js:3944 |
| `/api/stickers` | src/bridge.js:4832 |
| `/api/test-send` | src/bridge.js:4345 |
| `/api/tokens/summary` | src/bridge.js:4844 |
| `/api/whitelist` | src/bridge.js:4166<br>src/bridge.js:4170 |
| `/api/workspace/reset` | src/bridge.js:5136 |

### 已迁 / 混合

| 路径 | 状态 | 位置 |
| --- | --- | --- |
| `/api/console/notify-ai` | 混合 | src/api/console-notify.js:26 |
| `/api/send/voice` | 混合 | src/api/voice-send.js:24<br>src/api/voice-send.js:34 |
| `/api/session/reset` | 混合 | src/api/sessions.js:138 |
| `/api/sessions` | 混合 | src/api/sessions.js:126 |
| `/api/socialV2/dead-letter` | 已迁 | src/api/dead-letter.js:12 |
| `/api/socialV2/dead-letter/requeue` | 已迁 | src/api/dead-letter.js:24 |
| `/api/socialV2/forward-message` | 混合 | src/api/socialV2-inspect.js:78 |
| `/api/socialV2/message-detail` | 混合 | src/api/socialV2-inspect.js:27 |
| `/api/socialV2/official-proactive` | 已迁 | src/api/official-say.js:25 |
| `/api/socialV2/official-recall` | 已迁 | src/api/official-say.js:43 |
| `/api/socialV2/official-say` | 已迁 | src/api/official-say.js:74 |
| `/api/voice/send` | 混合 | src/api/voice-send.js:24 |
| `/api/x` | 已迁 | src/http/router.js:4 |

## 二、模块装配情况

> 注意：**很多模块自己不判断 url.pathname**，是被 bridge.js 的 if 链调用。
> 所以「bridge 里有 if」不等于「没迁移」—— 判断依据是这里的「已装配」列。

已装配 21 / 21 个模块。

| 模块 | 行数 | 导出 | 装配位置 |
| --- | --- | --- | --- |
| `src/api/console-notify.js` | 97 | createConsoleNotifyHandler | createConsoleNotifyHandler@L4374 |
| `src/api/dead-letter.js` | 42 | createDeadLetterHandler | createDeadLetterHandler@L3863 |
| `src/api/images.js` | 96 | createImagesHandler | createImagesHandler@L3852 |
| `src/api/inject.js` | 124 | createInjectHandler, makeInjectToken | createInjectHandler@L3871<br>makeInjectToken@L11035 |
| `src/api/official-say.js` | 112 | createOfficialSayHandler | createOfficialSayHandler@L3879 |
| `src/api/roles.js` | 221 | createRolesHandler | createRolesHandler@L3633 |
| `src/api/send.js` | 151 | createSendHandler | createSendHandler@L3885 |
| `src/api/sessions.js` | 147 | createSessionsHandler | createSessionsHandler@L3682 |
| `src/api/slang.js` | 367 | createSlangHandler | createSlangHandler@L3656 |
| `src/api/social.js` | 129 | createSocialHandler | createSocialHandler@L3703 |
| `src/api/socialV2-inspect.js` | 172 | createSocialV2InspectHandler | createSocialV2InspectHandler@L4853 |
| `src/api/socialV2-qzone.js` | 417 | createSocialV2QzoneHandler | createSocialV2QzoneHandler@L3814 |
| `src/api/socialV2-read.js` | 316 | createSocialV2ReadHandler | createSocialV2ReadHandler@L3712 |
| `src/api/socialV2-send.js` | 948 | createSocialV2SendHandler | createSocialV2SendHandler@L3784 |
| `src/api/socialV2-wait.js` | 244 | createSocialV2WaitHandler | createSocialV2WaitHandler@L3824 |
| `src/api/socialV2-write.js` | 759 | createSocialV2WriteHandler | createSocialV2WriteHandler@L3742 |
| `src/api/status.js` | 78 | createStatusHandler | createStatusHandler@L3620 |
| `src/api/stickers.js` | 102 | createStickersHandler | createStickersHandler@L3836 |
| `src/api/tokens.js` | 58 | createTokensHandler | createTokensHandler@L3847 |
| `src/api/voice-send.js` | 137 | createVoiceSendHandler | createVoiceSendHandler@L4786 |
| `src/http/router.js` | 177 | createRouter | createRouter@L3903 |
