/**
 * socialV2 —— B 批（第一批 5 条：标记已读 / 发送前检查 / 清日志 / 清反馈 / 内部占位）
 *
 *   POST /api/socialV2/mark-read
 *   POST /api/socialV2/check-send
 *   POST /api/socialV2/tool-log/clear
 *   POST /api/socialV2/feedback-clear
 *   POST /api/socialV2/record-sent
 *
 * 「按域拆 handler」第 9 组的 B 批之一。行为逐行等价。
 *
 * mark-read 的语义最容易改错，原文注释一并保留：
 *   · 不带 throughSeq 会清空**全部**未读 —— 这是有意保留的兼容语义
 *   · 已处于潜水配置且有未完成的睡前观察窗口时，必须 400 拒绝（防止「聊两句又去潜水」）
 */

import { addAtom, splitVariant, MAX_ATOMS, migrateFromLegacy } from '../memory-store.js';

export function createSocialV2WriteHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    fs,
    TOOL_LOG_FILE,
    FEEDBACK_FILE,
    atomicWriteJson,
    getCfg,
    getMode,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    getSocialV2,
    getSocialV2State,
    requestedReadThroughSeqV2,
    isSleepingConfigV2,
    preSleepWaitBlockedV2,
    acknowledgeMessagesV2,
    ensureWakeableV2,
    markReadCalledKeys,
    saveSocialV2State,
    readThroughSeqV2,
    computeWakeSafetyV2,
    feedbackTimes,
    truncateText,
    appendFeedbackEntry,
    appendActivity,
    appendMemoryV2,
    formatMemoryV2,
    redactKnownTokensOnly,
    bumpSessionEpoch,
    getState,
    sessionPromises,
    clearAllSocialV2Timers,
    drainAllPromptQueues,
    stopRetiredSessionWork,
    sessionModels,
    forgetAgentToken,
    seenForwardIds,
    saveState,
    pendingWakeKeys,
    clearAllPendingWakeLeases,
    wakeConfigUpdatedKeys,
    wakeConfigMissCount,
    SOCIAL_V2_FILE,
    api,
    sendWakePromptV2,
    modeAllowed,
    initialPrompts,
    initialPromptMaxChars,
    isInitialPromptWritable,
    canonicalV2Key,
    setInitialPrompt,
    pickWakeTriggersV2,
    normalizeSpeakerIdsV2,
    cancelReplyCheckV2,
    setupSleepTimerV2,
  } = deps;

  return async function handleSocialV2Write(req, url) {
    // initial-prompt 有 GET（读列表/单条），其它分支都是 POST
    if (req.method !== 'POST' && url.pathname !== '/api/socialV2/initial-prompt') return false;
    const { pathname } = url;

    // ── POST /api/socialV2/record-sent（内部接口，恒 403）──────────────────
    if (pathname === '/api/socialV2/record-sent') {
      // 内部接口不对外开放：防止持有会话 token 的调用方伪造「我说过…」的历史记录。
      sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
      return true;
    }

    // ── POST /api/socialV2/tool-log/clear ──────────────────────────────────
    if (pathname === '/api/socialV2/tool-log/clear') {
      if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
      try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch { }
      log('控制台：工具调用日志已清空');
      sendJson({ ok: true });
      return true;
    }

    // ── POST /api/socialV2/feedback-clear ──────────────────────────────────
    if (pathname === '/api/socialV2/feedback-clear') {
      if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
      atomicWriteJson(FEEDBACK_FILE, []);
      log('控制台：清空 AI 反馈');
      sendJson({ ok: true });
      return true;
    }

    // ── POST /api/socialV2/check-send ──────────────────────────────────────
    if (pathname === '/api/socialV2/check-send') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const tool = String(body.tool ?? '').trim();
      const token = String(body.token ?? '').trim();
      if (!key || !tool || !token) {
        sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
        return true;
      }
      if (!agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return true;
      }
      if (!v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
      const flag = flagMap[tool];
      if (!flag) {
        sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
        return true;
      }
      if (!v2ToolEnabled(flag)) {
        const toolName = tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply';
        sendJson({ ok: false, error: `工具未启用：qq_${toolName}` }, 403);
        return true;
      }
      sendJson({ ok: true, key, tool });
      return true;
    }

    // ── POST /api/socialV2/mark-read ───────────────────────────────────────
    if (pathname === '/api/socialV2/mark-read') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return true; }

      const st = getSocialV2State(key);
      // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
      // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessagesV2 的注释与
      // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
      const throughSeq = requestedReadThroughSeqV2(st, body, !!agentToken);
      // 如果当前已经是「潜水」唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
      // 必须先等够沉睡前观察窗口，避免「聊两句又去潜水」。
      if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(getCfg().socialV2?.wake?.preSleepWaitMs) || 300000);
        const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        sendJson({
          ok: false,
          error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
          preSleepWaitMs: preSleepMs,
          preSleepWaitRemainingMs: remaining,
        }, 400);
        return true;
      }

      const markedCount = acknowledgeMessagesV2(st, throughSeq);
      st.lastActionAt = Date.now();
      st.wakeConfig.noActionCount = 0;
      // 防止「有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾」导致无定时器无触发条件的静默态。
      if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
        st.wakeConfig.infinite = true;
      }
      ensureWakeableV2(st, { key });
      st.wakeConfig.confirmedAt = Date.now();
      st.wakeConfig.confirmedBy = 'mark_read';
      markReadCalledKeys.add(key);
      saveSocialV2State();
      log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
      sendJson({
        ok: true,
        key,
        markedCount,
        unreadCount: st.unread.length,
        readThroughSeq: readThroughSeqV2(st),
        wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed,
        wakeSafety: computeWakeSafetyV2(st.wakeConfig),
        wakeConfig: st.wakeConfig,
      });
      return true;
    }

    // ── POST /api/socialV2/feedback（AI 上报反馈，带限频）──────────────────
    if (pathname === '/api/socialV2/feedback') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
      const rawMessage = String(body.message ?? '').trim();
      if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return true; }
      // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
      const fNow = Date.now();
      const fTimes = feedbackTimes.get(key) || [];
      const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
      const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
      if (fRecentMinute >= 5 || fRecentHour >= 20) {
        sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
        return true;
      }
      fTimes.push(fNow);
      feedbackTimes.set(key, fTimes.slice(-100));
      const cfg = getCfg();
      const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
      const message = truncateText(rawMessage, maxLength);
      appendFeedbackEntry({
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        key, level, message, time: new Date().toISOString(),
      });
      log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
      appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
      if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
        log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
      }
      sendJson({ ok: true, key, level, message });
      return true;
    }

    // ── POST /api/socialV2/memory-weight ───────────────────────────────────
    // 人工调权重（控制台星图用）。只允许操作者：带 x-agent-token 的会话级主体一律拒绝，
    // 否则 A 群里的 AI 能改 B 群的记忆权重。
    if (pathname === '/api/socialV2/memory-weight') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim();
      const weight = Number(body.weight);
      if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅限操作者（控制台）' }, 403); return true; }
      if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return true; }
      if (!Number.isFinite(weight) || weight <= 0 || weight > 3) {
        sendJson({ ok: false, error: 'weight 必须在 (0, 3] 之间' }, 400);
        return true;
      }
      const st = getSocialV2State(key);
      // 读端点（socialV2-read）在没有 longTermMemories 时会用 migrateFromLegacy 现场合成，
      // 保证"升级即可见"。写端点必须同源：这里同样合成，并**顺手落盘**完成迁移，
      // 否则会出现"星图里看得到、改权重却 404"的鬼故事。
      if (!Array.isArray(st.longTermMemories) || !st.longTermMemories.length) {
        try {
          const synthesized = migrateFromLegacy(st);
          if (synthesized.length) {
            st.longTermMemories = synthesized;
            saveSocialV2State();
            log(`[memory] 旧结构迁移为长期原子：${synthesized.length} 条`);
          }
        } catch (error) {
          log(`[memory] 迁移失败（忽略）：${error?.message ?? error}`);
        }
      }
      if (!Array.isArray(st.longTermMemories) || !st.longTermMemories.length) {
        sendJson({ ok: false, error: '该会话还没有长期记忆' }, 404);
        return true;
      }
      const atom = st.longTermMemories.find((a) => String(a.text ?? '') === text);
      if (!atom) { sendJson({ ok: false, error: '没找到这条记忆（可能已被合并或归档）' }, 404); return true; }
      const before = Number(atom.weight || 1);
      atom.weight = Math.round(weight * 100) / 100;
      atom.manualWeightAt = Date.now();
      saveSocialV2State();
      log(`[memory] 人工调权重：${text.slice(0, 30)} ${before} → ${atom.weight}`);
      sendJson({ ok: true, key, before, atom });
      return true;
    }

    // ── POST /api/socialV2/memory-append ───────────────────────────────────
    if (pathname === '/api/socialV2/memory-append') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
      if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return true; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return true;
      }
      if (category === 'memberImpression' && !String(extra.target || '').trim()) {
        sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400);
        return true;
      }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return true; }
      const st = getSocialV2State(key);
      appendMemoryV2(st, category, content, extra);
      // 长期层（LivingMemory 式原子）：话题与群友印象是"能记很久"的事，同步落一份；
      // pendingThought 是两小时内的临时物，不落长期。权重/衰减/合并由 memory-store 管。
      try {
        if (!Array.isArray(st.longTermMemories)) st.longTermMemories = [];
        if (category === 'activeTopic') {
          addAtom(st.longTermMemories, { text: content, tags: ['话题'], source: key });
        } else if (category === 'memberImpression') {
          const target = String(extra.target ?? '').trim();
          const traits = Array.isArray(extra.traits) ? extra.traits.map(String) : [content];
          if (target && traits.length) {
            addAtom(st.longTermMemories, { text: `${target}：${traits.join('、')}`, tags: ['群友'], source: key });
          }
        }
        if (st.longTermMemories.length > MAX_ATOMS) st.longTermMemories = st.longTermMemories.slice(-MAX_ATOMS);
      } catch (error) {
        // 长期层是增强，不能因为它让主流程 500
        log(`[memory] 长期层写入失败（忽略）：${error?.message ?? error}`);
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
      return true;
    }

    // ── POST /api/socialV2/memory-split ────────────────────────────────────
    // 合并是有损的：Jaccard 可能把同一人的两件事吞成一条。被吞的原文留在 atom.variants 里，
    // 这里把它拆回成独立原子（幂等：拆过再拆返回 404）。
    if (pathname === '/api/socialV2/memory-split') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const text = String(body.text ?? '').trim();
      if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return true; }
      const st = getSocialV2State(key);
      if (!Array.isArray(st.longTermMemories)) st.longTermMemories = [];
      const r = splitVariant(st.longTermMemories, { text, now: Date.now() });
      if (!r.ok) { sendJson({ ok: false, error: r.reason }, 404); return true; }
      saveSocialV2State();
      log(`[memory] 拆分回原文：${text.slice(0, 40)}`);
      sendJson({ ok: true, key, restored: text, atom: r.atom });
      return true;
    }

    // ── POST /api/socialV2/memory-update ───────────────────────────────────
    if (pathname === '/api/socialV2/memory-update') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const oldContent = String(body.oldContent ?? '').trim();
      const target = redactKnownTokensOnly(String(body.target ?? '').trim());
      const newContent = body.newContent !== undefined && body.newContent !== null
        ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
      const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
      const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
      const cleanNewExtra = {
        ...newExtra,
        pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
        participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
        motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
        target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined,
      };
      if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return true;
      }
      if (category === 'memberImpression' && !target) {
        sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400);
        return true;
      }
      if (category !== 'memberImpression' && !oldContent) {
        sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400);
        return true;
      }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return true; }
      const st = getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return true; }
        if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
        if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return true; }
        if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
        if (cleanNewExtra.expiresAtMs !== undefined) {
          st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
        }
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        const oldTarget = target;
        if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
        // 必须命中已有条目（own property）：否则任意 target 都能凭空建一条，
        // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数。
        if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
          sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
          return true;
        }
        const im = st.memberImpressions[oldTarget];
        const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
        if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) {
          sendJson({ ok: false, error: '非法的群友名字' }, 400);
          return true;
        }
        if (newContent !== undefined) {
          im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
        }
        if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
        if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
        st.memberImpressions[newTarget] = im;
        // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧。
        const impressionEntries = Object.entries(st.memberImpressions);
        if (impressionEntries.length > 50) {
          impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
          for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
      return true;
    }

    // ── POST /api/socialV2/memory-remove ───────────────────────────────────
    if (pathname === '/api/socialV2/memory-remove') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const target = String(body.target ?? '').trim();
      if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return true;
      }
      if (category === 'memberImpression' && !target) {
        sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400);
        return true;
      }
      if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) {
        sendJson({ ok: false, error: '非法的群友名字' }, 400);
        return true;
      }
      if (category !== 'memberImpression' && !content) {
        sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400);
        return true;
      }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return true; }
      const st = getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        delete st.memberImpressions[target];
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
      return true;
    }

    // ── POST /api/socialV2/memory-clear ────────────────────────────────────
    if (pathname === '/api/socialV2/memory-clear') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
        sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400);
        return true;
      }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return true; }
      const st = getSocialV2State(key);
      if (!category || category === 'activeTopic') st.activeTopics = [];
      if (!category || category === 'pendingThought') st.pendingThoughts = [];
      if (!category || category === 'memberImpression') st.memberImpressions = {};
      saveSocialV2State();
      sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
      return true;
    }

    // ── POST /api/socialV2/reset（清空二代全部状态）────────────────────────
    if (pathname === '/api/socialV2/reset') {
      bumpSessionEpoch();
      sessionPromises.clear();
      clearAllSocialV2Timers();
      drainAllPromptQueues('二代状态已重置');
      const state = getState();
      for (const key of [...getSocialV2().conversations.keys()]) {
        const sid = state.sessions[key];
        if (sid) {
          delete state.sessions[key];
          // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
          // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
          // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换。
          stopRetiredSessionWork(sid, key);
          sessionModels.delete(sid);
          maps.modelAppliedSessions.delete(sid);
          maps.reverse.delete(sid);
          maps.collectors.delete(sid);
          maps.v2TurnStartAt.delete(sid);
          maps.turnLeaseNoted.delete(sid);
          maps.toolCallNames.delete(sid);
          maps.pendingSendToolCalls.delete(sid);
          maps.sendToolSucceededSessions.delete(sid);
          // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
          api.events.forget?.(sid);
        }
        delete state.sessionPolicies[key];
        forgetAgentToken(key);
        getSocialV2().conversations.delete(key);
        seenForwardIds.delete(key);
      }
      saveState();
      pendingWakeKeys.clear();
      clearAllPendingWakeLeases();
      wakeConfigUpdatedKeys.clear();
      markReadCalledKeys.clear();
      wakeConfigMissCount.clear();
      getSocialV2().paused = false;
      try {
        atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} });
      } catch (error) {
        log('重置二代状态：写空状态文件失败:', error?.message ?? error);
      }
      log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
      sendJson({ ok: true });
      return true;
    }

    // ── POST /api/socialV2/wake（手动唤醒）─────────────────────────────────
    if (pathname === '/api/socialV2/wake') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const reason = String(body.reason ?? 'admin').trim() || 'admin';
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (getMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if ((typeof id !== 'string' && (!Number.isFinite(id) || id <= 0)) || !modeAllowed(key, kind, id, getCfg(), getMode())) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      const st = getSocialV2State(key);
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「二代协议说明 + 操作者为这个会话
      // 预写的初始提示词」。若用手动唤醒的 admin 文案顶掉它，这个会话就永远拿不到引导。
      const firstWake = !st.bootstrapSent;
      if (firstWake) st.bootstrapSent = true;
      const effectiveReason = firstWake ? 'bootstrap' : reason;
      saveSocialV2State();
      // sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复等一个可能卡几十秒的模型回合），
      // 但必须挂 catch：裸调用 reject 就是 unhandledRejection。
      void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
      log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
      sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
      return true;
    }

    // ── /api/socialV2/initial-prompt（GET 列表/单条，POST 保存/删除）────────
    if (pathname === '/api/socialV2/initial-prompt') {
      if (req.method === 'GET') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) {
          const entries = [...initialPrompts.entries()]
            .map(([entryKey, entry]) => ({
              key: entryKey,
              chars: entry.text.length,
              createdAt: entry.createdAt || 0,
              updatedAt: entry.updatedAt || 0,
              preview: entry.text.replace(/\s+/g, ' ').slice(0, 80),
            }))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: isInitialPromptWritable() });
          return true;
        }
        const canonical = canonicalV2Key(key);
        if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
        const entry = initialPrompts.get(canonical) ?? null;
        sendJson({
          ok: true,
          key: canonical,
          exists: !!entry,
          text: entry?.text ?? '',
          createdAt: entry?.createdAt || 0,
          updatedAt: entry?.updatedAt || 0,
          maxChars: initialPromptMaxChars(),
          writable: isInitialPromptWritable(),
        });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const explicitDelete = body.delete === true;
        // 只接受 { key, text: string } 或 { key, delete: true }：
        // 缺 text 时不当作「清空」（否则一次漏字段的调用就把操作者写的内容删了）。
        if (!explicitDelete && typeof body.text !== 'string') {
          sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
          return true;
        }
        const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
        if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return true; }
        log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
        sendJson({
          ok: true,
          key: result.key,
          deleted: result.deleted,
          chars: result.chars,
          exists: !!result.entry,
          updatedAt: result.entry?.updatedAt || 0,
          maxChars: initialPromptMaxChars(),
        });
        return true;
      }
      return false;
    }

    // ── POST /api/socialV2/wake-config（设置下一次唤醒，clamp 最多）─────────
    if (pathname === '/api/socialV2/wake-config') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      const agentToken = req.headers['x-agent-token'];
      if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (agentToken && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return true; }

      const cfg = getCfg();
      const st = getSocialV2State(key);
      const throughSeq = requestedReadThroughSeqV2(st, body, !!agentToken);
      // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
      const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
      const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
      const current = st.wakeConfig;
      const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
      const normalizeTriggerBool = (name, fallback) => {
        if (name in inputTriggers) return inputTriggers[name] === true;
        return fallback;
      };
      const rawKeywords = inputTriggers.keywords;
      const nextKeywords = rawKeywords !== undefined
        ? (Array.isArray(rawKeywords)
          ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
          : [])
        : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
      const next = {
        ...current,
        mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
        infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
        sleepUntil: current.sleepUntil,
        triggers: {
          // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
          ...pickWakeTriggersV2(inputTriggers, current.triggers),
          atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
          nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
          question: normalizeTriggerBool('question', current.triggers.question === true),
          anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
          poke: normalizeTriggerBool('poke', current.triggers.poke === true),
          keywords: nextKeywords,
        },
        batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
          ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
          : current.batchWindowMs,
      };
      // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免「潜水=每条都唤醒」的语义矛盾。
      if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
        next.triggers.anyMessage = false;
      }
      if (next.mode === 'active') {
        next.infinite = true;
        next.sleepUntil = null;
        next.triggers.anyMessage = true;
      }
      if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
      if (next.infinite) {
        next.sleepUntil = null;
      } else if (input.sleepUntil) {
        const d = new Date(String(input.sleepUntil));
        if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
      } else if (Number.isFinite(Number(input.sleepMs))) {
        let ms = Math.max(0, Math.round(Number(input.sleepMs)));
        const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
        const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
        if (ms < minMs) ms = minMs;
        if (maxMs > 0 && ms > maxMs) ms = maxMs;
        next.sleepUntil = new Date(Date.now() + ms).toISOString();
      } else if (!next.sleepUntil && !next.infinite) {
        // 既没有无限也没有时间：使用推荐默认有限时长
        const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
        const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
        const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
        next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
      }
      // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
      if (!next.infinite && next.sleepUntil) {
        const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
        const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
        let until = Date.parse(next.sleepUntil);
        if (Number.isFinite(until)) {
          if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
          if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
          next.sleepUntil = new Date(until).toISOString();
        }
      }
      // 归一化概率
      if (next.triggers.probability !== undefined) {
        next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
      }
      // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
      if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
        next.triggers.poke = input.triggers.poke === true;
      }
      // 归一化「指定成员」触发：只保留正整数 QQ 号，去重，限制数量；
      // null/undefined/非法值统一清空，避免「null」被当成有效唤醒条件绕过防永眠。
      next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
      // 私聊不适用「指定成员发言醒来」：清除以免误导/脏数据。
      if (key.startsWith('private:')) {
        next.triggers.speakerIds = [];
      }
      // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
      if (next.infinite) {
        const tr = next.triggers ?? {};
        const hasTrigger = tr.atMention || tr.nameMention || tr.poke
          || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage
          || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
        if (!hasTrigger) {
          sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
          return true;
        }
      }
      // 沉睡前强制观察窗口：除非已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
      if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
        const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        sendJson({
          ok: false,
          error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
          preSleepWaitMs: preSleepMs,
          preSleepWaitRemainingMs: remaining,
        }, 400);
        return true;
      }

      const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
      st.wakeConfig = next;
      st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
      st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
      st.wakeConfig.noActionCount = 0;
      st.wakeConfig.confirmedAt = Date.now();
      st.wakeConfig.confirmedBy = 'set_wake_config';
      st.lastActionAt = Date.now();
      // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      saveSocialV2State();
      wakeConfigUpdatedKeys.add(key);
      wakeConfigMissCount.delete(key);
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
      setupSleepTimerV2(key);
      log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
      sendJson({
        ok: true,
        key,
        markedCount,
        unreadCount: st.unread.length,
        readThroughSeq: readThroughSeqV2(st),
        wakeConfig: next,
        wakeSafety: computeWakeSafetyV2(next),
      });
      return true;
    }

    return false;
  };
}

export default createSocialV2WriteHandler;
