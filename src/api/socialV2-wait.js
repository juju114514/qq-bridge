/**
 * socialV2 —— D 批：POST /api/socialV2/wait（长轮询等待）
 *
 * 「按域拆 handler」第 9 组的 D 批，最危险的一条。迁移前置了
 * scripts/test-wait-lease.mjs（租约 429 / 入参校验）钉住关键行为。
 *
 * 关键点（全部保留原注释语义）：
 *   · 同一会话只允许一个长轮询等待；租约按**归一后** key 记账（group:0123 == group:123）
 *   · 租约只由「自己那一份」负责删除；`req.on('close')` + `res.on('close')` 双兜底
 *   · reply 用途：短静默，不计入睡前观察；messages 用途：先等新消息再等 quiet
 *   · 返回里直接给 canSleepNow / countsAsObservation / hint，不让模型自己悟
 */

export function createSocialV2WaitHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    getMode,
    getCfg,
    getSocialV2,
    getSocialV2State,
    saveSocialV2State,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    readThroughSeqV2,
    noteModelMessagesV2,
    suggestQuietMsV2,
    preSleepWaitBlockedV2,
    canonicalV2Key,
    activeWaits,
    ACTIVE_WAIT_LEASE_MS,
    cancelReplyCheckV2,
    sleep,
    looksLikeUnfinished,
  } = deps;

  return async function handleSocialV2Wait(req, res, url) {
    const { pathname } = url;
    if (req.method !== 'POST' || pathname !== '/api/socialV2/wait') return false;

    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
      sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
      return true;
    }
    const replyWait = body.purpose === 'reply';
    const agentToken = req.headers['x-agent-token'];
    if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (agentToken && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return true; }
    if (getSocialV2().paused) {
      const st = getSocialV2State(key);
      sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
      return true;
    }
    const cfg = getCfg();
    const waitCfg = cfg.socialV2?.wait ?? {};
    const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
    const defaultMs = Number(waitCfg.defaultMs) || 30000;
    const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
    const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
    let timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
    const st = getSocialV2State(key);
    // 首回复闸门：本轮还没发过话就想要 5 分钟的"沉睡前观察"，一律压到 30 秒。
    // 真实踩过（2026-10-29 01:03）：模型被唤醒后先做 preSleep 观察，群里 5 分钟没有任何回复，
    // 用户看到的就是"它卡住了"。观察是**收尾**动作，不是回复的前置条件。
    const preSleepBudgetMs = Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000;
    // 只有 messages 用途才谈得上"沉睡前观察"；reply 用途本来就是短静默，绝不能被闸门拦。
    const wantsPreSleepObservation = !replyWait && timeoutMs >= preSleepBudgetMs;
    // 没有 lastWakeAt（老会话/测试环境）时无法判断"这轮发没发过" → 不拦，避免误伤。
    const hasWakeMark = Number(st.lastWakeAt) > 0;
    const replySinceWake = !hasWakeMark || (Number(st.lastAiReplyAt) || 0) > Number(st.lastWakeAt);
    if (wantsPreSleepObservation && !replySinceWake) {
      // 首回复闸门：**明确拒绝**，而不是偷偷把预算压到 30 秒。
      // 压预算是错的：观察闸门要求"单次满 300 秒"，压缩后永远凑不满，
      // 模型会反复重试、剩余时间原地打转（2026-10-29 01:0x 真实踩过，日志 258→226→194 秒）。
      // 注意：这里还没拿到租约（lease 在下面才 set），不能调 finishWait() —— 会 TDZ 报错。
      sendJson({
        ok: false,
        error: '本轮还没发过话：沉睡前观察必须在你第一次发言之后。先回复（qq_send_message），再观察收尾。',
        firstReplyGate: true,
        preSleepWaitMs: preSleepBudgetMs
      }, 409);
      return true;
    }
    // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
    // 租约按归一后的 key 记账；过期则视为残留，允许接管而不是永久 429。
    const leaseKey = canonicalV2Key(key) ?? key;
    if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
      sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
      return true;
    }
    const leaseStamp = Date.now();
    activeWaits.set(leaseKey, leaseStamp);
    // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
    const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
    req.on('close', finishWait);
    // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回 JSON，不会经过下面的 finishWait()。
    res.on('close', finishWait);
    const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
    const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
    const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
    // 收到新消息后至少再等 minQuietAfterNewMs，防止抢话；同时给 quietMs 加上限。
    const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
    // A reply wait must also include messages received while the model
    // was reading/thinking after its snapshot, before this HTTP request.
    const requestSeq = st.lastUnreadSeq || 0;
    const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
    const start = Date.now();
    let arrived = false;
    let lastNewAt = 0;
    let aborted = false;
    req.on('close', () => { aborted = true; });
    if (replyWait) {
      const incomingAt = () => {
        const value = Number(st.lastIncomingAt);
        return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
      };
      lastNewAt = incomingAt();
      let observedSeq = st.lastUnreadSeq || 0;
      while (!aborted && Date.now() - start < timeoutMs) {
        if ((st.lastUnreadSeq || 0) !== observedSeq) {
          observedSeq = st.lastUnreadSeq || 0;
          lastNewAt = incomingAt();
        }
        const remaining = quietMs - (Date.now() - lastNewAt);
        if (remaining <= 0) break;
        await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
      }
      lastNewAt = incomingAt();
      arrived = (st.lastUnreadSeq || 0) > baseline;
    } else while (Date.now() - start < timeoutMs && !aborted) {
      let nowSeq = st.lastUnreadSeq || 0;
      if (nowSeq - baseline >= minNew) {
        arrived = true;
        lastNewAt = Date.now();
        // 已等到新消息：继续等到「最后一条新消息之后 quietMs 内不再有新消息」再返回。
        while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
          if ((st.lastUnreadSeq || 0) > nowSeq) {
            nowSeq = st.lastUnreadSeq || 0;
            lastNewAt = Date.now();
          }
          await sleep(200);
        }
        break;
      }
      await sleep(300);
    }
    const waitedMs = Date.now() - start;
    if (getSocialV2().conversations.get(canonicalV2Key(key)) !== st ||
      (agentToken && (getMode() !== 'reserved2' || getSocialV2().paused || cfg.socialV2?.enabled === false
        || !agentTokenOk(key, agentToken) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
      finishWait();
      sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
      return true;
    }
    const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const preSleepBlocked = preSleepWaitBlockedV2(st);
    const preSleepRemainingMs = preSleepBlocked
      ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
      : 0;
    const preSleepCountsAsObservation = !replyWait && timeoutMs >= preSleepWaitMs;
    const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
    const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
    const preSleepSatisfiedNow = !replyWait && (!arrived
      ? waitedMs >= preSleepWaitMs
      : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
    if (preSleepSatisfiedNow) {
      st.preSleepWaitSatisfiedAt = Date.now();
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
    } else if (!replyWait && !arrived) {
      st.preSleepWaitAccumMs = 0;
    } else if (!replyWait) {
      if (preSleepAttempt) {
        st.preSleepWaitObservedAt = Date.now();
      }
      st.preSleepWaitAccumMs = 0;
    }
    if (!replyWait) saveSocialV2State();
    // Each buffer is governed by its own tool switch.
    const history = replyWait
      ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
        ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
      : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
    // ── 漏消息窗口（2026-10-18 修）：按「已读过水位」取，凡没进 readThroughSeq 的补给它 ──
    const watermarkAtRequest = readThroughSeqV2(st);
    const pendingFloor = Math.min(baseline, watermarkAtRequest);
    const fullPending = [...new Map(history
      .filter((m) => m && !m.isSelf && (m.seq || 0) > pendingFloor)
      .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
    // 有上限：一次倒 30 条旧账会把上下文挤爆。必须从最老的开始取；截断时 partial=true。
    const waitCap = Math.min(50, Math.max(12, Number(cfg.socialV2?.context?.unreadLimit) || 30));
    const pending = fullPending.length > waitCap ? fullPending.slice(0, waitCap) : fullPending;
    const pendingTruncated = fullPending.length > pending.length;
    const newMessages = replyWait ? pending : (arrived ? pending : []);
    const readThroughSeq = agentToken ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
    const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
      : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
    const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
    finishWait();
    sendJson({
      ok: true,
      key,
      purpose: replyWait ? 'reply' : 'messages',
      arrived,
      quiet,
      quietMs,
      suggestedQuietMs,
      speakerLikelyDone: quiet,
      lastMessageUnfinished,
      timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
      waitedMs,
      preSleepWaitSatisfied: preSleepSatisfiedNow,
      preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
      ...(pendingTruncated ? { partial: true } : {}),
      ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
      ...(!replyWait ? {
        canSleepNow: !preSleepBlocked,
        countsAsObservation: preSleepCountsAsObservation,
        hint: preSleepBlocked
          ? `还不能收尾：还需约 ${Math.ceil(preSleepRemainingMs / 1000)} 秒没有新消息。要完成沉睡前观察，请用 qq_wait_for_messages(timeoutMs=${preSleepWaitMs}) 一次等满——更短的 timeoutMs 不算观察，满足不了闸门（本次 ${Math.round(timeoutMs)}ms ${preSleepCountsAsObservation ? '达标' : '不达标'}）。`
          : '现在可以直接收尾：qq_mark_read(throughSeq=已读水位) 或 qq_set_wake_config(throughSeq=已读水位, config=…)。不用再等一轮。',
      } : {}),
      newMessages,
      readThroughSeq,
      unreadCount: st.unread.length,
    });
    return true;
  };
}

export default createSocialV2WaitHandler;
