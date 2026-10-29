// 黑话学习会话分支（src/mux-learner.js）：只收集 turn，绝不发 QQ。
//
// 重点（都是原代码注释里的坑）：
//   · **只有 turn/start 才建 collector**：迟到事件顺手建一个会永久占用集合并吞掉后续 turn
//   · turn 结束要唤醒等待者；失败要把 reject 带上原因
//   · 非当前学习会话结束后从集合移除（避免残留）

import assert from 'node:assert/strict';

const { createLearnerFrameHandler } = await import(new URL('../src/mux-learner.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function makeWorld({ current = 's-current' } = {}) {
  const learnerSessions = new Set(['s-current', 's-old']);
  const learnerCollectors = new Map();
  const learnerWaiters = new Map();
  const events = [];
  const collectorFactory = () => ({
    pushed: [],
    push(ev) {
      this.pushed.push(ev);
      return ev.type === 'turn/end' ? { reason: { kind: ev.ok === false ? 'failed' : 'completed' }, text: '学习结果' } : null;
    }
  });
  const h = createLearnerFrameHandler({
    learnerSessions, learnerCollectors, learnerWaiters,
    createTurnCollector: () => { const c = collectorFactory(); events.push(c); return c; },
    getSlangLearnerSessionId: () => current,
    clearTimeout: () => {}
  });
  return { h, learnerSessions, learnerCollectors, learnerWaiters, events };
}

check('非学习会话：返回 false（交回主流程）', () => {
  const { h } = makeWorld();
  assert.equal(h.handleLearnerFrame({ sessionId: 's-other', event: { type: 'turn/start' } }), false);
});

check('迟到事件不建 collector（只有 turn/start 才建）', () => {
  const { h, learnerCollectors } = makeWorld();
  const handled = h.handleLearnerFrame({ sessionId: 's-current', event: { type: 'session/title' } });
  assert.equal(handled, true, '已消费');
  assert.equal(learnerCollectors.size, 0, '不能为迟到事件建 collector');
});

check('turn/start 建 collector；turn/end 唤醒等待者并清理', () => {
  const { h, learnerCollectors, learnerWaiters, learnerSessions } = makeWorld();
  let resolved = null;
  learnerWaiters.set('s-current', [{ timer: 1, resolve: (t) => { resolved = t; }, reject: () => {} }]);
  h.handleLearnerFrame({ sessionId: 's-current', event: { type: 'turn/start' } });
  assert.equal(learnerCollectors.size, 1);
  h.handleLearnerFrame({ sessionId: 's-current', event: { type: 'turn/end' } });
  assert.equal(resolved, '学习结果');
  assert.equal(learnerCollectors.size, 0, 'collector 用完要删');
  assert.equal(learnerWaiters.size, 0, '等待队列用完要删');
  assert.equal(learnerSessions.has('s-current'), true, '当前学习会话要保留');
});

check('旧学习会话结束后从集合移除（避免残留）', () => {
  const { h, learnerSessions } = makeWorld({ current: 's-current' });
  h.handleLearnerFrame({ sessionId: 's-old', event: { type: 'turn/start' } });
  h.handleLearnerFrame({ sessionId: 's-old', event: { type: 'turn/end' } });
  assert.equal(learnerSessions.has('s-old'), false);
});

check('turn 失败：reject 带可读原因', () => {
  const { h, learnerWaiters } = makeWorld();
  let rejected = null;
  learnerWaiters.set('s-current', [{ timer: 1, resolve: () => {}, reject: (e) => { rejected = e; } }]);
  h.handleLearnerFrame({ sessionId: 's-current', event: { type: 'turn/start' } });
  h.handleLearnerFrame({ sessionId: 's-current', event: { type: 'turn/end', ok: false } });
  assert.ok(rejected instanceof Error);
  assert.match(rejected.message, /学习会话 turn 未正常完成/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }