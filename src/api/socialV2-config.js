// 二代仿真配置写入（从 bridge.js 抽出的第七片）
//
//   POST /api/socialV2/config
//
// 这是控制台保存 socialV2 全套开关的入口，166 行里绝大部分是**字段归一化**：
//   · 子对象必须是非 null 对象，否则保留当前值（防止一次保存把默认开关静默打开）
//   · tools 只接受布尔；wake/send/wait/proactive/sticker/context 的数值做范围收敛
//   · current 优先取文件里的 socialV2，没有才回落到运行时的 cfg.socialV2
//     （理由见原代码注释：current 取空会导致"保存一次就把 setStickerRemark 打开"）
//
// 依赖注入：cfg 与 ROOT 都用 getter/参数，避免热更新或路径写死后失效。

export function createSocialV2ConfigHandler(deps = {}) {
  const {
    sendJson, readBody, log,
    getCfg, rootDir, path,
    readConfigObject, atomicWriteJson, refreshAllDefaultWakeConfigsV2
  } = deps;

  return async function handleSocialV2Config(req, url) {
    const cfg = getCfg();
    const ROOT = rootDir;

          if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
            const body = await readBody();
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
            //
            // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
            // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
            // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
            // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
            // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
            // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
            // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
            const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
              ? file.socialV2
              : null;
            const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
            const merged = { ...current, ...body };
            // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
            for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
              if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
                merged[sub] = current[sub] ?? {};
              }
            }
            if (merged.autoReplyCheckMs !== undefined) {
              const n = Number(merged.autoReplyCheckMs);
              merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
            }
            // tools：只接受布尔开关
            const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
            if (body.tools && typeof body.tools === 'object') {
              merged.tools = { ...(current.tools ?? {}), ...body.tools };
              for (const k of toolFlags) {
                if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
              }
            }
            // wake：数值与字符串数组归一化
            if (body.wake && typeof body.wake === 'object') {
              merged.wake = { ...(current.wake ?? {}), ...body.wake };
              for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
                if (merged.wake[k] !== undefined) {
                  const n = Number(merged.wake[k]);
                  merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                  // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                  if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
                }
              }
              if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
              if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
              if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
              if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
              if (merged.wake.recommendedKeywords !== undefined) {
                merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
              }
              if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
              if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
            }
            // send：数值归一化
            if (body.send && typeof body.send === 'object') {
              merged.send = { ...(current.send ?? {}), ...body.send };
              for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
                if (merged.send[k] !== undefined) {
                  const n = Number(merged.send[k]);
                  merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                  // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                  if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
                }
              }
              if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
              if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
              if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
            }
            // wait：数值归一化
            if (body.wait && typeof body.wait === 'object') {
              merged.wait = { ...(current.wait ?? {}), ...body.wait };
              for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
                if (merged.wait[k] !== undefined) {
                  const n = Number(merged.wait[k]);
                  merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
                }
              }
            }
            // proactive：主动机会参数
            if (body.proactive && typeof body.proactive === 'object') {
              merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
              for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
                if (merged.proactive[k] !== undefined) {
                  const n = Number(merged.proactive[k]);
                  merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                  // 毫秒类字段统一非负取整；概率字段单独 clamp。
                  if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
                }
              }
              if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
              if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
            }
            // sticker：表情包体系参数归一化
            if (body.sticker && typeof body.sticker === 'object') {
              merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
              if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
              for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
                if (merged.sticker[k] !== undefined) {
                  const n = Number(merged.sticker[k]);
                  merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
                }
              }
              if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
              if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
              if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
              if (body.sticker.collect && typeof body.sticker.collect === 'object') {
                merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
                if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
                for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                  if (merged.sticker.collect[k] !== undefined) {
                    const n = Number(merged.sticker.collect[k]);
                    merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                  }
                }
              }
            }
            // feedback：数值/布尔归一化
            if (body.feedback && typeof body.feedback === 'object') {
              merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
              if (merged.feedback.maxLength !== undefined) {
                const n = Number(merged.feedback.maxLength);
                merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
              }
              if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
            }
            // context：数值归一化
            if (body.context && typeof body.context === 'object') {
              merged.context = { ...(current.context ?? {}), ...body.context };
              for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
                if (merged.context[k] !== undefined) {
                  const n = Number(merged.context[k]);
                  merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
                }
              }
              for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
                const n = Number(merged.context[name] ?? fallback);
                merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
              }
              if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
            }
            if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
            if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
            if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
            file.socialV2 = merged;
            atomicWriteJson(configFile, file);
            cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
            // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
            // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
            const WAKE_DEFAULT_KEYS = [
              'defaultMode', 'recommendedDefaultInfinite',
              'recommendedSleepMinMs', 'recommendedSleepMaxMs',
              'recommendedProbability', 'recommendedKeywords',
              'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
              'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
            ];
            const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
              WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
            if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
            log('控制台：二代仿真配置已更新');
            sendJson({ ok: true, config: cfg.socialV2 });
            return;
          }
  };
}
