// 进线社交阶段（src/incoming-social.js）—— 波次 3 第二块
//
// 顺序有意义：**先入库再判定**。否则"没唤醒"的消息会完全丢失，
// AI 醒来后看不到这段时间群里说了什么 —— unread 存在的理由就在这。

import assert from 'node:assert/strict';

const { runSocialIncomingStage } = await import(new URL('../src/incoming-social.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function harness({ paused = false, bootstrapSent = true, trigger = null, kind = 'group' } = {}) {
  const calls = { appended: [], slang: [], wakes: [], activity: [], steps: [], finished: [] };
  const st = { bootstrapSent, wakeConfig: { triggers: {} } };
  const ctx = {
    key: `group:1`, kind, event: { user_id: 789, message_id: 42, sender: { card: '老王' } },
    textContent: '你好', plainContent: '你好', quoteTargetIsSelf: false, isOwner: false, traceRec: {}
  };
  const deps = {
    paused,
    getState: () => st,
    saveState: () => {},
    appendMessage: (...args) => calls.appended.push(args),
    feedSlang: (...args) => calls.slang.push(args),
    scheduleWake: (k, why) => calls.wakes.push([k, why]),
    evaluateTrigger: () => trigger,
    appendActivity: (m) => calls.activity.push(m),
    trace: { step: (...a) => calls.steps.push(a), finish: (...a) => calls.finished.push(a) }
  };
  return { ctx, deps, st, calls };
}

check('先入库：无论后面是否唤醒，消息都要记进会话', () => {
  const { ctx, deps, calls } = harness({ trigger: null });
  const r = runSocialIncomingStage(ctx, deps);
  assert.equal(calls.appended.length, 1, '必须入库');
  assert.equal(calls.appended[0][0], 'group:1');
  assert.equal(r.action, 'unread');
});

check('AI 暂停 → 只入库不唤醒', () => {
  const { ctx, deps, calls } = harness({ paused: true, trigger: 'atMention' });
  const r = runSocialIncomingStage(ctx, deps);
  assert.equal(r.action, 'paused');
  assert.equal(calls.wakes.length, 0, '暂停时绝不唤醒');
  assert.equal(calls.appended.length, 1, '但消息仍要入库');
  assert.match(calls.activity.at(-1), /已暂停/);
});

check('首次消息 → bootstrap 唤醒（带人设介绍），并标记 bootstrapSent', () => {
  const { ctx, deps, st, calls } = harness({ bootstrapSent: false });
  const r = runSocialIncomingStage(ctx, deps);
  assert.equal(r.action, 'bootstrap');
  assert.equal(st.bootstrapSent, true, '必须落标记，否则每条消息都 bootstrap');
  assert.deepEqual(calls.wakes, [['group:1', 'bootstrap']]);
});

check('触发器命中 → 唤醒，并把原因写进决策追踪', () => {
  const { ctx, deps, calls } = harness({ trigger: 'keyword:部署' });
  const r = runSocialIncomingStage(ctx, deps);
  assert.equal(r.action, 'wake');
  assert.equal(r.reason, 'keyword:部署');
  assert.deepEqual(calls.wakes, [['group:1', 'keyword:部署']]);
  assert.match(String(calls.finished.at(-1)[1]), /已唤醒/);
});

check('触发器未命中 → 不唤醒，但追踪里要写明原因', () => {
  const { ctx, deps, calls } = harness({ trigger: null });
  const r = runSocialIncomingStage(ctx, deps);
  assert.equal(r.action, 'unread');
  assert.equal(calls.wakes.length, 0);
  assert.match(String(calls.finished.at(-1)[1]), /未唤醒/);
});

check('只有群聊才喂黑话窗口（私聊不进学习素材）', () => {
  const g = harness({ kind: 'group' });
  runSocialIncomingStage(g.ctx, g.deps);
  assert.equal(g.calls.slang.length, 1);

  const p = harness({ kind: 'private' });
  runSocialIncomingStage(p.ctx, p.deps);
  assert.equal(p.calls.slang.length, 0);
});

check('发送者名字：群聊取群名片，私聊为空', () => {
  const g = harness({ kind: 'group' });
  runSocialIncomingStage(g.ctx, g.deps);
  assert.equal(g.calls.appended[0][1], '老王');

  const p = harness({ kind: 'private' });
  runSocialIncomingStage(p.ctx, p.deps);
  assert.equal(p.calls.appended[0][1], '');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }