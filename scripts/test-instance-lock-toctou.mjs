// R49-01（v0.4.49.1）：锁租约 TOCTOU —— 真实双进程 + 确定性屏障。
//
// 竞态序列（独立复核给的准确描述）：
//   1. A 的 heartbeat/release 读到"锁还是我的"
//   2. A 在写入/删除前被暂停
//   3. B 在 A 心跳过期后接管，写入 B 的锁
//   4. A 恢复，按旧状态写/删 → 覆盖/删除 B 的锁
//
// 修复：beat/release 都在 guard 内 + 比对 generation token；
//       guard 回收要求 mtime 超时**且**持有者 pid 已死。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_MOD = new URL('../src/instance-lock.js', import.meta.url).href;
const m = await import(LOCK_MOD);
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-toctou-'));
const waitFor = async (file, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

// 子进程 A：拿锁 → 通知就绪 → 等父进程发号 → 退场（**不释放**，模拟"停顿后仍在持有"）
const CHILD = `
const m = await import(process.env.LOCK_MOD);
const fs = await import('node:fs');
const file = process.env.LOCK_FILE, ready = process.env.LOCK_READY, go = process.env.LOCK_GO;
const lock = m.acquireInstanceLock(file, { instanceId: 'host', pid: process.pid });
fs.writeFileSync(ready, lock.ok ? 'ok' : 'no');
if (!lock.ok) process.exit(1);
const deadline = Date.now() + 10000;
while (!fs.existsSync(go) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
process.exit(0);
`;
const spawnChild = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LOCK_MOD, ...env },
  });
  child.on('close', () => resolve());
});

await check('A 持有 guard 时，B 的认领被拒（不能覆盖活锁）', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const ready = path.join(dir, 'ready');
  const go = path.join(dir, 'go');
  const p = spawnChild({ LOCK_FILE: file, LOCK_READY: ready, LOCK_GO: go });
  assert.ok(await waitFor(ready), '子进程没拿到锁');
  const aLock = m.readLock(file);
  // 父进程模拟"另一个实例"：A 还活着、心跳新鲜 → 必须被拒
  const b = m.acquireInstanceLock(file, { instanceId: 'host', pid: process.pid, killFn: () => true });
  assert.equal(b.ok, false, 'B 覆盖了活锁（旧实现的 TOCTOU）');
  // 锁仍属于 A
  const after = m.readLock(file);
  assert.equal(after.token, aLock.token, '锁被 B 改写了');
  fs.writeFileSync(go, '1');
  await p;
});

await check('generation token：旧 token 不能删新锁', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const a = m.acquireInstanceLock(file, { instanceId: 'host', pid: 1111 });
  assert.equal(a.ok, true);
  fs.writeFileSync(file, JSON.stringify({
    instanceId: 'host', pid: 2222, hostname: 'h', since: Date.now(), beatAt: Date.now(), token: 'B-token',
  }));
  a.release();
  assert.ok(fs.existsSync(file), 'A 的 release 删掉了 B 的锁（token 比对失效）');
  assert.equal(m.readLock(file).token, 'B-token');
});

await check('guard 回收：mtime 超时但持有者活着 → 不强占', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const guard = `${file}.guard`;
  fs.writeFileSync(guard, String(process.pid));
  const old = Date.now() - 60_000;
  fs.utimesSync(guard, new Date(old), new Date(old));
  const r = m.acquireInstanceLock(file, { instanceId: 'host', pid: 3333 });
  assert.equal(r.ok, false, '持有者还活着时不能强占 guard');
  fs.rmSync(guard, { force: true });
});

await check('guard 回收：mtime 超时且持有者已死 → 可回收（不能永久卡死）', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const guard = `${file}.guard`;
  fs.writeFileSync(guard, '999999');
  const old = Date.now() - 60_000;
  fs.utimesSync(guard, new Date(old), new Date(old));
  const r = m.acquireInstanceLock(file, { instanceId: 'host', pid: 3333 });
  assert.equal(r.ok, true, '死持有者的 guard 应可回收');
  r.release?.();
});

await check('A 的心跳在 B 接管后不得覆盖 B 的锁（核心 TOCTOU）', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  // A 拿锁，并人为把心跳改旧 = "A 被冻住了"
  const a = m.acquireInstanceLock(file, { instanceId: 'host', pid: 1111, now: Date.now() });
  assert.equal(a.ok, true);
  const rec = m.readLock(file);
  fs.writeFileSync(file, JSON.stringify({ ...rec, beatAt: Date.now() - 200_000 }));
  // B 接管（A 的 pid 视为已死）
  const b = m.acquireInstanceLock(file, { instanceId: 'host', pid: 2222, killFn: () => false });
  assert.equal(b.ok, true, 'B 应能接管过期锁');
  // A 苏醒，执行心跳 —— 旧实现会用自己的记录覆盖 B
  a.beatNow();
  const after = m.readLock(file);
  assert.equal(after.token, b.token, 'A 的心跳覆盖了 B 的锁（TOCTOU 未修）');
  assert.equal(after.pid, 2222);
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
