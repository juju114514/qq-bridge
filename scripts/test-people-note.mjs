// 人物笔记读写（src/api/people-note.js + people.removeNote）：
// 模型能「记事」也要能「纠错」，否则记忆是死档案。
//
// 三条语义：
//   add   记住一条；重复内容不重复写
//   list  按关系档位截断（和提示词注入一致）
//   clear 删一条；text 为空 = 清空该作用域

import assert from 'node:assert/strict';

const { createPeopleNoteHandler } = await import(new URL('../src/api/people-note.js', import.meta.url).href);
const people = await import(new URL('../src/people.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function makeWorld() {
  const db = people.emptyDb();
  const saved = { n: 0 };
  const h = createPeopleNoteHandler({
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    loadPeopleDb: () => db,
    schedulePeopleSave: () => { saved.n += 1; },
    setNote: people.setNote,
    removeNote: people.removeNote,
    notesInScope: people.notesInScope,
    visibleNotes: people.visibleNotes,
    levelOf: people.levelOf,
    normalizeQQ: people.normalizeQQ
  });
  const replies = [];
  const ctx = (body) => ({
    req: { headers: {} },
    readBody: async () => body,
    sendJson: (payload) => replies.push(payload)
  });
  return { h, db, saved, replies, ctx };
}

await check('add：记住一条，并触发落盘', async () => {
  const { h, db, saved, replies, ctx } = makeWorld();
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: '喜欢猫，怕冷' }));
  assert.equal(replies.at(-1).ok, true);
  assert.equal(replies.at(-1).added, true);
  assert.equal(saved.n, 1, '必须调度落盘');
  assert.deepEqual(people.notesInScope(db, '10001', 'group:1'), ['喜欢猫，怕冷']);
});

await check('add：重复内容不重复写（幂等）', async () => {
  const { h, db, replies, ctx } = makeWorld();
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: '喜欢猫' }));
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: '喜欢猫' }));
  assert.equal(replies.at(-1).added, false);
  assert.equal(people.notesInScope(db, '10001', 'group:1').length, 1);
});

await check('list：返回该作用域笔记（含关系档位）', async () => {
  const { h, replies, ctx } = makeWorld();
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: 'A' }));
  await h.handle(ctx({ key: 'group:1', qq: '10001', op: 'list' }));
  const r = replies.at(-1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.inScope, ['A']);
  assert.equal(typeof r.level, 'string');
});

await check('list：档位低时说明「笔记暂不注入」（避免以为记了没生效）', async () => {
  const { h, replies, ctx } = makeWorld();
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: 'A' }));
  await h.handle(ctx({ key: 'group:1', qq: '10001', op: 'list' }));
  const r = replies.at(-1);
  assert.equal(r.inScope.length, 1);
  assert.ok(['stranger', 'listed'].includes(r.level), `默认没聊过应为 stranger/listed，实际 ${r.level}`);
  assert.equal(r.visible.length, 0);
  assert.equal(r.hidden, 1);
  assert.match(r.hint, /暂不注入提示词/);
});

await check('clear：删掉指定一条', async () => {
  const { h, db, replies, ctx } = makeWorld();
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: 'A' }));
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: 'B' }));
  await h.handle(ctx({ key: 'group:1', qq: '10001', op: 'clear', text: 'A' }));
  assert.equal(replies.at(-1).removed, true);
  assert.deepEqual(people.notesInScope(db, '10001', 'group:1'), ['B']);
});

await check('clear：text 为空 = 清空该作用域', async () => {
  const { h, db, ctx } = makeWorld();
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: 'A' }));
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: 'B' }));
  await h.handle(ctx({ key: 'group:1', qq: '10001', op: 'clear' }));
  assert.deepEqual(people.notesInScope(db, '10001', 'group:1'), []);
});

await check('非法输入：缺 qq / 空 text / 未知 op 都被明确拒绝', async () => {
  const { h, replies, ctx } = makeWorld();
  await h.handle(ctx({ key: 'group:1', text: 'x' }));
  assert.equal(replies.at(-1).ok, false);
  await h.handle(ctx({ key: 'group:1', qq: '10001', text: '   ' }));
  assert.equal(replies.at(-1).ok, false);
  await h.handle(ctx({ key: 'group:1', qq: '10001', op: 'explode' }));
  assert.match(String(replies.at(-1).error), /不支持的 op/);
});

await check('token 无效：403，且不写入', async () => {
  const { h, db, ctx } = makeWorld();
  const bad = {
    req: { headers: { 'x-agent-token': 'bad' } },
    readBody: async () => ({ key: 'group:1', qq: '10001', text: 'x' }),
    sendJson: () => {}
  };
  h.handle = h.handle; // 用同一个 handler，但让 agentTokenOk 失败需要重建
  const db2 = people.emptyDb();
  const h2 = createPeopleNoteHandler({
    log: () => {}, agentTokenOk: () => false,
    v2SessionAllowed: () => true, v2ToolEnabled: () => true,
    loadPeopleDb: () => db2, schedulePeopleSave: () => {},
    setNote: people.setNote, removeNote: people.removeNote,
    notesInScope: people.notesInScope, visibleNotes: people.visibleNotes,
    levelOf: people.levelOf, normalizeQQ: people.normalizeQQ
  });
  const replies = [];
  await h2.handle({ ...bad, sendJson: (p) => replies.push(p) });
  assert.equal(replies[0].ok, false);
  assert.equal(people.notesInScope(db2, '10001', 'group:1').length, 0);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }