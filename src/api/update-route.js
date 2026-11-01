// GET /api/update/check —— 检查 GitHub 有没有新版本（0.4.114）
//
// 设计：结果有 6 小时缓存，控制台首屏只问一次；force=1 强制刷新（手动点「检查更新」时用）。
export async function handleUpdateRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/update/check') return false;
  if (req.method !== 'GET') { sendJson({ ok: false, error: '只支持 GET' }, 405); return true; }

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  if (typeof d.updateCheck !== 'function') { sendJson({ ok: false, error: '更新检查未就绪' }, 500); return true; }

  try {
    const force = url.searchParams.get('force') === '1';
    const r = await d.updateCheck({ force });
    sendJson(r);
  } catch (error) {
    // 检查失败不该影响控制台，返回 ok:false 让前端静默忽略
    sendJson({ ok: false, error: String(error?.message ?? error), hasUpdate: false });
  }
  return true;
}
