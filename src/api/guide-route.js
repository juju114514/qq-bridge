// 攻略实时候选接口（控制台/调试用，0.5.63）
//
//   GET /api/guide?game=原神&topic=深渊12层
//
// 返回：ok / text（给模型看的整理文本）/ sources（标题+链接+日期）/ cached
// 走与控制台相同的鉴权（由 console-extra-routes 统一把关）。
import { fetchGuide, formatGuide } from '../guide-fetch.js';

export async function handleGuideRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !url.pathname.startsWith('/api/guide')) return false;
  if (req.method !== 'GET') {
    sendJson({ ok: false, error: '只支持 GET' }, 405);
    return true;
  }

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const stateDir = d.stateDir || 'state';

  const game = String(url.searchParams.get('game') || '').trim();
  const topic = String(url.searchParams.get('topic') || '').trim();
  if (!game) {
    sendJson({ ok: false, error: '缺少 game 参数（例：?game=原神&topic=深渊12层）' }, 400);
    return true;
  }

  try {
    const payload = await fetchGuide({ game, topic, stateDir, useCache: true });
    sendJson({
      ok: Boolean(payload?.ok),
      game,
      topic,
      cached: Boolean(payload?.cached),
      fetchedAt: payload?.fetchedAt || '',
      query: payload?.query || '',
      error: payload?.ok ? '' : (payload?.error || '没抓到内容'),
      text: formatGuide(payload),
      sources: (payload?.sources || []).map((s) => ({
        title: s.title,
        url: s.url,
        date: s.date || '',
        fetched: Boolean(s.fetched),
        excerpt: String(s.excerpt || '').slice(0, 300)
      }))
    });
  } catch (error) {
    sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 200) }, 500);
  }
  return true;
}
