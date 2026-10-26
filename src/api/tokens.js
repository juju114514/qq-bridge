/**
 * 用量账本：GET /api/tokens/{summary,series,turns,recent}、POST /api/tokens/reset
 *
 * 「按域拆 handler」第 7 组的前半（tokens）。
 *
 * 注意：**「仅控制台可用」的 agent-token 拒绝仍留在 bridge**（因为它包住整个
 * /api/tokens/ 前缀），本模块只处理「已经通过那道闸门」的请求。
 */

export function createTokensHandler(deps) {
  const { sendJson, log, getTokenLedger, getPriceTable } = deps;

  return async function handleTokens(req, url) {
    const { pathname } = url;
    const method = req.method;
    const tokenLedger = getTokenLedger();

    if (method === 'GET' && pathname === '/api/tokens/summary') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
      return true;
    }

    if (method === 'GET' && pathname === '/api/tokens/series') {
      const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
      sendJson(tokenLedger.series({ hours, maxBuckets }));
      return true;
    }

    if (method === 'GET' && pathname === '/api/tokens/turns') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const detail = tokenLedger.conversation(key, { turnLimit: limit });
      if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return true; }
      sendJson(detail);
      return true;
    }

    if (method === 'GET' && pathname === '/api/tokens/recent') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      sendJson({ ok: true, symbol: getPriceTable().symbol, entries: tokenLedger.recent(limit) });
      return true;
    }

    if (method === 'POST' && pathname === '/api/tokens/reset') {
      tokenLedger.reset();
      log('控制台：token 用量账本已重置');
      sendJson({ ok: true });
      return true;
    }

    return false;
  };
}

export default createTokensHandler;
