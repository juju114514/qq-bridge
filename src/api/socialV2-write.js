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
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
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
  } = deps;

  return async function handleSocialV2Write(req, url) {
    if (req.method !== 'POST') return false;
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
      sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
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

    return false;
  };
}

export default createSocialV2WriteHandler;
