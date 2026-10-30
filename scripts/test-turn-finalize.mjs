// 回合收尾记账（src/turn-finalize.js）
//
// 这段逻辑原本是 pumpMux 里 20 行"删一堆集合"，看着简单，但每个删除都对应一个事故：
//   · 不清 sendToolSucceededSessions → 下一轮即便没发送也被跳过自动转发（AI 不回话）
//   · 不清 exitingSessions → 下一次普通回复被误判成"退场发言"
//   · 不清 silentTurns → 计数残留，吞掉后续正常回复
//   · 不按超时回收 → 同上，而且难查

import assert from 'node:assert/strict';

const { finalizeTurn } = await import(new URL('../src/turn-finalize.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const SID = 'session-1';

function world({ farewell = false, silentQueue = [], sendSucceeded = false } = {}) {
  const m = () => new Map();
  const s = () => new Set();
  const social = {
    exitingSessions: farewell ? new Set([SID]) : new Set(),
    silentTurns: silentQueue.length ? new Map([[SID, silentQueue.slice()]]) : new Map()
  };
  const deps = {
    sessionId: SID,
    social,
    v2TurnStartAt: new Map([[SID, 1]]),
    collectors: m(),
    turnLeaseNoted: s(),
    sendToolSucceededSessions: sendSucceeded ? new Set([SID]) : new Set(),
    pendingSendToolCalls: new Map([[SID, new Set(['c1'])]]),
    toolCallNames: new Map([[SID, new Map([['c1', 'qq_send_message']])]]),
    now: 1_000_000
  };
  deps.collectors.set(SID, { size: () => 0 });
  deps.turnLeaseNoted.add(SID);
  return deps;
}

check('清空所有按会话记账的集合', () => {
  const deps = world({ sendSucceeded: true });
  const r = finalizeTurn(deps);
  assert.equal(r.sendToolSucceeded, true, '本轮发过消息要如实返回');
  assert.equal(deps.v2TurnStartAt.size, 0);
  assert.equal(deps.collectors.size, 0);
  assert.equal(deps.turnLeaseNoted.size, 0);
  assert.equal(deps.sendToolSucceededSessions.size, 0, '必须清掉，否则下一轮被误判"已发送"');
  assert.equal(deps.pendingSendToolCalls.size, 0);
  assert.equal(deps.toolCallNames.size, 0);
});

check('退场标记：取一次就清（避免下一轮普通回复被当退场）', () => {
  const deps = world({ farewell: true });
  const r = finalizeTurn(deps);
  assert.equal(r.isFarewell, true);
  assert.equal(deps.social.exitingSessions.size, 0);
  const again = finalizeTurn(deps);
  assert.equal(again.isFarewell, false, '第二次不该再是退场');
});

check('静默回合：消费一条并返回 silent=true', () => {
  const deps = world({ silentQueue: [{ ts: 999_000 }, { ts: 999_500 }] });
  const r = finalizeTurn(deps);
  assert.equal(r.silent, true);
  assert.equal(deps.social.silentTurns.get(SID).length, 1, '只消费一条');
});

check('静默回合：最后一条消费完就把 key 删掉（不留空数组）', () => {
  const deps = world({ silentQueue: [{ ts: 999_000 }] });
  const r = finalizeTurn(deps);
  assert.equal(r.silent, true);
  assert.equal(deps.social.silentTurns.has(SID), false);
});

check('超时的静默条目要被回收（否则吞掉后续正常回复）', () => {
  // now=1_000_000，超时 60s → ts=900_000（100 秒前）已过期
  const deps = world({ silentQueue: [{ ts: 900_000 }] });
  const r = finalizeTurn({ ...deps, silentTimeoutMs: 60_000 });
  assert.equal(r.silent, false, '过期条目不算静默');
  assert.equal(deps.social.silentTurns.has(SID), false, '过期条目应被清掉');
});

check('没有静默队列时 silent=false（正常回合）', () => {
  const deps = world();
  const r = finalizeTurn(deps);
  assert.equal(r.silent, false);
  assert.equal(r.isFarewell, false);
  assert.equal(r.sendToolSucceeded, false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }