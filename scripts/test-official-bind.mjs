// 官方扫码绑定（0.4.114）：解密 / 状态映射 / 轮询会话
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const m = await import(new URL('../src/official-bind.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// ── 加解密：按官方格式构造密文（nonce|ct|tag），验证我们能解开 ──
function encryptLikeQiye(secret, keyBuf) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(secret, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString('base64');
}

check('解出裸 AppSecret（AES-256-GCM，nonce 前 12 / tag 后 16）', () => {
  const key = crypto.randomBytes(32);
  const enc = encryptLikeQiye('MyAppSecret_1234567890', key);
  const out = m.decryptBindSecret(key.toString('base64'), enc);
  assert.equal(out, 'MyAppSecret_1234567890');
});

check('密钥长度不对 → 抛错（不是返回空串）', () => {
  assert.throws(() => m.decryptBindSecret(Buffer.alloc(16).toString('base64'), 'AAAA'), /32 字节/);
});

check('密文太短 → 抛错', () => {
  const key = crypto.randomBytes(32).toString('base64');
  assert.throws(() => m.decryptBindSecret(key, Buffer.alloc(10).toString('base64')), /格式异常/);
});

check('密文被篡改 → 认证失败要抛（GCM 的 tag 校验）', () => {
  const key = crypto.randomBytes(32);
  const enc = Buffer.from(encryptLikeQiye('secret-value', key), 'base64');
  enc[enc.length - 20] ^= 0xff;             // 改密文中间一个字节
  assert.throws(() => m.decryptBindSecret(key.toString('base64'), enc.toString('base64')));
});

check('状态码映射：0/1 等待，2 完成，3 过期，其它未知', () => {
  assert.equal(m.bindStatusName(0), 'pending');
  assert.equal(m.bindStatusName(1), 'pending');
  assert.equal(m.bindStatusName(2), 'created');
  assert.equal(m.bindStatusName(3), 'expired');
  assert.equal(m.bindStatusName(9), 'unknown');
});

check('二维码内容：URL 字符串 + task_id 百分号编码', () => {
  const url = m.buildQrUrl('abc 123/&x');
  assert.match(url, /^https:\/\/q\.qq\.com\/qqbot\/openclaw\/connect\.html\?task_id=/);
  assert.match(url, /_wv=2$/);
  assert.ok(!url.includes(' '), '不能有裸空格');
  assert.throws(() => m.buildQrUrl(''), /task_id/);
});

check('makeBindKey：32 字节 base64', () => {
  const k = m.makeBindKey();
  assert.equal(Buffer.from(k, 'base64').length, 32);
  assert.notEqual(m.makeBindKey(), k, '每次都要新 key');
});

// ── 会话：假 fetch 跑通 start → poll(pending) → poll(created) ──
function fakeFetch({ status = 0, appid = '', enc = '' } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/lite/create_bind_task')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ retcode: 0, data: { task_id: 'T-1' } }) };
    }
    if (url.endsWith('/lite/poll_bind_result')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ retcode: 0, data: { status, bot_appid: appid, bot_encrypt_secret: enc } })
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  fn.calls = calls;
  return fn;
}

await checkAsync('start 返回 taskId + qrUrl，请求体是 {key}', async () => {
  const f = fakeFetch();
  const s = m.createBindSession({ fetchImpl: f });
  const r = await s.start();
  assert.equal(r.taskId, 'T-1');
  assert.match(r.qrUrl, /task_id=T-1/);
  assert.equal(f.calls[0].url, 'https://q.qq.com/lite/create_bind_task');
  assert.equal(Buffer.from(f.calls[0].body.key, 'base64').length, 32);
});

await checkAsync('poll 等待中：返回 pending，不抛', async () => {
  const s = m.createBindSession({ fetchImpl: fakeFetch({ status: 1 }) });
  await s.start();
  const r = await s.poll('T-1');
  assert.equal(r.status, 'pending');
});

await checkAsync('poll 完成：返回 appid + 解密后的 secret（端到端）', async () => {
  const key = crypto.randomBytes(32);
  const f = fakeFetch({ status: 2, appid: '10001', enc: encryptLikeQiye('SECRET-XYZ', key) });
  const s = m.createBindSession({ fetchImpl: f, log: () => {}, keyFactory: () => key.toString('base64') });
  await s.start();
  const r = await s.poll('T-1');
  assert.equal(r.status, 'created');
  assert.equal(r.appid, '10001');
  assert.equal(r.secret, 'SECRET-XYZ');
});

await checkAsync('poll 完成但缺字段 → unknown + 明确报错，不当成功', async () => {
  const key = crypto.randomBytes(32);
  const f = fakeFetch({ status: 2, appid: '', enc: '' });
  const s = m.createBindSession({ fetchImpl: f, log: () => {}, keyFactory: () => key.toString('base64') });
  await s.start();
  const r = await s.poll('T-1');
  assert.equal(r.status, 'unknown');
  assert.match(r.error, /完整凭证/);
});

await checkAsync('成功后会话作废：再 poll 同一 task 会报错', async () => {
  const key = crypto.randomBytes(32);
  const f = fakeFetch({ status: 2, appid: '1', enc: encryptLikeQiye('S', key) });
  const s = m.createBindSession({ fetchImpl: f, log: () => {}, keyFactory: () => key.toString('base64') });
  await s.start();
  assert.equal((await s.poll('T-1')).status, 'created');
  await assert.rejects(() => s.poll('T-1'), /不是本进程发起/);
});

await checkAsync('poll 未知 task_id → 抛错（重启后要重新扫码）', async () => {
  const s = m.createBindSession({ fetchImpl: fakeFetch() });
  await assert.rejects(() => s.poll('nope'), /不是本进程发起/);
});

await checkAsync('retcode 非 0 → 抛错并带官方 message', async () => {
  const f = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ retcode: 1001, msg: 'task invalid' }) });
  const s = m.createBindSession({ fetchImpl: f });
  await assert.rejects(() => s.start(), /task invalid/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
