// 人物库（src/people.js）：身份、关系升档、作用域笔记、按关系截断。
//
// 重点钉死三条借来的规则：
//   ① 只认 QQ 号（改群名片不新增人）② 首次部署存量是 listed 不是新人
//   ③ 删除是真删除（跨全部作用域）

import assert from 'node:assert/strict';

const m = await import(new URL('../src/people.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const T0 = Date.UTC(2026, 0, 10, 4);           // 固定起点
const day = (n) => T0 + n * 86400000;

check('normalizeQQ：只接受合理 QQ 号', () => {
  assert.equal(m.normalizeQQ('123456789'), '123456789');
  assert.equal(m.normalizeQQ(' 12345 '), '12345');
  assert.equal(m.normalizeQQ('0123'), '', '不能以 0 开头');
  assert.equal(m.normalizeQQ('abc'), '');
  assert.equal(m.normalizeQQ(''), '');
});

check('cleanName：去控制字符/换行并限长', () => {
  assert.equal(m.cleanName('  小\nA\u200b  '), '小 A');
  assert.equal(m.cleanName('x'.repeat(40)).length, 30);
});

check('normalizeScope：三种作用域，其余为空', () => {
  assert.equal(m.normalizeScope('group:659013538'), 'group:659013538');
  assert.equal(m.normalizeScope('private:10001'), 'private:10001');
  assert.equal(m.normalizeScope('global'), 'global');
  assert.equal(m.normalizeScope('group:abc'), '');
  assert.equal(m.normalizeScope(''), '');
});

check('① 身份只认 QQ 号：改群名片不新增人，只更新名片', () => {
  const db = m.emptyDb(T0);
  m.touchPerson(db, { qq: '10001', groupId: '659013538', displayName: '旧名片', now: T0 });
  m.touchPerson(db, { qq: '10001', groupId: '659013538', displayName: '新名片', now: T0 + 1000 });
  assert.equal(Object.keys(db.people).length, 1, '应该还是同一个人');
  assert.equal(db.people['10001'].names.byGroup['659013538'], '新名片');
  assert.equal(db.people['10001'].relation.msgCount, 2);
});

check('同名不同号 = 两个人（不合并）', () => {
  const db = m.emptyDb(T0);
  m.touchPerson(db, { qq: '10001', groupId: '1', displayName: '小明', now: T0 });
  m.touchPerson(db, { qq: '10002', groupId: '1', displayName: '小明', now: T0 });
  assert.equal(Object.keys(db.people).length, 2);
});

check('关系升档：消息数与活跃天数都要满足（取较慢者）', () => {
  const db = m.emptyDb(T0);
  // 一天内刷 500 条 → 仍然是 listed
  for (let i = 0; i < 500; i += 1) m.touchPerson(db, { qq: '10001', now: T0 });
  assert.equal(m.levelOf(db, '10001'), 'listed', '一天刷再多也不算熟人');
  // 第 2/3 天各一条 → acquaintance（需要 20 条 + 3 天；补齐条数）
  for (let d = 1; d <= 2; d += 1) m.touchPerson(db, { qq: '10001', now: day(d) });
  for (let i = 0; i < 20; i += 1) m.touchPerson(db, { qq: '10001', now: day(2) });
  assert.equal(m.levelOf(db, '10001'), 'acquaintance');
});

check('② 首次部署存量标 listed，不是 stranger', () => {
  const db = m.emptyDb(T0);
  const added = m.markListed(db, ['10001', '10002', 'bad'], T0);
  assert.equal(added, 2);
  assert.equal(m.levelOf(db, '10001'), 'listed');
  assert.equal(m.levelOf(db, '99999'), 'stranger', '没记录的人才是 stranger');
});

check('笔记按作用域隔离 + 去重 + 上限', () => {
  const db = m.emptyDb(T0);
  m.setNote(db, { qq: '10001', scope: 'group:659013538', text: '这个群聊游戏', now: T0 });
  m.setNote(db, { qq: '10001', scope: 'group:659013538', text: '这个群聊游戏', now: T0 });
  assert.deepEqual(m.notesInScope(db, '10001', 'group:659013538'), ['这个群聊游戏'], '重复不新增');
  m.setNote(db, { qq: '10001', scope: 'private:10001', text: '喜欢被叫小A', now: T0 });
  assert.deepEqual(m.notesInScope(db, '10001', 'global'), [], '别的域看不到');
  assert.throws(() => m.setNote(db, { qq: '10001', scope: 'nope', text: 'x' }), /作用域非法/);
  assert.throws(() => m.setNote(db, { qq: '10001', scope: 'global', text: '   ' }), /为空/);
});

check('③ 按关系截断笔记：stranger/listed 看不到，familiar 看 8 条', () => {
  const db = m.emptyDb(T0);
  for (let i = 0; i < 12; i += 1) m.setNote(db, { qq: '10001', scope: 'global', text: `笔记${i}`, now: T0 });
  m.markListed(db, ['10001'], T0);
  assert.equal(m.visibleNotes(db, '10001', 'global').length, 0, 'listed 不注入笔记');
  // 升到 familiar
  for (let d = 0; d < 10; d += 1) {
    for (let i = 0; i < 12; i += 1) m.touchPerson(db, { qq: '10001', now: day(d) });
  }
  assert.equal(m.levelOf(db, '10001'), 'familiar');
  assert.equal(m.visibleNotes(db, '10001', 'global').length, 8, 'familiar 最多 8 条');
});

check('④ 删除是真删除（跨作用域一起消失）', () => {
  const db = m.emptyDb(T0);
  m.touchPerson(db, { qq: '10001', now: T0 });
  m.setNote(db, { qq: '10001', scope: 'global', text: 'a', now: T0 });
  m.setNote(db, { qq: '10001', scope: 'group:1', text: 'b', now: T0 });
  assert.equal(m.deletePerson(db, '10001'), true);
  assert.equal(db.people['10001'], undefined);
  assert.equal(m.levelOf(db, '10001'), 'stranger');
  assert.equal(m.deletePerson(db, '10001'), false, '重复删返回 false');
});

check('describePerson：给提示词的一句话（无记录返回空）', () => {
  const db = m.emptyDb(T0);
  assert.equal(m.describePerson(db, '10001', 'global'), '');
  m.touchPerson(db, { qq: '10001', displayName: '小A', now: T0 });
  assert.match(m.describePerson(db, '10001', 'global'), /小A/);
  m.setNote(db, { qq: '10001', scope: 'global', text: '喜欢猫', now: T0 });
  // listed 档位看不到笔记 → 只说"认识"
  assert.ok(!m.describePerson(db, '10001', 'global').includes('喜欢猫'));
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }