// 人物库列表（src/api/people-list.js）：控制台「人物库」页的数据源。
//
// 重点：200+ 条时要能搜、能按档位筛、按"最近说话"排序；且不泄露不该看的字段。

import assert from 'node:assert/strict';

const { createPeopleListHandler } = await import(new URL('../src/api/people-list.js', import.meta.url).href);
const people = await import(new URL('../src/people.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function makeDb() {
  const db = people.emptyDb();
  const now = Date.now();
  // 三个不同档位/活跃度的人
  people.touchPerson(db, { qq: '10001', groupId: '111', displayName: '阿甲', now: now - 1000 });
  for (let i = 0; i < 40; i += 1) people.touchPerson(db, { qq: '10001', groupId: '111', now: now - 1000 });
  people.markListed(db, ['10002'], now);
  people.touchPerson(db, { qq: '10003', groupId: '222', displayName: '阿丙', now: now - 500 });
  people.setNote(db, { qq: '10001', scope: 'group:111', text: '喜欢猫' });
  return db;
}

const db = makeDb();
const h = createPeopleListHandler({
  log: () => {},
  loadPeopleDb: () => db,
  levelOf: people.levelOf,
  notesInScope: people.notesInScope,
  normalizeQQ: people.normalizeQQ
});

check('列表：返回每个人 + 档位 + 消息数 + 笔记数', () => {
  const r = h.build({});
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  const p1 = r.people.find((x) => x.qq === '10001');
  assert.equal(p1.name, '阿甲');
  assert.equal(p1.noteCount, 1);
  assert.ok(p1.msgCount >= 40);
  assert.ok(r.levelCounts[p1.level] >= 1);
});

check('搜索：QQ 号 / 昵称 / 群名片都能命中', () => {
  assert.equal(h.build({ q: '10003' }).matched, 1);
  assert.equal(h.build({ q: '阿丙' }).matched, 1);
  assert.equal(h.build({ q: '阿' }).matched, 2, '阿甲 + 阿丙');
  assert.equal(h.build({ q: '不存在的人' }).matched, 0);
});

check('按档位筛', () => {
  const listed = h.build({ level: 'listed' });
  assert.ok(listed.people.every((p) => p.level === 'listed'));
  assert.ok(listed.people.some((p) => p.qq === '10002'));
});

check('排序：最近说话的在前', () => {
  const r = h.build({});
  assert.equal(r.people[0].qq, '10003', '10003 最近说过话');
});

check('scope=group:111 时附带该作用域笔记', () => {
  const r = h.build({ q: '10001', scope: 'group:111' });
  assert.deepEqual(r.people[0].notesInScope, ['喜欢猫']);
});

check('limit 生效且标记 truncated', () => {
  const r = h.build({ limit: 1 });
  assert.equal(r.returned, 1);
  assert.equal(r.truncated, true);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }