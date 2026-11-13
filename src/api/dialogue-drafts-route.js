/**
 * 示例对话草稿箱接口（0.5.64）
 *
 *   GET  /api/dialogue-drafts                 草稿列表
 *   POST /api/dialogue-drafts                 新增草稿 { card, level, text }
 *   POST /api/dialogue-drafts/update          改草稿  { id, text }
 *   POST /api/dialogue-drafts/apply           写进卡片 { id } | { card, text }
 *   POST /api/dialogue-drafts/discard         丢弃    { id }
 *
 * 「人确认」就落在 apply 这一步：草稿可以反复改，只有 apply 才动 roles/<名字>.md。
 */

import path from 'node:path';
import { addDraft, applyDialoguesToCard, dropDraft, readDrafts, updateDraft } from '../role-dialogue-write.js';

export function createDialogueDraftsHandler(deps) {
  const { sendJson, readBody, log, fs, ROOT, STATE_DIR, roleFilePath, roleEntry } = deps;

  function resolveCard(fileOrName) {
    const raw = String(fileOrName || '').trim();
    if (!raw) throw new Error('缺少 card（人格卡文件名或名字）');
    // 允许传完整路径（只接受 roles/ 下的 .md）
    if (/\.md$/i.test(raw)) {
      const base = path.basename(raw);
      const direct = path.join(ROOT, 'roles', base);
      if (fs.existsSync(direct)) return direct;
      // 也可能是 id
      const entry = typeof roleEntry === 'function' ? roleEntry(raw.replace(/\.md$/i, '')) : null;
      if (entry?.file) return entry.file;
    }
    const entry = typeof roleEntry === 'function' ? roleEntry(raw) : null;
    if (entry?.file) return entry.file;
    if (typeof roleFilePath === 'function') {
      const guess = roleFilePath(raw);
      if (guess && fs.existsSync(guess)) return guess;
    }
    throw new Error(`找不到人格卡：${raw}（只允许 roles/ 目录下的 .md）`);
  }

  return async function handleDialogueDrafts(req, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/dialogue-drafts') {
      const list = readDrafts(STATE_DIR);
      sendJson({ ok: true, items: list, count: list.length });
      return true;
    }

    if (method === 'POST' && pathname === '/api/dialogue-drafts') {
      const body = await readBody();
      try {
        const draft = addDraft(STATE_DIR, {
          card: body?.card,
          level: body?.level,
          text: body?.text,
          source: body?.source || 'console'
        });
        log(`[drafts] 新草稿 ${draft.id}（${draft.pairs} 组）`);
        sendJson({ ok: true, draft });
      } catch (e) {
        sendJson({ ok: false, error: String(e?.message ?? e).slice(0, 120) }, 400);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/dialogue-drafts/update') {
      const body = await readBody();
      try {
        const draft = updateDraft(STATE_DIR, String(body?.id || ''), String(body?.text ?? ''));
        sendJson({ ok: true, draft });
      } catch (e) {
        sendJson({ ok: false, error: String(e?.message ?? e).slice(0, 120) }, 400);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/dialogue-drafts/apply') {
      const body = await readBody();
      try {
        let card = body?.card;
        let text = body?.text;
        let id = String(body?.id || '');
        if (id) {
          const draft = readDrafts(STATE_DIR).find((d) => d.id === id);
          if (!draft) throw new Error('草稿不存在（可能已被丢弃）');
          card = draft.card;
          text = text || draft.text;
        }
        const file = resolveCard(card);
        const r = applyDialoguesToCard(file, text);
        if (id) dropDraft(STATE_DIR, id);
        log(`[drafts] 已写进 ${path.basename(file)}（${r.pairs} 组）`);
        sendJson({ ok: true, file: path.basename(file), pairs: r.pairs });
      } catch (e) {
        sendJson({ ok: false, error: String(e?.message ?? e).slice(0, 140) }, 400);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/dialogue-drafts/discard') {
      const body = await readBody();
      try {
        dropDraft(STATE_DIR, String(body?.id || ''));
        sendJson({ ok: true });
      } catch (e) {
        sendJson({ ok: false, error: String(e?.message ?? e).slice(0, 120) }, 400);
      }
      return true;
    }

    return false;
  };
}
