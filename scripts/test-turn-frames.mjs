// 回合帧的形状与生命周期（step 2 of C）
//
// 为什么单独测这个：今晚移植调度器时踩坑最多的是"上游的契约和我以为的不一样"。
// 回合帧也有同样风险 —— 形状错了不会报错，只会表现成"AI 回了但桥接没发"或"重复发"。
//
// 帧形状（来自 src/dsh-client.js 的 createTurnCollector）：
//   turn/start        { data: { turn } }
//   assistant/message { data: { turn, message: { content: [{ type:'text', text }] } } }
//   assistant/chunk   （必须被忽略，否则文本会翻倍 —— 曾把「收到」发成「收到收到」）
//   turn/end          { data: { turn, reason: { kind } } }

import assert from 'node:assert/strict';

const { bridgeHarness } = await import(new URL('../scripts/audit-bridge-harness.mjs', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const SID = 'session-turn-test';

async function withHarness(fn) {
  const h = await bridgeHarness();
  try { await fn(h); } finally { await h.close(); }
}

await check('turn/start → 建 collector；turn/end → 返回文本与结束原因', async () => {
  await withHarness(async (h) => {
    assert.equal(h.collectors.size, 0, '初始不应有 collector');

    const r1 = h.trackTurnEvent(SID, { type: 'turn/start', data: { turn: 1 } });
    assert.equal(r1.ended, null);
    assert.equal(h.collectors.size, 1, 'turn/start 必须建 collector');

    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '你' }] } } });
    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '好' }] } } });

    const r2 = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.ok(r2.ended, 'turn/end 应返回 ended');
    assert.equal(r2.ended.text, '你好', '没传文字时必须是空串，不能是「收到」变「收到收到」');
    assert.equal(r2.ended.reason.kind, 'completed');
    assert.equal(h.collectors.size, 0, '收尾后 collector 必须释放');
  });
});

await check('assistant/chunk 必须被忽略（否则文本翻倍）', async () => {
  await withHarness(async (h) => {
    h.trackTurnEvent(SID, { type: 'turn/start', data: { turn: 2 } });
    h.trackTurnEvent(SID, { type: 'assistant/chunk', data: { turn: 2, delta: '收到' } });
    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '收到' }] } } });
    const r = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    assert.equal(r.ended.text, '收到', `chunk 不该计入，实际「${r.ended.text}」`);
  });
});

await check('turn/end 没有对应 turn/start → 不崩、不留 collector', async () => {
  await withHarness(async (h) => {
    const r = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 99, reason: { kind: 'completed' } } });
    assert.equal(r.ended, null, '没有 start 时不该产出 ended');
    assert.equal(h.collectors.size, 0, '不能留下空壳 collector（否则会话永久繁忙）');
  });
});

await check('两个 turn 交织：各自独立收尾', async () => {
  await withHarness(async (h) => {
    h.trackTurnEvent(SID, { type: 'turn/start', data: { turn: 10 } });
    h.trackTurnEvent(SID, { type: 'turn/start', data: { turn: 11 } });
    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 10, message: { content: [{ type: 'text', text: 'A' }] } } });
    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 11, message: { content: [{ type: 'text', text: 'B' }] } } });
    const a = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } });
    assert.equal(a.ended.text, 'A', 'turn 10 只应拿到自己的文本');
    assert.equal(h.collectors.size, 1, 'turn 11 还没结束，collector 不能删');
    const b = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } });
    assert.equal(b.ended.text, 'B');
    assert.equal(h.collectors.size, 0);
  });
});

await check('失败回合也要能收尾（reason.kind=failed 原样透出）', async () => {
  await withHarness(async (h) => {
    h.trackTurnEvent(SID, { type: 'turn/start', data: { turn: 20 } });
    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 20, message: { content: [{ type: 'text', text: '半截' }] } } });
    const r = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 20, reason: { kind: 'failed', message: 'boom' } } });
    assert.equal(r.ended.reason.kind, 'failed');
    assert.equal(r.ended.text, '半截', '失败回合的已产生文本仍要保留');
    assert.equal(h.collectors.size, 0);
  });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }