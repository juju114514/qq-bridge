// 设备配对 + 签名（0.4.107）：签名/重放/超时/配对码/吊销
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/device-auth.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const SECRET = 'a'.repeat(64);
const NOW = Date.parse('2026-11-01T23:00:00+08:00');

check('签名：同样的输入 → 同样的签名；任何字段变了 → 变', () => {
  const base = { method: 'POST', path: '/api/send', timestamp: NOW, nonce: 'n1', bodyHash: m.hashBody('{"a":1}') };
  const s1 = m.signRequest(SECRET, base);
  const s2 = m.signRequest(SECRET, base);
  assert.equal(s1, s2);
  assert.notEqual(s1, m.signRequest(SECRET, { ...base, path: '/api/other' }));
  assert.notEqual(s1, m.signRequest(SECRET, { ...base, bodyHash: m.hashBody('{"a":2}') }));
  assert.notEqual(s1, m.signRequest(SECRET + 'x', base));
});

check('校验：合法签名通过', () => {
  const parts = { method: 'POST', path: '/api/send', timestamp: NOW, nonce: 'n2', bodyHash: m.hashBody('{}') };
  const r = m.verifyRequest({ secret: SECRET, sign: m.signRequest(SECRET, parts), ...parts, now: NOW, nonces: m.createNonceCache() });
  assert.equal(r.ok, true);
});

check('校验：被篡改的 body → 拒绝', () => {
  const parts = { method: 'POST', path: '/api/send', timestamp: NOW, nonce: 'n3', bodyHash: m.hashBody('{"a":1}') };
  const sign = m.signRequest(SECRET, parts);
  const r = m.verifyRequest({ secret: SECRET, sign, ...parts, bodyHash: m.hashBody('{"a":2}'), now: NOW, nonces: m.createNonceCache() });
  assert.equal(r.ok, false);
  assert.match(r.error, /签名不匹配/);
});

check('校验：时间窗 ±60 秒', () => {
  const mk = (ts) => {
    const parts = { method: 'GET', path: '/api/status', timestamp: ts, nonce: 'n' + ts, bodyHash: m.hashBody('') };
    return m.verifyRequest({ secret: SECRET, sign: m.signRequest(SECRET, parts), ...parts, now: NOW, nonces: m.createNonceCache() });
  };
  assert.equal(mk(NOW).ok, true);
  assert.equal(mk(NOW - 59 * 1000).ok, true);
  assert.equal(mk(NOW - 61 * 1000).ok, false, '61 秒前应拒绝');
  assert.equal(mk(NOW + 61 * 1000).ok, false, '61 秒后应拒绝');
});

check('校验：nonce 重放被拒（同一 nonce 两次）', () => {
  const nonces = m.createNonceCache();
  const parts = { method: 'POST', path: '/api/send', timestamp: NOW, nonce: 'replay-1', bodyHash: m.hashBody('{}') };
  const sign = m.signRequest(SECRET, parts);
  assert.equal(m.verifyRequest({ secret: SECRET, sign, ...parts, now: NOW, nonces }).ok, true);
  const again = m.verifyRequest({ secret: SECRET, sign, ...parts, now: NOW, nonces });
  assert.equal(again.ok, false);
  assert.match(again.error, /重放/);
});

check('校验：缺字段/未知设备', () => {
  assert.match(m.verifyRequest({}).error, /未知设备/);
  assert.match(m.verifyRequest({ secret: SECRET }).error, /时间戳/);
  assert.match(m.verifyRequest({ secret: SECRET, timestamp: NOW, now: NOW }).error, /nonce/);
});

check('配对码：6 位、一次性、过期', () => {
  const codes = m.createPairingCodes({ ttlMs: 60000 });
  const { code } = codes.issue(NOW);
  assert.match(code, /^\d{6}$/);
  assert.equal(codes.consume('000000' === code ? '111111' : '000000', NOW).ok, false, '错的码要被拒');
  assert.equal(codes.consume(code, NOW).ok, true);
  assert.equal(codes.consume(code, NOW).ok, false, '用过就不能再用');

  const c2 = m.createPairingCodes({ ttlMs: 1000 });
  const { code: code2 } = c2.issue(NOW);
  const expired = c2.consume(code2, NOW + 2000);
  assert.equal(expired.ok, false);
  assert.match(expired.error, /过期/);
});

check('设备库：配对 → 列表（不带 secret）→ 吊销', () => {
  const file = path.join(os.tmpdir(), `dev-${process.pid}-${Date.now()}.json`);
  const store = m.createDeviceStore(file);
  const d = store.add('我的手机');
  assert.match(d.id, /^[0-9a-f]{16}$/);
  assert.match(d.secret, /^[0-9a-f]{64}$/);
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].secret, undefined, '列表不能带 secret');
  assert.equal(store.find(d.id).secret, d.secret);
  assert.equal(store.revoke(d.id), true);
  assert.equal(store.find(d.id).revoked, true);
  assert.equal(store.revoke('不存在'), false);
  fs.rmSync(file, { force: true });
});

check('nonce 缓存会过期', () => {
  const c = m.createNonceCache({ ttlMs: 1000 });
  assert.equal(c.claim('x', NOW), true);
  assert.equal(c.claim('x', NOW + 500), false);
  assert.equal(c.claim('x', NOW + 2000), true, '超过 TTL 后可以再用（同 nonce 但时间戳会不同）');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
