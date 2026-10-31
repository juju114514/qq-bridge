// 会话重置「路由」（0.4.91）：文件名安全化 + 备份/重置顺序（备份失败就不重置）
// 注意：`test-session-reset.mjs` 测的是 src/session-reset.js 的清理清单，别混。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/api/session-reset-route.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const call = async (deps, body, { method = 'POST' } = {}) => {
  let out = null;
  const handled = await m.handleSessionResetRoute({
    req: { method, headers: {} },
    url: new URL('http://x/api/sessions/reset'),
    sendJson: (b) => { out = b; },
    readBody: async () => body,
    deps: () => deps
  });
  return { handled, out };
};

const tmpDir = () => path.join(os.tmpdir(), `sess-reset-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

await check('备份文件名安全化：group:1 → group_1-<时间戳>.json', async () => {
  const dir = tmpDir();
  const { out } = await call({
    files: { sessionBackups: dir },
    snapshotConversation: () => ({ key: 'group:1' }),
    resetConversation: async () => ({ ok: true })
  }, { key: 'group:1' });
  const base = path.basename(out.backupPath);
  assert.match(base, /^group_1-\d{8}-\d{6}\.json$/, `实际 ${base}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('路径穿越被**拒绝**（key 只允许字母数字下划线横线）', async () => {
  let resetCalled = false;
  const { out } = await call({
    files: { sessionBackups: tmpDir() },
    snapshotConversation: () => ({ key: 'x' }),
    resetConversation: async () => { resetCalled = true; return { ok: true }; }
  }, { key: 'group:../..' });
  assert.equal(out.ok, false);
  assert.match(out.error, /group:123/);
  assert.equal(resetCalled, false, '非法 key 绝不能触发重置');
});

await check('默认**先备份**再重置，并返回备份路径', async () => {
  const dir = tmpDir();
  let resetCalled = false;
  const { handled, out } = await call({
    files: { sessionBackups: dir },
    snapshotConversation: () => ({ key: 'group:1', messages: [{ t: 'hi' }] }),
    resetConversation: async () => { resetCalled = true; return { ok: true }; }
  }, { key: 'group:1' });
  assert.equal(handled, true);
  assert.equal(out.ok, true);
  assert.equal(resetCalled, true);
  assert.ok(out.backupPath && fs.existsSync(out.backupPath), '备份文件应存在');
  assert.match(out.note, /已备份并重置/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('backup:false → 不写文件，仍重置', async () => {
  const dir = tmpDir();
  const { out } = await call({
    files: { sessionBackups: dir },
    snapshotConversation: () => { throw new Error('不该被调用'); },
    resetConversation: async () => ({ ok: true })
  }, { key: 'private:2', backup: false });
  assert.equal(out.ok, true);
  assert.equal(out.backupPath, '');
  assert.match(out.note, /未备份/);
  assert.equal(fs.existsSync(dir), false, '不该创建目录');
});

await check('备份失败 → **中止重置**（不能丢上下文）', async () => {
  let resetCalled = false;
  const { out } = await call({
    files: { sessionBackups: tmpDir() },
    snapshotConversation: () => { throw new Error('磁盘满了'); },
    resetConversation: async () => { resetCalled = true; return { ok: true }; }
  }, { key: 'group:9' });
  assert.equal(out.ok, false);
  assert.match(out.error, /备份失败，已中止重置/);
  assert.equal(resetCalled, false, '备份失败时绝不能重置');
});

await check('key 不合法 → 400', async () => {
  const { out } = await call({ resetConversation: async () => ({ ok: true }) }, { key: 'bad key' });
  assert.equal(out.ok, false);
  assert.match(out.error, /group:123/);
});

await check('重置本身失败 → 502 且带上备份路径', async () => {
  const dir = tmpDir();
  const { out } = await call({
    files: { sessionBackups: dir },
    snapshotConversation: () => ({ key: 'group:3' }),
    resetConversation: async () => ({ ok: false, error: '会话繁忙' })
  }, { key: 'group:3' });
  assert.equal(out.ok, false);
  assert.match(out.error, /会话繁忙/);
  assert.ok(out.backupPath, '失败也要告诉用户备份在哪');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('GET 方法 → 405', async () => {
  const { handled, out } = await call({}, {}, { method: 'GET' });
  assert.equal(handled, true);
  assert.equal(out.ok, false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
