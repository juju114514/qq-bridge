// 死信端点：查看被丢弃的消息、把它们重放回队列。
//
//   GET  /api/socialV2/dead-letter            概览（总数/按原因/最近 N 条）
//   POST /api/socialV2/dead-letter/requeue    { key?, limit? } → 摘出来塞回 pending-queue
//
// 挂在 /api/socialV2/ 下是为了继承 prelude 的控制台令牌与只读降级。

export function createDeadLetterHandler(deps) {
  const { sendJson, readBody, log, droppedFile, summarize, readRecent, requeue } = deps;

  return async function handleDeadLetter(req, url) {
    if (url.pathname === '/api/socialV2/dead-letter') {
      const summary = summarize ? summarize() : { total: 0, byReason: {} };
      sendJson({
        ok: true,
        file: droppedFile,
        total: summary.total,
        byReason: summary.byReason,
        recent: readRecent ? readRecent(20) : []
      });
      return true;
    }

    if (url.pathname === '/api/socialV2/dead-letter/requeue') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const limit = Math.max(1, Math.min(50, Number(body.limit) || 10));
      if (!requeue) { sendJson({ ok: false, error: '重放不可用（桥接未提供 requeue）' }, 400); return true; }
      try {
        const r = await requeue({ key, limit });
        log(`[dead-letter] 重放 ${r.requeued} 条（key=${key || '全部'}），剩余 ${r.remaining} 条`);
        sendJson({ ok: true, ...r });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return true;
    }

    return false;
  };
}
