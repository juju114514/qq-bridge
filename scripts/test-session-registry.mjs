// 会话级状态注册表（src/session-registry.js）：
// 只验证"搬进来的东西能不能一次清干净"，不涉及 epoch（那仍由 bridge 管）。

import assert from 'node:assert/strict';

const { createSessionRegistry } = await import(new URL('../src/session-registry.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const MAPS = ['modelAppliedSessions', 'reverse', 'collectors', 'pendingSendToolCalls', 'v2TurnStartAt', 'toolCallNames'];
const SETS = ['sendToolSucceededSessions', 'turnLeaseNoted'];

check('8 个集合类型正确（6 Map + 2 Set）', () => {
  const r = createSessionRegistry();
  for (const k of MAPS) assert.ok(r[k] instanceof Map, `${k} 应该是 Map`);
  for (const k of SETS) assert.ok(r[k] instanceof Set, `${k} 应该是 Set`);
});

check('clearSession：一次性清掉 8 个集合里的该会话', () => {
  const r = createSessionRegistry();
  for (const k of MAPS) r[k].set('s1', 'x');
  for (const k of SETS) r[k].add('s1');
  for (const k of MAPS) r[k].set('s2', 'y');     // 别的会话不能被误删
  r.clearSession('s1');
  for (const k of MAPS) {
    assert.equal(r[k].has('s1'), false, `${k} 应已清掉 s1`);
    assert.equal(r[k].has('s2'), true, `${k} 不该动 s2`);
  }
  for (const k of SETS) {
    assert.equal(r[k].has('s1'), false, `${k} 应已清掉 s1`);
    assert.equal(r[k].has('s2'), false);
  }
});

check('clearSession：空 sessionId 返回 false 且不误删', () => {
  const r = createSessionRegistry();
  r.collectors.set('s1', 'x');
  assert.equal(r.clearSession(''), false);
  assert.equal(r.clearSession(null), false);
  assert.equal(r.collectors.has('s1'), true);
});

check('stats：能看出各集合大小（排障用）', () => {
  const r = createSessionRegistry();
  r.collectors.set('a', 1);
  r.collectors.set('b', 2);
  r.turnLeaseNoted.add('a');
  const s = r.stats();
  assert.equal(s.sizes.collectors, 2);
  assert.equal(s.sizes.turnLeaseNoted, 1);
});


check('epoch：初始为 0，bumpEpoch 递增并返回新值', () => {
  const r = createSessionRegistry();
  assert.equal(r.epoch, 0);
  assert.equal(r.bumpEpoch(), 1);
  assert.equal(r.epoch, 1);
  r.bumpEpoch();
  assert.equal(r.epoch, 2);
});

check('clearSession 不动 epoch（职责分离：只有显式 bump 才递增）', () => {
  const r = createSessionRegistry();
  r.collectors.set('s1', 'x');
  const before = r.epoch;
  r.clearSession('s1');
  assert.equal(r.epoch, before, 'clearSession 只管集合，epoch 由调用方决定');
});

check('stats 里带 epoch（排障时能看出重置过几次）', () => {
  const r = createSessionRegistry();
  r.bumpEpoch(); r.bumpEpoch();
  assert.equal(r.stats().epoch, 2);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }