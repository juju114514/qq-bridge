# 路由与模块归属索引（自动生成）

生成时间：2026-10-29T01:44:57.096Z

> **动路由前先看这里。** 生成：`node scripts/map-routes.mjs`

## 一、端点归属

| 统计 | 数量 |
| --- | --- |
| 端点总数 | 59 |
| 已迁（实现全在 src/api） | 6 |
| 混合（两边都有判断） | 12 |
| **内联（实现仍在 bridge.js）** | 41 |

### 内联（值得抽）

| 路径 | 位置 |
| --- | --- |
| `/` | src/bridge.js:3938 |
| `/api/authorize/read` | src/bridge.js:4665 |
| `/api/console/token` | src/bridge.js:4217 |
| `/api/dsh/effort` | src/bridge.js:4185 |
| `/api/dsh/model` | src/bridge.js:4138 |
| `/api/images/message` | src/bridge.js:4689 |
| `/api/inject` | src/bridge.js:4775 |
| `/api/pending` | src/bridge.js:4113 |
| `/api/preset/sim-prompt` | src/bridge.js:3984<br>src/bridge.js:4003 |
| `/api/preset/sim-prompt/backups` | src/bridge.js:4053 |
| `/api/preset/sim-prompt/restore` | src/bridge.js:4063 |
| `/api/presets` | src/bridge.js:3955 |
| `/api/restart` | src/bridge.js:4856 |
| `/api/role` | src/bridge.js:3980 |
| `/api/send/group` | src/bridge.js:4783 |
| `/api/send/private` | src/bridge.js:4783 |
| `/api/send/reply` | src/bridge.js:4783 |
| `/api/slang` | src/bridge.js:4101 |
| `/api/social` | src/bridge.js:4273 |
| `/api/social/flush` | src/bridge.js:4273 |
| `/api/social/state` | src/bridge.js:4273 |
| `/api/socialV2/active-members` | src/bridge.js:4534 |
| `/api/socialV2/activity` | src/bridge.js:4311 |
| `/api/socialV2/forward-media` | src/bridge.js:4515 |
| `/api/socialV2/group-members` | src/bridge.js:4563 |
| `/api/socialV2/initial-prompt` | src/bridge.js:4293 |
| `/api/socialV2/slang/submit` | src/bridge.js:4608 |
| `/api/socialV2/song` | src/bridge.js:4376 |
| `/api/socialV2/state` | src/bridge.js:4329 |
| `/api/socialV2/sticker-image` | src/bridge.js:4297 |
| `/api/socialV2/sticker-list` | src/bridge.js:4456 |
| `/api/socialV2/tools` | src/bridge.js:4697 |
| `/api/socialV2/video` | src/bridge.js:4769 |
| `/api/socialV2/video-cookies` | src/bridge.js:4717 |
| `/api/socialV2/video-link` | src/bridge.js:4738 |
| `/api/socialV2/wait` | src/bridge.js:4489 |
| `/api/status` | src/bridge.js:3949 |
| `/api/stickers` | src/bridge.js:4485 |
| `/api/test-send` | src/bridge.js:4249 |
| `/api/tokens/summary` | src/bridge.js:4497 |
| `/api/workspace/reset` | src/bridge.js:4789 |

### 已迁 / 混合

| 路径 | 状态 | 位置 |
| --- | --- | --- |
| `/api/console/notify-ai` | 混合 | src/api/console-notify.js:26 |
| `/api/mode` | 混合 | src/api/mode.js:29 |
| `/api/security` | 混合 | src/api/security.js:26<br>src/api/security.js:43 |
| `/api/send/voice` | 混合 | src/api/voice-send.js:24<br>src/api/voice-send.js:34 |
| `/api/session/reset` | 混合 | src/api/sessions.js:138 |
| `/api/sessions` | 混合 | src/api/sessions.js:126 |
| `/api/socialV2/config` | 混合 | src/api/socialV2-config.js:24 |
| `/api/socialV2/dead-letter` | 已迁 | src/api/dead-letter.js:12 |
| `/api/socialV2/dead-letter/requeue` | 已迁 | src/api/dead-letter.js:24 |
| `/api/socialV2/forward-message` | 混合 | src/api/socialV2-inspect.js:78 |
| `/api/socialV2/message-detail` | 混合 | src/api/socialV2-inspect.js:27 |
| `/api/socialV2/official-proactive` | 已迁 | src/api/official-say.js:25 |
| `/api/socialV2/official-recall` | 已迁 | src/api/official-say.js:43 |
| `/api/socialV2/official-say` | 已迁 | src/api/official-say.js:74 |
| `/api/socialV2/prompt` | 混合 | src/api/socialV2-prompt.js:37 |
| `/api/voice/send` | 混合 | src/api/voice-send.js:24 |
| `/api/whitelist` | 混合 | src/api/whitelist.js:22<br>src/api/whitelist.js:26 |
| `/api/x` | 已迁 | src/http/router.js:4 |

## 二、模块装配情况

> 注意：**很多模块自己不判断 url.pathname**，是被 bridge.js 的 if 链调用。
> 所以「bridge 里有 if」不等于「没迁移」—— 判断依据是这里的「已装配」列。

已装配 26 / 26 个模块。

| 模块 | 行数 | 导出 | 装配位置 |
| --- | --- | --- | --- |
| `src/api/console-notify.js` | 97 | createConsoleNotifyHandler | createConsoleNotifyHandler@L4278 |
| `src/api/dead-letter.js` | 42 | createDeadLetterHandler | createDeadLetterHandler@L3868 |
| `src/api/images.js` | 96 | createImagesHandler | createImagesHandler@L3857 |
| `src/api/inject.js` | 124 | createInjectHandler, makeInjectToken | createInjectHandler@L3876<br>makeInjectToken@L10688 |
| `src/api/mode.js` | 89 | createModeHandler | createModeHandler@L3965 |
| `src/api/official-say.js` | 112 | createOfficialSayHandler | createOfficialSayHandler@L3884 |
| `src/api/roles.js` | 221 | createRolesHandler | createRolesHandler@L3638 |
| `src/api/security.js` | 66 | createSecurityHandler | createSecurityHandler@L4205 |
| `src/api/send.js` | 151 | createSendHandler | createSendHandler@L3890 |
| `src/api/sessions.js` | 147 | createSessionsHandler | createSessionsHandler@L3687 |
| `src/api/slang.js` | 367 | createSlangHandler | createSlangHandler@L3661 |
| `src/api/social.js` | 129 | createSocialHandler | createSocialHandler@L3708 |
| `src/api/socialV2-config.js` | 192 | createSocialV2ConfigHandler | createSocialV2ConfigHandler@L4304 |
| `src/api/socialV2-inspect.js` | 172 | createSocialV2InspectHandler | createSocialV2InspectHandler@L4506 |
| `src/api/socialV2-prompt.js` | 149 | createSocialV2PromptHandler | createSocialV2PromptHandler@L4349 |
| `src/api/socialV2-qzone.js` | 417 | createSocialV2QzoneHandler | createSocialV2QzoneHandler@L3819 |
| `src/api/socialV2-read.js` | 316 | createSocialV2ReadHandler | createSocialV2ReadHandler@L3717 |
| `src/api/socialV2-send.js` | 948 | createSocialV2SendHandler | createSocialV2SendHandler@L3789 |
| `src/api/socialV2-wait.js` | 244 | createSocialV2WaitHandler | createSocialV2WaitHandler@L3829 |
| `src/api/socialV2-write.js` | 759 | createSocialV2WriteHandler | createSocialV2WriteHandler@L3747 |
| `src/api/status.js` | 78 | createStatusHandler | createStatusHandler@L3625 |
| `src/api/stickers.js` | 102 | createStickersHandler | createStickersHandler@L3841 |
| `src/api/tokens.js` | 58 | createTokensHandler | createTokensHandler@L3852 |
| `src/api/voice-send.js` | 137 | createVoiceSendHandler | createVoiceSendHandler@L4439 |
| `src/api/whitelist.js` | 64 | createWhitelistHandler | createWhitelistHandler@L4129 |
| `src/http/router.js` | 177 | createRouter | createRouter@L3908 |
