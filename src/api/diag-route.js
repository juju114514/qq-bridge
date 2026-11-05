// 诊断包下载接口（0.5.63）
//
//   GET  /api/diag/bundle            → 直接下载 zip
//   POST /api/diag/bundle            → 同上（控制台按钮用）
//
// 走控制台鉴权（由 console-extra-routes 统一把关），内容已脱敏。
import { buildDiagBundle } from '../diag-bundle.js';

export async function handleDiagRoute(ctx = {}) {
  const { req, url, sendJson, sendRaw } = ctx;
  if (!url || !url.pathname.startsWith('/api/diag/bundle')) return false;
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
    return true;
  }

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const stateDir = d.stateDir || 'state';
  const root = d.root || process.cwd();
  const health = d.health || { ok: true };

  try {
    const r = buildDiagBundle({ stateDir, root, health });
    if (typeof sendRaw === 'function') {
      // 与 role-image-route 的约定一致：sendRaw(buffer, ext)
      sendRaw(r.zip, 'zip');
      return true;
    }
    // 这个路由层没有 sendRaw 注入时，退回 JSON + base64（控制台可还原成文件下载）
    sendJson({
      ok: true,
      size: r.size,
      entries: r.entries,
      file: r.file,
      filename: `diag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`,
      zipBase64: r.size <= 300 * 1024 ? r.zip.toString('base64') : '',
      note: r.size > 300 * 1024
        ? '包太大，未内联 base64；请从服务器取 file 路径'
        : 'zip 已内联为 zipBase64，浏览器解码即可保存'
    });
  } catch (error) {
    sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 200) }, 500);
  }
  return true;
}
