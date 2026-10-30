// 回合收尾的「防遗忘」判定（src/turn-wake.js）
//
// 三条出口都要覆盖，而且要把"AI 到底算不算交代过"的两种来源都测到：
//   set_wake_config（wakeConfigUpdated）或 mark_read（markReadCalled）

import assert from 'node:assert/strict';

const { decideWakeReminder } = await import(new URL('../src/turn-wake.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('没有 pending 标记 → 什么都不做', () => {
  assert.equal(decideWakeReminder({ pending: false, missCount: 1 }).action, 'none');
});

check('设过唤醒条件 → settled，计数清零', () => {
  const r = decideWakeReminder({ pending: true, wakeConfigUpdated: true, missCount: 1 });
  assert.equal(r.action, 'settled');
  assert.equal(r.missCount, 0);
});

check('只是 mark_read 也算交代过 → settled', () => {
  assert.equal(decideWakeReminder({ pending: true, markReadCalled: true }).action, 'settled');
});

check('没设 → 第一次提醒，计数 1', () => {
  const r = decideWakeReminder({ pending: true, missCount: 0, maxReminders: 2 });
  assert.equal(r.action, 'remind');
  assert.equal(r.missCount, 1);
});

check('连续漏到上限 → reset（默认 max=2）', () => {
  const r = decideWakeReminder({ pending: true, missCount: 1, maxReminders: 2 });
  assert.equal(r.action, 'reset');
  assert.equal(r.missCount, 2);
});

check('maxReminders=3 时，第 2 次仍是提醒', () => {
  const r = decideWakeReminder({ pending: true, missCount: 1, maxReminders: 3 });
  assert.equal(r.action, 'remind');
  assert.equal(r.missCount, 2);
});

check('非法 maxReminders 兜底成 2', () => {
  const r = decideWakeReminder({ pending: true, missCount: 1, maxReminders: 0 });
  assert.equal(r.action, 'reset', '0 应兜底成 2，1+1>=2 即重置');
});

check('设过之后 missCount 历史会被清掉（不残留）', () => {
  const r = decideWakeReminder({ pending: true, wakeConfigUpdated: true, missCount: 5 });
  assert.equal(r.missCount, 0, 'settled 必须归零，否则下次少一次提醒机会');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }