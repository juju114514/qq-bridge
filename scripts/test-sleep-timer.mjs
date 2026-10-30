// 有限潜水定时器（src/domains/sleep-timer.js）—— 波次 2 第二块
//
// 两个必须记住的 Node 坑，都在这里测：
//   1. setTimeout 超过 2^31-1ms 会按 1ms 触发 → 远未来必须分段续期
//   2. 续期步长取 100 秒（不是"24 天上限"）：每次都用 Date.now() 重算，
//      系统时钟跳变时能快速纠正
//
// 还有一条语义：**先清旧定时器，再决定要不要设**。顺序错 → 到点醒两次。

import assert from 'node:assert/strict';

const { setupSleepTimer, SLEEP_TIMER_MAX_MS } = await import(new URL('../src/domains/sleep-timer.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

/** 假定时器：记录 setTimeout 的延时，手动触发最近的定时器 */
function fakeTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutFn: (h) => { cleared.push(h); },
    fire: (handle) => handle.fn()
  };
}

const at = (iso) => ({ ok: true, t: Date.parse(iso) });
const st = () => ({ sleepTimer: null });

check('社交模式关闭 → 什么都不做', () => {
  const t = fakeTimers();
  const r = setupSleepTimer({ key: 'group:1', st: st(), wakeConfig: {}, enabled: false, ...t });
  assert.equal(r.action, 'disabled');
  assert.equal(t.scheduled.length, 0);
});

check('会话不在当前模式允许范围 → not-allowed（官方会话打日志）', () => {
  const logs = [];
  const t = fakeTimers();
  const r = setupSleepTimer({ key: 'group:official-x', st: st(), wakeConfig: {}, allowed: () => false, log: (m) => logs.push(m), ...t });
  assert.equal(r.action, 'not-allowed');
  assert.match(logs.join(''), /official/);
});

check('先清旧定时器（防止醒两次）', () => {
  const t = fakeTimers();
  const s = { sleepTimer: { fn: () => {}, ms: 1 } };
  const old = s.sleepTimer;
  const r = setupSleepTimer({
    // 固定时钟：sleepUntil 必须相对假 now 来算，混用真实 Date.now() 会变成"远未来"
    key: 'group:1', st: s, wakeConfig: { infinite: false, sleepUntil: new Date(1000 + 60000).toISOString() },
    now: () => 1000, ...t
  });
  assert.equal(t.cleared.length, 1, '必须清掉旧定时器');
  assert.equal(t.cleared[0], old);
  assert.equal(r.action, 'scheduled');
});

check('无限潜水 → 不设定时器', () => {
  const t = fakeTimers();
  assert.equal(setupSleepTimer({ key: 'group:1', st: st(), wakeConfig: { infinite: true }, ...t }).action, 'none');
  assert.equal(setupSleepTimer({ key: 'group:1', st: st(), wakeConfig: null, ...t }).action, 'none');
});

check('sleepUntil 非法 → invalid，不设', () => {
  const t = fakeTimers();
  assert.equal(setupSleepTimer({ key: 'group:1', st: st(), wakeConfig: { infinite: false, sleepUntil: 'not-a-date' }, ...t }).action, 'invalid');
  assert.equal(t.scheduled.length, 0);
});

check('已经到期 → 立即唤醒，不再挂定时器', () => {
  const woken = [];
  const t = fakeTimers();
  const r = setupSleepTimer({
    key: 'group:1', st: st(), wakeConfig: { infinite: false, sleepUntil: new Date(5000).toISOString() },
    now: () => 9000, onWake: (k, why) => woken.push([k, why]), ...t
  });
  assert.equal(r.action, 'woke');
  assert.deepEqual(woken, [['group:1', 'timeout']]);
  assert.equal(t.scheduled.length, 0);
});

check('正常剩余时间 → 按剩余毫秒数挂定时器，到点唤醒', () => {
  const woken = [];
  const t = fakeTimers();
  const r = setupSleepTimer({
    key: 'group:1', st: st(), wakeConfig: { infinite: false, sleepUntil: new Date(100_000).toISOString() },
    now: () => 40_000, onWake: (k, why) => woken.push([k, why]), ...t
  });
  assert.equal(r.action, 'scheduled');
  assert.equal(r.delayMs, 60_000);
  assert.equal(t.scheduled[0].ms, 60_000);
  t.fire(t.scheduled[0]);
  assert.deepEqual(woken, [['group:1', 'timeout']]);
});

check('**远未来**（超过 100 秒）→ 先挂 100 秒的续期定时器，而不是直接睡到底', () => {
  const t = fakeTimers();
  const s = st();
  const r = setupSleepTimer({
    key: 'group:1', st: s, wakeConfig: { infinite: false, sleepUntil: new Date(10_000_000).toISOString() },
    now: () => 0, ...t
  });
  assert.equal(r.action, 'scheduled-long');
  assert.equal(t.scheduled[0].ms, SLEEP_TIMER_MAX_MS, '首段必须是 100 秒量级');
  assert.equal(s.sleepTimer, t.scheduled[0], '定时器句柄要挂在 st 上');
});

check('续期会重新读 wakeConfig（时钟跳变后能纠正）', () => {
  const t = fakeTimers();
  const s = st();
  let now = 0;
  const wc = { infinite: false, sleepUntil: new Date(10_000_000).toISOString() };
  const setup = () => setupSleepTimer({ key: 'group:1', st: s, wakeConfig: wc, now: () => now, ...t });
  setup();
  // 假设时钟突然跳到了快到期的位置
  now = 9_950_000;
  t.fire(t.scheduled[0]);
  // 第二次应该按"还剩 50 秒"挂，而不是又挂 100 秒
  const last = t.scheduled.at(-1);
  assert.equal(last.ms, 50_000, `续期后剩余应按新时间算，实际 ${last.ms}`);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }