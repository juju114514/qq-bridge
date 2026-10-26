/**
 * 会话列表：GET /api/sessions（只读）
 *
 * 「按域拆 handler」第 7 组的前半（sessions 只读部分）。
 *
 * ⚠️ `POST /api/session/reset`（重置会话）**不在本模块**：它要 retire DSH 会话、
 * 清一堆 Map、递增 sessionEpoch，属高危改动，单独评审后再搬。
 */

export function createSessionsHandler(deps) {
  const { sendJson, getState, getCfg } = deps;

  return async function handleSessions(req, url) {
    if (req.method !== 'GET' || url.pathname !== '/api/sessions') return false;
    const state = getState();
    const cfg = getCfg();
    const list = [];
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
    }
    sendJson({ sessions: list });
    return true;
  };
}

export default createSessionsHandler;
