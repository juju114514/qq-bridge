/**
 * Pixiv 控制台接口（0.5.65）
 *
 *   GET  /api/pixiv/status           cookie 状态 + 当前 R-18 档位（选择项）
 *   POST /api/pixiv/save             写 pixiv.r18Mode / defaultLimit
 *   POST /api/pixiv/search           按 tag 搜（返回标题/作者/分级/链接，不含图片字节）
 *
 * 为什么要走控制台而不是直接发群：
 *   先让人看见「搜出来的是什么、作者是谁、是不是 R-18」，再决定发不发。
 *   分级读两个地方：pixiv.r18Mode（下拉档位）+ 该群 personaPolicy（成人开关），两个都满足才放开。
 */

import {
  COOKIE_FILE,
  R18_MODES,
  effectiveR18Mode,
  hasCookies,
  resolveR18Mode,
  searchWeb
} from '../pixiv-web.js';
import { resolvePolicy } from '../persona-policy.js';
import { clearLibrary, evict, maxBytes, readIndex, removeEntry, stats as libStats } from '../pixiv-library.js';

export function createPixivHandler(deps) {
  const { sendJson, readBody, log, fs, ROOT, STATE_DIR, getCfg } = deps;
  const configFile = () => `${ROOT}/config.json`;

  const snapshot = (scopeKey = '') => {
    const cfg = getCfg() || {};
    const adultOk = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(`${STATE_DIR}/persona-adult.json`, 'utf8'));
        const gid = scopeKey.startsWith('group:') ? scopeKey.slice(6) : '';
        return Array.isArray(raw?.confirmed) && !!gid && raw.confirmed.map(String).includes(gid);
      } catch { return false; }
    })();
    const policy = resolvePolicy({ cfg, key: scopeKey, adultOk });
    const eff = effectiveR18Mode({ cfg, policy, hasCookiesNow: hasCookies(STATE_DIR) });
    return {
      ok: true,
      cookies: { present: hasCookies(STATE_DIR), file: COOKIE_FILE(STATE_DIR) },
      r18Mode: resolveR18Mode(cfg),
      effective: eff.mode,
      effectiveReason: eff.reason,
      modes: R18_MODES,
      defaultLimit: Number(cfg?.pixiv?.defaultLimit ?? 6),
      library: libStats(STATE_DIR, cfg),
      policy: { profanity: policy.profanity, nsfw: policy.nsfw }
    };
  };

  return async function handlePixiv(req, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/pixiv/status') {
      sendJson(snapshot(String(url.searchParams.get('key') || '')));
      return true;
    }

    if (method === 'POST' && pathname === '/api/pixiv/save') {
      const body = await readBody();
      const mode = String(body?.r18Mode ?? '').toLowerCase();
      if (mode && !R18_MODES.includes(mode)) {
        sendJson({ ok: false, error: `r18Mode 只能是 ${R18_MODES.join(' / ')}` }, 400);
        return true;
      }
      const cfg = getCfg();
      const next = {
        ...(cfg.pixiv || {}),
        ...(mode ? { r18Mode: mode } : {}),
        ...(body?.defaultLimit !== undefined ? { defaultLimit: Math.max(1, Math.min(20, Number(body.defaultLimit) || 6)) } : {})
      };
      try {
        const file = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
        file.pixiv = next;
        fs.writeFileSync(configFile(), JSON.stringify(file, null, 2) + '\n', 'utf8');
      } catch (e) {
        sendJson({ ok: false, error: `写 config.json 失败：${String(e?.message ?? e).slice(0, 80)}` }, 500);
        return true;
      }
      cfg.pixiv = next;
      log(`[pixiv] 档位=${next.r18Mode} 默认条数=${next.defaultLimit}`);
      sendJson(snapshot(String(body?.key || '')));
      return true;
    }

    if (method === 'POST' && pathname === '/api/pixiv/search') {
      const body = await readBody();
      const tag = String(body?.tag ?? '').trim();
      if (!tag) { sendJson({ ok: false, error: 'tag 不能为空' }, 400); return true; }
      const snap = snapshot(String(body?.key || ''));
      const limit = Math.max(1, Math.min(20, Number(body?.limit) || snap.defaultLimit));
      try {
        const mode = snap.effective === 'r18' ? 'r18' : 'all';
        const r = await searchWeb({ stateDir: STATE_DIR, tag, limit, mode });
        // 只回元数据；R-18 结果在没放开时过滤掉（双保险）
        const items = r.items.filter((it) => (it.grade === 'safe' ? true : snap.effective !== 'off'));
        sendJson({
          ok: true,
          tag,
          total: r.total,
          effective: snap.effective,
          effectiveReason: snap.effectiveReason,
          cookies: snap.cookies.present,
          items: items.map((it) => ({
            id: it.id, title: it.title, author: it.author, grade: it.grade,
            pageCount: it.pageCount, tags: it.tags, link: it.link
          }))
        });
      } catch (e) {
        sendJson({ ok: false, error: String(e?.message ?? e).slice(0, 140) }, 500);
      }
      return true;
    }


    // ── 图库（记忆数据库）──────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/pixiv/library') {
      sendJson({ ok: true, ...libStats(STATE_DIR, getCfg()) });
      return true;
    }

    if (method === 'POST' && pathname === '/api/pixiv/library/clean') {
      const body = await readBody();
      if (body?.clear === true) {
        const removed = clearLibrary(STATE_DIR);
        log(`[pixiv] 图库已清空（${removed} 个文件）`);
      } else {
        const r = evict(STATE_DIR, getCfg());
        log(`[pixiv] 图库按 LRU 清理：删 ${r.removed} 个，释放 ${Math.round(r.freedBytes / 1024 / 1024)}MB`);
      }
      sendJson({ ok: true, ...libStats(STATE_DIR, getCfg()) });
      return true;
    }

    if (method === 'POST' && pathname === '/api/pixiv/library/remove') {
      const body = await readBody();
      const file = String(body?.file || '');
      if (!file) { sendJson({ ok: false, error: '缺 file' }, 400); return true; }
      removeEntry(STATE_DIR, file);
      sendJson({ ok: true, ...libStats(STATE_DIR, getCfg()) });
      return true;
    }

    if (method === 'POST' && pathname === '/api/pixiv/library/cap') {
      const body = await readBody();
      const mb = Number(body?.libraryMaxMB);
      if (!Number.isFinite(mb) || mb < 20 || mb > 20000) {
        sendJson({ ok: false, error: 'libraryMaxMB 必须在 20~20000 之间' }, 400);
        return true;
      }
      const cfg = getCfg();
      const next = { ...(cfg.pixiv || {}), libraryMaxMB: Math.round(mb) };
      try {
        const file = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
        file.pixiv = next;
        fs.writeFileSync(configFile(), JSON.stringify(file, null, 2) + '\n', 'utf8');
      } catch (e) {
        sendJson({ ok: false, error: `写 config.json 失败：${String(e?.message ?? e).slice(0, 80)}` }, 500);
        return true;
      }
      cfg.pixiv = next;
      const ev = evict(STATE_DIR, cfg);
      log(`[pixiv] 图库上限改为 ${next.libraryMaxMB}MB（顺带清理 ${ev.removed} 个）`);
      sendJson({ ok: true, ...libStats(STATE_DIR, cfg) });
      return true;
    }

    return false;
  };
}
