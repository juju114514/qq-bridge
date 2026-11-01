// 访问守卫（0.4.110）：限流 / 审计 / 哈希 / 回环判定
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/access-guard.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const T0 = Date.parse('2026-11-02T00:10:00+08:00');

check('限流：窗口内前 N 次放行，第 N+1 次拒绝并给出等待时间', () => {
  const rl = m.createRateLimiter({ windowMs: 60000, max: 3 });
  assert.equal(rl.hit('1.2.3.4', T0).ok, true);
  assert.equal(rl.hit('1.2.3.4', T0).ok, true);
  assert.equal(rl.hit('1.2.3.4', T0).ok, true);
  const blocked = rl.hit('1.2.3.4', T0);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60000);
});

check('限流：不同来源互不影响；窗口过期后恢复', () => {
  const rl = m.createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(rl.hit('a', T0).ok, true);
  assert.equal(rl.hit('a', T0).ok, false);
  assert.equal(rl.hit('b', T0).ok, true, '另一个 IP 不该被连坐');
  assert.equal(rl.hit('a', T0 + 1500).ok, true, '窗口过了应恢复');
});

check('限流：peek 不计数', () => {
  const rl = m.createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(rl.peek('x', T0).count, 0);
  rl.hit('x', T0);
  assert.equal(rl.peek('x', T0).count, 1);
  assert.equal(rl.peek('x', T0).count, 1, 'peek 不该把计数推上去');
});

check('审计：写入后能按时间顺序读回，且自动裁剪', () => {
  const file = path.join(os.tmpdir(), `acc-${process.pid}-${Date.now()}.jsonl`);
  const log = m.createAccessLog({ file, maxLines: 3 });
  for (let i = 0; i < 5; i++) {
    log.record({ ip: '192.168.1.9', method: 'GET', path: '/api/status', ok: i !== 4, reason: i === 4 ? 'unauthorized' : undefined });
  }
  const rows = log.tail(10);
  assert.equal(rows.length, 3, 'maxLines=3 只保留最近 3 条');
  assert.equal(rows[2].reason, 'unauthorized');
  assert.equal(rows[0].ip, '192.168.1.9');
  fs.rmSync(file, { force: true });
});

check('审计：文件不存在时不抛，返回空', () => {
  const file = path.join(os.tmpdir(), `acc-none-${Date.now()}.jsonl`);
  const log = m.createAccessLog({ file });
  assert.deepEqual(log.tail(5), []);
});

check('sha256：null 当空串、Buffer 与字符串结果一致', () => {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(m.sha256Hex(null), empty);
  assert.equal(m.sha256Hex(''), empty);
  assert.equal(m.sha256Hex(Buffer.from('abc')), m.sha256Hex('abc'));
  assert.equal(m.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

check('回环判定：127.x / ::1 算本机，局域网 IP 不算', () => {
  assert.equal(m.isLoopback('127.0.0.1'), true);
  assert.equal(m.isLoopback('::1'), true);
  assert.equal(m.isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(m.isLoopback('192.168.1.2'), false);
  assert.equal(m.isLoopback('100.101.102.103'), false);
  assert.equal(m.isLoopback(''), false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
