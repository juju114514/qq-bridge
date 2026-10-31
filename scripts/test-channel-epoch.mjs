// epoch（fencing token）测试：0.4.39。
//
// 目标不是"文件里数字变大"，而是「旧持有者的任务永远不能再产生副作用」。
// 五条主测 + 两条副作用边界（记忆写入 / 工具执行）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(new URL('../src/domains/channel-mode-store.js', import.meta.url).href);
const { StaleEpochError } = mod;

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const mkStore = (dir, ttlMs) => mod.createChannelModeStore({ fs, path, stateDir: dir, ttlMs });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-'));

/** 模拟一次「带着 epoch 的任务」：副作用前校验，失败即中止。 */
function runTask(store, { mode, epoch }, sideEffect) {
  try {
    store.assertCurrent({ mode, epoch });
    sideEffect();
    return { ok: true };
  } catch (error) {
    if (error instanceof StaleEpochError) return { ok: false, stale: true, code: error.code };
    throw error;
  }
}

// ① 旧消息排队后切换模式 → 旧任务不能继续推进
await check('① 旧 epoch 任务在模式切换后被拒绝', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  const first = s.claim('bridge', { pid: process.pid });
  assert.ok(first.ok);
  const taskEpoch = first.record.epoch;
  // 模拟"切换"：释放 + 插件拿所有权
  s.release('bridge', { pid: process.pid });
  const second = s.claim('plugin', { pid: process.pid });
  assert.ok(second.ok, '切换后插件应该能拿到');
  const r = runTask(s, { mode: 'bridge', epoch: taskEpoch }, () => { throw new Error('不该执行'); });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STALE_EPOCH');
});

// ② DSH 提交前拦截：请求次数必须为 0
await check('② 旧 epoch 任务不会提交 DSH 请求（次数=0）', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  const claim = s.claim('bridge', { pid: process.pid });
  const taskEpoch = claim.record.epoch;
  s.release('bridge', { pid: process.pid });
  s.claim('plugin', { pid: process.pid + 1 });
  let submits = 0;
  runTask(s, { mode: 'bridge', epoch: taskEpoch }, () => { submits += 1; });
  assert.equal(submits, 0, '旧任务居然提交了 DSH 请求');
});

// ③ QQ 发送前拦截：发送次数必须为 0
await check('③ 旧 epoch 任务不会发出 QQ 消息（次数=0）', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  const claim = s.claim('bridge', { pid: process.pid });
  const taskEpoch = claim.record.epoch;
  s.release('bridge', { pid: process.pid });
  s.claim('plugin', { pid: process.pid + 1 });
  let sends = 0;
  runTask(s, { mode: 'bridge', epoch: taskEpoch }, () => { sends += 1; });
  assert.equal(sends, 0, '旧任务居然发出了 QQ 消息');
});

// ④ 崩溃重启：旧 epoch 不复活
await check('④ 进程崩溃重启后，旧 epoch 不能重新有效', async () => {
  const dir = tmpDir();
  const s1 = mkStore(dir);
  const claim = s1.claim('bridge', { pid: 999999 });
  const deadEpoch = claim.record.epoch;
  // 模拟崩溃：不调用 release，直接起新实例（会在 TTL 内被判 other-active，但接管路径会删认领）
  const s2 = mkStore(dir);
  const takeover = s2.claim('bridge', { pid: process.pid });
  if (!takeover.ok) {
    // 还没过期 → 走 guard 的死持有者接管（删认领再抢）
    fs.rmSync(path.join(dir, 'channel-mode.json'), { force: true });
  }
  const fresh = s2.claim('bridge', { pid: process.pid });
  assert.ok(fresh.ok, '新实例应该能拿到');
  assert.ok(fresh.record.epoch > deadEpoch,
    `新 epoch 必须严格大于旧的（${fresh.record.epoch} vs ${deadEpoch}）—— 否则旧任务会复活`);
  const r = runTask(s2, { mode: 'bridge', epoch: deadEpoch }, () => { throw new Error('不该执行'); });
  assert.equal(r.ok, false, '旧 epoch 居然在新实例里有效');
});

// ⑤ 并发切换：只有一个有效 owner，epoch 不倒退
await check('⑤ 并发认领：只有一个赢家，epoch 单调递增', async () => {
  const dir = tmpDir();
  const script = path.join(dir, 'claimer.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
const mod = await import(${JSON.stringify(new URL('../src/domains/channel-mode-store.js', import.meta.url).href)});
const store = mod.createChannelModeStore({ fs, path, stateDir: process.argv[2] });
const r = store.claim('bridge', { pid: process.pid });
fs.writeFileSync(process.argv[3], JSON.stringify({ ok: r.ok, epoch: r.record?.epoch ?? null, reason: r.reason ?? null }));
`, 'utf8');
  const results = [];
  const runs = [];
  for (let i = 0; i < 4; i += 1) {
    const out = path.join(dir, `r${i}.json`);
    runs.push(new Promise((resolve) => {
      const child = spawnSync(process.execPath, [script, dir, out], { stdio: 'ignore', timeout: 20_000 });
      void child;
      try { results.push(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch { results.push({ ok: false, epoch: null }); }
      resolve();
    }));
  }
  await Promise.all(runs);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `应该有且只有一个赢家，实际 ${winners.length}（${JSON.stringify(results)}）`);
  const epochs = results.map((r) => r.epoch).filter((e) => Number.isFinite(e));
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'channel-mode.json'), 'utf8'));
  assert.ok(Number(state.epoch) >= Math.max(...epochs, state.epoch), 'epoch 倒退了');
});

// ⑥ 记忆写入前拦截（副作用边界，不能只靠 DSH/QQ 两端代表）
await check('⑥ 旧 epoch 任务不会写入记忆', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  const claim = s.claim('bridge', { pid: process.pid });
  const taskEpoch = claim.record.epoch;
  s.release('bridge', { pid: process.pid });
  s.claim('plugin', { pid: process.pid + 1 });
  const memoryFile = path.join(dir, 'memory.md');
  runTask(s, { mode: 'bridge', epoch: taskEpoch }, () => fs.writeFileSync(memoryFile, '被污染'));
  assert.equal(fs.existsSync(memoryFile), false, '旧任务污染了记忆');
});

// ⑦ 工具执行前拦截
await check('⑦ 旧 epoch 任务不会执行工具', async () => {
  const dir = tmpDir();
  const s = mkStore(dir);
  const claim = s.claim('bridge', { pid: process.pid });
  const taskEpoch = claim.record.epoch;
  s.release('bridge', { pid: process.pid });
  s.claim('plugin', { pid: process.pid + 1 });
  let toolCalls = 0;
  runTask(s, { mode: 'bridge', epoch: taskEpoch }, () => { toolCalls += 1; });
  assert.equal(toolCalls, 0, '旧任务执行了工具');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
