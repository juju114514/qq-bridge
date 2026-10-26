/**
 * 表情库：GET /api/stickers, POST /api/stickers/{sync,note,remark}
 *
 * 「按域拆 handler」第 5 组（stickers）。行为逐行等价；只把「读副本」改成 getter，
 * 因为 bridge 里的 stickerEntries / stickerSyncedAt 会被同步流程整体替换。
 */

export function createStickersHandler(deps) {
  const {
    sendJson,
    readBody,
    getCfg,
    syncStickerLibrary,
    formatStickerList,
    getStickerEntries,
    getStickerSyncedAt,
    isWritable,
    applyStickerNoteV2,
    setStickerRemarkV2,
  } = deps;

  return async function handleStickers(req, url) {
    const { pathname } = url;
    const method = req.method;

    // ── GET /api/stickers ──────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/stickers') {
      const cfg = getCfg();
      const query = String(url.searchParams.get('query') ?? '').trim();
      const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
      // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
      try {
        const synced = await syncStickerLibrary(false);
        const list = formatStickerList(synced?.entries ?? getStickerEntries(), query, count);
        sendJson({
          ok: true,
          ...list,
          syncedAt: synced?.syncedAt ?? getStickerSyncedAt(),
          fromCache: synced?.fromCache ?? false,
          writable: isWritable(),
        });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/stickers/sync ────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/stickers/sync') {
      try {
        const synced = await syncStickerLibrary(true);
        sendJson({
          ok: true,
          total: synced?.entries?.length ?? getStickerEntries().length,
          syncedAt: synced?.syncedAt ?? getStickerSyncedAt(),
          fromCache: synced?.fromCache ?? false,
        });
      } catch (error) {
        sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    // ── POST /api/stickers/note —— 本地笔记（含义/标签/用法）─────────────────
    if (method === 'POST' && pathname === '/api/stickers/note') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      const note = body.note !== undefined && body.note !== null
        ? String(body.note).trim().slice(0, 200) : undefined;
      const tags = body.tags !== undefined && body.tags !== null
        ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean) : [])
        : undefined;
      const usage = body.usage !== undefined && body.usage !== null
        ? String(body.usage).trim().slice(0, 200) : undefined;
      if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
      const entry = applyStickerNoteV2(stickerId, note, tags, usage);
      if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
      sendJson({ ok: true, sticker: entry });
      return true;
    }

    // ── POST /api/stickers/remark —— QQ 侧备注 ─────────────────────────────
    if (method === 'POST' && pathname === '/api/stickers/remark') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
      try {
        const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
        sendJson({ ok: true, sticker: entry });
      } catch (error) {
        sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

    return false;
  };
}

export default createStickersHandler;
