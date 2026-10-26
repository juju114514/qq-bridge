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

    return false;
  };
}

export default createSocialV2WriteHandler;
