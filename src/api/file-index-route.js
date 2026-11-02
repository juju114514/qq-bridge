// 文件索引路由（0.5.49 · P3）
//
// 三个端点，与 arcdream-hub 的分法一致（搜索一个入口，扫描异步、状态可查）：
//   GET  /api/index/status   已索引多少、上次扫到什么时候、在不在扫
//   POST /api/index/start    开始扫描（body 可带 roots 覆盖配置）
//   GET  /api/search?q=&limit=  按文件名/路径搜
//   POST /api/index/clear    清空索引
import path from 'node:path';
import { createFileIndex } from '../file-index.js';

/** 进程内单例：同一个桥接进程只开一个 SQLite 连接 */
let shared = null;
function indexFor(d) {
  if (shared) return shared;
  const stateDir = d.stateDir || 'state';
  shared = createFileIndex({
    dbFile: path.join(stateDir, 'index', 'hub.db'),
    skipDirs: d.fileIndex?.skipDirs || [],
    log: (m) => { try { d.log?.(m); } catch { /* ignore */ } }
  });
  return shared;
}

export async function handleFileIndexRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !url.pathname.startsWith('/api/index/') && url.pathname !== '/api/search') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  let cfg = {};
  try { cfg = typeof d.getCfg === 'function' ? (d.getCfg() || {}) : {}; } catch { cfg = {}; }
  const fi = cfg.fileIndex || {};
  const idx = indexFor(d);

  if (url.pathname === '/api/index/status' && req.method === 'GET') {
    const st = await idx.stats();
    sendJson({ ok: true, at: Date.now(), enabled: fi.enabled !== false, roots: fi.roots || [], ...st });
    return true;
  }

  if (url.pathname === '/api/index/start' && req.method === 'POST') {
    if (fi.enabled === false) { sendJson({ ok: false, error: '文件索引已在配置里关闭（fileIndex.enabled=false）' }, 400); return true; }
    const body = typeof ctx.readBody === 'function' ? await ctx.readBody() : {};
    const roots = Array.isArray(body?.roots) && body.roots.length ? body.roots : (fi.roots || []);
    // 扫描是长活：先回 202，再后台跑（别让 HTTP 挂着）
    idx.scan(roots).catch(() => {});
    sendJson({ ok: true, started: true, roots, at: Date.now() }, 202);
    return true;
  }

  if (url.pathname === '/api/search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '');
    const limit = Number(url.searchParams.get('limit') || 20);
    const root = String(url.searchParams.get('root') || '');
    const rows = await idx.search(q, { limit, root });
    sendJson({ ok: true, at: Date.now(), q, count: rows.length, results: rows });
    return true;
  }

  if (url.pathname === '/api/index/clear' && req.method === 'POST') {
    await idx.clear();
    sendJson({ ok: true, at: Date.now() });
    return true;
  }

  sendJson({ ok: false, error: '未知的索引接口' }, 404);
  return true;
}
