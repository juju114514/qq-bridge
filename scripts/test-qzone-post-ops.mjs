// 空间删除 / 挑图逻辑（0.4.80）
import assert from 'node:assert/strict';

const m = await import(new URL('../src/qzone-post-ops.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('删除候选 action 表非空且去重、顺序稳定', () => {
  assert.ok(m.QZONE_DELETE_ACTIONS.length >= 3);
  assert.equal(new Set(m.QZONE_DELETE_ACTIONS).size, m.QZONE_DELETE_ACTIONS.length);
  assert.equal(m.QZONE_DELETE_ACTIONS[0], 'delete_qzone_msg');
});

check('tokensOf：英文按词、中文按 2 字滑窗', () => {
  const t = m.tokensOf('深夜值班的鱼 Whale');
  assert.ok(t.has('whale'));
  assert.ok(t.has('深夜'));
  assert.ok(t.has('值班'));
  assert.ok(!t.has('深'));
});

check('scoreImages：描述命中的排在前面', () => {
  const items = [
    { id: 'a', name: 'IMG_1.jpg', desc: '' },
    { id: 'b', name: 'whale.jpg', desc: '沙滩上的水豚和鲸鱼' }
  ];
  const scored = m.scoreImages({ text: '今天和鲸鱼在沙滩上发呆', items });
  assert.equal(scored[0].id, 'b');
  assert.ok(scored[0].score > scored[1].score);
  assert.match(scored[0].reason, /重合/);
});

check('pickImages：最多 2 张（产品约束）', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, name: `鲸鱼${i}.jpg`, desc: '鲸鱼' }));
  assert.equal(m.pickImages({ text: '鲸鱼', items }).length, 2);
  assert.equal(m.pickImages({ text: '鲸鱼', items, max: 9 }).length, 2, 'max 被限制到 2');
});

check('pickImages：全都不相关时也有兜底（不返回空）', () => {
  const items = [{ id: 'x', name: 'a.png', desc: '' }, { id: 'y', name: 'b.png', desc: '' }];
  const picked = m.pickImages({ text: '完全无关的话', items });
  assert.equal(picked.length, 2);
});

check('pickImages：没有图 → 空数组（不会造出假 id）', () => {
  assert.deepEqual(m.pickImages({ text: '随便', items: [] }), []);
  assert.deepEqual(m.pickImages({ text: '随便', items: null }), []);
});

check('脏数据不炸（非字符串描述、缺字段）', () => {
  const items = [{ id: 'a' }, { id: 'b', desc: null, name: undefined }, {}];
  const scored = m.scoreImages({ text: '鲸鱼', items });
  assert.equal(scored.length, 3);
  for (const s of scored) assert.ok(typeof s.score === 'number');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
