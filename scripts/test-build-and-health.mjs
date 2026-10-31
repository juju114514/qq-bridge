// 0.4.41：buildId / ownerId / 健康状态聚合。
//
// 验收（对应外部评审的四条）：
//   ① 相同代码不同 Git HEAD → buildId 相同
//   ② 不同运行代码相同 Git HEAD → buildId 不同
//   ③ PID 相同但 ownerId 不同 → 旧进程不能继续持有
//   ④ DSH 断开/恢复 → 健康状态 connected → reconnecting → connected
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildIdMod = await import(new URL('../src/build-id.js', import.meta.url).href);
const healthMod = await import(new URL('../src/health-state.js', import.meta.url).href);
const modeMod = await import(new URL('../src/domains/channel-mode.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

/** 复制运行时清单里的文件到临时目录，模拟"另一个部署"。 */
function cloneRuntime(withGitHead) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildid-'));
  for (const rel of buildIdMod.collectRuntimeFiles(root)) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dst);
  }
  if (withGitHead) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
  }
  return dir;
}

const base = buildIdMod.computeBuildId(root);

// ① 同内容不同 git HEAD
check('① 相同代码、不同 Git HEAD → buildId 相同', () => {
  const a = cloneRuntime(false);
  const b = cloneRuntime(true); // 带一个假的 HEAD
  const ra = buildIdMod.computeBuildId(a);
  const rb = buildIdMod.computeBuildId(b);
  assert.equal(ra.buildId, rb.buildId, 'buildId 不该受 git HEAD 影响');
  assert.equal(ra.buildId, base.buildId, '同内容应等于仓库自身');
  // sourceCommit 仍然各自可追溯（一个空、一个有值）
  assert.notEqual(buildIdMod.readSourceCommit(a), buildIdMod.readSourceCommit(b));
});

// ② 改运行代码 → buildId 变
check('② 只改运行代码（同 HEAD）→ buildId 变化', () => {
  const dir = cloneRuntime(true);
  const before = buildIdMod.computeBuildId(dir).buildId;
  const target = path.join(dir, 'src', 'build-id.js');
  fs.appendFileSync(target, '\n// runtime change\n');
  const after = buildIdMod.computeBuildId(dir).buildId;
  assert.notEqual(before, after, '改了运行代码 buildId 却没变');
});

// ②-b 改文档 → buildId 不变
check('②-b 只改文档 → buildId 不变', () => {
  const dir = cloneRuntime(false);
  const before = buildIdMod.computeBuildId(dir).buildId;
  fs.writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  const after = buildIdMod.computeBuildId(dir).buildId;
  assert.equal(before, after, '文档不该进入运行时清单');
});

// ②-c skip 非运行时目录（state/logs/node_modules）
check('②-c state/ 与 node_modules 不进 buildId', () => {
  const dir = cloneRuntime(false);
  const before = buildIdMod.computeBuildId(dir).buildId;
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'bridge.log'), 'noise');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'noise');
  assert.equal(buildIdMod.computeBuildId(dir).buildId, before);
});

// ③ PID 相同但 ownerId 不同
check('③ 同一 PID、不同 ownerId → 旧进程不能继续持有（epoch 递增）', () => {
  const now = Date.now();
  const current = { schemaVersion: 2, mode: 'bridge', pid: 4242, ownerId: 'old-owner', procStart: now - 1000, epoch: 7, status: 'active', at: now };
  // 旧进程 heartbeat / release：ownerId 不匹配 → 不认
  assert.equal(modeMod.shouldRelease(current, { mode: 'bridge', pid: 4242, ownerId: 'new-owner' }), false);
  assert.equal(modeMod.shouldRelease(current, { mode: 'bridge', pid: 4242, ownerId: 'old-owner' }), true);
  // 新进程 claim：同 pid 但 ownerId 不同 → 新持有者，epoch +1
  const r = modeMod.claimMode({ current, mode: 'bridge', pid: 4242, ownerId: 'new-owner', procStart: now });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'pid-reused');
  assert.equal(r.record.epoch, 8, `epoch 应递增到 8，实际 ${r.record.epoch}`);
  assert.equal(r.record.ownerId, 'new-owner');
});

// ③-b v1 记录（无 ownerId）不能因字段缺失被当成死亡
check('③-b schemaVersion 1 记录可平滑续期（不误判死亡）', () => {
  const now = Date.now();
  const legacy = { mode: 'bridge', pid: 4243, epoch: 3, at: now };
  const r = modeMod.claimMode({ current: legacy, mode: 'bridge', pid: 4243, ownerId: 'fresh', procStart: now });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'refresh');
  assert.equal(r.record.epoch, 3, 'v1 续期不该改 epoch');
  assert.equal(r.record.ownerId, 'fresh', '续期应补上 ownerId');
});

// ④ 健康状态随事件变化
check('④ DSH 断开/恢复：connected → reconnecting → connected，ready 跟随', () => {
  const h = healthMod.createHealthState({ version: 'x', buildId: 'sha256:abc', ownerId: 'me', pid: 1 });
  h.setChannel({ mode: 'bridge', epoch: 2, status: 'active' });
  h.set('snowluma', 'connected');
  h.set('dsh', 'connected');
  assert.equal(h.snapshot().ready, true, '全连接时应 ready');
  h.set('dsh', 'reconnecting', 'ws-close');
  const mid = h.snapshot();
  assert.equal(mid.services.dsh, 'reconnecting');
  assert.equal(mid.ready, false, 'DSH 重连中不该 ready');
  assert.equal(mid.live, true, '但进程还活着');
  h.set('dsh', 'connected');
  assert.equal(h.snapshot().ready, true, '恢复后应重新 ready');
});

// ④-b 通道被别人持有时 ready=false，但服务可以 connected
check('④-b 通道未持有 → ready=false（连接状态与所有权分离）', () => {
  const h = healthMod.createHealthState({ version: 'x', buildId: '', ownerId: 'me', pid: 1 });
  h.set('snowluma', 'connected');
  h.set('dsh', 'connected');
  h.setChannel({ mode: null, epoch: null, status: 'starting' });
  const s = h.snapshot();
  assert.equal(s.services.dsh, 'connected');
  assert.equal(s.ready, false, '没有通道所有权就不能 ready');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
