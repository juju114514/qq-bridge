# 控制台路由总表

> **自动生成，勿手改**：`node scripts/gen-route-index.mjs --write`
> 守卫：`scripts/check-route-inventory.mjs`（模块导出 vs 派发链对账 + 内联路由预算）

- 已搬进模块：**109** 条（24 个文件）
- 仍在 bridge 内联：**46** 条（波次 4 目标是 0）

## src/api/console-extra-routes.js（4 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/diagnostics` | handleExtraRoutes |
| ANY | `/api/scheduler` | handleExtraRoutes |
| ANY | `/api/scheduler/` | handleExtraRoutes |
| GET | `/api/socialV2/people` | handleExtraRoutes |

## src/api/console-notify.js（1 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/console/notify-ai` | createConsoleNotifyHandler |

## src/api/dead-letter.js（2 条）

| 方法 | 路径 | handler |
|---|---|---|
| ANY | `/api/socialV2/dead-letter` | createDeadLetterHandler |
| ANY | `/api/socialV2/dead-letter/requeue` | createDeadLetterHandler |

## src/api/inject.js（1 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/inject` | createInjectHandler |

## src/api/mode.js（1 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/mode` | createModeHandler |

## src/api/official-say.js（3 条）

| 方法 | 路径 | handler |
|---|---|---|
| ANY | `/api/socialV2/official-proactive` | createOfficialSayHandler |
| ANY | `/api/socialV2/official-recall` | createOfficialSayHandler |
| ANY | `/api/socialV2/official-say` | createOfficialSayHandler |

## src/api/roles.js（9 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/role` | createRolesHandler |
| POST | `/api/role-mode` | createRolesHandler |
| GET | `/api/roles` | createRolesHandler |
| GET | `/api/roles/content` | createRolesHandler |
| POST | `/api/roles/create` | createRolesHandler |
| POST | `/api/roles/delete` | createRolesHandler |
| POST | `/api/roles/limit` | createRolesHandler |
| POST | `/api/roles/rename` | createRolesHandler |
| POST | `/api/roles/update` | createRolesHandler |

## src/api/security.js（2 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/security` | createSecurityHandler |
| POST | `/api/security` | createSecurityHandler |

## src/api/send.js（2 条）

| 方法 | 路径 | handler |
|---|---|---|
| ANY | `/api/send/private` | createSendHandler |
| ANY | `/api/send/reply` | createSendHandler |

## src/api/sessions.js（2 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/session/reset` | createSessionsHandler |
| GET | `/api/sessions` | createSessionsHandler |

## src/api/slang.js（9 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/slang` | createSlangHandler |
| POST | `/api/slang` | createSlangHandler |
| POST | `/api/slang/batch-confirm` | createSlangHandler |
| POST | `/api/slang/batch-delete` | createSlangHandler |
| POST | `/api/slang/batch-reject` | createSlangHandler |
| POST | `/api/slang/clear` | createSlangHandler |
| POST | `/api/slang/config` | createSlangHandler |
| POST | `/api/slang/extract` | createSlangHandler |
| POST | `/api/slang/research` | createSlangHandler |

## src/api/social.js（4 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/social` | createSocialHandler |
| POST | `/api/social` | createSocialHandler |
| POST | `/api/social/flush` | createSocialHandler |
| POST | `/api/social/state` | createSocialHandler |

## src/api/socialV2-config.js（1 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/socialV2/config` | createSocialV2ConfigHandler |

## src/api/socialV2-inspect.js（2 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/socialV2/forward-message` | createSocialV2InspectHandler |
| GET | `/api/socialV2/message-detail` | createSocialV2InspectHandler |

## src/api/socialV2-prompt.js（1 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/socialV2/prompt` | createSocialV2PromptHandler |

## src/api/socialV2-qzone.js（6 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/socialV2/guide` | createSocialV2QzoneHandler |
| POST | `/api/socialV2/qzone` | createSocialV2QzoneHandler |
| POST | `/api/socialV2/qzone-comment` | createSocialV2QzoneHandler |
| POST | `/api/socialV2/qzone-feeds` | createSocialV2QzoneHandler |
| POST | `/api/socialV2/qzone-like` | createSocialV2QzoneHandler |
| POST | `/api/socialV2/qzone-user-posts` | createSocialV2QzoneHandler |

## src/api/socialV2-read.js（14 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/socialV2/activity` | createSocialV2ReadHandler |
| GET | `/api/socialV2/config` | createSocialV2ReadHandler |
| GET | `/api/socialV2/feedback` | createSocialV2ReadHandler |
| GET | `/api/socialV2/memory` | createSocialV2ReadHandler |
| GET | `/api/socialV2/my-recent` | createSocialV2ReadHandler |
| GET | `/api/socialV2/recent` | createSocialV2ReadHandler |
| GET | `/api/socialV2/self-image` | createSocialV2ReadHandler |
| GET | `/api/socialV2/slang/query` | createSocialV2ReadHandler |
| GET | `/api/socialV2/states` | createSocialV2ReadHandler |
| GET | `/api/socialV2/sticker-list` | createSocialV2ReadHandler |
| GET | `/api/socialV2/tool-log` | createSocialV2ReadHandler |
| GET | `/api/socialV2/unread` | createSocialV2ReadHandler |
| GET | `/api/socialV2/voices` | createSocialV2ReadHandler |
| GET | `/api/voice/list` | createSocialV2ReadHandler |

## src/api/socialV2-send.js（14 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/socialV2/collect-sticker` | createSocialV2SendHandler |
| POST | `/api/socialV2/like` | createSocialV2SendHandler |
| POST | `/api/socialV2/say` | createSocialV2SendHandler |
| POST | `/api/socialV2/send-burst` | createSocialV2SendHandler |
| POST | `/api/socialV2/send-message` | createSocialV2SendHandler |
| POST | `/api/socialV2/send-poke` | createSocialV2SendHandler |
| POST | `/api/socialV2/send-sticker` | createSocialV2SendHandler |
| POST | `/api/socialV2/send-voice` | createSocialV2SendHandler |
| POST | `/api/socialV2/sing` | createSocialV2SendHandler |
| POST | `/api/socialV2/sticker-image` | createSocialV2SendHandler |
| POST | `/api/socialV2/sticker-image` | createSocialV2SendHandler |
| POST | `/api/socialV2/sticker-note` | createSocialV2SendHandler |
| POST | `/api/socialV2/sticker-pick` | createSocialV2SendHandler |
| POST | `/api/socialV2/sticker-remark` | createSocialV2SendHandler |

## src/api/socialV2-wait.js（1 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/socialV2/wait` | createSocialV2WaitHandler |

## src/api/socialV2-write.js（16 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/socialV2/check-send` | createSocialV2WriteHandler |
| POST | `/api/socialV2/feedback` | createSocialV2WriteHandler |
| POST | `/api/socialV2/feedback-clear` | createSocialV2WriteHandler |
| POST | `/api/socialV2/initial-prompt` | createSocialV2WriteHandler |
| POST | `/api/socialV2/initial-prompt` | createSocialV2WriteHandler |
| POST | `/api/socialV2/mark-read` | createSocialV2WriteHandler |
| POST | `/api/socialV2/memory-append` | createSocialV2WriteHandler |
| POST | `/api/socialV2/memory-clear` | createSocialV2WriteHandler |
| POST | `/api/socialV2/memory-remove` | createSocialV2WriteHandler |
| POST | `/api/socialV2/memory-split` | createSocialV2WriteHandler |
| POST | `/api/socialV2/memory-update` | createSocialV2WriteHandler |
| POST | `/api/socialV2/record-sent` | createSocialV2WriteHandler |
| POST | `/api/socialV2/reset` | createSocialV2WriteHandler |
| POST | `/api/socialV2/tool-log/clear` | createSocialV2WriteHandler |
| POST | `/api/socialV2/wake` | createSocialV2WriteHandler |
| POST | `/api/socialV2/wake-config` | createSocialV2WriteHandler |

## src/api/stickers.js（4 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/stickers` | createStickersHandler |
| POST | `/api/stickers/note` | createStickersHandler |
| POST | `/api/stickers/remark` | createStickersHandler |
| POST | `/api/stickers/sync` | createStickersHandler |

## src/api/tokens.js（5 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/tokens/recent` | createTokensHandler |
| POST | `/api/tokens/reset` | createTokensHandler |
| GET | `/api/tokens/series` | createTokensHandler |
| GET | `/api/tokens/summary` | createTokensHandler |
| GET | `/api/tokens/turns` | createTokensHandler |

## src/api/voice-send.js（3 条）

| 方法 | 路径 | handler |
|---|---|---|
| POST | `/api/send/voice` | createVoiceSendHandler |
| ANY | `/api/send/voice` | createVoiceSendHandler |
| POST | `/api/voice/send` | createVoiceSendHandler |

## src/api/whitelist.js（2 条）

| 方法 | 路径 | handler |
|---|---|---|
| GET | `/api/whitelist` | createWhitelistHandler |
| POST | `/api/whitelist` | createWhitelistHandler |

## src/bridge.js 内联（46 条，待迁移）

| 方法 | 路径 | 行号 |
|---|---|---|
| GET | `/` | L4011 |
| GET | `/api/status` | L4022 |
| GET | `/api/presets` | L4028 |
| POST | `/api/mode` | L4037 |
| GET | `/api/preset/sim-prompt` | L4055 |
| POST | `/api/preset/sim-prompt` | L4059 |
| GET | `/api/preset/sim-prompt/backups` | L4063 |
| POST | `/api/preset/sim-prompt/restore` | L4067 |
| GET | `/api/pending` | L4084 |
| ANY | `/api/whitelist` | L4099 |
| GET | `/api/dsh/model` | L4109 |
| POST | `/api/dsh/effort` | L4113 |
| ANY | `/api/security` | L4119 |
| POST | `/api/console/token` | L4132 |
| POST | `/api/test-send` | L4138 |
| POST | `/api/console/notify-ai` | L4147 |
| POST | `/api/socialV2/config` | L4164 |
| POST | `/api/socialV2/activity` | L4172 |
| GET | `/api/socialV2/state` | L4190 |
| GET | `/api/socialV2/prompt` | L4209 |
| POST | `/api/socialV2/song` | L4239 |
| POST | `/api/voice/send` | L4301 |
| POST | `/api/send/voice` | L4301 |
| POST | `/api/socialV2/sticker-list` | L4319 |
| POST | `/api/socialV2/wait` | L4349 |
| ANY | `/api/tokens/summary` | L4357 |
| ANY | `/api/tokens/` | L4357 |
| ANY | `/api/socialV2/message-detail` | L4365 |
| ANY | `/api/socialV2/forward-message` | L4365 |
| POST | `/api/socialV2/forward-media` | L4375 |
| GET | `/api/socialV2/active-members` | L4394 |
| POST | `/api/socialV2/people-note` | L4418 |
| GET | `/api/socialV2/group-members` | L4429 |
| POST | `/api/socialV2/slang/submit` | L4435 |
| POST | `/api/authorize/read` | L4440 |
| GET | `/api/images/message` | L4447 |
| GET | `/api/socialV2/tools` | L4455 |
| GET | `/api/socialV2/video-cookies` | L4475 |
| POST | `/api/socialV2/video-link` | L4482 |
| GET | `/api/socialV2/video` | L4494 |
| POST | `/api/inject` | L4500 |
| POST | `/api/send/group` | L4508 |
| POST | `/api/send/private` | L4508 |
| POST | `/api/send/reply` | L4508 |
| POST | `/api/workspace/reset` | L4514 |
| POST | `/api/restart` | L4520 |
