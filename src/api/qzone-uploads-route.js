// GET/POST/DELETE /api/qzone/uploads —— 空间配图上传（0.4.79）
//
// 上传用 JSON + base64（不引 multipart 依赖）；单张 6MB、最多 9 张、内容寻址去重。
// 描述（识图）单独一步：POST {action:'describe', id} → 用 describeImageBuffer 生成一句，
// 这样上传不会被模型拖慢；没配识图能力时前端照常可以选中图片。
import { saveUpload, listUploads, setDesc, removeUpload, resolvePaths, MAX_FILES } from '../qzone-uploads.js';
import { pickImages } from '../qzone-post-ops.js';

export async function handleQzoneUploadsRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!req || !url || url.pathname !== '/api/qzone/uploads') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const dir = d.files?.qzoneUploads || '';

  if (req.method === 'GET') {
    // 不把绝对路径返回给前端（没必要，也少一处信息泄露）
    sendJson({ ok: true, items: listUploads(dir).map(({ path: _p, ...rest }) => rest), maxFiles: MAX_FILES });
    return true;
  }

  if (req.method === 'DELETE') {
    const body = (await (ctx.readBody || d.readBody)?.()) || {};
    const id = String(body.id || url.searchParams?.get('id') || '');
    if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; }
    sendJson({ ok: removeUpload(dir, id) });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson({ ok: false, error: '只支持 GET / POST / DELETE' }, 405);
    return true;
  }

  const body = (await (ctx.readBody || d.readBody)?.()) || {};
  const action = String(body.action || 'upload');

  if (action === 'upload') {
    const r = saveUpload(dir, { dataBase64: body.data, name: body.name, mime: body.mime });
    if (!r.ok) { sendJson({ ok: false, error: r.error }, 400); return true; }
    sendJson({ ok: true, item: { ...r.item, path: undefined }, maxFiles: MAX_FILES });
    return true;
  }

  if (action === 'describe') {
    const id = String(body.id || '');
    if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; }
    const item = listUploads(dir, { withPaths: true }).find((x) => x.id === id);
    if (!item) { sendJson({ ok: false, error: '没有这张图' }, 404); return true; }
    if (typeof d.describeImageBuffer !== 'function') {
      sendJson({ ok: false, error: '当前环境没有识图能力（describeImageBuffer 未注入）' }, 501);
      return true;
    }
    try {
      const buf = (await import('node:fs')).readFileSync(item.path);
      const desc = await d.describeImageBuffer(buf);
      if (desc) setDesc(dir, id, desc);
      sendJson({ ok: true, id, desc: desc || '' });
    } catch (error) {
      sendJson({ ok: false, error: `识图失败：${error?.message ?? error}` }, 502);
    }
    return true;
  }

  if (action === 'pick') {
    // 按草稿文字与图片描述的相关度挑 1~2 张（没有视觉能力时也能用）
    const text = String(body.text || '');
    const items = listUploads(dir);
    const picked = pickImages({ text, items, max: 2 });
    sendJson({ ok: true, picked, reason: '按描述/文件名与正文的词重合度；最多 2 张' });
    return true;
  }

  if (action === 'resolve') {
    sendJson({ ok: true, paths: resolvePaths(dir, body.ids) });
    return true;
  }

  sendJson({ ok: false, error: 'action 只能是 upload / describe / resolve' }, 400);
  return true;
}
