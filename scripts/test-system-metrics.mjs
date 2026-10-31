// 资源可观测性（0.4.48）：事件循环延迟 / CPU / 内存
import assert from 'node:assert/strict';

const m = await import(new URL('../src/system-metrics.js', import.meta.url).href);
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('事件循环延迟：阻塞 250ms 能被捕到', async () => {
  const mon = m.startEventLoopMonitor({ intervalMs: 50, warnMs: 1000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 250) { /* busy wait */ }
  await new Promise((r) => setTimeout(r, 200));
  const r = mon.read();
  mon.stop();
  assert.ok(r.samples >= 2, `采样数太少：${r.samples}`);
  assert.ok(r.eventLoopLagMaxMs >= 100, `最大延迟没捕到阻塞：${r.eventLoopLagMaxMs}ms`);
});

await check('事件循环延迟：空闲时应该很低', async () => {
  const mon = m.startEventLoopMonitor({ intervalMs: 50 });
  await new Promise((r) => setTimeout(r, 400));
  const r = mon.read();
  mon.stop();
  assert.ok(r.eventLoopLagMaxMs < 200, `空闲时延迟异常高：${r.eventLoopLagMaxMs}ms`);
});

await check('CPU 采样返回合理范围', () => {
  const cpu = m.createCpuSampler();
  const t0 = Date.now();
  while (Date.now() - t0 < 80) { /* 制造一点 CPU */ }
  const pct = cpu();
  assert.ok(pct >= 0 && pct <= 100 * 64, `CPU 数值不合理：${pct}`);
});

await check('快照包含关键字段且 warn 是数组', () => {
  const snap = m.readSystemSnapshot({ lag: { eventLoopLagMs: 0, eventLoopLagMaxMs: 0 }, cpuPercent: 3 });
  for (const k of ['cpuPercent', 'rssMb', 'freeMemMb', 'totalMemMb', 'memUsedPercent', 'eventLoopLagMs', 'cores', 'warn']) {
    assert.ok(k in snap, `缺字段 ${k}`);
  }
  assert.ok(Array.isArray(snap.warn));
  assert.equal(snap.warn.length, 0, '正常快照不该有 warn');
});

await check('阈值触发 warn（高延迟 / 低内存）', () => {
  const snap = m.readSystemSnapshot({ lag: { eventLoopLagMs: 900, eventLoopLagMaxMs: 3000 }, cpuPercent: 95 });
  assert.ok(snap.warn.some((w) => w.startsWith('event-loop-lag:')), '高延迟没进 warn');
  assert.ok(snap.warn.some((w) => w.startsWith('high-cpu:')), '高 CPU 没进 warn');
});

await check('Windows 上 loadavg 明确为 null（不假装有值）', () => {
  const snap = m.readSystemSnapshot({});
  if (process.platform === 'win32') assert.equal(snap.loadavg, null);
  else assert.ok(Array.isArray(snap.loadavg));
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
