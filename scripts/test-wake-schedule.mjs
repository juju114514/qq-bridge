// 唤醒排程（src/domains/wake-schedule.js）—— 波次 2 第三块
//
// 这段同时要处理四件事，顺序不能换：
//   总开关/暂停 → 静默时段 → 合并窗口升级原因 → 繁忙暂存 → 真正排程
//
// 三个真实事故：
//   · 合并窗口只看 pendingWakeTimer：漏了会排两个定时器，到点醒两次
//   · 繁忙时丢弃而不是暂存：表现是"被 @ 了却完全没反应"
//   · 不清理 sleepTimer：有限潜水定时器与唤醒定时器同时活着

import assert from 'node:assert/strict';

const { scheduleWake, WAKE_QUEUE_MAX, DEFAULT_BATCH_MS } =
  await import(new URL('../src/domains/wake-schedule.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function fakeTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled, cleared,
    setTimeoutFn: (fn, ms) => { const h = { fn, ms, unref() {} }; scheduled.push(h); return h; },
    clearTimeoutFn: (h) => cleared.push(h),
    fire: (h) => h.fn()
  };
}
const mkState = (over = {}) => ({ pendingWakeTimer: null, pendingWakeReason: null, sleepTimer: null, lastUnreadSeq: 5, wakeConfig: {}, ...over });

check('总开关关 → disabled；暂停 → paused（都不排程）', () => {
  const t = fakeTimers();
  assert.equal(scheduleWake({ key: 'g:1', reason: 'at', enabled: false, getState: () => mkState(), ...t }).action, 'disabled');
  assert.equal(scheduleWake({ key: 'g:1', reason: 'at', paused: true, getState: () => mkState(), ...t }).action, 'paused');
  assert.equal(t.scheduled.length, 0);
});

check('静默时段：只在"自己去搭话"的唤醒上拦', () => {
  const t = fakeTimers();
  const base = {
    key: 'g:1', quietRange: [23, 7], inQuiet: () => true, getState: () => mkState(), ...t,
    silenceWake: (r) => r !== 'atMention'
  };
  assert.equal(scheduleWake({ ...base, reason: 'probability' }).action, 'quiet');
  assert.equal(scheduleWake({ ...base, reason: 'atMention' }).action, 'scheduled', '@ 属于被动唤醒，静默时段也要叫');
});

check('会话不在允许范围 → disallowed', () => {
  const t = fakeTimers();
  const r = scheduleWake({ key: 'g:1', reason: 'at', allowed: () => false, getState: () => mkState(), ...t });
  assert.equal(r.action, 'disallowed');
  assert.equal(t.scheduled.length, 0);
});

check('**合并窗口**：已有待发唤醒时按优先级升级原因，不排第二个定时器', () => {
  const t = fakeTimers();
  const st = mkState({ pendingWakeTimer: { fn() {}, unref() {} }, pendingWakeReason: 'probability' });
  const priority = (r) => ({ atMention: 10, question: 6, probability: 1 }[r] ?? 0);
  const r = scheduleWake({ key: 'g:1', reason: 'atMention', getState: () => st, priorityOf: priority, ...t });
  assert.equal(r.action, 'merged');
  assert.equal(r.upgraded, true);
  assert.equal(st.pendingWakeReason, 'atMention', '原因必须被升级');
  assert.equal(t.scheduled.length, 0, '不能再排一个定时器');
});

check('合并窗口：优先级不高于当前 → 保持原原因', () => {
  const t = fakeTimers();
  const st = mkState({ pendingWakeTimer: { fn() {}, unref() {} }, pendingWakeReason: 'atMention' });
  const priority = (r) => ({ atMention: 10, probability: 1 }[r] ?? 0);
  const r = scheduleWake({ key: 'g:1', reason: 'probability', getState: () => st, priorityOf: priority, ...t });
  assert.equal(r.action, 'merged');
  assert.equal(r.upgraded, false);
  assert.equal(st.pendingWakeReason, 'atMention');
});

check('**会话繁忙**：暂存原因（不丢），并去重', () => {
  const t = fakeTimers();
  const st = mkState();
  const opts = { key: 'g:1', reason: 'atMention', isBusy: () => true, getState: () => st, ...t };
  assert.equal(scheduleWake(opts).action, 'busy');
  assert.equal(scheduleWake(opts).action, 'busy', '同一 reason+seq 重复不该堆两条');
  assert.equal(st.pendingWakeReasons.length, 1);
  assert.equal(st.pendingWakeReasons[0].reason, 'atMention');
  assert.equal(st.pendingWakeReasons[0].seq, 5);
  assert.equal(t.scheduled.length, 0);
});

check('繁忙暂存队列有界（最多 20 条）', () => {
  const t = fakeTimers();
  const st = mkState();
  for (let i = 1; i <= 30; i += 1) {
    st.lastUnreadSeq = i;
    scheduleWake({ key: 'g:1', reason: 'k' + i, isBusy: () => true, getState: () => st, ...t });
  }
  assert.equal(st.pendingWakeReasons.length, WAKE_QUEUE_MAX);
  assert.equal(st.pendingWakeReasons.at(-1).reason, 'k30', '保留最新的');
});

check('正常排程：清 sleepTimer + 取消回复检查 + 到点用最终原因唤醒', () => {
  const t = fakeTimers();
  const fired = [];
  const cancelled = [];
  const st = mkState({ sleepTimer: { fn() {}, unref() {} } });
  const r = scheduleWake({
    key: 'g:1', reason: 'question', getState: () => st,
    cancelReplyCheck: (k) => cancelled.push(k),
    onFire: (k, why) => fired.push([k, why]),
    ...t
  });
  assert.equal(r.action, 'scheduled');
  assert.equal(r.delayMs, DEFAULT_BATCH_MS);
  assert.deepEqual(cancelled, ['g:1'], '必须取消普通回复检查');
  assert.equal(st.sleepTimer, null, '睡眠定时器必须清掉');
  t.fire(t.scheduled[0]);
  assert.deepEqual(fired, [['g:1', 'question']]);
  assert.equal(st.pendingWakeTimer, null, '触发后句柄要清空');
});

check('batchWindowMs 生效，且有下限 1000ms', () => {
  const t = fakeTimers();
  const mk = (batch) => scheduleWake({ key: 'g:1', reason: 'at', getState: () => mkState({ wakeConfig: { batchWindowMs: batch } }), ...t });
  assert.equal(mk(3000).delayMs, 3000);
  assert.equal(mk(10).delayMs, 1000, '太小要抬到 1 秒');
  assert.equal(mk('x').delayMs, DEFAULT_BATCH_MS, '非法值回落默认');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }