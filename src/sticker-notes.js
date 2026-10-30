// 表情笔记：把"这张图是什么、好不好用"独立存一份，**不进聊天 prompt**。
//
// 为什么要独立（对齐 slang.json 的做法）：
//   · 黑话是"群里的词 → 含义"的独立知识库，确认后才进提示词；
//   · 表情同理：先记下来（意思是啥、打几分、用没用过），
//     等真的被用上、被群友认可，再考虑要不要进上下文。
//   · 好处：判断过程不污染每轮对话，也不会因为一张图把 prompt 撑大。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-write.js';

export const STICKER_NOTE_STATUS = Object.freeze({
  PENDING: 'pending',     // 刚识别，还没用过
  USED: 'used',           // 已经发出去过
  KEPT: 'kept',           // 群友有正向反应（被回复/被笑）
  DROPPED: 'dropped'      // 判定无价值，或用了没反应
});

export const STICKER_NOTE_MAX = 300;

// 会话隔离：群聊学到的东西绝不能影响私聊，反之亦然。
// scope 只有两个合法值；没给 scope 的笔记一律算 private（最不容易外泄的默认）。
export const STICKER_SCOPES = Object.freeze(['group', 'private']);

export function normalizeScope(scope) {
  const s = String(scope ?? '').trim().toLowerCase();
  return s === 'group' ? 'group' : 'private';
}

export function emptyStore() {
  return { version: 1, notes: [] };
}

export function loadStickerNotes(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const notes = Array.isArray(raw?.notes) ? raw.notes : [];
    return { version: Number(raw?.version) || 1, notes };
  } catch {
    return emptyStore();
  }
}

export function saveStickerNotes(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const trimmed = { version: 1, notes: (store.notes || []).slice(-STICKER_NOTE_MAX) };
  atomicWriteJson(file, trimmed);
}

/** 一张图一条笔记；同 id 覆盖（更新含义/分数/状态）。 */
export function upsertStickerNote(store, { id, meaning, tags = [], score = 0, status = STICKER_NOTE_STATUS.PENDING, now = Date.now(), source = '', scope = 'private' }) {
  const key = String(id ?? '').trim();
  if (!key) return store;
  const notes = store.notes || (store.notes = []);
  const idx = notes.findIndex((n) => n.id === key);
  const patch = {
    id: key,
    meaning: String(meaning ?? '').slice(0, 40),
    tags: tags.slice(0, 6),
    score,
    status,
    updatedAt: now,
    source: String(source).slice(0, 20),
    scope: normalizeScope(scope)
  };
  if (idx >= 0) notes[idx] = { ...notes[idx], ...patch, uses: notes[idx].uses || 0 };
  else notes.push({ ...patch, uses: 0, createdAt: now });
  return store;
}

/** 用掉一次（主动发表情时调用），用于后续判断"这图到底好不好用"。 */
export function markStickerUsed(store, id, now = Date.now()) {
  const n = (store.notes || []).find((x) => x.id === id);
  if (!n) return store;
  n.uses = (n.uses || 0) + 1;
  n.lastUsedAt = now;
  if (n.status === STICKER_NOTE_STATUS.PENDING) n.status = STICKER_NOTE_STATUS.USED;
  return store;
}

/** 按状态筛选（控制台/维护用）。 */
export function listStickerNotes(store, status = '', scope = '') {
  let all = store.notes || [];
  if (scope) { const sc = normalizeScope(scope); all = all.filter((n) => normalizeScope(n.scope) === sc); }
  return status ? all.filter((n) => n.status === status) : all;
}

/**
 * 给提示词用的极简摘要：**只取被认可的**，最多 8 条、每条一行。
 * 默认返回空串 —— 没确认过的东西不该进上下文。
 */
export function buildStickerNotesHint(store, { limit = 8, statuses = [STICKER_NOTE_STATUS.KEPT], scope = '' } = {}) {
  // 没有 scope 就返回空：宁可少给提示，也不能让群聊的东西串进私聊
  if (!scope) return '';
  const sc = normalizeScope(scope);
  const picked = (store.notes || [])
    .filter((n) => normalizeScope(n.scope) === sc)
    .filter((n) => statuses.includes(n.status) && n.meaning)
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, limit);
  if (!picked.length) return '';
  return picked.map((n) => `- ${n.meaning}${n.uses ? `（用过 ${n.uses} 次）` : ''}`).join('\n');
}
