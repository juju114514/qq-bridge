// 0.4.42：启动摘要（boot-report）。
//   · summary 只打一次
//   · 中途失败也留证（startup.incomplete）
//   · 摘要里不出现凭证
import assert from 'node:assert/strict';

const mod = await import(new URL('../src/boot-report.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const collect = () => {
  const lines = [];
  const r = mod.createBootReport({ log: (m) => lines.push(m) });
  return { r, lines, parsed: () => lines.map((l) => { try { return JSON.parse(l.replace(/^[^{]*/, '')); } catch { return null; } }).filter(Boolean) };
};

check('summary 打一次并包含关键字段', () => {
  const { r, parsed } = collect();
  r.setMeta({ version: '0.4.42', buildId: 'sha256:abc', sourceCommit: 'deadbeef' });
  r.begin('channel-claim'); r.end('channel-claim', 'ok');
  r.summary({ ready: true, channel: { mode: 'bridge', epoch: 3 } });
  const ev = parsed();
  assert.equal(ev.length, 1);
  const s = ev[0];
  assert.equal(s.event, 'startup.summary');
  assert.equal(s.version, '0.4.42');
  assert.equal(s.buildId, 'sha256:abc');
  assert.ok(s.stages.some((x) => x.name === 'channel-claim'));
});

check('summary 只打一次（重复调用不会刷屏）', () => {
  const { r, parsed } = collect();
  r.summary({ ready: false });
  r.summary({ ready: true });
  assert.equal(parsed().length, 1);
});

check('启动中途失败也留证（startup.incomplete + 未完成阶段标 aborted）', () => {
  const { r, parsed } = collect();
  r.begin('dsh-connect');
  r.incomplete('ECONNREFUSED');
  const ev = parsed();
  assert.equal(ev[0].event, 'startup.incomplete');
  assert.match(ev[0].reason, /ECONNREFUSED/);
  assert.ok(ev[0].stages.some((x) => x.name === 'dsh-connect' && x.status === 'aborted'));
});

check('摘要里不出现凭证形态字符串', () => {
  const { r, lines } = collect();
  r.setMeta({ version: 'x', buildId: 'sha256:abc', sourceCommit: 'abc' });
  r.summary({ ready: true });
  const text = lines.join('\n');
  // 32 位以上 hex / 明显 token 形态：buildId 是 sha256: 前缀的十六进制，允许；其余不允许
  const stripped = text.replace(/sha256:[0-9a-f]{64}/g, '');
  assert.ok(!/[0-9a-f]{32,}/i.test(stripped), '摘要里出现了长 hex 串（可能是凭证）');
  assert.ok(!/secret|token|password|cookie/i.test(text), '摘要里出现了凭证字段名');
});

check('shutdown.summary 单独成事件', () => {
  const { r, parsed } = collect();
  r.shutdown({ signal: 'SIGTERM' });
  assert.equal(parsed()[0].event, 'shutdown.summary');
  assert.equal(parsed()[0].signal, 'SIGTERM');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
