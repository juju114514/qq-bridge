// 控制台：群成员查询（GET /api/socialV2/group-members）。
//
// 权限语义比看上去复杂，三条都**不能简化**：
//   ① 有 agent token 时必须校验 token（否则任意群号都能枚举）
//   ② 白名单/模式判定**不能**挂在"有令牌"条件里
//      —— closed-agent 的代理调用本来就不带令牌，只按 header 判会放开枚举
//   ③ 不能用 v2SessionAllowed 一把梭：它的 closed-agent 分支只放行 private:<ownerQQ>，
//      于是"管理员私聊里让 AI 看看某群成员"会 403（旧工具本来支持，属于回归）
//      → closed-agent 下按同样严格的 allowed('group', id) 放行群读取

export function createGroupMembersHandler(baseDeps = {}) {
  const {
    log = () => {}, getCfg, getMode, allowed, v2SessionAllowed, v2ToolEnabled, agentTokenOk,
    bot, onebotHttpAction, truncateText
  } = baseDeps;

  async function handle(ctx = {}) {
    const { req, url, sendJson } = ctx;
    const cfg = getCfg();
    const currentMode = getMode();
    const key = String(url.searchParams.get('key') ?? '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const groupMatch = /^group:(\d+)$/.exec(key);
    if (!groupMatch) { sendJson({ ok: false, error: '群成员只能按 group:群号 查询' }, 400); return true; }

    const agentToken = req.headers['x-agent-token'];
    if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }

    const groupMembersAllowed = currentMode === 'closed-agent'
      ? allowed('group', Number(groupMatch[1]), cfg)
      : v2SessionAllowed(key);
    if (!groupMembersAllowed) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (agentToken && !v2ToolEnabled('getGroupMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_group_members' }, 403); return true; }

    const groupId = Number(groupMatch[1]);
    try {
      let response;
      try {
        response = await bot.request('get_group_member_list', { group_id: groupId });
      } catch {
        // 与表情库同步同一条原则：WS 挂了不代表网关挂了，读接口走 HTTP 兜底。
        response = await onebotHttpAction('get_group_member_list', { group_id: groupId });
      }
      const payload = response && typeof response === 'object' && response.data !== undefined ? response.data : response;
      const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
      if (!raw) { sendJson({ ok: false, error: '网关返回的成员列表格式异常，已拒绝' }, 502); return true; }
      const members = raw.slice(0, limit).map((m) => ({
        userId: m?.user_id != null ? String(m.user_id) : '',
        nickname: truncateText(String(m?.nickname ?? ''), 40),
        card: truncateText(String(m?.card ?? ''), 40),
        ...(m?.role ? { role: String(m.role) } : {})
      })).filter((m) => m.userId);
      sendJson({ ok: true, key, count: raw.length, returned: members.length, truncated: raw.length > members.length, members });
    } catch (error) {
      log(`群成员查询失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `获取群成员失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  return { handle };
}