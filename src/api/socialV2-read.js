/**
 * socialV2 —— A 组：只读端点（第一批 8 条）
 *
 *   GET /api/socialV2/config      配置快照
 *   GET /api/socialV2/activity    暂停状态
 *   GET /api/socialV2/tool-log    工具调用日志（最近 N 条）
 *   GET /api/socialV2/feedback    反馈列表
 *   GET /api/socialV2/states      所有会话的唤醒快照
 *   GET /api/socialV2/my-recent   自己最近说过的话
 *   GET /api/socialV2/memory      轻量记忆
 *   GET /api/socialV2/slang/query 黑话查询
 *
 * 「按域拆 handler」第 9 组的 A 批。全部只读，不改任何状态。
 * 校验顺序与原实现一致：key 空 → agent token → 会话白名单 → 工具开关。
 */

export function createSocialV2ReadHandler(deps) {
  const {
    sendJson,
    getCfg,
    getSocialV2,
    readToolLog,
    readFeedbackEntries,
    getSocialV2State,
    agentTokenOk,
    v2SessionAllowed,
    v2ToolEnabled,
    readThroughSeqV2,
    formatMemoryV2,
    confirmedSlangListV2,
    buildSlangContext,
    getSlangEntries,
  } = deps;

  /** 三条 agent 校验，顺序与原实现一致；返回 true 表示已拒绝并回复 */
  function rejectAgent(req, key, toolFlag, toolName) {
    const agentToken = req.headers['x-agent-token'];
    if (agentToken && !agentTokenOk(key, agentToken)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return true;
    }
    if (agentToken && !v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return true;
    }
    if (agentToken && !v2ToolEnabled(toolFlag)) {
      sendJson({ ok: false, error: `工具未启用：${toolName}` }, 403);
      return true;
    }
    return false;
  }

  return async function handleSocialV2Read(req, url) {
    if (req.method !== 'GET') return false;
    const { pathname } = url;

    if (pathname === '/api/socialV2/config') {
      sendJson({ ok: true, config: getCfg().socialV2 ?? {} });
      return true;
    }

    if (pathname === '/api/socialV2/activity') {
      sendJson({ ok: true, paused: getSocialV2().paused });
      return true;
    }

    if (pathname === '/api/socialV2/tool-log') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ok: true, entries: readToolLog(limit) });
      return true;
    }

    if (pathname === '/api/socialV2/feedback') {
      sendJson({ ok: true, entries: readFeedbackEntries() });
      return true;
    }

    if (pathname === '/api/socialV2/states') {
      const list = [];
      for (const [key, st] of getSocialV2().conversations) {
        list.push({
          key,
          wakeConfig: st.wakeConfig,
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          noActionCount: st.wakeConfig.noActionCount || 0,
        });
      }
      sendJson({ ok: true, conversations: list });
      return true;
    }

    if (pathname === '/api/socialV2/my-recent') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'getMyRecent', 'qq_get_my_recent_messages')) return true;
      const st = getSocialV2State(key);
      const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
      sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
      return true;
    }

    if (pathname === '/api/socialV2/memory') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const category = String(url.searchParams.get('category') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'memory', 'qq_memory_query')) return true;
      const st = getSocialV2State(key);
      const raw = {
        activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
        pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt) : [],
        memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
      };
      if (category === 'activeTopic') {
        raw.pendingThoughts = [];
        raw.memberImpressions = {};
      } else if (category === 'pendingThought') {
        raw.activeTopics = [];
        raw.memberImpressions = {};
      } else if (category === 'memberImpression') {
        raw.activeTopics = [];
        raw.pendingThoughts = [];
      }
      sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
      return true;
    }

    if (pathname === '/api/socialV2/slang/query') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (rejectAgent(req, key, 'slangQuery', 'qq_slang_query')) return true;
      const list = confirmedSlangListV2().filter((e) => {
        if (!q) return true;
        return e.content.toLowerCase().includes(q)
          || e.meaning.toLowerCase().includes(q)
          || e.usage.toLowerCase().includes(q)
          || e.example.toLowerCase().includes(q);
      });
      sendJson({
        ok: true,
        key,
        total: list.length,
        entries: list,
        block: buildSlangContext(getSlangEntries(), getCfg().slang?.injectMax ?? 8),
      });
      return true;
    }

    return false;
  };
}

export default createSocialV2ReadHandler;
