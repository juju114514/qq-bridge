// 表情策展的执行入口：把"要不要"（sticker-curator）接到桥接上。
//
//   POST /api/socialV2/sticker/curate
//   { key, meaning, tags?, duplicate?, relevance?, mood?, apply?:true }
//
// 两种用法：
//   · apply 不传 —— 只返回决策（给模型看，成本低，不产生副作用）
//   · apply=true —— 决策为 collect 时真的收藏；决策为 send 时给出候选表情
//
// 为什么要分两步：模型先说含义 → 我们判价值 → 有价值才动接口。
// 一步到底会让"看不懂的图"也进收藏夹，越攒越乱。

import { decideCollect, decideProactiveSend, scoreSticker, normalizeMeaning } from '../sticker-curator.js';

export function createStickerCurateHandler(deps) {
  const { sendJson, readBody, log, getCfg, collectSticker, pickSticker } = deps;

  return async function handleStickerCurate(req, url) {
    if (url.pathname !== '/api/socialV2/sticker/curate') return false;
    if (req.method !== 'POST') { sendJson({ ok: false, error: '只支持 POST' }, 405); return true; }

    const body = await readBody();
    const cfg = getCfg() || {};
    const opts = cfg.socialV2?.sticker?.curator || {};
    const key = String(body.key ?? '').trim();
    const meaning = normalizeMeaning(body.meaning);
    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 6) : [];
    const duplicate = body.duplicate === true;
    const relevance = Number(body.relevance ?? 0) || 0;
    const mood = String(body.mood ?? '');

    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!meaning) { sendJson({ ok: false, error: 'meaning 不能为空（说不出含义就别收藏）' }, 400); return true; }

    const score = scoreSticker({ meaning, tags, duplicate, animated: body.animated === true, eyesOnly: body.eyesOnly === true });
    const collectVerdict = decideCollect({ score, collectedToday: Number(body.collectedToday ?? 0) || 0 }, opts);
    const sendVerdict = decideProactiveSend({
      relevance,
      lastSentAt: Number(body.lastSentAt ?? 0) || 0,
      sentThisHour: Number(body.sentThisHour ?? 0) || 0,
      mood
    }, opts);

    if (body.apply !== true) {
      sendJson({ ok: true, applied: false, meaning, score, collect: collectVerdict, send: sendVerdict });
      return true;
    }

    if (collectVerdict.collect && typeof collectSticker === 'function') {
      try {
        await collectSticker(key, meaning);
        log(`[sticker] 已收藏：${meaning}（score=${score}）`);
      } catch (error) {
        sendJson({ ok: false, error: `收藏失败：${error?.message ?? error}` }, 500);
        return true;
      }
    }

    let candidate = null;
    if (sendVerdict.send && typeof pickSticker === 'function') {
      try { candidate = await pickSticker(meaning, mood); } catch { candidate = null; }
    }

    sendJson({ ok: true, applied: true, meaning, score, collected: collectVerdict.collect, candidate });
    return true;
  };
}
