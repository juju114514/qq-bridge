/**
 * 示例对话草稿：AI 生成的内容先进草稿箱，人确认/改完再写进人格卡（0.5.64）
 *
 * 为什么要草稿箱：
 *   Grok/模型生成的示例对话直接写卡 = 未经人看的文字直接变成机器人的说话风格，
 *   而且卡片改动**即时生效**（下一轮注入就用新的）。中间加一道「人确认」，
 *   顺便解决格式问题（`用户：/我：` 成对，解析器才不会安静地少注入）。
 *
 * 草稿文件：state/dialogue-drafts.json（数组，最多保留 20 条）
 * 每条：{ id, card, level, text, source, createdAt }
 */

import fs from 'node:fs';
import { atomicWriteJson } from './atomic-write.js';
import path from 'node:path';

const MAX_DRAFTS = 20;

export function draftsFile(stateDir) {
  return path.join(stateDir, 'dialogue-drafts.json');
}

export function readDrafts(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(draftsFile(stateDir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeDrafts(stateDir, list) {
  // 走仓库统一的原子写（tmp + rename 只允许在 src/atomic-write.js 里出现）
  atomicWriteJson(draftsFile(stateDir), list.slice(0, MAX_DRAFTS));
}

/** 只保留「用户：/我：」行，清掉代码块与说明（和 tools/grok-dialogues.mjs 同一套规则）。 */
export function sanitizeDialogues(text) {
  return String(text || '')
    .replace(/```[a-z]*\n?/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(用户|对方|user|我|助手|assistant)\s*[:：]\s*\S/.test(l))
    .map((l) => l.replace(/^用户\s*[:：]/, '用户：').replace(/^(我|助手|assistant)\s*[:：]/, '我：'))
    .join('\n');
}

/** 草稿里的成对消息数（奇数说明最后落单，写卡前会丢掉） */
export function countPairs(block) {
  const lines = String(block || '').split('\n').filter(Boolean);
  return Math.floor(lines.length / 2);
}

export function addDraft(stateDir, { card = '', level = 'strong', text = '', source = 'manual' } = {}) {
  const clean = sanitizeDialogues(text);
  if (!clean) throw new Error('没解析出「用户：/我：」行');
  const list = readDrafts(stateDir);
  const draft = {
    id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    card: String(card || ''),
    level: String(level || ''),
    text: clean,
    pairs: countPairs(clean),
    source: String(source || 'manual'),
    createdAt: new Date().toISOString()
  };
  writeDrafts(stateDir, [draft, ...list]);
  return draft;
}

export function updateDraft(stateDir, id, text) {
  const list = readDrafts(stateDir);
  const idx = list.findIndex((d) => d.id === id);
  if (idx < 0) throw new Error('草稿不存在');
  const clean = sanitizeDialogues(text);
  if (!clean) throw new Error('改完的内容里没有「用户：/我：」行');
  list[idx] = { ...list[idx], text: clean, pairs: countPairs(clean), updatedAt: new Date().toISOString() };
  writeDrafts(stateDir, list);
  return list[idx];
}

export function dropDraft(stateDir, id) {
  const list = readDrafts(stateDir).filter((d) => d.id !== id);
  writeDrafts(stateDir, list);
  return { ok: true };
}

/** 把示例写进卡片：替换已有 `## 示例对话` 小节；没有就追加到末尾。 */
export function applyDialoguesToCard(cardPath, block) {
  const clean = sanitizeDialogues(block);
  if (!clean) throw new Error('没有可写入的示例对话');
  const raw = fs.readFileSync(cardPath, 'utf8');
  const section = `## 示例对话\n${clean}\n`;
  const re = /^#{1,6}\s*(示例对话|示例|对话样例|examples?)\s*$[\s\S]*?(?=^#{1,6}\s|\s*$)/im;
  const next = re.test(raw) ? raw.replace(re, section) : raw.trimEnd() + `\n\n${section}`;
  fs.writeFileSync(cardPath, next.endsWith('\n') ? next : next + '\n', 'utf8');
  return { ok: true, pairs: countPairs(clean) };
}
