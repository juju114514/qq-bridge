// 通道模式闸（N3）的离线测试：认领 / 续期 / 抢占过期 / 拒绝他人 / 释放
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(path.join(here, '..', 'src', 'domains', 'channel-mode.js')).href);

const results = [];
const check = (n, f) => { try { f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };

const NOW = 1_800_000_000_000;

check('没有认领文件 → 直接拿到', () => {
  const r = m.claimMode({ current: null, mode: 'bridge', pid: 111, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'free');
  assert.equal(r.record.mode, 'bridge');
});

check('同 mode 同 pid → 续期', () => {
  const cur = { mode: 'bridge', pid: 111, at: NOW - 5000 };
  const r = m.claimMode({ current: cur, mode: 'bridge', pid: 111, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'refresh');
  assert.equal(r.record.at, NOW);
});

check('同 mode 不同 pid 且心跳新鲜 → 拒绝（两个同类实例）', () => {
  const cur = { mode: 'bridge', pid: 111, at: NOW - 5000 };
  const r = m.claimMode({ current: cur, mode: 'bridge', pid: 222, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'other-active');
  assert.equal(r.sameMode, true);
});

check('不同 mode 且心跳新鲜 → 拒绝并回报持有者', () => {
  const cur = { mode: 'bridge', pid: 111, at: NOW - 1000 };
  const r = m.claimMode({ current: cur, mode: 'plugin', pid: 333, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.holder.mode, 'bridge');
  assert.equal(r.sameMode, false);
});

check('对方心跳过期（崩溃残留）→ 抢占，reason=stale', () => {
  const cur = { mode: 'bridge', pid: 111, at: NOW - m.DEFAULT_TTL_MS - 1000 };
  const r = m.claimMode({ current: cur, mode: 'plugin', pid: 333, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'stale');
  assert.equal(r.record.mode, 'plugin');
});

check('心跳边界：正好等于 TTL 算新鲜（不提前抢占）', () => {
  const cur = { mode: 'bridge', pid: 111, at: NOW - m.DEFAULT_TTL_MS };
  const r = m.claimMode({ current: cur, mode: 'plugin', pid: 333, now: NOW });
  assert.equal(r.ok, false);
});

check('isFresh：脏数据（null / 无 at / 字符串 at）都当过期', () => {
  assert.equal(m.isFresh(null), false);
  assert.equal(m.isFresh({}), false);
  assert.equal(m.isFresh({ at: 'abc' }), false);
  assert.equal(m.isFresh({ at: NOW - 1000 }, NOW), true);
});

check('shouldRelease：只有持有者能释放', () => {
  const cur = { mode: 'bridge', pid: 111, at: NOW };
  assert.equal(m.shouldRelease(cur, { mode: 'bridge', pid: 111 }), true);
  assert.equal(m.shouldRelease(cur, { mode: 'bridge', pid: 222 }), false);
  assert.equal(m.shouldRelease(cur, { mode: 'plugin', pid: 111 }), false);
  assert.equal(m.shouldRelease(null, { mode: 'bridge', pid: 111 }), false);
});

check('describeMode：无认领 / 有认领都能说人话', () => {
  assert.match(m.describeMode(null), /没有通道/);
  const s = m.describeMode({ mode: 'bridge', pid: 42, at: NOW, note: 'sidecar 通道' });
  assert.match(s, /bridge/);
  assert.match(s, /pid 42/);
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);