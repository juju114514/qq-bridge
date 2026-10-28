import { CONV_KEY_RE, convId } from '../conv-key.js';
/**
 * 统一发送端点：POST /api/send/{group,private,reply}（MCP 发送工具走这里）。
 *
 * 「按域拆 handler」第 6 组（send）。行为与迁移前逐行等价。
 * 这段是发送链路的核心：频率预占/回滚、引用解析、敏感词拦截都在里面。
 * 状态全部通过 deps 注入；st/now 声明在 try 之外（回滚额度时要用）。
 */

export function createSendHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    unquoteJsonString,
    getMode,
    getSocialV2,
    getCfg,
    agentTokenOk,
    v2ToolEnabled,
    modeAllowed,
    shouldBlockSilentReply,
    getSocialV2State,
    saveSocialV2State,
    resolveReplyTargetV2,
    sendMessagesV2,
    recordSentMessagesV2,
    appendActivity,
    scheduleReplyCheckV2,
    SENSITIVE_RE,
  } = deps;

  return async function handleSend(req, url) {
    const { pathname } = url;
    const body = await readBody();
    const token = String(body.token ?? '').trim();
    const isPrivate = pathname === '/api/send/private';
    const isReply = pathname === '/api/send/reply';
    const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
    const message = unquoteJsonString(String(body.message ?? '').trim());
    // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
    const replyToMessageId = body.replyToMessageId;
    const atUserId = body.atUserId ?? null;
    const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
    const currentMode = getMode();
    const socialV2 = getSocialV2();
    const cfg = getCfg();

    // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用。
    if (currentMode === 'chat' || currentMode === 'reserved') {
      sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
      return true;
    }
    if (socialV2.paused && token) {
      sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
      return true;
    }
    if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return true; }
    if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
    if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
      sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
      return true;
    }
    if (currentMode === 'reserved2' && !token) {
      sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403);
      return true;
    }
    if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
    if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return true; }
    if (shouldBlockSilentReply(key)) {
      sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
      return true;
    }
    const keyMatch = CONV_KEY_RE.exec(key);
    if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return true; }
    const kind = keyMatch[1];
    const id = convId(keyMatch[2]);
    if ((typeof id !== 'string' && (!Number.isFinite(id) || id <= 0)) || !modeAllowed(key, kind, id, cfg, currentMode)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?\d+$/.test(String(replyToMessageId).trim())) {
      sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
      return true;
    }

    let quotedInfo = null;
    let actualReplyToMessageId = replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const stForReply = getSocialV2State(key);
      const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
      if (!resolved) {
        sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
        return true;
      }
      quotedInfo = resolved.info;
      actualReplyToMessageId = resolved.messageId;
    }

    const sendCfg = cfg.socialV2?.send ?? {};
    const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
    if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return true; }
    if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }

    // st/now 必须在 try 之外：catch 要用它们回滚预占的发送额度。
    const st = getSocialV2State(key);
    const now = Date.now();
    try {
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return true;
      }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
      recordSentMessagesV2(key, sentMessages);
      st.lastAiReplyAt = now;
      st.lastActionAt = now;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
      log(`[send] ${pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
      appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
    } catch (error) {
      if (error?.sent?.length) {
        recordSentMessagesV2(key, error.sent);
        log(`[send] ${pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
      }
      // 失败/未发出的消息回滚预占的发送额度，避免假 429。
      const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
      const failedCount = Math.max(0, 1 - sentCount);
      for (let i = 0; i < failedCount; i++) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
      }
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      saveSocialV2State();
      sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
    }
    return true;
  };
}

export default createSendHandler;
