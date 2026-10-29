// 控制台：清空 QQ 聊天工作区（POST /api/workspace/reset）。
//
// 危险动作，但语义简单：**把所有会话连同 token 一起作废**。
// 刻意用"整体 clear"而不是逐会话摘除 —— 逐会话写容易漏一个集合，
// 漏删的后果是内存慢慢涨、旧上下文串进新会话（很难查）。
//
// 顺序有含义：
//   ① 先遍历 DSH 侧会话：只处理 cwd 在本仓库 state/ 下的**根会话**
//      （子代理会话由父会话管理，误归档会破坏别人的工作）
//   ② 再清桥接自己的集合
//   ③ 最后落盘
//
// 依赖分两类：baseDeps（启动给一次）+ ctx（每请求的 sendJson）。

export function createWorkspaceResetHandler(baseDeps = {}) {
  const {
    log = () => {}, fs, path, process: proc,
    api, withTimeout, unwrap, DSH_CONTROL_TIMEOUT_MS, STATE_DIR,
    sessionRegistry, state, social, socialV2,
    pending, queued, queuedHintAt, sessionPromises,
    messageMediaStore, seenForwardIds,
    slangWindows, slangExtractionCooldowns, slangSubmitTimes,
    reverse, collectors, sendToolSucceededSessions, pendingSendToolCalls, v2TurnStartAt, toolCallNames,
    CONVERSATION_TOKENS, KNOWN_AGENT_TOKENS,
    cancelPendingEntry, drainAllPromptQueues, cancelAllSocialTimers, clearAllSocialV2Timers,
    saveSocialV2State, saveState, ACTIVITY_LOG
  } = baseDeps;

  async function resetAll(ctx = {}) {
    const { sendJson } = ctx;
    sessionRegistry?.bumpEpoch?.();
    let archivedCount = 0;
    let stoppedCount = 0;

    try {
      // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
      const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'sessions.list');
      const stateDir = path.resolve(STATE_DIR);
      const statePrefix = path.normalize(stateDir + path.sep);
      const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
      const isUnderState = (cwd) => (proc?.platform === 'win32'
        ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
        : cwd.startsWith(statePrefix));
      for (const item of list.items ?? []) {
        if (item.origin === 'subagent' || item.parentSessionId) continue;
        const cwd = normPath(item.cwd);
        if (!isUnderState(cwd)) continue;
        // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
        try {
          await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork');
          stoppedCount += 1;
        } catch (error) {
          log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`);
        }
        try {
          await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession');
          archivedCount += 1;
        } catch { /* 归档失败不阻塞整体清空 */ }
      }
    } catch { /* 列会话失败也要继续清本地状态 */ }

    for (const entry of pending?.values?.() ?? []) {
      try { clearTimeout(entry.timer); } catch { /* 忽略 */ }
      cancelPendingEntry?.(entry)?.catch?.(() => {});
    }
    pending?.clear?.();
    queued?.clear?.();
    queuedHintAt?.clear?.();
    sessionPromises?.clear?.();
    drainAllPromptQueues?.('工作区已清空');
    social?.states?.clear?.();
    social?.recentMessages?.clear?.();
    messageMediaStore?.clear?.();
    seenForwardIds?.clear?.();
    social?.pendingSummaries?.clear?.();
    social?.silentContext?.clear?.();
    social?.silentTurns?.clear?.();
    social?.exitingSessions?.clear?.();
    slangWindows?.clear?.();
    slangExtractionCooldowns?.clear?.();
    slangSubmitTimes?.clear?.();
    cancelAllSocialTimers?.();
    clearAllSocialV2Timers?.();
    // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）
    socialV2?.conversations?.clear?.();
    CONVERSATION_TOKENS?.clear?.();
    KNOWN_AGENT_TOKENS?.clear?.();
    saveSocialV2State?.();
    if (state) { state.sessions = {}; state.sessionPolicies = {}; }
    reverse?.clear?.();
    collectors?.clear?.();
    sendToolSucceededSessions?.clear?.();
    pendingSendToolCalls?.clear?.();
    v2TurnStartAt?.clear?.();
    toolCallNames?.clear?.();
    saveState?.();
    try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch { /* 忽略 */ }

    log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
    sendJson({ ok: true, archivedCount, stoppedCount });
    return { ok: true, archivedCount, stoppedCount };
  }

  return { resetAll };
}