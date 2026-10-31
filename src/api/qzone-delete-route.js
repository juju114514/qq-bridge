// POST /api/qzone/delete —— 删除自己空间的一条说说（0.4.80）
//
// 为什么需要：发图/发说说是**对外不可撤销**的动作，没有删除能力就等于只能由人去 QQ 里手动删。
// 之前探测发现我们没有任何删除路径，这一版补上，并且**先探测网关到底认不认这个 action**。
//
// 用法：POST { tid } 或 { ids: [tid, ...] }（最多 10 条）
//   返回每条的结果：{ tid, ok, error? }
import { QZONE_DELETE_ACTIONS } from '../qzone-post-ops.js';

export async function handleQzoneDeleteRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/qzone/delete') return false;
  if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const onebot = d.onebotAction;
  if (typeof onebot !== 'function') {
    sendJson({ ok: false, error: '当前版本没有网关动作通道（onebotAction 未注入）' }, 501);
    return true;
  }

  const body = (await (ctx.readBody || d.readBody)?.()) || {};
  const ids = (Array.isArray(body.ids) ? body.ids : [body.tid])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, 10);
  if (!ids.length) { sendJson({ ok: false, error: 'tid 不能为空' }, 400); return true; }

  const results = [];
  for (const tid of ids) {
    let done = null;
    let lastErr = '';
    // 依次试候选 action 名：不同网关实现命名不同，认第一个成功的
    for (const action of QZONE_DELETE_ACTIONS) {
      try {
        const res = await onebot(action, { tid }, { timeoutMs: 20000 });
        const failed = res && (res.status === 'failed' || (res.retcode && res.retcode !== 0));
        if (!failed) { done = action; break; }
        lastErr = String(res?.wording || res?.message || `${action} 失败`);
        // 明确的"不支持的 action"就直接换下一个；其它错误（如无权限）也换，但保留最后一条错误
      } catch (error) {
        lastErr = String(error?.message ?? error);
      }
    }
    results.push({ tid, ok: Boolean(done), action: done || '', error: done ? '' : (lastErr || '所有候选 action 都失败') });
  }

  const okCount = results.filter((r) => r.ok).length;
  sendJson({
    ok: okCount > 0,
    deleted: okCount,
    failed: results.length - okCount,
    results,
    note: okCount === results.length
      ? `已删除 ${okCount} 条`
      : (okCount === 0
        ? '网关不支持删除（或没有权限）——只能去 QQ 空间手动删'
        : `删了 ${okCount} 条，失败 ${results.length - okCount} 条`)
  });
  return true;
}
