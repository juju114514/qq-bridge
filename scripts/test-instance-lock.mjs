// 实例锁（src/instance-lock.js）的契约测试：防止两个进程抢同一个官方机器人。
//
// 这是"宿主机桥接 + Docker 容器"共存的护栏：两边都连同一个 bot 的 gateway 会互相踢线，
// 表现是消息时有时无，极难排查。所以锁的行为必须钉死。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/instance-lock.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-lock-')), 'official.lock');

check('第一次抢锁成功，写入 instanceId/pid/hostname', () => {
  const f = tmpLock();
  const r = m.acquireInstanceLock(f, { instanceId: 'host', pid: 111 });
  assert.equal(r.ok, true);
  const info = m.readLock(f);
  assert.equal(info.instanceId, 'host');
  assert.equal(info.pid, 111);
  assert.ok(info.hostname);
  r.release();
  assert.equal(m.readLock(f), null, '释放后锁应删除');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('另一个实例抢锁失败，并告知持有者', () => {
  const f = tmpLock();
  const a = m.acquireInstanceLock(f, { instanceId: 'host', pid: 111 });
  const b = m.acquireInstanceLock(f, { instanceId: 'docker', pid: 222 });
  assert.equal(b.ok, false, '第二个实例必须被拒绝');
  assert.equal(b.holder.instanceId, 'host');
  a.release();
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('同一 instanceId 重复抢锁是幂等的（重启/热重载不误报）', () => {
  const f = tmpLock();
  const a = m.acquireInstanceLock(f, { instanceId: 'host', pid: 111 });
  const b = m.acquireInstanceLock(f, { instanceId: 'host', pid: 222 });
  assert.equal(b.ok, true, '同名实例应允许接管');
  a.release(); // 旧实例释放不能删掉新实例的锁
  assert.ok(m.readLock(f), '新实例的锁必须保留');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('心跳过期的锁可被接管（进程被强杀后会留下残锁）', () => {
  const f = tmpLock();
  const now = Date.now();
  m.writeLock(f, { instanceId: 'host', pid: 111, hostname: 'x', since: now - 10_000, beatAt: now - 200_000 });
  const r = m.acquireInstanceLock(f, { instanceId: 'docker', pid: 222 });
  assert.equal(r.ok, true, '超过 staleMs 的锁应视为残留');
  assert.equal(m.readLock(f).instanceId, 'docker');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('锁文件损坏时视为无锁（不能让坏文件把服务挡死）', () => {
  const f = tmpLock();
  fs.writeFileSync(f, '{broken', 'utf8');
  const r = m.acquireInstanceLock(f, { instanceId: 'host', pid: 111 });
  assert.equal(r.ok, true);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('接线：bridge 启动官方通道前抢锁，失败则跳过 start；compose 做实例隔离', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /acquireInstanceLock/, '要抢锁');
  assert.match(bridge, /officialLockedOut/, '拿不到锁要跳过启动');
  assert.match(bridge, /QQB_INSTANCE/, '实例名可用环境变量区分');
  const compose = read('docker-compose.yml');
  assert.match(compose, /QQB_INSTANCE=docker/, '容器是独立实例');
  assert.match(compose, /state-docker/, '容器用独立 state，不能和宿主机共用');
  assert.match(compose, /3101/, '容器用独立端口');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
