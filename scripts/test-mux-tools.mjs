// pumpMux 的工具调用追踪（src/mux-tools.js）：决定"要不要自动转发"。
//
// 语义（错一点就是"同一句话发两遍"或"该发的没发"）：
//   · tool/call  → 记住 callId→name；发送类工具进 pending
//   · tool/result→ 按 callId 找回名字；pending 里且**没报错**才标记"本轮已发送"
//   · 其它帧型   → 返回 false，交回主流程

import assert from 'node:assert/strict';

const { createMuxToolTracker } = await import(new URL('../src/mux-tools.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function makeTracker({ sendTools = ['qq_send_message'] } = {}) {
  const toolCallNames = new Map();
  const pendingSendToolCalls = new Map();
  const sendToolSucceededSessions = new Set();
  const logs = [];
  const t = createMuxToolTracker({
    toolCallNames, pendingSendToolCalls, sendToolSucceededSessions,
    isSendToolName: (n) => sendTools.includes(n),
    sanitizeToolArgs: (v) => v,
    appendToolLog: (e) => logs.push(e)
  });
  return { t, toolCallNames, pendingSendToolCalls, sendToolSucceededSessions, logs };
}

const SID = 's-1';
const callFrame = (name, callId) => ({ sessionId: SID, event: { type: 'tool/call', data: { name, callId, arguments: { a: 1 } } } });
const resultFrame = (callId, { isError = false } = {}) => ({
  sessionId: SID,
  event: { type: 'tool/result', data: { message: { source: { callId }, isError, content: [{ text: isError ? 'boom' : 'ok' }] } } }
});

check('非工具帧：返回 false（交回主流程）', () => {
  const { t } = makeTracker();
  assert.equal(t.handleToolFrame({ sessionId: SID, event: { type: 'turn/start' } }, 'k'), false);
});

check('发送类工具调用：进 pending 并记名字', () => {
  const { t, pendingSendToolCalls, toolCallNames } = makeTracker();
  assert.equal(t.handleToolFrame(callFrame('qq_send_message', 'c1'), 'k'), true);
  assert.equal(pendingSendToolCalls.get(SID).has('c1'), true);
  assert.equal(toolCallNames.get(SID).get('c1'), 'qq_send_message');
});

check('非发送类工具调用：只记名字，不进 pending', () => {
  const { t, pendingSendToolCalls, toolCallNames } = makeTracker();
  t.handleToolFrame(callFrame('qq_memory_append', 'c2'), 'k');
  assert.equal(pendingSendToolCalls.has(SID), false);
  assert.equal(toolCallNames.get(SID).get('c2'), 'qq_memory_append');
});

check('发送成功：标记本轮已发送，并清掉 pending 与名字', () => {
  const { t, pendingSendToolCalls, toolCallNames, sendToolSucceededSessions } = makeTracker();
  t.handleToolFrame(callFrame('qq_send_message', 'c1'), 'k');
  t.handleToolFrame(resultFrame('c1'), 'k');
  assert.equal(sendToolSucceededSessions.has(SID), true, '成功才标记');
  assert.equal(pendingSendToolCalls.has(SID), false);
  assert.equal(toolCallNames.get(SID)?.has('c1'), false);
});

check('发送失败：**不**标记已发送（否则 AI 的文本也不会发出去了）', () => {
  const { t, pendingSendToolCalls, toolCallNames, sendToolSucceededSessions } = makeTracker();
  t.handleToolFrame(callFrame('qq_send_message', 'c1'), 'k');
  t.handleToolFrame(resultFrame('c1', { isError: true }), 'k');
  assert.equal(sendToolSucceededSessions.has(SID), false);
  assert.equal(pendingSendToolCalls.has(SID), false, 'pending 仍要清掉');
  assert.equal(toolCallNames.get(SID)?.has('c1'), false);
});

check('结果日志：成功 ok=true，失败带 error 文本', () => {
  const { t, logs } = makeTracker();
  t.handleToolFrame(callFrame('qq_send_message', 'c1'), 'k');
  t.handleToolFrame(resultFrame('c1', { isError: true }), 'k');
  const result = logs.find((l) => l.type === 'result');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }