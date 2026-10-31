// 通道模式闸的落盘测试：认领 / 心跳 / 拒绝 / 释放 / 抢占过期。
// 用临时目录，不碰真实 state。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'src', 'domains', 'channel-mode-store.js')).href);

const results = [];
const check = (n, f) => { try { f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chanmode-'));
const mk = () => mod.createChannelModeStore({ fs, path, stateDir: tmp });

check('首次认领成功，文件落盘', () => {
  const s = mk();
  const r = s.claim('bridge', { pid: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'free');
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'channel-mode.json'), 'utf8'));
  assert.equal(onDisk.mode, 'bridge');
  assert.equal(onDisk.pid, 100);
});

check('同 pid 心跳续期；别人不能续期', () => {
  const s = mk();
  const before = JSON.parse(fs.readFileSync(path.join(tmp, 'channel-mode.json'), 'utf8')).at;
  assert.equal(s.heartbeat('bridge', { pid: 100 }), true);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'channel-mode.json'), 'utf8')).at;
  assert.ok(after >= before);
  assert.equal(s.heartbeat('bridge', { pid: 200 }), false);
});

check('不同 mode 抢 → 拒绝并给出持有者', () => {
  const s = mk();
  const r = s.claim('plugin', { pid: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'other-active');
  assert.equal(r.holder.mode, 'bridge');
});

check('release：非持有者不能释放；持有者释放后状态是 released（保留 epoch）', () => {
  const s = mk();
  assert.equal(s.release('bridge', { pid: 999 }), false);
  const before = JSON.parse(fs.readFileSync(path.join(tmp, 'channel-mode.json'), 'utf8'));
  assert.ok(before.epoch >= 1, '认领时必须有 epoch');
  assert.equal(s.release('bridge', { pid: 100 }), true);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'channel-mode.json'), 'utf8'));
  // 0.4.39 起：文件保留（epoch 是 fencing token，不能随释放消失）
  assert.equal(after.status, 'released');
  assert.equal(after.pid, undefined, 'released 状态不该还有持有者 pid');
  assert.equal(after.epoch, before.epoch, '释放不能让 epoch 回退');
});

check('心跳过期后可以被抢占（崩溃残留）', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chanmode2-'));
  const stale = { mode: 'bridge', pid: 111, at: Date.now() - 120_000 };
  fs.writeFileSync(path.join(dir2, 'channel-mode.json'), JSON.stringify(stale));
  const s = mod.createChannelModeStore({ fs, path, stateDir: dir2 });
  const r = s.claim('plugin', { pid: 222 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'stale');
  assert.equal(s.read().mode, 'plugin');
});

check('startBridgeChannelGuard：拿到时启动心跳、stop 时释放', () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'chanmode3-'));
  let ticks = 0;
  const guard = mod.startBridgeChannelGuard({
    fs, path, stateDir: dir3, pid: 777,
    setIntervalFn: (fn) => { ticks += 1; const t = setInterval(fn, 10_000); return t; },
    clearIntervalFn: (t) => clearInterval(t),
    log: () => {},
  });
  assert.equal(guard.ok, true);
  assert.equal(ticks, 1);
  assert.ok(guard.epoch >= 1, 'guard 要暴露本次持有的 epoch');
  guard.stop();
  // 0.4.39 起释放写 status=released（保留 epoch），不再删文件
  const after = JSON.parse(fs.readFileSync(path.join(dir3, 'channel-mode.json'), 'utf8'));
  assert.equal(after.status, 'released');
  assert.equal(after.epoch, guard.epoch);
});

check('startBridgeChannelGuard：被占用时 ok:false 且不留文件', () => {
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'chanmode4-'));
  fs.writeFileSync(path.join(dir4, 'channel-mode.json'), JSON.stringify({ mode: 'plugin', pid: process.pid, at: Date.now() }));
  const logs = [];
  const guard = mod.startBridgeChannelGuard({
    fs, path, stateDir: dir4, pid: 777, log: (m) => logs.push(m),
  });
  assert.equal(guard.ok, false);
  assert.equal(guard.reason, 'other-active');
  assert.match(logs[0], /通道被占用/);
});

check('startBridgeChannelGuard：持有者进程已退出 → 直接接管（脏环境实测）', () => {
  const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'chanmode6-'));
  // 用一个几乎不可能存在的 pid，模拟"上一个 bridge 被杀了但认领还在 TTL 内"
  fs.writeFileSync(path.join(dir6, 'channel-mode.json'), JSON.stringify({ mode: 'bridge', pid: 999999, at: Date.now(), note: 'stale' }));
  const logs = [];
  const guard = mod.startBridgeChannelGuard({ fs, path, stateDir: dir6, pid: 888, log: (m) => logs.push(m) });
  assert.equal(guard.ok, true, '死持有者不该拦住新实例');
  assert.ok(logs.some((m) => /已退出，接管通道/.test(m)), '要记一行接管日志');
  guard.stop();
});

check('startBridgeChannelGuard：enabled=false → sidecar-only，不认领也不写文件', () => {
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'chanmode5-'));
  const logs = [];
  const guard = mod.startBridgeChannelGuard({
    fs, path, stateDir: dir5, pid: 888, enabled: false, log: (m) => logs.push(m),
  });
  assert.equal(guard.ok, false);
  assert.equal(guard.disabled, true);
  assert.equal(fs.existsSync(path.join(dir5, 'channel-mode.json')), false, '不该留认领文件');
  assert.match(logs[0], /sidecar-only/);
  guard.stop(); // 不应抛错
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);