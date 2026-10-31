// GET / POST /api/roles/map —— 每个群/私聊接入的是哪个角色 + 角色状态（0.4.98）
//
// GET  → { ok, groupEnabled, groupDefaultName, globalRole, paused, rows:[{key,kind,id,label,role,source,wake,overridden}], issues:[] }
// POST { key, role }        → 给该会话单独设角色（role=null 表示"跟随默认"）
import { summarizeAssignments, isolationReport, effectiveRole } from '../role-map.js';

export async function handleRoleMapRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/roles/map') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  // 直接读 state 文件：内存里的 socialV2 有时还没 hydrate，
  // 页面会显示"0 个会话"——而用户要看的就是"每个群用的谁"，读盘才是准的。
  const readJson = (p) => {
    try {
      const raw = typeof d.readFile === 'function' ? d.readFile(p) : '';
      return raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : null;
    } catch { return null; }
  };
  let conversations = [];
  const pausedFromFile = (() => {
    const sv = readJson(d.files?.socialV2 || '');
    if (sv && sv.conversations && typeof sv.conversations === 'object') {
      conversations = Object.entries(sv.conversations).map(([key, c]) => ({ key, wakeConfig: c?.wakeConfig }));
      return Boolean(sv.paused);
    }
    return null;
  })();
  if (!conversations.length && typeof d.listConversations === 'function') {
    conversations = d.listConversations() || [];
  }
  const rolesByKey = (() => {
    const fromFile = readJson(d.files?.rolesByKey || '');
    if (fromFile && typeof fromFile === 'object') return fromFile;
    return typeof d.getRolesByKey === 'function' ? (d.getRolesByKey() || {}) : {};
  })();
  const globalRole = typeof d.getGlobalRole === 'function' ? (d.getGlobalRole() || null) : null;
  const roleCfg = typeof d.getRoleCfg === 'function' ? (d.getRoleCfg() || {}) : {};
  const paused = pausedFromFile !== null ? pausedFromFile : (typeof d.isSocialPaused === 'function' ? Boolean(d.isSocialPaused()) : false);
  const groupEnabled = roleCfg.groupEnabled === true;
  const groupDefaultName = roleCfg.groupDefaultName || null;

  if (req.method === 'GET') {
    const rows = summarizeAssignments({ conversations, rolesByKey, globalRole, groupEnabled, groupDefaultName, paused });
    sendJson({
      ok: true,
      groupEnabled,
      groupDefaultName,
      globalRole,
      paused,
      rows,
      issues: isolationReport({ conversations, rolesByKey, groupEnabled })
    });
    return true;
  }

  if (req.method === 'POST') {
    const body = (await ctx.readBody?.()) || {};
    const key = String(body.key || '').trim();
    if (!/^(group|private):[A-Za-z0-9_-]+$/.test(key)) { sendJson({ ok: false, error: 'key 形如 group:123' }, 400); return true; }
    if (typeof d.setRoleForKey !== 'function') { sendJson({ ok: false, error: '当前版本不支持按会话设角色' }, 501); return true; }
    const role = body.role === null || body.role === '' ? null : String(body.role);
    try {
      d.setRoleForKey(key, role);
      const eff = effectiveRole({
        key,
        record: role ? { role } : null,
        globalRole,
        groupEnabled,
        groupDefaultName
      });
      sendJson({ ok: true, key, role, effective: eff.role, note: role ? '已给该会话单独设置角色' : '已恢复为跟随默认' });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  sendJson({ ok: false, error: '只支持 GET / POST' }, 405);
  return true;
}
