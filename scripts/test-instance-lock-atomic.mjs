// P2-3（v0.4.49）：instance-lock 必须原子认领，且同实例不同 PID 不得覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const m = await import(new URL('../src/instance-lock.js', import.meta.url).href);
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-lock-'));
const write = (file, info) => fs.writeFileSync(file, JSON.stringify(info));

await check('无锁时可获取；重复获取同一 PID 幂等成功', () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = m.acquireInstanceLock(file, { instanceId: 'host', pid: 1111, now: 1_000_000 });
  assert.equal(a.ok, true);
  const b = m.acquireInstanceLock(file, { instanceId: 'host', pid: 1111, now: 1_000_001 });
  assert.equal(b.ok, true, '同一进程重复认领应成功');
  a.release?.(); b.release?.();
});

await check('活锁 + 不同 instanceId → 拒绝', () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  write(file, { instanceId: 'host', pid: 2222, hostname: 'h', since: 1, beatAt: 1_000_000 });
  const r = m.acquireInstanceLock(file, { instanceId: 'docker', pid: 3333, now: 1_000_500 });
  assert.equal(r.ok, false);
  r.release?.();
});

await check('活锁 + 同 instanceId 不同 PID → 拒绝（审查指出的覆盖窗口）', () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  write(file, { instanceId: 'host', pid: 2222, hostname: 'h', since: 1, beatAt: 1_000_000 });
  // killFn 返回 true = 模拟"老进程还活着"
  const r = m.acquireInstanceLock(file, { instanceId: 'host', pid: 3333, now: 1_000_500, killFn: () => true });
  assert.equal(r.ok, false, '同实例换 PID 不能直接覆盖对战锁');
  r.release?.();
});

await check('过期锁（beatAt 太旧）→ 可接管', () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  write(file, { instanceId: 'other', pid: 4444, hostname: 'h', since: 1, beatAt: 1_000_000 });
  const r = m.acquireInstanceLock(file, { instanceId: 'host', pid: 3333, now: 1_000_000 + 120_000 });
  assert.equal(r.ok, true, '超过 staleMs 应允许接管');
  r.release?.();
});

await check('残留 guard 文件不会永久卡死（>5s 视为残留）', () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const guard = `${file}.guard`;
  fs.writeFileSync(guard, '999');
  const old = Date.now() - 60_000;
  fs.utimesSync(guard, new Date(old), new Date(old));
  const r = m.acquireInstanceLock(file, { instanceId: 'host', pid: 3333 });
  assert.equal(r.ok, true, '残留 guard 应被强占，不能永久阻塞');
  r.release?.();
});

await check('并发子进程：最多一个拿到锁', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const script = `
    const m = await import(${JSON.stringify(new URL('../src/instance-lock.js', import.meta.url).href)});
    // 用**真实** pid（子进程自己）：否则 isPidAlive 判死，每个都会"接管"
    const r = m.acquireInstanceLock(${JSON.stringify(file)}, { instanceId: 'host', pid: process.pid });
    process.stdout.write(r.ok ? 'OK' : 'NO');
    setTimeout(() => process.exit(0), 150);
  `;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out.trim()));
  });
  const results = await Promise.all([run(), run(), run()]);
  const okCount = results.filter((r) => r === 'OK').length;
  assert.equal(okCount, 1, `应恰好一个成功，实际 ${okCount}（${results.join(',')}）`);
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
