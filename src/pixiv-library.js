/**
 * Pixiv 图库（0.5.65）
 *
 * 目的：群友反复要同一张图时别再下载一遍；同时**限制占用**，满了按「最久没用过的」删。
 *
 * 存储：
 *   state/pixiv-library/<illustId>-p<N>.jpg
 *   state/pixiv-library/index.json   ← 每条：{ file, bytes, illustId, title, author, link, grade, addedAt, lastUsedAt, hits }
 *
 * 淘汰策略：**LRU by lastUsedAt**（不是 by addedAt）——
 *   刚存进来但没人看的图会被先删；经常被点的老图会留着。
 *
 * 上限：config.pixiv.libraryMaxMB（默认 500MB）+ 文件数上限 2000（防小文件把 inode 撑爆）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_MB = 500;
export const MAX_FILES = 2000;

export function libraryDir(stateDir) {
  return path.join(stateDir, 'pixiv-library');
}

function indexFile(stateDir) {
  return path.join(libraryDir(stateDir), 'index.json');
}

export function readIndex(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(stateDir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeIndex(stateDir, list) {
  fs.mkdirSync(libraryDir(stateDir), { recursive: true });
  fs.writeFileSync(indexFile(stateDir), JSON.stringify(list, null, 2), 'utf8');
}

export function maxBytes(cfg) {
  const mb = Number(cfg?.pixiv?.libraryMaxMB);
  return Math.max(20, Math.min(20000, Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB)) * 1024 * 1024;
}

export function stats(stateDir, cfg) {
  const list = readIndex(stateDir);
  const used = list.reduce((n, e) => n + (Number(e.bytes) || 0), 0);
  const cap = maxBytes(cfg);
  return {
    count: list.length,
    usedBytes: used,
    capBytes: cap,
    usedMB: Math.round((used / 1024 / 1024) * 10) / 10,
    capMB: Math.round(cap / 1024 / 1024),
    percent: cap ? Math.min(100, Math.round((used / cap) * 100)) : 0,
    files: list
      .slice()
      .sort((a, b) => (b.lastUsedAt || b.addedAt || '').localeCompare(a.lastUsedAt || a.addedAt || ''))
      .slice(0, 60)
      .map((e) => ({
        file: path.basename(e.file || ''),
        illustId: e.illustId,
        title: e.title,
        author: e.author,
        grade: e.grade,
        link: e.link,
        bytes: e.bytes,
        addedAt: e.addedAt,
        lastUsedAt: e.lastUsedAt,
        hits: e.hits || 0
      }))
  };
}

/**
 * 按 LRU 淘汰，直到低于上限（可指定目标字节数）。
 * @returns {{removed:number, freedBytes:number}}
 */
export function evict(stateDir, cfg, { targetBytes } = {}) {
  const cap = targetBytes ?? maxBytes(cfg);
  let list = readIndex(stateDir);
  let used = list.reduce((n, e) => n + (Number(e.bytes) || 0), 0);
  if (used <= cap && list.length <= MAX_FILES) return { removed: 0, freedBytes: 0 };

  // 最久没用过的先删；从没被用过的按加入时间算
  const byLru = list.slice().sort((a, b) => {
    const ka = String(a.lastUsedAt || a.addedAt || '');
    const kb = String(b.lastUsedAt || b.addedAt || '');
    return ka.localeCompare(kb);
  });
  let removed = 0;
  let freed = 0;
  const drop = new Set();
  for (const e of byLru) {
    if (used <= cap && list.length - drop.size <= MAX_FILES) break;
    drop.add(e.file);
    used -= Number(e.bytes) || 0;
    freed += Number(e.bytes) || 0;
    removed += 1;
  }
  for (const f of drop) {
    try { fs.unlinkSync(path.isAbsolute(f) ? f : path.join(libraryDir(stateDir), path.basename(f))); } catch { /* 文件可能已不在 */ }
  }
  list = list.filter((e) => !drop.has(e.file));
  writeIndex(stateDir, list);
  return { removed, freedBytes: freed };
}

/** 查找已有条目（同一个作品同一页直接复用，不重复下载） */
export function findEntry(stateDir, illustId, page = 1) {
  const id = String(illustId);
  const hit = readIndex(stateDir).find((e) => String(e.illustId) === id && Number(e.page || 1) === Number(page));
  if (!hit) return null;
  const file = path.isAbsolute(hit.file) ? hit.file : path.join(libraryDir(stateDir), path.basename(hit.file));
  return fs.existsSync(file) ? { ...hit, absFile: file } : null;
}

/** 记一次使用（更新 lastUsedAt / hits） */
export function touch(stateDir, illustId, page = 1) {
  const id = String(illustId);
  const list = readIndex(stateDir);
  const idx = list.findIndex((e) => String(e.illustId) === id && Number(e.page || 1) === Number(page));
  if (idx < 0) return null;
  list[idx] = { ...list[idx], lastUsedAt: new Date().toISOString(), hits: (list[idx].hits || 0) + 1 };
  writeIndex(stateDir, list);
  return list[idx];
}

/**
 * 存一条（会把文件挪进库；不存在则从 srcFile 复制）。
 * @returns {{entry:object, evicted:{removed:number,freedBytes:number}}}
 */
export function addToLibrary(stateDir, cfg, { srcFile, illustId, page = 1, title, author, link, grade, tags }) {
  const dir = libraryDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${illustId}-p${page}${path.extname(srcFile || '.jpg') || '.jpg'}`;
  const dest = path.join(dir, base);
  let bytes = 0;
  try {
    if (path.resolve(srcFile) !== path.resolve(dest)) fs.copyFileSync(srcFile, dest);
    bytes = fs.statSync(dest).size;
  } catch {
    bytes = 0;
  }
  const now = new Date().toISOString();
  const entry = {
    file: base,
    bytes,
    illustId: String(illustId),
    page: Number(page) || 1,
    title: String(title || ''),
    author: String(author || ''),
    link: String(link || ''),
    grade: String(grade || 'safe'),
    tags: Array.isArray(tags) ? tags.slice(0, 12) : [],
    addedAt: now,
    lastUsedAt: now,
    hits: 1
  };
  let list = readIndex(stateDir).filter((e) => !(String(e.illustId) === entry.illustId && Number(e.page || 1) === entry.page));
  list.push(entry);
  writeIndex(stateDir, list);
  const ev = evict(stateDir, cfg);
  return { entry, evicted: ev };
}

/** 删一条 */
export function removeEntry(stateDir, fileName) {
  const base = path.basename(String(fileName || ''));
  if (!base) return false;
  const list = readIndex(stateDir).filter((e) => path.basename(e.file) !== base);
  try { fs.unlinkSync(path.join(libraryDir(stateDir), base)); } catch { /* ignore */ }
  writeIndex(stateDir, list);
  return true;
}

/** 清空 */
export function clearLibrary(stateDir) {
  const dir = libraryDir(stateDir);
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === 'index.json') continue;
      try { fs.unlinkSync(path.join(dir, f)); removed += 1; } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 */ }
  writeIndex(stateDir, []);
  return removed;
}
