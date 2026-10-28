// 待判表情队列（src/sticker-pending.js）契约测试：全离线。
//
// 重点：scope 隔离、先进先出上限、不重复挂、提示渲染为空即不出现。

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const m = await import(pathToFileURL('D:/QQBot-open/qq-bridge/src/sticker-pending.js').href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('add：空 id 拒绝；同 id 不重复挂', () => {
  const q = m.createPendingQueue();
  assert.equal(q.add('group', { id: '' }), false);
  assert.equal(q.add('group', { id: 'a' }), true);
  assert.equal(q.add('group', { id: 'a' }), false);
  assert.equal(q.size('group'), 1);
});

check('上限：超过 max 先进先出', () => {
  const q = m.createPendingQueue({ max: 2 });
  q.add('group', { id: '1' }); q.add('group', { id: '2' }); q.add('group', { id: '3' });
  assert.deepEqual(q.peek('group').map((x) => x.id), ['2', '3']);
});

check('scope 隔离：群聊的绝不进私聊', () => {
  const q = m.createPendingQueue();
  q.add('group', { id: 'g1' });
  q.add('private', { id: 'p1' });
  assert.deepEqual(q.take('group').map((x) => x.id), ['g1']);
  assert.deepEqual(q.take('private').map((x) => x.id), ['p1']);
  assert.equal(q.size('group'), 0, 'take 默认清空');
});

check('take({clear:false}) 保留，peek 不消费', () => {
  const q = m.createPendingQueue();
  q.add('group', { id: 'x' });
  assert.equal(q.take('group', { clear: false }).length, 1);
  assert.equal(q.size('group'), 1);
  q.peek('group');
  assert.equal(q.size('group'), 1);
});

check('renderPendingHint：空 → 空串；有内容 → 带工具名与说明', () => {
  assert.equal(m.renderPendingHint([]), '');
  assert.equal(m.renderPendingHint(null), '');
  const s = m.renderPendingHint([{ id: 'm1' }, { id: 'm2' }]);
  assert.match(s, /qq_collect_sticker/);
  assert.match(s, /m1、m2/);
});

check('renderPendingHint：hard 默认带"别直接忽略"，soft 带"没意思就忽略"', () => {
  const soft = m.renderPendingHint([{ id: 'a' }], { style: 'soft' });
  const hard = m.renderPendingHint([{ id: 'a' }]);
  assert.match(soft, /没意思就忽略/);
  assert.match(hard, /不必再调看图工具/);
  assert.match(hard, /qq_collect_sticker/);
  assert.ok(!/本轮先看一眼/.test(hard), '不能再要求先调看图工具（实测会被整个跳过）');
});

check('renderPendingHint：inspect 档展示桥接给的描述', () => {
  const s = m.renderPendingHint([{ id: 'a', note: '无语到翻白眼' }], { style: 'inspect' });
  assert.match(s, /无语到翻白眼/);
  assert.match(s, /只需决定收不收/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
