// 空间配图上传（0.4.79）
//
// 为什么单独一个模块：
//   · 上传涉及"落盘 + 限额 + 类型白名单"，是最容易被写松的地方，必须集中
//   · 图片要能被 AI"看懂"才有意义（识图挑图），所以描述缓存也一起管
//
// 存储：state/qzone-uploads/（跟着 state 一起备份，不进 git）
// 索引：state/qzone-uploads/index.json（id/name/size/desc/createdAt）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from './atomic-write.js';

export const MAX_BYTES = 6 * 1024 * 1024;      // 单张 6MB（QQ 空间也会压）
export const MAX_FILES = 9;                    // 一条说说最多 9 张
export const MAX_STORE = 60;                   // 本地最多留 60 张，超了删最旧
export const ALLOWED_EXT = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'gif']);

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

export function extOf({ mime = '', name = '' } = {}) {
  const byMime = MIME_EXT[String(mime).toLowerCase().trim()];
  if (byMime) return byMime;
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] || '';
  return ALLOWED_EXT.includes(ext) ? ext : '';
}

/** 文件头嗅探：不信 mime，也不信扩展名 */
export function sniffExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  return '';
}

export function readIndex(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return Array.isArray(j?.items) ? j : { items: [] };
  } catch {
    return { items: [] };
  }
}

export function writeIndex(dir, index) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteJson(path.join(dir, 'index.json'), index);
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存一张上传的图。
 * @returns {{ok:true, item:object} | {ok:false, error:string}}
 */
export function saveUpload(dir, { dataBase64 = '', name = '', mime = '' } = {}, now = Date.now()) {
  const raw = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) return { ok: false, error: '没有图片数据' };
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return { ok: false, error: 'base64 解析失败' };
  }
  if (!buf.length) return { ok: false, error: '图片是空的' };
  if (buf.length > MAX_BYTES) return { ok: false, error: `单张图不能超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB` };

  const sniffed = sniffExt(buf);
  if (!sniffed) return { ok: false, error: '不是支持的图片格式（jpg/png/webp/gif）' };

  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const id = `${sha}.${sniffed}`;
  const file = path.join(dir, id);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);

  const index = readIndex(dir);
  const existed = index.items.find((x) => x.id === id);
  if (existed) return { ok: true, item: { ...existed, path: file } };

  const item = {
    id,
    name: String(name || id).slice(0, 80),
    size: buf.length,
    ext: sniffed,
    desc: '',
    createdAt: now,
    path: file
  };
  index.items.push(item);

  // 只留最近 MAX_STORE 张，顺便删文件
  if (index.items.length > MAX_STORE) {
    const drop = index.items.splice(0, index.items.length - MAX_STORE);
    for (const d of drop) {
      try { fs.rmSync(path.join(dir, d.id), { force: true }); } catch { /* ignore */ }
    }
  }
  writeIndex(dir, index);
  return { ok: true, item };
}

export function listUploads(dir, { withPaths = false } = {}) {
  const index = readIndex(dir);
  return index.items
    .slice()
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .map((x) => (withPaths ? { ...x, path: path.join(dir, x.id) } : { ...x }));
}

export function setDesc(dir, id, desc) {
  const index = readIndex(dir);
  const item = index.items.find((x) => x.id === id);
  if (!item) return false;
  item.desc = String(desc || '').slice(0, 200);
  return writeIndex(dir, index);
}

export function removeUpload(dir, id) {
  const index = readIndex(dir);
  const i = index.items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  index.items.splice(i, 1);
  writeIndex(dir, index);
  try { fs.rmSync(path.join(dir, String(id)), { force: true }); } catch { /* ignore */ }
  return true;
}

/** 发布时把 id 换成绝对路径（网关接受本地路径，已实测） */
export function resolvePaths(dir, ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  return listUploads(dir, { withPaths: true })
    .filter((x) => wanted.has(x.id))
    .slice(0, MAX_FILES)
    .map((x) => x.path);
}
