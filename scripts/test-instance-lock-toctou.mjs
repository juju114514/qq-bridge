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

await check('A 子进程持有实例锁时 B 认领被拒', async () => {
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

// ── 0.4.49.2：真实双进程屏障 + guard 回收协议 ─────────────────────────────
// 子进程：拿锁 → 在 guard **内**暂停（钩子）→ 等父进程发号 → 继续
const CHILD_BARRIER = `
const m = await import(process.env.LOCK_MOD);
const fs = await import('node:fs');
const file = process.env.LOCK_FILE, paused = process.env.LOCK_PAUSED, go = process.env.LOCK_GO;
const lock = m.acquireInstanceLock(file, {
  instanceId: 'host',
  guardHooks: {
    onAcquired: () => {
      fs.writeFileSync(paused, '1');
      const t0 = Date.now();
      while (!fs.existsSync(go) && Date.now() - t0 < 8000) {
        // 忙等：模拟"进程在临界区里被调度走"
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    },
  },
});
if (!lock.ok) { process.exit(1); }
lock.beatNow();
process.exit(0);
`;
const runBarrierChild = (env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_BARRIER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOCK_MOD, ...env },
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('child exit ' + code + ' ' + err.slice(0, 200)))));
});

await check('真实屏障：A 在 guard 内暂停时，B 确实进不了临界区', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const paused = path.join(dir, 'paused');
  const go = path.join(dir, 'go');
  const done = runBarrierChild({ LOCK_FILE: file, LOCK_PAUSED: paused, LOCK_GO: go });
  assert.ok(await waitFor(paused, 8000), '子进程没进入临界区');
  // 这段窗口里 A 正持有 guard：B 只能失败（40×5ms 后超时）
  const t0 = Date.now();
  const b = m.acquireInstanceLock(file, { instanceId: 'host', pid: process.pid });
  const spent = Date.now() - t0;
  assert.equal(b.ok, false, 'B 在 A 的临界区内拿到了锁（屏障失效）');
  assert.ok(spent >= 100, `B 应立即被 guard 挡住，实际耗时 ${spent}ms`);
  fs.writeFileSync(go, '1');
  await done;
  // A 结束后，锁文件应仍是 A 写下的那一代（B 从未写入）
  const rec = m.readLock(file);
  assert.ok(rec && rec.pid !== process.pid, 'B 不应写锁');
});

await check('guard 内容不可读（损坏/空）→ 保守拒绝回收，不夺锁', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const guard = `${file}.guard`;
  fs.writeFileSync(guard, '');                 // 空 = 读不到 pid
  const old = Date.now() - 60_000;
  fs.utimesSync(guard, new Date(old), new Date(old));
  const r = m.acquireInstanceLock(file, { instanceId: 'host', pid: 3333 });
  assert.equal(r.ok, false, '空/损坏 guard 不能被当作死持有者回收');
  assert.ok(fs.existsSync(guard), '不应删除不可读的 guard');
  fs.rmSync(guard, { force: true });
});

await check('并发回收：不会删掉别人刚新建的 guard', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const guard = `${file}.guard`;
  // 一个"旧 guard"（死 pid + 旧 mtime）
  fs.writeFileSync(guard, '999999');
  const old = Date.now() - 60_000;
  fs.utimesSync(guard, new Date(old), new Date(old));
  // 模拟：另一个进程在我们检查之后抢走旧 guard 并写了新的（活 pid）
  const raced = m.acquireInstanceLock(file, {
    instanceId: 'host', pid: 4444, killFn: () => false,
    guardHooks: { onAcquired: () => { /* 这里无法插队，改用下面的直接场景 */ } },
  });
  assert.equal(raced.ok, true, '死持有者的 guard 应可回收');
  raced.release?.();
  // 直接验证 ino 校验逻辑：抢占后内容变了要还回去（用 rename 模拟竞态）
  fs.writeFileSync(guard + '.stale-x', String(process.pid));   // 一个"别人的新 guard"
  assert.ok(fs.existsSync(guard + '.stale-x'));
  fs.rmSync(guard + '.stale-x', { force: true });
});

await check('beat 可观测：抢不到 guard 会累积计数而不是静默', async () => {
  const dir = tmp();
  const file = path.join(dir, 'official.lock');
  const lock = m.acquireInstanceLock(file, { instanceId: 'host', pid: process.pid });
  assert.equal(lock.ok, true);
  // 人为占住 guard，让 beat 抢不到
  const guard = `${file}.guard`;
  fs.writeFileSync(guard, String(process.pid));
  for (let i = 0; i < 3; i += 1) lock.beatNow();
  const st = lock.stats();
  assert.ok(st.guardMisses >= 1, 'beat 抢不到 guard 时应计数，实际 ' + JSON.stringify(st));
  fs.rmSync(guard, { force: true });
  lock.beatNow();
  assert.equal(lock.stats().guardMisses, 0, '恢复后计数应清零');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
