// 表情笔记（src/sticker-notes.js）契约测试：全离线（用临时目录）。
//
// 对齐 slang.json 的设计：独立存储、状态机、上限截断、默认不进提示词。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const m = await import(pathToFileURL('D:/QQBot-open/qq-bridge/src/sticker-notes.js').href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-notes-')), 'sticker-notes.json');

check('空文件/坏文件都返回空 store（不能让坏 json 把服务带崩）', () => {
  const f = tmp();
  assert.deepEqual(m.loadStickerNotes(f).notes, []);
  fs.writeFileSync(f, '{broken');
  assert.deepEqual(m.loadStickerNotes(f).notes, []);
});

check('upsert：新增 → 更新含义不新增条目，uses 保留', () => {
  let s = m.emptyStore();
  m.upsertStickerNote(s, { id: 'a', meaning: '无语', score: 0.7 });
  assert.equal(s.notes.length, 1);
  m.markStickerUsed(s, 'a');
  m.upsertStickerNote(s, { id: 'a', meaning: '无语到翻白眼', score: 0.8 });
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].meaning, '无语到翻白眼');
  assert.equal(s.notes[0].uses, 1);
});

check('markStickerUsed：pending → used，计数累加', () => {
  const s = m.emptyStore();
  m.upsertStickerNote(s, { id: 'b', meaning: '笑死' });
  assert.equal(s.notes[0].status, m.STICKER_NOTE_STATUS.PENDING);
  m.markStickerUsed(s, 'b'); m.markStickerUsed(s, 'b');
  assert.equal(s.notes[0].status, m.STICKER_NOTE_STATUS.USED);
  assert.equal(s.notes[0].uses, 2);
});

check('落盘 + 读回：超过上限截断，只保留最后 N 条', () => {
  const f = tmp();
  const s = m.emptyStore();
  for (let i = 0; i < m.STICKER_NOTE_MAX + 20; i += 1) m.upsertStickerNote(s, { id: `id${i}`, meaning: `m${i}`, score: 0.6 });
  m.saveStickerNotes(f, s);
  const back = m.loadStickerNotes(f);
  assert.equal(back.notes.length, m.STICKER_NOTE_MAX);
  assert.equal(back.notes.at(-1).id, `id${m.STICKER_NOTE_MAX + 19}`);
});

check('buildStickerNotesHint：默认不进提示词，只有 kept 才出现', () => {
  const s = m.emptyStore();
  m.upsertStickerNote(s, { id: 'x', meaning: '无语', status: m.STICKER_NOTE_STATUS.PENDING, scope: 'group' });
  assert.equal(m.buildStickerNotesHint(s, { scope: 'group' }), '', 'pending 不该进提示词');
  m.upsertStickerNote(s, { id: 'x', meaning: '无语', status: m.STICKER_NOTE_STATUS.KEPT, scope: 'group' });
  assert.match(m.buildStickerNotesHint(s, { scope: 'group' }), /无语/);
  assert.equal(m.buildStickerNotesHint(s), '', '不给 scope 必须为空');
});

check('buildStickerNotesHint：群聊/私聊严格隔离', () => {
  const s = m.emptyStore();
  m.upsertStickerNote(s, { id: 'g', meaning: '群里的图', status: m.STICKER_NOTE_STATUS.KEPT, scope: 'group' });
  m.upsertStickerNote(s, { id: 'p', meaning: '私聊的图', status: m.STICKER_NOTE_STATUS.KEPT, scope: 'private' });
  assert.match(m.buildStickerNotesHint(s, { scope: 'group' }), /群里的图/);
  assert.ok(!/私聊的图/.test(m.buildStickerNotesHint(s, { scope: 'group' })));
  assert.match(m.buildStickerNotesHint(s, { scope: 'private' }), /私聊的图/);
  assert.ok(!/群里的图/.test(m.buildStickerNotesHint(s, { scope: 'private' })));
});

check('normalizeScope：非法值兜底成 private（最不容易外泄）', () => {
  assert.equal(m.normalizeScope('group'), 'group');
  assert.equal(m.normalizeScope('GROUP'), 'group');
  assert.equal(m.normalizeScope(''), 'private');
  assert.equal(m.normalizeScope('whatever'), 'private');
});

check('listStickerNotes：按状态筛选', () => {
  const s = m.emptyStore();
  m.upsertStickerNote(s, { id: '1', meaning: 'a', status: m.STICKER_NOTE_STATUS.KEPT });
  m.upsertStickerNote(s, { id: '2', meaning: 'b', status: m.STICKER_NOTE_STATUS.DROPPED });
  assert.equal(m.listStickerNotes(s, m.STICKER_NOTE_STATUS.KEPT).length, 1);
  assert.equal(m.listStickerNotes(s).length, 2);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
