// 总览仪表盘聚合（0.4.58）：/api/overview 的纯函数部分。
// 重点测三件事：来源失败时是 unavailable（不是 0）、日志解析可靠、异常区分当前/历史。
import assert from 'node:assert/strict';

const m = await import(new URL('../src/overview-build.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('全部来源可用：8 项都是 ok，且带 at', () => {
  const r = m.buildOverview({
    getMode: () => 'reserved2',
    isDshReady: () => true,
    getOfficialStatus: () => 'connected',
    getTokenSeries: () => ({ totals: { cost: 6.59, turns: 132 }, symbol: '¥' }),
    getConversations: () => [
      { key: 'group:1', unreadCount: 3, longTermCount: 22 },
      { key: 'group:2', unreadCount: 0, longTermCount: 0 },
    ],
    getQuietHours: () => [2, 10],
    readFile: (p) => (String(p).includes('runner')
      ? '{"event":"runner.child_exit","time":"2026-10-31T23:50:41+08:00","exitCode":1}\n{"event":"runner.restart","time":"2026-10-31T23:50:41+08:00","reason":"exitCode=1"}\n'
      : '[2026-10-31T23:50:42+08:00] health 不可用（kind=unreachable）\n'),
    files: { runner: '/x/runner.log', watchdog: '/x/watchdog.log' },
  });
  assert.equal(r.ok, true);
  for (const [k, v] of Object.entries(r.metrics)) {
    assert.equal(v.status, 'ok', `${k} 应为 ok`);
    assert.ok(Number.isFinite(v.at), `${k} 应带 at`);
  }
  assert.equal(r.metrics.unread.value, 3);
  assert.deepEqual(r.metrics.memory.value, { atoms: 22, sessionsWithMemory: 1, sessionsTotal: 2 });
  assert.equal(r.metrics.cost24h.value, 6.59);
});

check('来源失败 → unavailable，且绝不出 0', () => {
  const r = m.buildOverview({
    getMode: () => { throw new Error('boom'); },
    isDshReady: () => undefined,
    getTokenSeries: () => null,
    getConversations: () => undefined,
    getQuietHours: () => '__missing__',
    files: {},
  });
  assert.equal(r.metrics.mode.status, 'unavailable');
  assert.equal(r.metrics.dsh.status, 'unavailable');
  assert.equal(r.metrics.cost24h.status, 'unavailable');
  assert.equal(r.metrics.unread.status, 'unavailable');
  assert.equal(r.metrics.memory.status, 'unavailable');
  assert.equal(r.metrics.quiet.status, 'unavailable');
  assert.equal(r.metrics.supervisor.status, 'unavailable');
  assert.equal(r.metrics.alert.status, 'unavailable');
  // 关键：不能把"读不到"写成 0
  for (const v of Object.values(r.metrics)) {
    assert.notEqual(v.value, 0, '不得用 0 冒充缺失');
  }
});

check('单个来源炸了不拖垮其它', () => {
  const r = m.buildOverview({
    getMode: () => 'bridge',
    isDshReady: () => { throw new Error('dsh boom'); },
    getTokenSeries: () => ({ totals: { cost: 1 }, symbol: '¥' }),
    getConversations: () => [{ key: 'k', unreadCount: 1, longTermCount: 2 }],
    getQuietHours: () => null,
    readFile: () => '',
    files: { runner: 'r', watchdog: 'w' },
  });
  assert.equal(r.metrics.mode.value, 'bridge');
  assert.equal(r.metrics.dsh.status, 'unavailable');
  assert.equal(r.metrics.unread.value, 1);
  assert.equal(r.metrics.quiet.value, null, '未启用应如实给 null，不是 unavailable');
});

check('parseRunnerEvents：取退出码与重启', () => {
  const lines = [
    '{"event":"runner.start","time":"2026-10-31T23:48:41+08:00"}',
    '{"event":"runner.child_exit","time":"2026-10-31T23:50:41+08:00","exitCode":1,"attempt":1}',
    '{"event":"runner.restart","time":"2026-10-31T23:50:41+08:00","reason":"exitCode=1","delayMs":5000}',
    'not json',
  ];
  const ev = m.parseRunnerEvents(lines, Date.parse('2026-10-31T23:55:00+08:00'));
  assert.equal(ev.filter((e) => e.kind === 'exit').length, 1);
  assert.equal(ev.filter((e) => e.kind === 'restart').length, 1);
  assert.equal(ev.find((e) => e.kind === 'exit').code, 1);
});

check('parseWatchdogEvents + 当前/历史区分', () => {
  const now = Date.parse('2026-10-31T23:55:00+08:00');
  const lines = [
    '[2026-10-31T23:50:42+08:00] health 不可用（第 1 次）',
    '[2026-10-30T12:00:00+08:00] 3100 未监听，重启桥接',
    '垃圾行没有时间戳',
  ];
  const ev = m.parseWatchdogEvents(lines);
  assert.equal(ev.length, 2, '无时间戳的行应被丢弃');
  const recent = ev.filter((e) => e.at >= now - 15 * 60 * 1000);
  assert.equal(recent.length, 1, '15 分钟窗口内只有 1 条');
  assert.equal(m.countSince(ev, now - 24 * 3600 * 1000), 1, '24 小时内 1 条');
});

check('脏数据不炸', () => {
  assert.deepEqual(m.parseRunnerEvents(null), []);
  assert.deepEqual(m.parseWatchdogEvents(undefined), []);
  assert.equal(m.countSince(null, 0), 0);
  const r = m.buildOverview({});
  assert.equal(r.ok, true, '空 deps 也要给 ok:true + 全部 unavailable');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
