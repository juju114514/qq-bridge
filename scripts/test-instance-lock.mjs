// 实例锁（0.4.49.3 起 = 回环端口互斥）基础行为。
//
// 真机上桥接可能在跑，所以每个用例用**自己的一次性端口**，不用派生端口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/instance-lock.js', import.meta.url).href);
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-lock-'));
const BASE = 34500 + (process.pid % 300);
let seq = 0;
const port = () => BASE + (++seq);

await check('第一次抢锁成功，状态文件写入 instanceId/pid/hostname', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const r = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 111, port: port() });
  assert.equal(r.ok, true);
  const rec = m.readLock(file);
  assert.equal(rec.instanceId, 'host');
  assert.equal(rec.pid, 111);
  assert.ok(rec.hostname);
  assert.ok(rec.token);
  await r.release();
});

await check('同一 instanceId 的第二个进程抢锁失败，并告知持有者信息', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const p = port();
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 111, port: p });
  assert.equal(a.ok, true, '第一个应成功');
  const b = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 222, port: p });
  assert.equal(b.ok, false, '同一 bot 的第二个实例必须被拒');
  assert.ok(b.holder, '应能读到持有者诊断信息');
  assert.equal(b.reason, 'held');
  await a.release();
});

await check('不同 instanceId 默认派生不同端口 → 可以并存（多 bot 同机）', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'bot-a', pid: 111 });
  const b = await m.acquireInstanceLock(file, { instanceId: 'bot-b', pid: 222 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, '不同 bot 应各有各的端口');
  assert.notEqual(a.stats().port, b.stats().port);
  await a.release();
  await b.release();
});

await check('心跳更新 beatAt（只影响诊断文件）', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 111, port: port() });
  const before = m.readLock(file).beatAt;
  a.beatNow();
  assert.ok(m.readLock(file).beatAt >= before);
  await a.release();
});

await check('释放后文件被清理，端口可再次获取', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const p = port();
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 111, port: p });
  await a.release();
  assert.equal(fs.existsSync(file), false);
  const b = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 222, port: p });
  assert.equal(b.ok, true);
  await b.release();
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
