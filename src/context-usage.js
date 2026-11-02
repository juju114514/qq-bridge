// 上下文用量（0.4.141）
//
// 数据来源：DSH 的 `session/snapshot` 帧里已经有 `contextPressure` 与 `contextBreakdown`
// （schema 实测确认：systemTokens / toolsTokens / messageTokens）。
// 桥接本来就收这个帧，只是过去只喂了 token 账本 —— 这里把它顺手留下来给控制台显示。
//
// 设计取向：**只做展示，不做估算**。拿不到就显示"暂无数据"，绝不编一个数出来。

/**
 * @param {{now?:()=>number, maxSessions?:number}} [opts]
 */
export function createContextUsageStore({ now = () => Date.now(), maxSessions = 20 } = {}) {
  /** @type {Map<string, any>} */
  const bySession = new Map();

  /** 从 snapshot 里抠出上下文相关字段（缺就返回 null，不猜） */
  function extract(snapshot) {
    const values = snapshot?.projections?.values;
    if (!values) return null;
    const pressure = values.contextPressure || null;
    const breakdown = values.contextBreakdown || null;
    if (!pressure && !breakdown) return null;
    return {
      pressureTokens: Number(pressure?.pressureTokens ?? pressure?.pressure ?? 0) || 0,
      capacityTokens: Number(pressure?.capacityTokens ?? 0) || 0,
      systemTokens: Number(breakdown?.systemTokens ?? 0) || 0,
      toolsTokens: Number(breakdown?.toolsTokens ?? 0) || 0,
      messageTokens: Number(breakdown?.messageTokens ?? 0) || 0
    };
  }

  return {
    /** 收到 session/snapshot 时调用 */
    record(sessionId, snapshot) {
      const data = extract(snapshot);
      if (!data) return;
      bySession.set(String(sessionId), { sessionId: String(sessionId), at: now(), ...data });
      if (bySession.size > maxSessions) {
        const oldest = [...bySession.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) bySession.delete(oldest[0]);
      }
    },

    /** 取某会话（不给就取最新一条） */
    latest(sessionId = '') {
      if (sessionId) return bySession.get(String(sessionId)) || null;
      const all = [...bySession.values()].sort((a, b) => b.at - a.at);
      return all[0] || null;
    },

    all() {
      return [...bySession.values()].sort((a, b) => b.at - a.at);
    },

    /**
     * 给控制台用的完整视图：把三个分类 + 剩余 拼成百分比。
     * 分母优先用 capacityTokens（DSH 报的路线容量），没有就用 pressureTokens。
     */
    view(sessionId = '') {
      const one = this.latest(sessionId);
      if (!one) return { ok: false, reason: '还没收到会话快照（等 DSH 发下一轮）', sessions: this.all().length };

      // 百分比只在**知道容量**时给：没有容量就没有"用了几成"这回事，不能拿压力自己除自己凑 100%
      const capacity = one.capacityTokens || 0;
      const measured = one.pressureTokens || 0;
      const parts = [
        { key: 'system', label: '系统提示词', tokens: one.systemTokens, color: '#6b8cff' },
        { key: 'tools', label: '工具定义', tokens: one.toolsTokens, color: '#9a7bff' },
        { key: 'messages', label: '对话消息', tokens: one.messageTokens, color: '#43c59e' }
      ];
      const broken = parts.reduce((n, p) => n + p.tokens, 0);
      // 压力读数通常大于 breakdown（前者含缓存/系统开销），差额单列"未分类"，
      // 这样分段条之和 = 压力读数，视觉上不会留一块看不懂的空缺。
      const unaccounted = Math.max(0, (one.pressureTokens || 0) - broken);
      if (unaccounted > 0) parts.push({ key: 'other', label: '未分类', tokens: unaccounted, color: '#5a6b86' });
      // breakdown 是"下一条请求的启发式构成"，pressure 是"上一次请求的实际读数"；
      // 两者可能不等 —— 分开呈现，不强行凑成一个数。
      return {
        ok: true,
        sessionId: one.sessionId,
        at: one.at,
        pressureTokens: one.pressureTokens,
        capacityTokens: one.capacityTokens,
        brokenTotal: broken,
        percent: capacity > 0 && measured > 0 ? Math.min(100, Math.round((measured / capacity) * 1000) / 10) : null,
        remainder: capacity > 0 && measured > 0 ? Math.max(0, capacity - measured) : null,
        parts,
        sessions: this.all().length
      };
    }
  };
}
