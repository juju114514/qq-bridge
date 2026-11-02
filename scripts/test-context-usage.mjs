// 上下文用量（0.4.141）
import assert from 'node:assert/strict';
const m = await import(new URL('../src/context-usage.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const snap = (pressure, breakdown) => ({ projections: { values: { contextPressure: pressure, contextBreakdown: breakdown } } });

await check('没有快照时 view() 明确说"还没收到"，不编数字', () => {
  const s = m.createContextUsageStore();
  const v = s.view();
  assert.equal(v.ok, false);
  assert.match(v.reason, /还没收到/);
});

await check('record 只认 projections.values 里的字段', () => {
  const s = m.createContextUsageStore();
  s.record('a', { records: [] });                       // 没有 projections
  assert.equal(s.view().ok, false);
});

await check('正常快照：百分比 = 压力 / 容量', () => {
  const s = m.createContextUsageStore();
  s.record('a', snap(
    { pressureTokens: 11500, capacityTokens: 1000000 },
    { systemTokens: 1300, toolsTokens: 1200, messageTokens: 3600 }
  ));
  const v = s.view('a');
  assert.equal(v.ok, true);
  assert.equal(v.pressureTokens, 11500);
  assert.equal(v.capacityTokens, 1000000);
  assert.equal(v.percent, 1.2);                          // 1.15% → 1.2
  assert.equal(v.remainder, 988500);
  assert.equal(v.brokenTotal, 6100);
  assert.deepEqual(v.parts.map((p) => p.key), ['system', 'tools', 'messages']);
});

await check('容量未知时 percent 为 null（不假装 0%）', () => {
  const s = m.createContextUsageStore();
  s.record('a', snap({ pressureTokens: 500 }, { systemTokens: 10, toolsTokens: 0, messageTokens: 0 }));
  const v = s.view('a');
  assert.equal(v.percent, null);
  assert.equal(v.remainder, null);
});

await check('没有 pressure 但有 breakdown 也要能显示构成', () => {
  const s = m.createContextUsageStore();
  s.record('a', snap(null, { systemTokens: 100, toolsTokens: 200, messageTokens: 300 }));
  const v = s.view('a');
  assert.equal(v.ok, true);
  assert.equal(v.brokenTotal, 600);
});

await check('多会话：latest() 取最新一条，all() 按时间倒序', () => {
  let t = 1000;
  const s = m.createContextUsageStore({ now: () => (t += 10) });
  s.record('a', snap({ pressureTokens: 1, capacityTokens: 10 }, { systemTokens: 1 }));
  s.record('b', snap({ pressureTokens: 2, capacityTokens: 10 }, { systemTokens: 2 }));
  assert.equal(s.latest().sessionId, 'b');
  assert.deepEqual(s.all().map((x) => x.sessionId), ['b', 'a']);
});

await check('超过 maxSessions 淘汰最旧的', () => {
  let t = 1000;
  const s = m.createContextUsageStore({ now: () => (t += 10), maxSessions: 2 });
  for (const id of ['a', 'b', 'c']) s.record(id, snap({ pressureTokens: 1, capacityTokens: 10 }, { systemTokens: 1 }));
  assert.equal(s.all().length, 2);
  assert.ok(!s.all().some((x) => x.sessionId === 'a'), '最旧的 a 应该被淘汰');
});

await check('百分比封顶 100（压力超过容量时不出现 137%）', () => {
  const s = m.createContextUsageStore();
  s.record('a', snap({ pressureTokens: 1370, capacityTokens: 1000 }, { systemTokens: 1 }));
  assert.equal(s.view('a').percent, 100);
  assert.equal(s.view('a').remainder, 0);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
