// 人物卡外观照片端点（0.4.97）
//
//   GET    /api/roles/image?role=<id>         → { ok, has, ext, desc }
//   GET    /api/roles/image?role=<id>&raw=1   → 图片字节（控制台预览用）
//   POST   /api/roles/image { role, dataBase64 }        → 保存（覆盖）
//   POST   /api/roles/image { role, action:'describe' } → 让视觉模型描述这张图并缓存
//   DELETE /api/roles/image?role=<id>                   → 删除图与描述
import fs from 'node:fs';
import { saveRoleImage, findRoleImage, removeRoleImage, readRoleAppearance, writeRoleAppearance, safeRoleId } from '../role-image.js';

export async function handleRoleImageRoute(ctx = {}) {
  const { req, url, sendJson, sendRaw } = ctx;
  if (!req || !url || url.pathname !== '/api/roles/image') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const dir = d.files?.roleImages || '';
  if (!dir) { sendJson({ ok: false, error: '未配置角色图片目录' }, 500); return true; }

  const qRole = url.searchParams.get('role') || '';

  if (req.method === 'GET') {
    const role = safeRoleId(qRole);
    const found = findRoleImage(dir, role);
    if (!found) { sendJson({ ok: true, has: false, desc: readRoleAppearance(dir, role) }); return true; }
    if (url.searchParams.get('raw') === '1') {
      try {
        const buf = fs.readFileSync(found.file);
        if (typeof sendRaw === 'function') { sendRaw(buf, found.ext); return true; }
        sendJson({ ok: true, has: true, ext: found.ext, dataBase64: buf.toString('base64') });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return true;
    }
    sendJson({ ok: true, has: true, ext: found.ext, desc: readRoleAppearance(dir, role) });
    return true;
  }

  if (req.method === 'POST') {
    const body = (await (ctx.readBody)?.()) || {};
    const role = safeRoleId(body.role || '');
    if (!role || role === 'role') { sendJson({ ok: false, error: '缺少 role' }, 400); return true; }

    if (body.action === 'delete') {
      sendJson({ ok: true, removed: removeRoleImage(dir, role), role });
      return true;
    }

    if (body.action === 'describe') {
      const found = findRoleImage(dir, role);
      if (!found) { sendJson({ ok: false, error: '这个角色还没有照片' }, 400); return true; }
      if (typeof d.describeImageBuffer !== 'function') { sendJson({ ok: false, error: '当前环境没有视觉能力' }, 501); return true; }
      try {
        const buf = fs.readFileSync(found.file);
        const desc = await d.describeImageBuffer(buf, { hint: '这是你（AI 角色）的外貌照片。用一句话客观描述：性别、发型发色、服饰、气质。不要评价，不要加"照片中"这种前缀。' });
        const text = String(desc || '').trim();
        if (!text) { sendJson({ ok: false, error: '视觉模型没给出描述' }, 502); return true; }
        writeRoleAppearance(dir, role, text);
        sendJson({ ok: true, role, desc: text });
      } catch (error) {
        sendJson({ ok: false, error: `描述失败：${error?.message ?? error}` }, 502);
      }
      return true;
    }

    const saved = saveRoleImage(dir, role, body.dataBase64);
    if (!saved.ok) { sendJson({ ok: false, error: saved.error }, 400); return true; }
    sendJson({ ok: true, role, ext: saved.ext, bytes: saved.bytes, note: '已保存；点「识别外貌」生成一句话描述' });
    return true;
  }

  if (req.method === 'DELETE') {
    const role = safeRoleId(qRole || '');
    if (!role) { sendJson({ ok: false, error: '缺少 role' }, 400); return true; }
    sendJson({ ok: true, removed: removeRoleImage(dir, role), role });
    return true;
  }

  sendJson({ ok: false, error: '只支持 GET / POST / DELETE' }, 405);
  return true;
}
