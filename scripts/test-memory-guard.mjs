// 记忆护栏（0.4.141）
import assert from 'node:assert/strict';
const m = await import(new URL('../src/memory-guard.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const conv = (over = {}) => ({ memberImpressions: {}, activeTopics: [], pendingThoughts: [], ...over });

await check('真实事故重放：磁盘有印象、内存是空 → 救回来', () => {
  const disk = {
    'group:100000001': conv({
      memberImpressions: { 甲: { traits: ['爱发语音'], interactionCount: 3 }, 乙: { traits: ['爱调戏'] } },
      activeTopics: [{ text: '在更新仓库' }]
    })
  };
  const memory = { 'group:100000001': conv() };
  const { restored, memory: out } = m.restoreDroppedMemory({ memory, disk });
  assert.equal(restored.length, 2);
  assert.equal(Object.keys(out['group:100000001'].memberImpressions).length, 2);
  assert.equal(out['group:100000001'].activeTopics.length, 1);
});

await check('内存里有新内容时不覆盖（新数据优先）', () => {
  const disk = { k: conv({ memberImpressions: { A: { traits: ['旧'] } } }) };
  const memory = { k: conv({ memberImpressions: { B: { traits: ['新'] } } }) };
  const { restored, memory: out } = m.restoreDroppedMemory({ memory, disk });
  assert.equal(restored.length, 0);
  assert.deepEqual(Object.keys(out.k.memberImpressions), ['B']);
});

await check('显式清空（已报备）放行，不被救回', () => {
  const disk = { k: conv({ memberImpressions: { A: { traits: ['x'] } } }) };
  const memory = { k: conv() };
  m.markMemoryClear('k');
  const { restored } = m.restoreDroppedMemory({ memory, disk, isAllowed: m.isMemoryClearAllowed });
  assert.equal(restored.length, 0);
  assert.equal(m.isMemoryClearAllowed('k'), true);
  m.consumeMemoryClear('k');
  assert.equal(m.isMemoryClearAllowed('k'), false);
});

await check('消费掉报备之后，同样的空写又会被拦', () => {
  const disk = { k: conv({ memberImpressions: { A: { traits: ['x'] } } }) };
  const memory = { k: conv() };
  m.markMemoryClear('k');
  m.consumeMemoryClear('k');
  const { restored } = m.restoreDroppedMemory({ memory, disk, isAllowed: m.isMemoryClearAllowed });
  assert.equal(restored.length, 1);
});

await check('会话被整体删掉（不在内存里）不拦 —— 那是重置，不是覆盖', () => {
  const disk = { k: conv({ memberImpressions: { A: { traits: ['x'] } } }) };
  const memory = {};
  const { restored } = m.restoreDroppedMemory({ memory, disk });
  assert.equal(restored.length, 0);
});

await check('只保护三个记忆字段，水位/时间变空不管', () => {
  const disk = { k: { memberImpressions: {}, lastReadThroughSeq: 42, sendTimes: [1, 2, 3] } };
  const memory = { k: { memberImpressions: {}, lastReadThroughSeq: 0, sendTimes: [] } };
  const { restored, memory: out } = m.restoreDroppedMemory({ memory, disk });
  assert.equal(restored.length, 0);
  assert.equal(out.k.lastReadThroughSeq, 0);
  assert.deepEqual(out.k.sendTimes, []);
});

await check('坏输入不抛（磁盘文件损坏时不能让落盘挂掉）', () => {
  assert.doesNotThrow(() => m.restoreDroppedMemory({ memory: null, disk: null }));
  assert.doesNotThrow(() => m.restoreDroppedMemory({ memory: {}, disk: 'oops' }));
});

await check('pendingThoughts 过期的空数组不算内容', () => {
  const disk = { k: conv({ pendingThoughts: [{ text: '想说' }] }) };
  const memory = { k: conv() };
  const { restored } = m.restoreDroppedMemory({ memory, disk });
  assert.ok(restored.some((r) => r.field === 'pendingThoughts'));
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
