// 回合收尾"要不要发"的判定（src/turn-reply.js）
//
// 三个 continue 分支各自对应一个用户能感知的事故，必须穷举：
//   空/纯格式 → 不发（否则 QQ 里出现空消息）
//   静默标记 → 不发（这是 AI 主动潜水）
//   工具已发送 → 不自动转发（否则同一句话发两遍）

import assert from 'node:assert/strict';

const { decideReplyAction } = await import(new URL('../src/turn-reply.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('正常完成 + 有文本 → 发', () => {
  assert.deepEqual(decideReplyAction({ kind: 'completed', text: '你好' }), { action: 'send', reason: '' });
});

check('空文本 → 不发（reason=empty）', () => {
  assert.equal(decideReplyAction({ kind: 'completed', text: '' }).reason, 'empty');
  assert.equal(decideReplyAction({ kind: 'completed', text: '   \n\t ' }).reason, 'empty');
});

check('非 completed（失败/取消）→ 不发', () => {
  assert.equal(decideReplyAction({ kind: 'failed', text: '半截' }).action, 'skip');
  assert.equal(decideReplyAction({ kind: 'cancelled', text: 'x' }).action, 'skip');
});

check('静默标记 → 不发（reason=silent）', () => {
  assert.equal(decideReplyAction({ kind: 'completed', text: '嗯', isSilent: true }).reason, 'silent');
});

check('本轮已用工具发过 → 不自动转发（reason=already-sent）', () => {
  assert.equal(decideReplyAction({ kind: 'completed', text: '收到', sendToolSucceeded: true }).reason, 'already-sent');
});

check('优先级：静默标记优先于"工具已发送"（两者都成立时按静默记）', () => {
  const r = decideReplyAction({ kind: 'completed', text: 'x', isSilent: true, sendToolSucceeded: true });
  assert.equal(r.reason, 'silent');
});

check('文本是纯空白但工具发过 → 仍按 empty（不重复发）', () => {
  const r = decideReplyAction({ kind: 'completed', text: '  ', sendToolSucceeded: true });
  assert.equal(r.action, 'skip');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }