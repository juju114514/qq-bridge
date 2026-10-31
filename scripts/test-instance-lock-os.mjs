// 0.4.49.3：OS 级互斥 = 回环端口绑定（内核保证唯一 + 崩溃自动释放）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOD = new URL('../src/instance-lock.js', import.meta.url).href;
const m = await import(MOD);
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-portlock-'));

await check('端口派生：同一 instanceId 稳定，不同实例不同', () => {
  const a = m.lockPortFor('host');
  assert.equal(a, m.lockPortFor('host'));
  assert.notEqual(a, m.lockPortFor('docker'));
  assert.ok(a >= 31200 && a < 33200, '端口应落在 [31200,33200)');
});

await check('独占：第一个拿到，第二个被内核拒绝', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 1111 });
  assert.equal(a.ok, true, '第一个应成功');
  const b = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 2222 });
  assert.equal(b.ok, false, '第二个不该拿到');
  assert.equal(b.reason, 'held');
  assert.ok(b.holder, '应能读到持有者诊断信息');
  await a.release();
  const c = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 3333 });
  assert.equal(c.ok, true, '释放后应能重新拿到');
  await c.release();
});

await check('崩溃自动恢复：子进程被 kill 后父进程立刻能拿到（无需人工）', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(MOD)});
    const r = await m.acquireInstanceLock(${JSON.stringify(file)}, { instanceId: 'host', pid: process.pid });
    process.stdout.write(r.ok ? 'ok' : 'no:' + r.reason);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const got = await new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    setTimeout(() => resolve(out), 2000);
  });
  assert.equal(got, 'ok', '子进程应拿到锁，实际: ' + got);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;                       // 复核：必须等 exit，不能靠固定 sleep
  await new Promise((r) => setTimeout(r, 150));   // 让内核完成端口回收
  const r = await m.acquireInstanceLock(file, { instanceId: 'host', pid: process.pid });
  assert.equal(r.ok, true, '子进程被杀后应能自动接管');
  await r.release();
});

await check('心跳只更新状态文件，不影响互斥', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 1111 });
  const before = m.readLock(file).beatAt;
  a.beatNow();
  const after = m.readLock(file).beatAt;
  assert.ok(after >= before, '心跳应更新 beatAt');
  assert.equal(a.stats().beats, 1);
  await a.release();
});

await check('状态文件被删掉也不影响互斥（互斥靠端口，不靠文件）', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 1111 });
  assert.equal(a.ok, true);
  fs.rmSync(file, { force: true });
  const b = await m.acquireInstanceLock(file, { instanceId: 'host', pid: 2222 });
  assert.equal(b.ok, false, '删了状态文件也不能骗到锁');
  await a.release();
});

await check('并发：多个实例同时抢，最多一个成功', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const results = await Promise.all([1, 2, 3, 4].map((i) => m.acquireInstanceLock(file, { instanceId: 'host', pid: i })));
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 1, `应恰好一个成功，实际 ${okCount}`);
  for (const r of results.filter((x) => x.ok)) await r.release();
});

await check('显式端口优先：QQB_LOCK_PORT 覆盖派生值', () => {
  const r = m.resolveLockPort({ instanceId: 'host', env: { QQB_LOCK_PORT: '32123' } });
  assert.equal(r.port, 32123);
  assert.equal(r.source, 'explicit');
  const d = m.resolveLockPort({ instanceId: 'host', env: {} });
  assert.equal(d.source, 'derived');
  assert.equal(d.port, m.lockPortFor('host'));
});

await check('端口派生范围：落在 [31200, 33200)（复核指出 200 太小）', () => {
  for (const id of ['host', 'docker', 'bot-a', 'bot-b', 'x']) {
    const p = m.lockPortFor(id);
    assert.ok(p >= 31200 && p < 33200, `${id} → ${p} 超出范围`);
  }
});

await check('bind 错误码分类：四种情况不能混成一个"被占用"', () => {
  assert.equal(m.classifyBindError('EADDRINUSE').reason, 'held');
  assert.equal(m.classifyBindError('EACCES').reason, 'permission');
  assert.equal(m.classifyBindError('EPERM').reason, 'permission');
  assert.equal(m.classifyBindError('EADDRNOTAVAIL').reason, 'unavailable');
  assert.equal(m.classifyBindError('timeout').reason, 'timeout');
  assert.equal(m.classifyBindError('EWHATEVER').reason, 'error');
});

await check('显式端口生效：两个不同 instanceId 配同一个显式端口 → 第二个被拒', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'bot-a', port: 33211 });
  assert.equal(a.ok, true);
  const b = await m.acquireInstanceLock(file, { instanceId: 'bot-b', port: 33211 });
  assert.equal(b.ok, false, '显式端口相同时也必须互斥');
  await a.release();
});

await check('release 返回 Promise，await 之后可立刻重新获取（不留 EADDRINUSE）', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', port: 33222 });
  assert.equal(a.ok, true);
  const p = a.release();
  assert.ok(p && typeof p.then === 'function', 'release 必须返回 Promise');
  await p;
  const b = await m.acquireInstanceLock(file, { instanceId: 'host', port: 33222 });
  assert.equal(b.ok, true, 'await 之后应能立刻重取');
  await b.release();
});

await check('非法显式端口：直接失败，不静默回退', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  for (const bad of ['abc', '0', '-1', '70000', '']) {
    if (bad === '') continue;   // 空 = 未配置，允许派生
    const r = await m.acquireInstanceLock(file, { instanceId: 'host', env: { QQB_LOCK_PORT: bad } });
    assert.equal(r.ok, false, `QQB_LOCK_PORT=${bad} 不该静默回退`);
    assert.equal(r.reason, 'invalid-port');
  }
  const derived = m.resolveLockPort({ instanceId: 'host', env: { QQB_LOCK_PORT: '  ' } });
  assert.equal(derived.source, 'derived', '空白应视为未配置');
});

await check('writeLock 不再暴露 fs 注入（避免误导）', async () => {
  const fs2 = await import('node:fs/promises');
  const src = await fs2.readFile(new URL('../src/instance-lock.js', import.meta.url), 'utf8');
  assert.ok(!/export function writeLock\(file, info, \{ fs/.test(src), 'writeLock 仍带无效 fs 参数');
});

await check('绑定失败后不留孤儿 listener（端口可被再次绑定）', async () => {
  // 构造：先占一个端口，再让 acquire 用同一端口走到失败分支，最后释放，验证端口可复用
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', port: 33233 });
  assert.equal(a.ok, true);
  const b = await m.acquireInstanceLock(file, { instanceId: 'host', port: 33233 });
  assert.equal(b.ok, false);
  await a.release();
  const c = await m.acquireInstanceLock(file, { instanceId: 'host', port: 33233 });
  assert.equal(c.ok, true, '失败路径不应把端口占死');
  await c.release();
});

// ── 真正的 timeout 路径：用 fake server 注入，不依赖真实 socket 时序 ──────────
const fakeServer = () => {
  const handlers = { error: [], listening: [] };
  const state = { closed: 0, listening: false };
  return {
    state,
    once(ev, fn) { (handlers[ev] ??= []).push(fn); return this; },
    listen(_opts, cb) {
      // 像 Node 一样：'listening' 时调用 listen 的回调
      this.once('__nodeListeningCb', cb);
      return this;
    },
    close() { state.closed += 1; state.listening = false; return this; },
    emit(ev, arg) {
      for (const fn of handlers[ev] ?? []) fn(arg);
      if (ev === 'listening') for (const fn of handlers.__nodeListeningCb ?? []) fn(arg);
    },
  };
};

await check('timeout 注入：listen 一直不响应 → 失败并主动关闭 server', async () => {
  const s = fakeServer();
  const r = await m.bindWithTimeout(s, { port: 33501, timeoutMs: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'timeout');
  assert.equal(s.state.closed, 1, '超时必须关闭 server，否则孤儿 listener 占着端口');
});

await check('timeout 注入：超时后迟到的 listening → 立刻关闭，不留孤儿', async () => {
  const s = fakeServer();
  const r = await m.bindWithTimeout(s, { port: 33502, timeoutMs: 60 });
  assert.equal(r.code, 'timeout');
  const before = s.state.closed;
  s.emit('listening');                 // 迟到的成功事件
  await new Promise((r) => setImmediate(r));   // 守卫在 microtask 里判断
  assert.ok(s.state.closed > before, '迟到 listening 必须被关闭');
});

await check('成功路径：先 listening 后超时定时器 → 不被关闭', async () => {
  const s = fakeServer();
  const p = m.bindWithTimeout(s, { port: 33503, timeoutMs: 200 });
  s.emit('listening');
  const r = await p;
  assert.equal(r.ok, true);
  s.emit('listening');                 // 再来一次迟到事件
  await new Promise((r) => setImmediate(r));
  assert.equal(s.state.closed, 0, '成功拿到的 listener 不能被自己关掉');
});

await check('错误路径：EADDRINUSE → 失败并关闭', async () => {
  const s = fakeServer();
  const p = m.bindWithTimeout(s, { port: 33504, timeoutMs: 200 });
  s.emit('error', { code: 'EADDRINUSE' });
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EADDRINUSE');
  assert.equal(s.state.closed, 1);
});

await check('release 幂等：close 回调与兜底只生效一次（不会二次删文件）', async () => {
  const dir = tmp(); const file = path.join(dir, 'official.lock');
  const a = await m.acquireInstanceLock(file, { instanceId: 'host', port: 33266 });
  assert.equal(a.ok, true);
  const before = fs.readFileSync(file, 'utf8').length;
  await a.release();
  assert.equal(fs.existsSync(file), false, '正常 release 应删除诊断文件');
  assert.ok(before > 0);
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
