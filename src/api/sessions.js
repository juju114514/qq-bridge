/**
 * 会话：GET /api/sessions（只读列表）、POST /api/session/reset（重置单个会话）
 *
 * 「按域拆 handler」第 7 组（sessions/tokens）的后半。
 *
 * ⚠️ reset 是高危路径：它要同时清掉 ~30 个 Map/Set + state 四个字段，并 retire DSH 旧会话。
 * 迁移前先有回归测试（scripts/test-session-reset.mjs，10 项断言）钉住「清干净了没有」。
 *
 * 顺序很关键，别改：
 *   1. 校验 key 存在
 *   2. sessionEpoch++ / 删除 state 字段
 *   3. 按 sessionId 清 Map → 按 key 清 Map → 清定时器/令牌
 *   4. 落盘（saveSocialV2State / saveState）
 *   5. **最后**才停并归档 DSH 会话（失败只告警，不影响本地已清理的结果）
 */

export function createSessionsHandler(deps) {
  const {
    sendJson,
    readBody,
    log,
    getState,
    getCfg,
    bumpSessionEpoch,
    maps,
    pending,
    queued,
    queuedHintAt,
    sessionPromises,
    cancelPendingEntry,
    drainPromptQueue,
    social,
    messageMediaStore,
    slangWindows,
    slangExtractionCooldowns,
    slangSubmitTimes,
    cancelSocialTimers,
    clearSocialV2Timers,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    forgetAgentToken,
    socialV2,
    seenForwardIds,
    saveSocialV2State,
    saveState,
    api,
    withTimeout,
    DSH_CONTROL_TIMEOUT_MS,
  } = deps;

  async function handleReset(req) {
    const body = await readBody();
    const state = getState();
    const key = String(body.key ?? '');
    if (!key || !state.sessions[key]) {
      sendJson({ ok: false, error: '会话不存在' }, 404);
      return true;
    }

    bumpSessionEpoch();
    const oldSessionId = state.sessions[key];
    delete state.sessions[key];
    maps.modelAppliedSessions.delete(oldSessionId);
    // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
    delete state.sessionPolicies[key];
    maps.reverse.delete(oldSessionId);
    maps.collectors.delete(oldSessionId);
    maps.sendToolSucceededSessions.delete(oldSessionId);
    maps.pendingSendToolCalls.delete(oldSessionId);
    maps.v2TurnStartAt.delete(oldSessionId);
    maps.turnLeaseNoted.delete(oldSessionId);
    maps.toolCallNames.delete(oldSessionId);

    const pe = pending.get(key);
    if (pe) {
      clearTimeout(pe.timer);
      cancelPendingEntry(pe).catch(() => {});
    }
    pending.delete(key);
    queued.delete(key);
    queuedHintAt.delete(key);
    sessionPromises.delete(key);
    drainPromptQueue(key, '会话已重置');
    social.recentMessages.delete(key);
    messageMediaStore.delete(key);
    social.pendingSummaries.delete(key);
    social.states.delete(key);
    social.silentContext.delete(key);
    social.silentTurns.delete(oldSessionId);
    social.exitingSessions.delete(oldSessionId);
    slangWindows.delete(key);
    slangExtractionCooldowns.delete(key);
    slangSubmitTimes.delete(key);
    cancelSocialTimers(key);
    clearSocialV2Timers(key);
    pendingWakeKeys.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
    wakeConfigMissCount.delete(key);
    forgetAgentToken(key);
    socialV2.conversations.delete(key);
    seenForwardIds.delete(key);
    saveSocialV2State();
    saveState();

    // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
    try {
      await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork');
    } catch (error) {
      log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`);
    }
    try {
      await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession');
    } catch (error) {
      log(`⚠️ 归档旧会话失败 ${key}：${error?.message ?? error}`);
    }
    log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
    sendJson({ ok: true, key, archived: oldSessionId });
    return true;
  }

  return async function handleSessions(req, url) {
    // ── GET /api/sessions ────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const state = getState();
      const cfg = getCfg();
      const list = [];
      for (const [key, sessionId] of Object.entries(state.sessions)) {
        list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
      }
      sendJson({ sessions: list });
      return true;
    }

    // ── POST /api/session/reset ─────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/session/reset') {
      return handleReset(req);
    }

    return false;
  };
}

export default createSessionsHandler;
