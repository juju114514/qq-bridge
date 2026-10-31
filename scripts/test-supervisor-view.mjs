// 守护视图（0.4.62）：存活用进程信息，历史用日志；两者矛盾必须显式提示。
import assert from 'node:assert/strict';

const m = await import(new URL('../src/supervisor-view.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const now = Date.parse('2026-11-01T00:30:00+08:00');
const exit = (at, code = 1) => ({ kind: 'exit', at, code, attempt: 1 });
const restart = (at, reason = 'exitCode=1') => ({ kind: 'restart', at, reason, delayMs: 5000 });

check('存活判定只看进程信息，不看日志', () => {
  const v = m.buildSupervisorView({ processInfo: { pid: 123, uptimeMs: 60000, ready: true }, runnerEvents: [], watchdogEvents: [], now });
  assert.equal(v.alive, true);
  assert.equal(v.authority, 'process');
  const v2 = m.buildSupervisorView({ processInfo: null, runnerEvents: [restart(now - 1000)], watchdogEvents: [], now });
  assert.equal(v2.alive, false, '没有进程信息时不能因为"日志有重启"就认为活着');
});

check('24 小时窗口内的重启/退出计数', () => {
  const v = m.buildSupervisorView({
    processInfo: { pid: 1, uptimeMs: 1000 },
    runnerEvents: [exit(now - 2 * 3600 * 1000), restart(now - 2 * 3600 * 1000 + 5000), exit(now - 30 * 3600 * 1000)],
    watchdogEvents: [{ at: now - 3600 * 1000, text: '健康不可用' }, { at: now - 30 * 3600 * 1000, text: '旧事件' }],
    now,
  });
  assert.equal(v.restarts24h, 1);
  assert.equal(v.exits24h, 1, '36 小时前的退出不计入');
  assert.equal(v.watchdog24h, 1);
  assert.equal(v.lastExit.code, 1);
});

check('事件合并：两类来源按时间倒序', () => {
  const v = m.buildSupervisorView({
    processInfo: { pid: 1, uptimeMs: 1000 },
    runnerEvents: [{ kind: 'start', at: now - 3000 }, restart(now - 2000)],
    watchdogEvents: [{ at: now - 1000, text: '健康恢复' }],
    now,
  });
  assert.deepEqual(v.events.map((e) => e.source), ['watchdog', 'runner', 'runner']);
  assert.ok(v.events[0].at > v.events[1].at);
});

check('矛盾检测：日志里的重启晚于当前进程启动', () => {
  // 进程已经活了 10 分钟，但日志说 1 分钟前才重启过 → 对不上
  const v = m.buildSupervisorView({
    processInfo: { pid: 1, uptimeMs: 10 * 60 * 1000 },
    runnerEvents: [restart(now - 60 * 1000)],
    watchdogEvents: [],
    now,
  });
  assert.equal(v.conflicts.length, 1, '应报冲突');
  assert.match(v.conflicts[0], /当前进程启动之后/);
});

check('无矛盾时不乱报', () => {
  const v = m.buildSupervisorView({
    processInfo: { pid: 1, uptimeMs: 60 * 60 * 1000 },
    runnerEvents: [restart(now - 2 * 60 * 60 * 1000)],
    watchdogEvents: [{ at: now - 10 * 60 * 1000, text: '健康恢复' }],
    now,
  });
  assert.deepEqual(v.conflicts, []);
});

check('脏数据不炸', () => {
  const v = m.buildSupervisorView({ processInfo: null, runnerEvents: null, watchdogEvents: undefined, now });
  assert.equal(v.ok, true);
  assert.equal(v.alive, false);
  assert.deepEqual(v.events, []);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
