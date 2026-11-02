// 上下文用量路由（0.4.141）
export async function handleContextUsageRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || url.pathname !== '/api/context/usage' || req.method !== 'GET') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const store = d.contextUsage || null;
  if (!store) { sendJson({ ok: false, reason: '上下文用量模块未接线' }, 503); return true; }

  const sessionId = String(url.searchParams.get('session') || '');
  const view = store.view(sessionId);
  sendJson({ ok: true, at: Date.now(), ...view });
  return true;
}
