// 角色卡「按节奏注入」的离线回归。
//
// 背景：实测每轮提示词约 15K tokens，其中 10.6K 是角色卡（71%）。配 socialV2.roleInjectEvery=N
// 之后，首次/换卡全量、其后每 N 轮一次；默认 N=1 保持老行为（每轮全量）。
// 这条只影响"提示词里放不放完整卡"，不影响服务端的权限判定。
import assert from 'node:assert/strict';

const { createRoleCadence } = await import(new URL('../src/domains/role-cadence.js', import.meta.url).href);

const results = [];
function check(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e?.message ?? e)]); }
}

check('默认 every=1：每轮都全量（老行为不变）', () => {
  const c = createRoleCadence({});
  for (let i = 0; i < 5; i += 1) assert.equal(c.shouldInjectFull('group:1', 'xiaojingyu'), true);
});

check('every=8：第 1 轮全量，随后 7 轮不注入，第 9 轮再全量', () => {
  const c = createRoleCadence({ every: 8 });
  const seq = [];
  for (let i = 0; i < 17; i += 1) seq.push(c.shouldInjectFull('group:1', 'xiaojingyu'));
  assert.deepEqual(seq, [
    true, false, false, false, false, false, false, false,
    true, false, false, false, false, false, false, false, true
  ]);
});

check('换卡立刻全量（哪怕还没到 N 轮）', () => {
  const c = createRoleCadence({ every: 8 });
  c.shouldInjectFull('group:1', 'xiaojingyu');   // 第 1 轮全量
  assert.equal(c.shouldInjectFull('group:1', 'xiaojingyu'), false);
  assert.equal(c.shouldInjectFull('group:1', 'paimon'), true, '换卡必须全量');
  assert.equal(c.shouldInjectFull('group:1', 'paimon'), false);
});

check('会话之间互不影响', () => {
  const c = createRoleCadence({ every: 4 });
  assert.equal(c.shouldInjectFull('group:A', 'r'), true);
  assert.equal(c.shouldInjectFull('group:B', 'r'), true, 'B 的第一次也该全量');
  assert.equal(c.shouldInjectFull('group:A', 'r'), false);
  assert.equal(c.shouldInjectFull('group:B', 'r'), false);
});

check('脏配置（0 / 负数 / 字符串）都按 1 处理，不会静默"永不注入"', () => {
  for (const bad of [0, -3, 'abc', null]) {
    const c = createRoleCadence({ every: bad });
    assert.equal(c.shouldInjectFull('k', 'r'), true, `every=${bad} 必须退化成每轮全量`);
    assert.equal(c.shouldInjectFull('k', 'r'), true);
  }
});

check('按调用传 every 能覆盖默认值（配置运行时可改）', () => {
  const c = createRoleCadence({});           // 模块级默认 every=1
  // every=1 走提前返回，不记计数（所以下一次见到这个会话仍是"第一次"→全量）
  assert.equal(c.shouldInjectFull('k', 'r', 1), true);
  assert.equal(c.shouldInjectFull('k', 'r', 4), true);   // 第一次见到 → 全量
  assert.equal(c.shouldInjectFull('k', 'r', 4), false);  // 2
  assert.equal(c.shouldInjectFull('k', 'r', 4), false);  // 3
  assert.equal(c.shouldInjectFull('k', 'r', 4), false);  // 4
  assert.equal(c.shouldInjectFull('k', 'r', 4), true);   // 5 → (5-1)%4===0
});

check('reset 之后下一轮回到全量', () => {
  const c = createRoleCadence({ every: 8 });
  c.shouldInjectFull('k', 'r');
  assert.equal(c.shouldInjectFull('k', 'r'), false);
  c.reset('k');
  assert.equal(c.shouldInjectFull('k', 'r'), true);
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, name] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${name}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);