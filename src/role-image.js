// 人物卡「外观照片」（0.4.97）
//
// 用户："人物卡升级，允许引用一张照片来定义自己，照片由用户提供，具体和小鲸鱼那个实施差不多"
//
// 小鲸鱼那套的做法是：**图片不进每轮提示词，只把它的一句话描述注入**。
// 这里照抄这个取舍——
//   · 原图存 state/role-images/<roleId>.<ext>（gitignore）
//   · 用视觉模型生成一句"外貌描述"，存 <roleId>.desc.txt
//   · 提示词只加一行「你的外貌：……」，不塞图（一张图 ≈ 上千 token，每轮都发会烧钱）
//
// 为什么不让模型自己看图：看图要走视觉接口、要给 base64、要等；而"你长什么样"
// 这类问题一天问不了几次，缓存一句描述足够，还省 token。
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 4 * 1024 * 1024;         // 单张 4MB
export const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/** roleId → 安全文件名（角色 id 一般是 slug，这里再兜一层） */
export function safeRoleId(roleId) {
  return String(roleId || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'role';
}

/** 按文件头判真实类型，别信扩展名 */
export function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return '';
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function descPath(dir, roleId) {
  return path.join(dir, `${safeRoleId(roleId)}.desc.txt`);
}

/** 找出该角色已有的图（任意允许的扩展名） */
export function findRoleImage(dir, roleId) {
  const base = safeRoleId(roleId);
  for (const ext of ALLOWED_EXT) {
    const file = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
}

export function readRoleAppearance(dir, roleId) {
  try {
    const text = fs.readFileSync(descPath(dir, roleId), 'utf8').trim();
    return text;
  } catch {
    return '';
  }
}

export function writeRoleAppearance(dir, roleId, desc) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(descPath(dir, roleId), String(desc || '').trim().slice(0, 400));
    return true;
  } catch {
    return false;
  }
}

/** 保存图片：base64 → 文件（旧扩展名的图先删掉，避免同角色两张） */
export function saveRoleImage(dir, roleId, dataBase64) {
  const raw = String(dataBase64 || '').replace(/^data:image\/[a-z]+;base64,/i, '');
  if (!raw) return { ok: false, error: '缺少图片数据' };
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return { ok: false, error: '图片数据不是合法 base64' };
  }
  if (!buf.length) return { ok: false, error: '图片是空的' };
  if (buf.length > MAX_BYTES) return { ok: false, error: `图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB` };
  const ext = sniffImageExt(buf);
  if (!ext) return { ok: false, error: '不是支持的图片（png/jpg/webp/gif）' };

  try {
    fs.mkdirSync(dir, { recursive: true });
    const prev = findRoleImage(dir, roleId);
    if (prev && prev.ext !== ext) { try { fs.rmSync(prev.file, { force: true }); } catch { /* 忽略 */ } }
    const file = path.join(dir, `${safeRoleId(roleId)}.${ext}`);
    fs.writeFileSync(file, buf);
    // 换了图 → 旧描述作废，避免"照片换了描述还是旧的"
    try { fs.rmSync(descPath(dir, roleId), { force: true }); } catch { /* 忽略 */ }
    return { ok: true, file, ext, bytes: buf.length };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function removeRoleImage(dir, roleId) {
  const prev = findRoleImage(dir, roleId);
  let removed = false;
  if (prev) { try { fs.rmSync(prev.file, { force: true }); removed = true; } catch { /* 忽略 */ } }
  try { fs.rmSync(descPath(dir, roleId), { force: true }); } catch { /* 忽略 */ }
  return removed;
}

/** 提示词里那一行（没描述就不加，别塞空话） */
export function appearancePromptLine(desc) {
  const d = String(desc || '').trim();
  if (!d) return '';
  return `你的外貌（来自用户提供的照片）：${d}`;
}
