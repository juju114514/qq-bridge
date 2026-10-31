// 唤醒漏斗聚合（0.4.53）：把决策链压成「卡在哪一步 + 为什么」。
import assert from 'node:assert/strict';

const { buildWakeFunnel } = await import(new URL('../src/wake-funnel.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const rec = (steps, outcome = '') => ({ seq: 1, at: 0, key: 'group:1', steps, outcome });

check('全通过：四段计数一致，没有流失原因', () => {
  const r = buildWakeFunnel([
    rec([{ stage: '闸门', verdict: '通过' }, { stage: '唤醒', verdict: '命中', detail: 'atMention' }, { stage: '投递', verdict: '进模型' }]),
    rec([{ stage: '闸门', verdict: '通过' }, { stage: '唤醒', verdict: '命中', detail: 'keyword' }, { stage: '投递', verdict: '进模型' }]),
  ]);
  assert.equal(r.total, 2);
  assert.deepEqual(r.stages.map((s) => s.count), [2, 2, 2, 2]);
  assert.equal(r.topReasons.length, 0);
});

check('闸门拦截：记到 topReasons，且不再计入后续段', () => {
  const r = buildWakeFunnel([
    rec([{ stage: '闸门', verdict: '拦截', detail: '不在白名单' }]),
    rec([{ stage: '闸门', verdict: '拦截', detail: '不在白名单' }]),
    rec([{ stage: '闸门', verdict: '通过' }, { stage: '唤醒', verdict: '命中' }, { stage: '投递', verdict: '进模型' }]),
  ]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.stages.map((s) => s.count), [3, 1, 1, 1]);
  assert.equal(r.topReasons[0].text, '闸门：不在白名单');
  assert.equal(r.topReasons[0].count, 2);
});

check('未命中与暂停分别归因', () => {
  const r = buildWakeFunnel([
    rec([{ stage: '闸门', verdict: '通过' }, { stage: '唤醒', verdict: '未命中', detail: '概率/条件未满足' }]),
    rec([{ stage: '闸门', verdict: '通过' }, { stage: '唤醒', verdict: '已暂停' }]),
  ]);
  const texts = r.topReasons.map((x) => x.text);
  assert.ok(texts.some((x) => x.startsWith('唤醒未命中')), '应有未命中原因');
  assert.ok(texts.some((x) => x.includes('已暂停')), '应有暂停原因');
  assert.equal(r.stages[2].count, 0, '都没有命中唤醒');
});

check('过闸门但没走到唤醒：归为命令/引导分支', () => {
  const r = buildWakeFunnel([rec([{ stage: '闸门', verdict: '通过' }])]);
  assert.equal(r.stages[1].count, 1);
  assert.equal(r.stages[2].count, 0);
  assert.ok(r.topReasons.some((x) => x.text.includes('命令/引导')));
});

check('空输入不炸', () => {
  const r = buildWakeFunnel([]);
  assert.equal(r.total, 0);
  assert.deepEqual(r.stages.map((s) => s.count), [0, 0, 0, 0]);
});

check('脏数据不炸（null 跳过 / 缺 steps 当空 / steps 夹 null）', () => {
  const r = buildWakeFunnel([null, {}, { steps: undefined }, { steps: [null] }]);
  // null 不是"一条消息"，跳过；其余 3 条算收到
  assert.equal(r.total, 3);
  assert.deepEqual(r.stages.map((s) => s.count), [3, 0, 0, 0]);
  assert.ok(Array.isArray(r.topReasons));
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }