# 路由与模块归属索引（自动生成）

生成时间：2026-10-29T00:41:04.394Z

> **动路由前先看这里。** 生成：`node scripts/map-routes.mjs`

## 一、端点归属

| 统计 | 数量 |
| --- | --- |
| 端点总数 | 59 |
| 已迁（实现全在 src/api） | 6 |
| 混合（两边都有判断） | 4 |
| **内联（实现仍在 bridge.js）** | 49 |

### 内联（值得抽）

| 路径 | 位置 |
| --- | --- |
| `/` | src/bridge.js:3931 |
| `/api/authorize/read` | src/bridge.js:5171 |
| `/api/console/notify-ai` | src/bridge.js:4371 |
| `/api/console/token` | src/bridge.js:4311 |
| `/api/dsh/effort` | src/bridge.js:4253 |
| `/api/dsh/model` | src/bridge.js:4206 |
| `/api/images/message` | src/bridge.js:5195 |
| `/api/inject` | src/bridge.js:5281 |
| `/api/mode` | src/bridge.js:3957 |
| `/api/pending` | src/bridge.js:4149 |
| `/api/preset/sim-prompt` | src/bridge.js:4020<br>src/bridge.js:4039 |
| `/api/preset/sim-prompt/backups` | src/bridge.js:4089 |
| `/api/preset/sim-prompt/restore` | src/bridge.js:4099 |
| `/api/presets` | src/bridge.js:3948 |
| `/api/restart` | src/bridge.js:5362 |
| `/api/role` | src/bridge.js:4016 |
| `/api/security` | src/bridge.js:4272<br>src/bridge.js:4289 |
| `/api/send/group` | src/bridge.js:5289 |
| `/api/send/private` | src/bridge.js:5289 |
| `/api/send/reply` | src/bridge.js:5289 |
| `/api/send/voice` | src/bridge.js:4843<br>src/bridge.js:4853 |
| `/api/slang` | src/bridge.js:4137 |
| `/api/social` | src/bridge.js:4367 |
| `/api/social/flush` | src/bridge.js:4367 |
| `/api/social/state` | src/bridge.js:4367 |
| `/api/socialV2/active-members` | src/bridge.js:5040 |
| `/api/socialV2/activity` | src/bridge.js:4623 |
| `/api/socialV2/config` | src/bridge.js:4457 |
| `/api/socialV2/forward-media` | src/bridge.js:5021 |
| `/api/socialV2/group-members` | src/bridge.js:5069 |
| `/api/socialV2/initial-prompt` | src/bridge.js:4447 |
| `/api/socialV2/prompt` | src/bridge.js:4660 |
| `/api/socialV2/slang/submit` | src/bridge.js:5114 |
| `/api/socialV2/song` | src/bridge.js:4781 |
| `/api/socialV2/state` | src/bridge.js:4641 |
| `/api/socialV2/sticker-image` | src/bridge.js:4451 |
| `/api/socialV2/sticker-list` | src/bridge.js:4962 |
| `/api/socialV2/tools` | src/bridge.js:5203 |
| `/api/socialV2/video` | src/bridge.js:5275 |
| `/api/socialV2/video-cookies` | src/bridge.js:5223 |
| `/api/socialV2/video-link` | src/bridge.js:5244 |
| `/api/socialV2/wait` | src/bridge.js:4995 |
| `/api/status` | src/bridge.js:3942 |
| `/api/stickers` | src/bridge.js:4991 |
| `/api/test-send` | src/bridge.js:4343 |
| `/api/tokens/summary` | src/bridge.js:5003 |
| `/api/voice/send` | src/bridge.js:4843 |
| `/api/whitelist` | src/bridge.js:4164<br>src/bridge.js:4168 |
| `/api/workspace/reset` | src/bridge.js:5295 |

### 已迁 / 混合

| 路径 | 状态 | 位置 |
| --- | --- | --- |
| `/api/session/reset` | 混合 | src/api/sessions.js:138 |
| `/api/sessions` | 混合 | src/api/sessions.js:126 |
| `/api/socialV2/dead-letter` | 已迁 | src/api/dead-letter.js:12 |
| `/api/socialV2/dead-letter/requeue` | 已迁 | src/api/dead-letter.js:24 |
| `/api/socialV2/forward-message` | 混合 | src/api/socialV2-inspect.js:78 |
| `/api/socialV2/message-detail` | 混合 | src/api/socialV2-inspect.js:27 |
| `/api/socialV2/official-proactive` | 已迁 | src/api/official-say.js:25 |
| `/api/socialV2/official-recall` | 已迁 | src/api/official-say.js:43 |
| `/api/socialV2/official-say` | 已迁 | src/api/official-say.js:74 |
| `/api/x` | 已迁 | src/http/router.js:4 |

## 二、模块装配情况

> 注意：**很多模块自己不判断 url.pathname**，是被 bridge.js 的 if 链调用。
> 所以「bridge 里有 if」不等于「没迁移」—— 判断依据是这里的「已装配」列。

已装配 19 / 19 个模块。

| 模块 | 行数 | 导出 | 装配位置 |
| --- | --- | --- | --- |
| `src/api/dead-letter.js` | 42 | createDeadLetterHandler | createDeadLetterHandler@L3861 |
| `src/api/images.js` | 96 | createImagesHandler | createImagesHandler@L3850 |
| `src/api/inject.js` | 124 | createInjectHandler, makeInjectToken | createInjectHandler@L3869<br>makeInjectToken@L11194 |
| `src/api/official-say.js` | 112 | createOfficialSayHandler | createOfficialSayHandler@L3877 |
| `src/api/roles.js` | 221 | createRolesHandler | createRolesHandler@L3631 |
| `src/api/send.js` | 151 | createSendHandler | createSendHandler@L3883 |
| `src/api/sessions.js` | 147 | createSessionsHandler | createSessionsHandler@L3680 |
| `src/api/slang.js` | 367 | createSlangHandler | createSlangHandler@L3654 |
| `src/api/social.js` | 129 | createSocialHandler | createSocialHandler@L3701 |
| `src/api/socialV2-inspect.js` | 172 | createSocialV2InspectHandler | createSocialV2InspectHandler@L5012 |
| `src/api/socialV2-qzone.js` | 417 | createSocialV2QzoneHandler | createSocialV2QzoneHandler@L3812 |
| `src/api/socialV2-read.js` | 316 | createSocialV2ReadHandler | createSocialV2ReadHandler@L3710 |
| `src/api/socialV2-send.js` | 948 | createSocialV2SendHandler | createSocialV2SendHandler@L3782 |
| `src/api/socialV2-wait.js` | 244 | createSocialV2WaitHandler | createSocialV2WaitHandler@L3822 |
| `src/api/socialV2-write.js` | 759 | createSocialV2WriteHandler | createSocialV2WriteHandler@L3740 |
| `src/api/status.js` | 78 | createStatusHandler | createStatusHandler@L3618 |
| `src/api/stickers.js` | 102 | createStickersHandler | createStickersHandler@L3834 |
| `src/api/tokens.js` | 58 | createTokensHandler | createTokensHandler@L3845 |
| `src/http/router.js` | 177 | createRouter | createRouter@L3901 |
