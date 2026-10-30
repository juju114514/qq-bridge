// 运行时 rt（src/runtime.js）
//
// 这个文件存在的唯一理由：**共享状态要有唯一归属**。
// 它不做事，只是"东西放哪儿"的答案 —— 所以测试要钉住的正是"东西确实在那儿、确实共享"。

import assert from 'node:assert/strict';

const { createRuntime, createEmitter } = await import(new URL('../src/runtime.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('rt 提供全部共享容器', () => {
  const rt = createRuntime({ cfg: { a: 1 }, log: () => {} });
  assert.equal(rt.cfg.a, 1);
  assert.ok(rt.state.sessions);
  assert.ok(rt.social.states instanceof Map);
  assert.ok(rt.social.silentTurns instanceof Map);
  assert.ok(rt.social.exitingSessions instanceof Set);
  assert.ok(rt.socialV2.conversations instanceof Map);
  assert.equal(rt.socialV2.paused, false);
  assert.ok(rt.queues.pending instanceof Map);
  assert.equal(rt.clients.api, null);
  assert.ok(rt.events);
});

check('计数器唯一归属 rt.counters，且从 0 开始', () => {
  const rt = createRuntime();
  assert.equal(rt.counters.gatewayReconnects, 0);
  rt.counters.gatewayReconnects += 1;
  assert.equal(rt.counters.gatewayReconnects, 1);
});

check('两个 rt 互不共享状态（不能变成全局单例）', () => {
  const a = createRuntime();
  const b = createRuntime();
  a.socialV2.conversations.set('group:1', { x: 1 });
  assert.equal(b.socialV2.conversations.size, 0);
  a.counters.gatewayReconnects = 5;
  assert.equal(b.counters.gatewayReconnects, 0);
});

check('事件总线：on/emit/off', () => {
  const rt = createRuntime();
  const seen = [];
  const off = rt.events.on('wake/scheduled', (p) => seen.push(p.key));
  assert.equal(rt.events.emit('wake/scheduled', { key: 'group:1' }), 1);
  assert.deepEqual(seen, ['group:1']);
  off();
  assert.equal(rt.events.emit('wake/scheduled', { key: 'group:2' }), 0);
  assert.deepEqual(seen, ['group:1'], '取消订阅后不该再收到');
});

check('事件总线：一个监听器抛错不影响其它监听器', () => {
  const e = createEmitter();
  const seen = [];
  e.on('x', () => { throw new Error('boom'); });
  e.on('x', () => seen.push('ok'));
  const delivered = e.emit('x', {});
  assert.equal(delivered, 1, '只有成功的那一个算投递');
  assert.deepEqual(seen, ['ok']);
  assert.ok(e.lastError instanceof Error, '出错要记下来，但不要抛出去');
});

check('事件总线：没有监听器时 emit 返回 0（不报错）', () => {
  const e = createEmitter();
  assert.equal(e.emit('nothing', {}), 0);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }