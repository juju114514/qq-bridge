// 角色分配（0.4.98）：群聊人设是否隔离 / 状态标签
import assert from 'node:assert/strict';

const m = await import(new URL('../src/role-map.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('隔离：群 A 单独设角色，不影响群 B', () => {
  const rolesByKey = { 'group:1': { role: '小鲸鱼' } };
  const a = m.effectiveRole({ key: 'group:1', record: rolesByKey['group:1'], globalRole: '派蒙' });
  const b = m.effectiveRole({ key: 'group:2', record: rolesByKey['group:2'], globalRole: '派蒙' });
  assert.equal(a.role, '小鲸鱼');
  assert.equal(a.source, 'per-key');
  assert.equal(b.role, null, '没设角色的群不该继承别的群');
  assert.equal(b.source, 'none');
});

check('群聊默认不注入人设（groupEnabled=false）', () => {
  const r = m.effectiveRole({ key: 'group:9', groupEnabled: false, globalRole: '派蒙' });
  assert.equal(r.role, null);
  assert.equal(r.source, 'none');
});

check('开了群默认后，没单独设的群用默认', () => {
  const r = m.effectiveRole({ key: 'group:9', groupEnabled: true, groupDefaultName: '群小助手' });
  assert.equal(r.role, '群小助手');
  assert.equal(r.source, 'group-default');
});

check('单独设置优先于群默认', () => {
  const r = m.effectiveRole({
    key: 'group:9',
    record: { role: '樱羽艾玛' },
    groupEnabled: true,
    groupDefaultName: '群小助手'
  });
  assert.equal(r.role, '樱羽艾玛');
  assert.equal(r.source, 'per-key');
});

check('私聊跟随全局角色', () => {
  const r = m.effectiveRole({ key: 'private:7', globalRole: '小鲸鱼' });
  assert.equal(r.role, '小鲸鱼');
  assert.equal(r.source, 'global');
});

check('状态标签：活跃 / 潜水（条件唤醒）/ 潜水（还有 N 分钟）/ 暂停', () => {
  const now = Date.parse('2026-11-01T10:00:00+08:00');
  assert.equal(m.wakeLabel({ mode: 'active' }, { now }), '活跃');
  assert.equal(m.wakeLabel({ mode: 'diving', infinite: true }, { now }), '潜水（条件唤醒）');
  assert.match(m.wakeLabel({ mode: 'diving', sleepUntil: now + 30 * 60000 }, { now }), /潜水（还有约 30 分钟）/);
  assert.match(m.wakeLabel({ mode: 'diving', sleepUntil: now - 1000 }, { now }), /已到期/);
  assert.equal(m.wakeLabel({ mode: 'active' }, { now, paused: true }), '已暂停');
});

check('汇总：群在前、私聊在后，按号码升序，字段齐全', () => {
  const rows = m.summarizeAssignments({
    conversations: [
      { key: 'private:20', wakeConfig: { mode: 'active' } },
      { key: 'group:100', wakeConfig: { mode: 'diving', infinite: true } },
      { key: 'group:9', wakeConfig: { mode: 'active' } }
    ],
    rolesByKey: { 'group:9': { role: '小鲸鱼' } },
    globalRole: '派蒙',
    groupEnabled: false
  });
  assert.deepEqual(rows.map((r) => r.key), ['group:9', 'group:100', 'private:20']);
  assert.equal(rows[0].role, '小鲸鱼');
  assert.equal(rows[0].wake, '活跃');
  assert.equal(rows[1].wake, '潜水（条件唤醒）');
  assert.equal(rows[2].role, '派蒙');
  assert.equal(rows[2].source, 'global');
});

check('隔离报告：没有重复 key 就不报问题', () => {
  const issues = m.isolationReport({
    conversations: [{ key: 'group:1' }, { key: 'private:2' }],
    rolesByKey: {},
    groupEnabled: false
  });
  assert.deepEqual(issues, []);
});

check('隔离报告：给单个群设了角色但没开群默认 → 提示（不是错误）', () => {
  const issues = m.isolationReport({
    conversations: [{ key: 'group:1' }],
    rolesByKey: { 'group:1': { role: '小鲸鱼' } },
    groupEnabled: false
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].problem, 'group-role-without-group-default');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
