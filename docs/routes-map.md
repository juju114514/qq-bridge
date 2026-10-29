# 路由与模块归属索引（自动生成）

生成时间：2026-10-29T01:34:30.541Z

> **动路由前先看这里。** 生成：`node scripts/map-routes.mjs`

## 一、端点归属

| 统计 | 数量 |
| --- | --- |
| 端点总数 | 59 |
| 已迁（实现全在 src/api） | 6 |
| 混合（两边都有判断） | 9 |
| **内联（实现仍在 bridge.js）** | 44 |

### 内联（值得抽）

| 路径 | 位置 |
| --- | --- |
| `/` | src/bridge.js:3935 |
| `/api/authorize/read` | src/bridge.js:4956 |
| `/api/console/token` | src/bridge.js:4257 |
| `/api/dsh/effort` | src/bridge.js:4225 |
| `/api/dsh/model` | src/bridge.js:4178 |
| `/api/images/message` | src/bridge.js:4980 |
| `/api/inject` | src/bridge.js:5066 |
| `/api/mode` | src/bridge.js:3961 |
| `/api/pending` | src/bridge.js:4153 |
| `/api/preset/sim-prompt` | src/bridge.js:4024<br>src/bridge.js:4043 |
| `/api/preset/sim-prompt/backups` | src/bridge.js:4093 |
| `/api/preset/sim-prompt/restore` | src/bridge.js:4103 |
| `/api/presets` | src/bridge.js:3952 |
| `/api/restart` | src/bridge.js:5147 |
| `/api/role` | src/bridge.js:4020 |
| `/api/send/group` | src/bridge.js:5074 |
| `/api/send/private` | src/bridge.js:5074 |
| `/api/send/reply` | src/bridge.js:5074 |
| `/api/slang` | src/bridge.js:4141 |
| `/api/social` | src/bridge.js:4313 |
| `/api/social/flush` | src/bridge.js:4313 |
| `/api/social/state` | src/bridge.js:4313 |
| `/api/socialV2/active-members` | src/bridge.js:4825 |
| `/api/socialV2/activity` | src/bridge.js:4509 |
| `/api/socialV2/config` | src/bridge.js:4343 |
| `/api/socialV2/forward-media` | src/bridge.js:4806 |
| `/api/socialV2/group-members` | src/bridge.js:4854 |
| `/api/socialV2/initial-prompt` | src/bridge.js:4333 |
| `/api/socialV2/prompt` | src/bridge.js:4546 |
| `/api/socialV2/slang/submit` | src/bridge.js:4899 |
| `/api/socialV2/song` | src/bridge.js:4667 |
| `/api/socialV2/state` | src/bridge.js:4527 |
| `/api/socialV2/sticker-image` | src/bridge.js:4337 |
| `/api/socialV2/sticker-list` | src/bridge.js:4747 |
| `/api/socialV2/tools` | src/bridge.js:4988 |
| `/api/socialV2/video` | src/bridge.js:5060 |
| `/api/socialV2/video-cookies` | src/bridge.js:5008 |
| `/api/socialV2/video-link` | src/bridge.js:5029 |
| `/api/socialV2/wait` | src/bridge.js:4780 |
| `/api/status` | src/bridge.js:3946 |
| `/api/stickers` | src/bridge.js:4776 |
| `/api/test-send` | src/bridge.js:4289 |
| `/api/tokens/summary` | src/bridge.js:4788 |
| `/api/workspace/reset` | src/bridge.js:5080 |

### 已迁 / 混合

| 路径 | 状态 | 位置 |
| --- | --- | --- |
| `/api/console/notify-ai` | 混合 | src/api/console-notify.js:26 |
| `/api/security` | 混合 | src/api/security.js:26<br>src/api/security.js:43 |
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
| `/api/whitelist` | 混合 | src/api/whitelist.js:22<br>src/api/whitelist.js:26 |
| `/api/x` | 已迁 | src/http/router.js:4 |

## 二、模块装配情况

> 注意：**很多模块自己不判断 url.pathname**，是被 bridge.js 的 if 链调用。
> 所以「bridge 里有 if」不等于「没迁移」—— 判断依据是这里的「已装配」列。

已装配 23 / 23 个模块。

| 模块 | 行数 | 导出 | 装配位置 |
| --- | --- | --- | --- |
| `src/api/console-notify.js` | 97 | createConsoleNotifyHandler | createConsoleNotifyHandler@L4318 |
| `src/api/dead-letter.js` | 42 | createDeadLetterHandler | createDeadLetterHandler@L3865 |
| `src/api/images.js` | 96 | createImagesHandler | createImagesHandler@L3854 |
| `src/api/inject.js` | 124 | createInjectHandler, makeInjectToken | createInjectHandler@L3873<br>makeInjectToken@L10979 |
| `src/api/official-say.js` | 112 | createOfficialSayHandler | createOfficialSayHandler@L3881 |
| `src/api/roles.js` | 221 | createRolesHandler | createRolesHandler@L3635 |
| `src/api/security.js` | 66 | createSecurityHandler | createSecurityHandler@L4245 |
| `src/api/send.js` | 151 | createSendHandler | createSendHandler@L3887 |
| `src/api/sessions.js` | 147 | createSessionsHandler | createSessionsHandler@L3684 |
| `src/api/slang.js` | 367 | createSlangHandler | createSlangHandler@L3658 |
| `src/api/social.js` | 129 | createSocialHandler | createSocialHandler@L3705 |
| `src/api/socialV2-inspect.js` | 172 | createSocialV2InspectHandler | createSocialV2InspectHandler@L4797 |
| `src/api/socialV2-qzone.js` | 417 | createSocialV2QzoneHandler | createSocialV2QzoneHandler@L3816 |
| `src/api/socialV2-read.js` | 316 | createSocialV2ReadHandler | createSocialV2ReadHandler@L3714 |
| `src/api/socialV2-send.js` | 948 | createSocialV2SendHandler | createSocialV2SendHandler@L3786 |
| `src/api/socialV2-wait.js` | 244 | createSocialV2WaitHandler | createSocialV2WaitHandler@L3826 |
| `src/api/socialV2-write.js` | 759 | createSocialV2WriteHandler | createSocialV2WriteHandler@L3744 |
| `src/api/status.js` | 78 | createStatusHandler | createStatusHandler@L3622 |
| `src/api/stickers.js` | 102 | createStickersHandler | createStickersHandler@L3838 |
| `src/api/tokens.js` | 58 | createTokensHandler | createTokensHandler@L3849 |
| `src/api/voice-send.js` | 137 | createVoiceSendHandler | createVoiceSendHandler@L4730 |
| `src/api/whitelist.js` | 64 | createWhitelistHandler | createWhitelistHandler@L4169 |
| `src/http/router.js` | 177 | createRouter | createRouter@L3905 |
