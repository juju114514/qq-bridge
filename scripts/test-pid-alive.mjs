// P2-2（v0.4.49）：PID 存活性判定必须区分错误码。
//
// 旧行为：`catch { alive = false }` —— EPERM（无权发信号，但进程存在）
// 会被当成"已退出"，于是删掉别人的锁、自己接管 = 双实例。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/domains/channel-mode-store.js', import.meta.url).href);
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const err = (code) => Object.assign(new Error(code), { code });

await check('classifyKillError：ESRCH → gone', () => {
  assert.equal(m.classifyKillError(err('ESRCH')), 'gone');
});

await check('classifyKillError：EPERM / EACCES / 未知 → alive（保守）', () => {
  assert.equal(m.classifyKillError(err('EPERM')), 'alive');
  assert.equal(m.classifyKillError(err('EACCES')), 'alive');
  assert.equal(m.classifyKillError(new Error('boom')), 'alive');
  assert.equal(m.classifyKillError(undefined), 'alive');
});

await check('isPidAlive：正常返回 true', () => {
  assert.equal(m.isPidAlive(4321, () => true), true);
});

await check('isPidAlive：ESRCH → false；EPERM → true', () => {
  assert.equal(m.isPidAlive(4321, () => { throw err('ESRCH'); }), false);
  assert.equal(m.isPidAlive(4321, () => { throw err('EPERM'); }), true);
});

await check('isPidAlive：非法 pid → false（不调用 kill）', () => {
  let called = 0;
  assert.equal(m.isPidAlive(0, () => { called += 1; return true; }), false);
  assert.equal(m.isPidAlive(NaN, () => { called += 1; return true; }), false);
  assert.equal(m.isPidAlive(-1, () => { called += 1; return true; }), false);
  assert.equal(called, 0);
});

await check('接管语义：持有者 pid 触发 EPERM → 不接管（关键回归）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-pid-'));
  const file = path.join(dir, 'channel-mode.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2, mode: 'bridge', pid: 999999, ownerId: 'other-owner',
    procStart: 0, epoch: 5, status: 'active', at: Date.now(), note: 'other instance',
  }));
  const guard = m.startBridgeChannelGuard({
    fs, path, stateDir: dir, pid: process.pid, log: () => {},
    intervalMs: 60_000, enabled: true,
    killFn: () => { throw err('EPERM'); },
  });
  try {
    assert.equal(guard.ok, false, 'EPERM 时绝不能接管（否则会双实例）');
    assert.ok(fs.existsSync(file), '不能删掉别人的锁文件');
  } finally { try { guard.stop(); } catch { /* ignore */ } }
});

await check('接管语义：持有者 pid 触发 ESRCH → 接管并拿到更大 epoch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-pid2-'));
  const file = path.join(dir, 'channel-mode.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2, mode: 'bridge', pid: 888888, ownerId: 'dead-owner',
    procStart: 0, epoch: 7, status: 'active', at: Date.now(), note: 'dead instance',
  }));
  // epoch 水位是单独的文件（删认领不会回退）：真实场景里它一定在
  fs.writeFileSync(path.join(dir, 'channel-mode-epoch'), JSON.stringify({ schemaVersion: 2, epoch: 7 }));
  const guard = m.startBridgeChannelGuard({
    fs, path, stateDir: dir, pid: process.pid, log: () => {},
    intervalMs: 60_000, enabled: true,
    killFn: () => { throw err('ESRCH'); },
  });
  try {
    assert.equal(guard.ok, true, 'ESRCH 时应能接管');
    assert.ok(guard.epoch > 7, `epoch should increase, got ${guard.epoch}`);
  } finally { try { guard.stop(); } catch { /* ignore */ } }
});

// ── 两份实现（src/pid-alive.js 与 src/domains/channel-mode-store.js）必须一致 ──
// 前者给 instance-lock 用，后者内联给 VM 注入用；漂了就会出现两把锁口径不一致。
await check('行为对照：pid-alive.js 与 channel-mode-store.js 判定一致', async () => {
  const leaf = await import(new URL('../src/pid-alive.js', import.meta.url).href);
  const errs = [err('ESRCH'), err('EPERM'), err('EACCES'), new Error('unknown'), undefined];
  for (const e of errs) {
    assert.equal(leaf.classifyKillError(e), m.classifyKillError(e),
      `classifyKillError 不一致（${e?.code ?? 'unknown'}）`);
  }
  for (const e of errs) {
    const kill = () => { throw e; };
    assert.equal(leaf.isPidAlive(1234, kill), m.isPidAlive(1234, kill), 'isPidAlive 结果不一致');
  }
  assert.equal(leaf.isPidAlive(1234, () => true), m.isPidAlive(1234, () => true));
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
