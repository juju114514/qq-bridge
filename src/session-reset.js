// /reset（重开上下文）：把一个会话的全部残留清干净。
//
// 为什么值得单独成模块：
//   这段要动 18 个集合 + 6 个副作用钩子，散在 bridge 里最容易"漏删一个"——
//   漏删的后果不是报错，而是内存慢慢涨、旧上下文串进新会话（很难查）。
//   抽出来之后有一个可以**离线跑**的清单测试：所有集合都必须被清。
//
// 设计：
//   · collections —— 纯数据（Map/Set/数组包装），本模块直接 delete
//   · hooks       —— 有副作用的（清定时器、取消挂起、落盘、通知 DSH），调用方注入
//   · 顺序固定：先清数据 → 再取消挂起 → 再落盘 → 最后通知 DSH

export function createSessionResetter({ collections = {}, hooks = {} } = {}) {
  const {
    sessionRegistry,
    state, social, socialV2,
    pending, queued, queuedHintAt, sessionPromises,
    messageMediaStore, slangWindows, slangExtractionCooldowns, slangSubmitTimes,
    pendingWakeKeys, wakeConfigUpdatedKeys, markReadCalledKeys, wakeConfigMissCount,
    seenForwardIds
  } = collections;

  /**
   * @param {string} key 会话 key（group:123 / private:456）
   * @returns {{ok:boolean, sessionId:string|null, reason?:string}}
   */
  async function resetConversation(key) {
    const sessionId = state?.sessions?.[key] ?? null;
    if (!sessionId) return { ok: false, sessionId: null, reason: 'no-session' };

    // ① 会话级集合：registry 一次性清（epoch 也要递增，防止在飞的异步流程复活旧会话）
    sessionRegistry?.bumpEpoch?.();
    sessionRegistry?.clearSession?.(sessionId);
    delete state.sessions[key];
    delete state.sessionPolicies?.[key];

    // ② 按会话 key 归属的集合
    social?.silentTurns?.delete(sessionId);
    social?.exitingSessions?.delete(sessionId);
    social?.recentMessages?.delete(key);
    social?.pendingSummaries?.delete(key);
    social?.states?.delete(key);
    social?.silentContext?.delete(key);
    socialV2?.conversations?.delete(key);
    messageMediaStore?.delete(key);
    slangWindows?.delete(key);
    slangExtractionCooldowns?.delete(key);
    slangSubmitTimes?.delete(key);
    pendingWakeKeys?.delete(key);
    wakeConfigUpdatedKeys?.delete(key);
    markReadCalledKeys?.delete(key);
    wakeConfigMissCount?.delete(key);
    seenForwardIds?.delete(key);
    queued?.delete(key);
    queuedHintAt?.delete(key);
    sessionPromises?.delete(key);

    // ③ 挂起项：先清定时器再取消，避免取消回调里再去 clear 一个不存在的定时器
    const pend = pending?.get?.(key);
    if (pend) {
      try { if (pend.timer) hooks.clearTimeout?.(pend.timer); } catch { /* 忽略 */ }
      try { await hooks.cancelPendingEntry?.(pend); } catch { /* 忽略 */ }
    }
    pending?.delete?.(key);

    // ④ 其它副作用（定时器 / 队列落盘 / 令牌缓存）
    try { hooks.cancelSocialTimers?.(key); } catch { /* 忽略 */ }
    try { hooks.clearSocialV2Timers?.(key); } catch { /* 忽略 */ }
    try { hooks.drainPromptQueue?.(key, '会话已重置'); } catch { /* 忽略 */ }
    try { hooks.forgetAgentToken?.(key); } catch { /* 忽略 */ }
    try { hooks.persistQueueSoon?.(); } catch { /* 忽略 */ }
    try { hooks.saveSocialV2State?.(); } catch { /* 忽略 */ }
    try { hooks.saveState?.(); } catch { /* 忽略 */ }

    // ⑤ 通知 DSH：先停排队工作，再归档（归档只隐藏，不删数据）
    //    这两个也可能失败（DSH 重启/会话已不存在），失败不能影响"本地已清理"这个事实
    try { await hooks.stopSessionWork?.(sessionId); } catch { /* 忽略 */ }
    try { await hooks.archiveSession?.(sessionId); } catch { /* 忽略 */ }

    return { ok: true, sessionId };
  }

  return { resetConversation };
}