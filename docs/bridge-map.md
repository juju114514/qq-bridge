# bridge.js 索引（自动生成）

生成时间：2026-10-29T00:17:10.849Z　总行数：**12029**

> 改代码前先查这里拿行号，再精读那一段。生成：`node scripts/map-bridge.mjs`

## HTTP 路由（51）

| 行号 | 方法 | 路径 |
| --- | --- | --- |
| 4293 | GET | `/` |
| 4304 | GET | `/api/status` |
| 4310 | GET | `/api/presets` |
| 4319 | POST | `/api/mode` |
| 4378 | ? | `/api/role` |
| 4382 | GET | `/api/preset/sim-prompt` |
| 4401 | POST | `/api/preset/sim-prompt` |
| 4451 | GET | `/api/preset/sim-prompt/backups` |
| 4461 | POST | `/api/preset/sim-prompt/restore` |
| 4499 | ? | `/api/slang` |
| 4508 | ? | `/api/sessions` |
| 4511 | GET | `/api/pending` |
| 4526 | GET | `/api/whitelist` |
| 4530 | POST | `/api/whitelist` |
| 4568 | GET | `/api/dsh/model` |
| 4615 | POST | `/api/dsh/effort` |
| 4634 | GET | `/api/security` |
| 4651 | POST | `/api/security` |
| 4673 | POST | `/api/console/token` |
| 4705 | POST | `/api/test-send` |
| 4729 | ? | `/api/social` |
| 4733 | POST | `/api/console/notify-ai` |
| 4809 | POST | `/api/socialV2/initial-prompt` |
| 4813 | POST | `/api/socialV2/sticker-image` |
| 4819 | POST | `/api/socialV2/config` |
| 4985 | POST | `/api/socialV2/activity` |
| 5003 | GET | `/api/socialV2/state` |
| 5022 | GET | `/api/socialV2/prompt` |
| 5143 | POST | `/api/socialV2/song` |
| 5205 | POST | `/api/voice/send` |
| 5215 | ? | `/api/send/voice` |
| 5324 | POST | `/api/socialV2/sticker-list` |
| 5353 | ? | `/api/stickers` |
| 5357 | POST | `/api/socialV2/wait` |
| 5365 | ? | `/api/tokens/summary` |
| 5373 | GET | `/api/socialV2/message-detail` |
| 5424 | GET | `/api/socialV2/forward-message` |
| 5516 | POST | `/api/socialV2/forward-media` |
| 5535 | GET | `/api/socialV2/active-members` |
| 5564 | GET | `/api/socialV2/group-members` |
| 5609 | POST | `/api/socialV2/slang/submit` |
| 5666 | POST | `/api/authorize/read` |
| 5690 | GET | `/api/images/message` |
| 5698 | GET | `/api/socialV2/tools` |
| 5718 | GET | `/api/socialV2/video-cookies` |
| 5739 | POST | `/api/socialV2/video-link` |
| 5770 | GET | `/api/socialV2/video` |
| 5776 | POST | `/api/inject` |
| 5784 | POST | `/api/send/group` |
| 5790 | POST | `/api/workspace/reset` |
| 5857 | POST | `/api/restart` |

## 函数（319）

| 行号 | 名称 |
| --- | --- |
| 112 | `stickerScopeOf` |
| 125 | `privateAccessVerdict` |
| 131 | `stickerCuratorEnabled` |
| 146 | `stickerDebug` |
| 151 | `stickerHintFor` |
| 202 | `normalizeModeInput` |
| 218 | `settingFromDshNamespace` |
| 229 | `readJsonSafe` |
| 251 | `readConfigObject` |
| 265 | `renameWithRetry` |
| 282 | `atomicWriteJson` |
| 296 | `atomicWriteText` |
| 309 | `loadOrCreateConsoleToken` |
| 340 | `hardenStateDirAcl` |
| 357 | `readActivityTail` |
| 384 | `applyRoleInjectLimit` |
| 410 | `invalidateRoleIndex` |
| 412 | `buildRoleIndex` |
| 446 | `roleIndex` |
| 454 | `roleEntry` |
| 463 | `roleName` |
| 464 | `listRoles` |
| 471 | `resolveRoleName` |
| 493 | `resolveExistingRole` |
| 497 | `roleFilePath` |
| 504 | `firstMeaningfulLine` |
| 512 | `roleWarnings` |
| 534 | `roleSummaries` |
| 574 | `validateRoleName` |
| 588 | `allocateRoleId` |
| 597 | `validateRoleContent` |
| 613 | `readRoleContent` |
| 619 | `readRoleRaw` |
| 624 | `writeRoleContent` |
| 636 | `createRoleCard` |
| 647 | `renameRoleCard` |
| 657 | `deleteRoleCard` |
| 686 | `knownPresetName` |
| 692 | `presetSourceYaml` |
| 696 | `dshHomeDir` |
| 700 | `installedPresetYaml` |
| 711 | `readPresetPromptText` |
| 722 | `presetBackupPrefix` |
| 726 | `backupPresetFile` |
| 741 | `listPresetBackups` |
| 753 | `presetStatus` |
| 770 | `isSilentMarker` |
| 777 | `isSendToolName` |
| 810 | `rememberAgentToken` |
| 831 | `forgetAgentToken` |
| 849 | `normalizeReasoningEffort` |
| 859 | `redactSensitiveText` |
| 872 | `escapeCqText` |
| 877 | `unquoteJsonString` |
| 891 | `appendActivity` |
| 897 | `readRoleState` |
| 900 | `writeRoleState` |
| 911 | `readRolesByKey` |
| 916 | `readRoleStateForKey` |
| 934 | `writeRoleStateForKey` |
| 944 | `sanitizeRoleName` |
| 949 | `normalizeOwnerQQ` |
| 960 | `normalizeIdList` |
| 975 | `persistDshBaseUrl` |
| 990 | `loadConfig` |
| 1378 | `loadState` |
| 1406 | `saveState` |
| 1427 | `consolePortInUse` |
| 1443 | `acquireLock` |
| 1506 | `releaseLock` |
| 1529 | `createCappedLogger` |
| 1558 | `localClock` |
| 1566 | `log` |
| 1589 | `withTimeout` |
| 1605 | `transcribeVoiceLocal` |
| 1663 | `readRuntimePaths` |
| 1675 | `resolveRuntimeDir` |
| 1687 | `ensureDirSafe` |
| 1696 | `cleanSenderName` |
| 1709 | `segmentsToText` |
| 1819 | `sanitizeMediaSummary` |
| 1836 | `looksLikeVideoRef` |
| 1840 | `extractMediaFromSegments` |
| 1905 | `allowed` |
| 1926 | `canonicalV2Key` |
| 1946 | `main` |
| 2000 | `stickerEnabled` |
| 2004 | `saveStickerStoreSafe` |
| 2019 | `onebotHttpAction` |
| 2039 | `syncStickerLibrary` |
| 2079 | `listStickersForV2` |
| 2086 | `getStickerImageData` |
| 2116 | `assertOutboundAuditOk` |
| 2126 | `voiceCfg` |
| 2143 | `voiceLibrary` |
| 2165 | `voicePathInsideLibrary` |
| 2172 | `resolveVoicePathForV2` |
| 2248 | `resolveVoicePathForOperator` |
| 2267 | `voiceBudgetCheck` |
| 2281 | `voiceBudgetCommit` |
| 2295 | `sendVoiceV2` |
| 2384 | `recordVoiceSentV2` |
| 2414 | `verifyVoiceMessageSent` |
| 2449 | `sendVoiceForV2` |
| 2488 | `sendStickerV2` |
| 2566 | `applyStickerNoteV2` |
| 2579 | `setStickerRemarkV2` |
| 2600 | `collectStickerV2` |
| 2646 | `saveSlangStore` |
| 2660 | `queueSlangTask` |
| 2665 | `ensureSlangLearnerSession` |
| 2703 | `invalidateSlangLearnerSession` |
| 2714 | `waitLearnerTurn` |
| 2730 | `runSlangExtraction` |
| 2792 | `runSlangResearch` |
| 2846 | `maybeQueueSlangExtraction` |
| 2861 | `feedSlangWindow` |
| 2875 | `allowSlangSubmit` |
| 2893 | `publicSlangEntry` |
| 2909 | `confirmedSlangListV2` |
| 2918 | `withSlangContext` |
| 2980 | `fetchModelCatalog` |
| 3044 | `rememberModel` |
| 3052 | `recordSessionUsage` |
| 3073 | `recordSessionSnapshot` |
| 3106 | `rebuildInFlightCollector` |
| 3145 | `armPendingWakeLease` |
| 3169 | `disarmPendingWakeLease` |
| 3177 | `clearAllPendingWakeLeases` |
| 3318 | `refreshMode` |
| 3370 | `refreshPresetList` |
| 3384 | `modeAllowed` |
| 3403 | `resolvePresetName` |
| 3418 | `modePreset` |
| 3431 | `isSessionAllowedInCurrentMode` |
| 3441 | `sessionPolicy` |
| 3445 | `isCurrentSession` |
| 3456 | `stopRetiredSessionWork` |
| 3474 | `forgetConversationCaches` |
| 3485 | `retireSession` |
| 3528 | `reconcileSessionPolicies` |
| 3744 | `startDshWatch` |
| 3805 | `noteUpstreamPacket` |
| 3811 | `noteReceiveHealth` |
| 3820 | `snowlumaHealthSnapshot` |
| 3855 | `reportSnowlumaHealth` |
| 3877 | `pollSnowlumaStatus` |
| 3903 | `startSnowlumaWatch` |
| 3915 | `v2ToolEnabled` |
| 3919 | `startConsoleServer` |
| 5899 | `redactKnownTokensOnly` |
| 5914 | `sendToQQ` |
| 5956 | `lastSendSucceeded` |
| 5961 | `singleLineForQQ` |
| 5970 | `splitLongSegment` |
| 6049 | `isCjkChar` |
| 6062 | `splitByCjkSpaces` |
| 6085 | `planSocialTimeline` |
| 6112 | `sendBurstToQQ` |
| 6170 | `resolveGuideTopic` |
| 6181 | `matchGuideFile` |
| 6217 | `sendGuideTemplate` |
| 6270 | `sendPrivateViaTempSession` |
| 6317 | `pickStickersByMood` |
| 6341 | `onebotSend` |
| 6404 | `mimeFromBuffer` |
| 6413 | `mimeFromUrl` |
| 6426 | `getImageDimensions` |
| 6474 | `base64FromMaybe` |
| 6569 | `videoLinkConfig` |
| 6572 | `fetchVideoFile` |
| 6600 | `analyzeVideoFile` |
| 6649 | `videoToModelParts` |
| 6664 | `videoLinkToModelParts` |
| 6726 | `toModelMedia` |
| 6736 | `isSafeLocalMediaPath` |
| 6750 | `isProbablySafeImageFileRef` |
| 6765 | `emojiCdnCandidates` |
| 6772 | `emojiIdFromFileName` |
| 6778 | `acceptImageBuffer` |
| 6792 | `fetchOneBotImage` |
| 6872 | `fetchFaceMedia` |
| 6898 | `resolveMediaList` |
| 6960 | `nounForVideo` |
| 6962 | `fetchMediaData` |
| 7131 | `visionApiKey` |
| 7148 | `describeImageBuffer` |
| 7179 | `autoDescribeMedia` |
| 7206 | `mediaHintFor` |
| 7214 | `findMessageMedia` |
| 7244 | `clampGapV2` |
| 7250 | `computeGapsV2` |
| 7280 | `sendMessagesV2` |
| 7315 | `shouldAuditKey` |
| 7323 | `captureSendGuard` |
| 7335 | `shouldBlockSilentReply` |
| 7341 | `auditAndSend` |
| 7363 | `ensureChatModel` |
| 7390 | `ensureSession` |
| 7524 | `normalizeSpeakerIdsV2` |
| 7545 | `pickWakeTriggersV2` |
| 7556 | `defaultWakeConfigV2` |
| 7592 | `refreshDefaultWakeConfigV2` |
| 7609 | `refreshAllDefaultWakeConfigsV2` |
| 7625 | `hasExplicitEndV2` |
| 7632 | `isSleepingConfigV2` |
| 7638 | `preSleepWaitBlockedV2` |
| 7654 | `computeWakeSafetyV2` |
| 7669 | `ensureWakeableV2` |
| 7693 | `getSocialV2State` |
| 7740 | `loadSocialV2State` |
| 7862 | `saveSocialV2State` |
| 7908 | `initialPromptMaxChars` |
| 7914 | `normalizeInitialPromptText` |
| 7927 | `loadInitialPrompts` |
| 7971 | `saveInitialPrompts` |
| 7989 | `getInitialPrompt` |
| 7999 | `setInitialPrompt` |
| 8031 | `formatInitialPromptV2` |
| 8040 | `formatParticipationV2` |
| 8076 | `suggestQuietMsV2` |
| 8089 | `formatMemoryV2` |
| 8125 | `memoryCapFor` |
| 8140 | `appendMemoryV2` |
| 8213 | `isSocialEnabled` |
| 8217 | `socialState` |
| 8225 | `isDirectAddress` |
| 8239 | `isDirectedAtAi` |
| 8256 | `isMustReplyText` |
| 8266 | `appendRecentMessage` |
| 8284 | `appendSummary` |
| 8293 | `buildContextBlock` |
| 8299 | `enterActive` |
| 8320 | `cancelSocialTimers` |
| 8327 | `cancelAllSocialTimers` |
| 8335 | `cleanupSocialForModeChange` |
| 8351 | `leaveActive` |
| 8359 | `buildBatchPrompt` |
| 8369 | `buildProbePrompt` |
| 8375 | `buildActiveExitPrompt` |
| 8384 | `triggerActiveDurationExit` |
| 8409 | `buildProactivePrompt` |
| 8421 | `appendVisionForWake` |
| 8445 | `deliverPromptNow` |
| 8535 | `deliverPrompt` |
| 8547 | `processPromptQueue` |
| 8570 | `scheduleSocialReply` |
| 8587 | `socialLoopTick` |
| 8705 | `startSocialLoop` |
| 8711 | `flushSummaries` |
| 8767 | `roleRawContent` |
| 8798 | `roleHintForMode` |
| 8814 | `setRoleNeedTagsFromText` |
| 8823 | `clearRoleNeedTags` |
| 8827 | `currentRoleHint` |
| 8834 | `isCjkLikeChar` |
| 8848 | `convertExampleSpacesToComma` |
| 8873 | `findCjkSpaceWarning` |
| 8897 | `findSplitBoundaryWarning` |
| 8918 | `currentRoleHintV2` |
| 8951 | `pruneGroupMemberNameCache` |
| 8966 | `assertGroupMember` |
| 8992 | `resolveGroupMemberName` |
| 9028 | `pruneReplyInfoCache` |
| 9039 | `resolveReplyInfo` |
| 9106 | `resolveReplyTargetV2` |
| 9145 | `isQuoteTargetSelf` |
| 9157 | `appendSocialV2Message` |
| 9232 | `appendSocialV2Poke` |
| 9274 | `recordSentMessagesV2` |
| 9300 | `readFeedbackEntries` |
| 9305 | `appendFeedbackEntry` |
| 9316 | `readToolLog` |
| 9332 | `appendToolLog` |
| 9364 | `redactSensitive` |
| 9380 | `sanitizeToolArgs` |
| 9401 | `evaluateWakeTriggerV2` |
| 9454 | `readThroughSeqV2` |
| 9470 | `noteModelMessagesV2` |
| 9480 | `requestedReadThroughSeqV2` |
| 9492 | `acknowledgeMessagesV2` |
| 9518 | `localClockText` |
| 9524 | `timeSenseCfg` |
| 9537 | `wakeReasonSeq` |
| 9544 | `findV2MessageBySeq` |
| 9558 | `buildTimeSenseLine` |
| 9587 | `buildWakeSnapshotV2` |
| 9640 | `replyTimingV2` |
| 9654 | `selfIdentityTextV2` |
| 9666 | `buildWakePromptV2` |
| 9743 | `buildWakeReminderPromptV2` |
| 9753 | `sendWakePromptV2` |
| 9878 | `cancelReplyCheckV2` |
| 9885 | `scheduleReplyCheckV2` |
| 9906 | `busyReasonV2` |
| 9927 | `socialV2BusySnapshot` |
| 9953 | `isConversationBusyV2` |
| 9990 | `wakePriorityV2` |
| 9999 | `isTimerWakeReason` |
| 10003 | `scheduleWakeV2` |
| 10059 | `replayPendingWakeReasonsV2` |
| 10090 | `setupSleepTimerV2` |
| 10133 | `cancelProactiveCheckV2` |
| 10140 | `scheduleProactiveCheckV2` |
| 10174 | `clearSocialV2Timers` |
| 10201 | `clearAllSocialV2Timers` |
| 10210 | `drainPromptQueue` |
| 10218 | `drainAllPromptQueues` |
| 10226 | `handleIncoming` |
| 10944 | `cancelPendingEntry` |
| 10968 | `handlePendingAnswer` |
| 11024 | `handlePokeNotice` |
| 11084 | `registerPending` |
| 11116 | `trackTurnEvent` |
| 11135 | `pumpMux` |
| 11669 | `sendOfficialProactive` |
| 11869 | `applyHealedTokens` |
| 11924 | `syncTokenToFile` |
| 11934 | `healTokenIfStale` |

## 模块导入（63）

- L8 `node:fs`
- L9 `node:os`
- L10 `node:http`
- L11 `node:path`
- L12 `node:crypto`
- L13 `node:child_process`
- L14 `js-yaml`
- L15 `./preset-prompt.js`
- L22 `./http/response.js`
- L23 `./http/body.js`
- L24 `./http/prelude.js`
- L25 `./http/router.js`
- L26 `node:url`
- L27 `./onebot-ws.js`
- L28 `./dsh-client.js`
- L29 `./md-to-plain.js`
- L30 `./sensitive.js`
- L31 `./v2-wait.js`
- L32 `./qq-model-view.js`
- L33 `./safe-fetch.js`
- L34 `./media-normalize.js`
- L35 `./ocr.js`
- L36 `./audio-transcribe.js`
- L37 `./video-link.js`
- L38 `./video-download.js`
- L39 `./douyin-resolve.js`
- L40 `./dsh-port.js`
- L41 `./official-transport.js`
- L42 `./conv-key.js`
- L43 `./state-schema.js`
- L44 `./bili-enrich.js`
- L45 `./dead-letter.js`
- L46 `./api/dead-letter.js`
- L47 `./official-proactive.js`
- L48 `./api/official-say.js`
- L49 `./instance-lock.js`
- L50 `./api/inject.js`
- L51 `./pending-queue.js`
- L52 `./send-voice-lib.js`
- L53 `./snowluma-conn.js`
- L54 `./api/status.js`
- L55 `./api/images.js`
- L56 `./api/roles.js`
- L57 `./api/slang.js`
- L58 `./api/stickers.js`
- L59 `./sticker-hint.js`
- L60 `./sticker-notes.js`
- L61 `./sticker-pending.js`
- L62 `./private-access.js`
- L63 `./sticker-curator.js`
- L64 `./api/send.js`
- L65 `./api/sessions.js`
- L66 `./api/tokens.js`
- L67 `./api/social.js`
- L68 `./api/socialV2-read.js`
- L69 `./api/socialV2-write.js`
- L70 `./api/socialV2-send.js`
- L71 `./api/socialV2-qzone.js`
- L72 `./api/socialV2-wait.js`
- L73 `./state-acl.mjs`
- L74 `./forward.js`
- L75 `./model-prices.js`
- L76 `./token-ledger.js`

## 顶层常量（46）

`ROOT`(L104) · `STATE_DIR`(L105) · `STATE_FILE`(L106) · `ROLE_STATE_FILE`(L107) · `SLANG_FILE`(L108) · `STICKER_NOTES_FILE`(L111) · `SLANG_SESSION_FILE`(L165) · `SOCIAL_V2_FILE`(L166) · `INITIAL_PROMPTS_FILE`(L169) · `STICKER_FILE`(L170) · `FEEDBACK_FILE`(L171) · `TOOL_LOG_FILE`(L172) · `TOKEN_USAGE_FILE`(L173) · `ACTIVITY_LOG`(L174) · `BRIDGE_LOG`(L175) · `MODE_INPUT_ALIASES`(L191) · `VALID_MODES`(L199) · `ROLE_NON_CARD_FILES`(L370) · `ROLES_DIR`(L374) · `ROLE_NAME_MAX`(L375) · `ROLE_CONTENT_MAX_BYTES`(L376) · `ROLE_INJECT_MAX_CHARS_DEFAULT`(L382) · `ROLE_RESERVED_NAMES`(L389) · `WINDOWS_RESERVED_NAMES`(L392) · `ROLE_INDEX_TTL_MS`(L408) · `PRESET_NAMES`(L673) · `PRESET_BACKUP_DIR`(L674) · `PRESET_BACKUP_KEEP`(L675) · `SILENT_MARKER`(L769) · `SEND_TOOL_RE`(L776) · `SPACE_SPLIT_HINT`(L783) · `DIRECTION_HINT`(L785) · `KNOWN_AGENT_TOKENS`(L788) · `CONVERSATION_TOKENS`(L803) · `MAX_KNOWN_AGENT_TOKENS`(L804) · `REASONING_EFFORT_OPTIONS`(L847) · `REASONING_EFFORT_DEFAULT`(L848) · `ROLES_BY_KEY_FILE`(L909) · `LOCK_FILE`(L1417) · `LOG_LINE_MAX`(L1518) · `SEND_TIMEOUT_MS`(L1584) · `DSH_CONTROL_TIMEOUT_MS`(L1588) · `QQBOT_ROOT`(L1652) · `VIDEO_REF_RE`(L1835) · `APPROVE_WORDS`(L1938) · `REJECT_WORDS`(L1939)
