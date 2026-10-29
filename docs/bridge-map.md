# bridge.js 索引（自动生成）

生成时间：2026-10-29T00:27:53.330Z　总行数：**11665**

> 改代码前先查这里拿行号，再精读那一段。生成：`node scripts/map-bridge.mjs`

## HTTP 路由（51）

| 行号 | 方法 | 路径 |
| --- | --- | --- |
| 3929 | GET | `/` |
| 3940 | GET | `/api/status` |
| 3946 | GET | `/api/presets` |
| 3955 | POST | `/api/mode` |
| 4014 | ? | `/api/role` |
| 4018 | GET | `/api/preset/sim-prompt` |
| 4037 | POST | `/api/preset/sim-prompt` |
| 4087 | GET | `/api/preset/sim-prompt/backups` |
| 4097 | POST | `/api/preset/sim-prompt/restore` |
| 4135 | ? | `/api/slang` |
| 4144 | ? | `/api/sessions` |
| 4147 | GET | `/api/pending` |
| 4162 | GET | `/api/whitelist` |
| 4166 | POST | `/api/whitelist` |
| 4204 | GET | `/api/dsh/model` |
| 4251 | POST | `/api/dsh/effort` |
| 4270 | GET | `/api/security` |
| 4287 | POST | `/api/security` |
| 4309 | POST | `/api/console/token` |
| 4341 | POST | `/api/test-send` |
| 4365 | ? | `/api/social` |
| 4369 | POST | `/api/console/notify-ai` |
| 4445 | POST | `/api/socialV2/initial-prompt` |
| 4449 | POST | `/api/socialV2/sticker-image` |
| 4455 | POST | `/api/socialV2/config` |
| 4621 | POST | `/api/socialV2/activity` |
| 4639 | GET | `/api/socialV2/state` |
| 4658 | GET | `/api/socialV2/prompt` |
| 4779 | POST | `/api/socialV2/song` |
| 4841 | POST | `/api/voice/send` |
| 4851 | ? | `/api/send/voice` |
| 4960 | POST | `/api/socialV2/sticker-list` |
| 4989 | ? | `/api/stickers` |
| 4993 | POST | `/api/socialV2/wait` |
| 5001 | ? | `/api/tokens/summary` |
| 5009 | GET | `/api/socialV2/message-detail` |
| 5060 | GET | `/api/socialV2/forward-message` |
| 5152 | POST | `/api/socialV2/forward-media` |
| 5171 | GET | `/api/socialV2/active-members` |
| 5200 | GET | `/api/socialV2/group-members` |
| 5245 | POST | `/api/socialV2/slang/submit` |
| 5302 | POST | `/api/authorize/read` |
| 5326 | GET | `/api/images/message` |
| 5334 | GET | `/api/socialV2/tools` |
| 5354 | GET | `/api/socialV2/video-cookies` |
| 5375 | POST | `/api/socialV2/video-link` |
| 5406 | GET | `/api/socialV2/video` |
| 5412 | POST | `/api/inject` |
| 5420 | POST | `/api/send/group` |
| 5426 | POST | `/api/workspace/reset` |
| 5493 | POST | `/api/restart` |

## 函数（318）

| 行号 | 名称 |
| --- | --- |
| 113 | `stickerScopeOf` |
| 126 | `privateAccessVerdict` |
| 132 | `stickerCuratorEnabled` |
| 147 | `stickerDebug` |
| 152 | `stickerHintFor` |
| 203 | `normalizeModeInput` |
| 219 | `settingFromDshNamespace` |
| 230 | `readJsonSafe` |
| 252 | `readConfigObject` |
| 266 | `renameWithRetry` |
| 283 | `atomicWriteJson` |
| 297 | `atomicWriteText` |
| 310 | `loadOrCreateConsoleToken` |
| 341 | `hardenStateDirAcl` |
| 358 | `readActivityTail` |
| 385 | `applyRoleInjectLimit` |
| 411 | `invalidateRoleIndex` |
| 413 | `buildRoleIndex` |
| 447 | `roleIndex` |
| 455 | `roleEntry` |
| 464 | `roleName` |
| 465 | `listRoles` |
| 472 | `resolveRoleName` |
| 494 | `resolveExistingRole` |
| 498 | `roleFilePath` |
| 505 | `firstMeaningfulLine` |
| 513 | `roleWarnings` |
| 535 | `roleSummaries` |
| 575 | `validateRoleName` |
| 589 | `allocateRoleId` |
| 598 | `validateRoleContent` |
| 614 | `readRoleContent` |
| 620 | `readRoleRaw` |
| 625 | `writeRoleContent` |
| 637 | `createRoleCard` |
| 648 | `renameRoleCard` |
| 658 | `deleteRoleCard` |
| 687 | `knownPresetName` |
| 693 | `presetSourceYaml` |
| 697 | `dshHomeDir` |
| 701 | `installedPresetYaml` |
| 712 | `readPresetPromptText` |
| 723 | `presetBackupPrefix` |
| 727 | `backupPresetFile` |
| 742 | `listPresetBackups` |
| 754 | `presetStatus` |
| 771 | `isSilentMarker` |
| 778 | `isSendToolName` |
| 811 | `rememberAgentToken` |
| 832 | `forgetAgentToken` |
| 850 | `normalizeReasoningEffort` |
| 860 | `redactSensitiveText` |
| 873 | `escapeCqText` |
| 878 | `unquoteJsonString` |
| 892 | `appendActivity` |
| 898 | `readRoleState` |
| 901 | `writeRoleState` |
| 912 | `readRolesByKey` |
| 917 | `readRoleStateForKey` |
| 935 | `writeRoleStateForKey` |
| 945 | `sanitizeRoleName` |
| 950 | `normalizeOwnerQQ` |
| 961 | `normalizeIdList` |
| 976 | `persistDshBaseUrl` |
| 1014 | `loadState` |
| 1042 | `saveState` |
| 1063 | `consolePortInUse` |
| 1079 | `acquireLock` |
| 1142 | `releaseLock` |
| 1165 | `createCappedLogger` |
| 1194 | `localClock` |
| 1202 | `log` |
| 1225 | `withTimeout` |
| 1241 | `transcribeVoiceLocal` |
| 1299 | `readRuntimePaths` |
| 1311 | `resolveRuntimeDir` |
| 1323 | `ensureDirSafe` |
| 1332 | `cleanSenderName` |
| 1345 | `segmentsToText` |
| 1455 | `sanitizeMediaSummary` |
| 1472 | `looksLikeVideoRef` |
| 1476 | `extractMediaFromSegments` |
| 1541 | `allowed` |
| 1562 | `canonicalV2Key` |
| 1582 | `main` |
| 1636 | `stickerEnabled` |
| 1640 | `saveStickerStoreSafe` |
| 1655 | `onebotHttpAction` |
| 1675 | `syncStickerLibrary` |
| 1715 | `listStickersForV2` |
| 1722 | `getStickerImageData` |
| 1752 | `assertOutboundAuditOk` |
| 1762 | `voiceCfg` |
| 1779 | `voiceLibrary` |
| 1801 | `voicePathInsideLibrary` |
| 1808 | `resolveVoicePathForV2` |
| 1884 | `resolveVoicePathForOperator` |
| 1903 | `voiceBudgetCheck` |
| 1917 | `voiceBudgetCommit` |
| 1931 | `sendVoiceV2` |
| 2020 | `recordVoiceSentV2` |
| 2050 | `verifyVoiceMessageSent` |
| 2085 | `sendVoiceForV2` |
| 2124 | `sendStickerV2` |
| 2202 | `applyStickerNoteV2` |
| 2215 | `setStickerRemarkV2` |
| 2236 | `collectStickerV2` |
| 2282 | `saveSlangStore` |
| 2296 | `queueSlangTask` |
| 2301 | `ensureSlangLearnerSession` |
| 2339 | `invalidateSlangLearnerSession` |
| 2350 | `waitLearnerTurn` |
| 2366 | `runSlangExtraction` |
| 2428 | `runSlangResearch` |
| 2482 | `maybeQueueSlangExtraction` |
| 2497 | `feedSlangWindow` |
| 2511 | `allowSlangSubmit` |
| 2529 | `publicSlangEntry` |
| 2545 | `confirmedSlangListV2` |
| 2554 | `withSlangContext` |
| 2616 | `fetchModelCatalog` |
| 2680 | `rememberModel` |
| 2688 | `recordSessionUsage` |
| 2709 | `recordSessionSnapshot` |
| 2742 | `rebuildInFlightCollector` |
| 2781 | `armPendingWakeLease` |
| 2805 | `disarmPendingWakeLease` |
| 2813 | `clearAllPendingWakeLeases` |
| 2954 | `refreshMode` |
| 3006 | `refreshPresetList` |
| 3020 | `modeAllowed` |
| 3039 | `resolvePresetName` |
| 3054 | `modePreset` |
| 3067 | `isSessionAllowedInCurrentMode` |
| 3077 | `sessionPolicy` |
| 3081 | `isCurrentSession` |
| 3092 | `stopRetiredSessionWork` |
| 3110 | `forgetConversationCaches` |
| 3121 | `retireSession` |
| 3164 | `reconcileSessionPolicies` |
| 3380 | `startDshWatch` |
| 3441 | `noteUpstreamPacket` |
| 3447 | `noteReceiveHealth` |
| 3456 | `snowlumaHealthSnapshot` |
| 3491 | `reportSnowlumaHealth` |
| 3513 | `pollSnowlumaStatus` |
| 3539 | `startSnowlumaWatch` |
| 3551 | `v2ToolEnabled` |
| 3555 | `startConsoleServer` |
| 5535 | `redactKnownTokensOnly` |
| 5550 | `sendToQQ` |
| 5592 | `lastSendSucceeded` |
| 5597 | `singleLineForQQ` |
| 5606 | `splitLongSegment` |
| 5685 | `isCjkChar` |
| 5698 | `splitByCjkSpaces` |
| 5721 | `planSocialTimeline` |
| 5748 | `sendBurstToQQ` |
| 5806 | `resolveGuideTopic` |
| 5817 | `matchGuideFile` |
| 5853 | `sendGuideTemplate` |
| 5906 | `sendPrivateViaTempSession` |
| 5953 | `pickStickersByMood` |
| 5977 | `onebotSend` |
| 6040 | `mimeFromBuffer` |
| 6049 | `mimeFromUrl` |
| 6062 | `getImageDimensions` |
| 6110 | `base64FromMaybe` |
| 6205 | `videoLinkConfig` |
| 6208 | `fetchVideoFile` |
| 6236 | `analyzeVideoFile` |
| 6285 | `videoToModelParts` |
| 6300 | `videoLinkToModelParts` |
| 6362 | `toModelMedia` |
| 6372 | `isSafeLocalMediaPath` |
| 6386 | `isProbablySafeImageFileRef` |
| 6401 | `emojiCdnCandidates` |
| 6408 | `emojiIdFromFileName` |
| 6414 | `acceptImageBuffer` |
| 6428 | `fetchOneBotImage` |
| 6508 | `fetchFaceMedia` |
| 6534 | `resolveMediaList` |
| 6596 | `nounForVideo` |
| 6598 | `fetchMediaData` |
| 6767 | `visionApiKey` |
| 6784 | `describeImageBuffer` |
| 6815 | `autoDescribeMedia` |
| 6842 | `mediaHintFor` |
| 6850 | `findMessageMedia` |
| 6880 | `clampGapV2` |
| 6886 | `computeGapsV2` |
| 6916 | `sendMessagesV2` |
| 6951 | `shouldAuditKey` |
| 6959 | `captureSendGuard` |
| 6971 | `shouldBlockSilentReply` |
| 6977 | `auditAndSend` |
| 6999 | `ensureChatModel` |
| 7026 | `ensureSession` |
| 7160 | `normalizeSpeakerIdsV2` |
| 7181 | `pickWakeTriggersV2` |
| 7192 | `defaultWakeConfigV2` |
| 7228 | `refreshDefaultWakeConfigV2` |
| 7245 | `refreshAllDefaultWakeConfigsV2` |
| 7261 | `hasExplicitEndV2` |
| 7268 | `isSleepingConfigV2` |
| 7274 | `preSleepWaitBlockedV2` |
| 7290 | `computeWakeSafetyV2` |
| 7305 | `ensureWakeableV2` |
| 7329 | `getSocialV2State` |
| 7376 | `loadSocialV2State` |
| 7498 | `saveSocialV2State` |
| 7544 | `initialPromptMaxChars` |
| 7550 | `normalizeInitialPromptText` |
| 7563 | `loadInitialPrompts` |
| 7607 | `saveInitialPrompts` |
| 7625 | `getInitialPrompt` |
| 7635 | `setInitialPrompt` |
| 7667 | `formatInitialPromptV2` |
| 7676 | `formatParticipationV2` |
| 7712 | `suggestQuietMsV2` |
| 7725 | `formatMemoryV2` |
| 7761 | `memoryCapFor` |
| 7776 | `appendMemoryV2` |
| 7849 | `isSocialEnabled` |
| 7853 | `socialState` |
| 7861 | `isDirectAddress` |
| 7875 | `isDirectedAtAi` |
| 7892 | `isMustReplyText` |
| 7902 | `appendRecentMessage` |
| 7920 | `appendSummary` |
| 7929 | `buildContextBlock` |
| 7935 | `enterActive` |
| 7956 | `cancelSocialTimers` |
| 7963 | `cancelAllSocialTimers` |
| 7971 | `cleanupSocialForModeChange` |
| 7987 | `leaveActive` |
| 7995 | `buildBatchPrompt` |
| 8005 | `buildProbePrompt` |
| 8011 | `buildActiveExitPrompt` |
| 8020 | `triggerActiveDurationExit` |
| 8045 | `buildProactivePrompt` |
| 8057 | `appendVisionForWake` |
| 8081 | `deliverPromptNow` |
| 8171 | `deliverPrompt` |
| 8183 | `processPromptQueue` |
| 8206 | `scheduleSocialReply` |
| 8223 | `socialLoopTick` |
| 8341 | `startSocialLoop` |
| 8347 | `flushSummaries` |
| 8403 | `roleRawContent` |
| 8434 | `roleHintForMode` |
| 8450 | `setRoleNeedTagsFromText` |
| 8459 | `clearRoleNeedTags` |
| 8463 | `currentRoleHint` |
| 8470 | `isCjkLikeChar` |
| 8484 | `convertExampleSpacesToComma` |
| 8509 | `findCjkSpaceWarning` |
| 8533 | `findSplitBoundaryWarning` |
| 8554 | `currentRoleHintV2` |
| 8587 | `pruneGroupMemberNameCache` |
| 8602 | `assertGroupMember` |
| 8628 | `resolveGroupMemberName` |
| 8664 | `pruneReplyInfoCache` |
| 8675 | `resolveReplyInfo` |
| 8742 | `resolveReplyTargetV2` |
| 8781 | `isQuoteTargetSelf` |
| 8793 | `appendSocialV2Message` |
| 8868 | `appendSocialV2Poke` |
| 8910 | `recordSentMessagesV2` |
| 8936 | `readFeedbackEntries` |
| 8941 | `appendFeedbackEntry` |
| 8952 | `readToolLog` |
| 8968 | `appendToolLog` |
| 9000 | `redactSensitive` |
| 9016 | `sanitizeToolArgs` |
| 9037 | `evaluateWakeTriggerV2` |
| 9090 | `readThroughSeqV2` |
| 9106 | `noteModelMessagesV2` |
| 9116 | `requestedReadThroughSeqV2` |
| 9128 | `acknowledgeMessagesV2` |
| 9154 | `localClockText` |
| 9160 | `timeSenseCfg` |
| 9173 | `wakeReasonSeq` |
| 9180 | `findV2MessageBySeq` |
| 9194 | `buildTimeSenseLine` |
| 9223 | `buildWakeSnapshotV2` |
| 9276 | `replyTimingV2` |
| 9290 | `selfIdentityTextV2` |
| 9302 | `buildWakePromptV2` |
| 9379 | `buildWakeReminderPromptV2` |
| 9389 | `sendWakePromptV2` |
| 9514 | `cancelReplyCheckV2` |
| 9521 | `scheduleReplyCheckV2` |
| 9542 | `busyReasonV2` |
| 9563 | `socialV2BusySnapshot` |
| 9589 | `isConversationBusyV2` |
| 9626 | `wakePriorityV2` |
| 9635 | `isTimerWakeReason` |
| 9639 | `scheduleWakeV2` |
| 9695 | `replayPendingWakeReasonsV2` |
| 9726 | `setupSleepTimerV2` |
| 9769 | `cancelProactiveCheckV2` |
| 9776 | `scheduleProactiveCheckV2` |
| 9810 | `clearSocialV2Timers` |
| 9837 | `clearAllSocialV2Timers` |
| 9846 | `drainPromptQueue` |
| 9854 | `drainAllPromptQueues` |
| 9862 | `handleIncoming` |
| 10580 | `cancelPendingEntry` |
| 10604 | `handlePendingAnswer` |
| 10660 | `handlePokeNotice` |
| 10720 | `registerPending` |
| 10752 | `trackTurnEvent` |
| 10771 | `pumpMux` |
| 11305 | `sendOfficialProactive` |
| 11505 | `applyHealedTokens` |
| 11560 | `syncTokenToFile` |
| 11570 | `healTokenIfStale` |

## 模块导入（64）

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
- L59 `./config.js`
- L60 `./sticker-hint.js`
- L61 `./sticker-notes.js`
- L62 `./sticker-pending.js`
- L63 `./private-access.js`
- L64 `./sticker-curator.js`
- L65 `./api/send.js`
- L66 `./api/sessions.js`
- L67 `./api/tokens.js`
- L68 `./api/social.js`
- L69 `./api/socialV2-read.js`
- L70 `./api/socialV2-write.js`
- L71 `./api/socialV2-send.js`
- L72 `./api/socialV2-qzone.js`
- L73 `./api/socialV2-wait.js`
- L74 `./state-acl.mjs`
- L75 `./forward.js`
- L76 `./model-prices.js`
- L77 `./token-ledger.js`

## 顶层常量（46）

`ROOT`(L105) · `STATE_DIR`(L106) · `STATE_FILE`(L107) · `ROLE_STATE_FILE`(L108) · `SLANG_FILE`(L109) · `STICKER_NOTES_FILE`(L112) · `SLANG_SESSION_FILE`(L166) · `SOCIAL_V2_FILE`(L167) · `INITIAL_PROMPTS_FILE`(L170) · `STICKER_FILE`(L171) · `FEEDBACK_FILE`(L172) · `TOOL_LOG_FILE`(L173) · `TOKEN_USAGE_FILE`(L174) · `ACTIVITY_LOG`(L175) · `BRIDGE_LOG`(L176) · `MODE_INPUT_ALIASES`(L192) · `VALID_MODES`(L200) · `ROLE_NON_CARD_FILES`(L371) · `ROLES_DIR`(L375) · `ROLE_NAME_MAX`(L376) · `ROLE_CONTENT_MAX_BYTES`(L377) · `ROLE_INJECT_MAX_CHARS_DEFAULT`(L383) · `ROLE_RESERVED_NAMES`(L390) · `WINDOWS_RESERVED_NAMES`(L393) · `ROLE_INDEX_TTL_MS`(L409) · `PRESET_NAMES`(L674) · `PRESET_BACKUP_DIR`(L675) · `PRESET_BACKUP_KEEP`(L676) · `SILENT_MARKER`(L770) · `SEND_TOOL_RE`(L777) · `SPACE_SPLIT_HINT`(L784) · `DIRECTION_HINT`(L786) · `KNOWN_AGENT_TOKENS`(L789) · `CONVERSATION_TOKENS`(L804) · `MAX_KNOWN_AGENT_TOKENS`(L805) · `REASONING_EFFORT_OPTIONS`(L848) · `REASONING_EFFORT_DEFAULT`(L849) · `ROLES_BY_KEY_FILE`(L910) · `LOCK_FILE`(L1053) · `LOG_LINE_MAX`(L1154) · `SEND_TIMEOUT_MS`(L1220) · `DSH_CONTROL_TIMEOUT_MS`(L1224) · `QQBOT_ROOT`(L1288) · `VIDEO_REF_RE`(L1471) · `APPROVE_WORDS`(L1574) · `REJECT_WORDS`(L1575)
