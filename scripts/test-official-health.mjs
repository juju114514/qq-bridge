// 官方通道存活（0.4.130）：能区分「连着」和「还活着」
import assert from 'node:assert/strict';

const m = await import(new URL('../src/official-health.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// 可控时钟
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

check('新建：未连接、未就绪', () => {
  const c = makeClock();
  const s = m.createLivenessTracker({ now: c.now }).snapshot();
  assert.equal(s.connected, false);
  assert.equal(s.ready, false);
  assert.equal(s.stale, false);
});

check('连上 + 就绪：不 stale', () => {
  const c = makeClock();
  const tr = m.createLivenessTracker({ now: c.now, staleMs: 60_000 });
  tr.onOpen(); tr.onReady();
  const s = tr.snapshot();
  assert.equal(s.connected, true);
  assert.equal(s.ready, true);
  assert.equal(s.stale, false);
});

check('超过 staleMs 没数据 → stale', () => {
  const c = makeClock();
  const tr = m.createLivenessTracker({ now: c.now, staleMs: 60_000 });
  tr.onOpen(); tr.onReady();
  c.advance(61_000);
  assert.equal(tr.snapshot().stale, true, '61 秒没数据应判 stale');
});

check('收到任意帧就 touch，不再 stale', () => {
  const c = makeClock();
  const tr = m.createLivenessTracker({ now: c.now, staleMs: 60_000 });
  tr.onOpen(); tr.onReady();
  c.advance(50_000);
  tr.touch();
  c.advance(50_000);
  assert.equal(tr.snapshot().stale, false, 'touch 之后应重新计时');
});

check('断开后：不是 stale（是 disconnected）', () => {
  const c = makeClock();
  const tr = m.createLivenessTracker({ now: c.now, staleMs: 60_000 });
  tr.onOpen(); tr.onReady();
  tr.onClose();
  c.advance(120_000);
  const s = tr.snapshot();
  assert.equal(s.connected, false);
  assert.equal(s.stale, false, '断开时不该报 stale');
});

check('describeLiveness：四种状态各有话说', () => {
  assert.equal(m.describeLiveness(null).level, 'warn');
  assert.equal(m.describeLiveness({ connected: false, ready: false }).level, 'error');
  assert.equal(m.describeLiveness({ connected: true, ready: false }).level, 'warn');
  const stale = m.describeLiveness({ connected: true, ready: true, stale: true, ageMs: 7 * 60_000 });
  assert.equal(stale.level, 'error');
  assert.match(stale.text, /7 分钟/);
  assert.equal(m.describeLiveness({ connected: true, ready: true, stale: false }).level, 'ok');
});

check('snapshot 带 staleMs，方便控制台解释阈值', () => {
  const c = makeClock();
  const s = m.createLivenessTracker({ now: c.now, staleMs: 90_000 }).snapshot();
  assert.equal(s.staleMs, 90_000);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
