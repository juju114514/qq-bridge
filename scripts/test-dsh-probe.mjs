// DSH 连通性探测（0.5.44）
import assert from 'node:assert/strict';
const m = await import(new URL('../src/dsh-probe.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const okFetch = (status) => async () => ({ status, body: { cancel: async () => {} } });
const okProbe = async () => ({ ok: true, host: '127.0.0.1', port: 3080 });
const badProbe = async () => ({ ok: false, reason: 'ECONNREFUSED' });

await check('回环判定：127.0.0.1 / localhost / ::1 算本机，其余不算', () => {
  assert.equal(m.isLoopbackBaseUrl('http://127.0.0.1:3080'), true);
  assert.equal(m.isLoopbackBaseUrl('http://localhost:3080'), true);
  assert.equal(m.isLoopbackBaseUrl('http://[::1]:3080'), true);
  assert.equal(m.isLoopbackBaseUrl('http://192.168.1.2:3080'), false);
  assert.equal(m.isLoopbackBaseUrl('不是URL'), false);
});

await check('没填 baseUrl → 直接给"去填地址"', async () => {
  const r = await m.probeDsh({ baseUrl: '' });
  assert.equal(r.ok, false);
  assert.match(r.hints.join(), /填 DSH 地址/);
});

await check('端口不通 + 远程地址 → 提示要建隧道', async () => {
  const r = await m.probeDsh({ baseUrl: 'http://192.168.1.2:3080', probeImpl: badProbe, fetchImpl: okFetch(200) });
  assert.equal(r.ok, false);
  assert.equal(r.loopback, false);
  assert.match(r.hints.join(), /adb reverse|ssh -L|frp/);
});

await check('端口不通 + 本机 → 提示 DSH 没开/端口变了', async () => {
  const r = await m.probeDsh({ baseUrl: 'http://127.0.0.1:3080', probeImpl: badProbe, fetchImpl: okFetch(200) });
  assert.match(r.hints.join(), /没启动|端口/);
});

await check('匿名可访问 → ok（不要求鉴权）', async () => {
  const r = await m.probeDsh({ baseUrl: 'http://127.0.0.1:3080', probeImpl: okProbe, fetchImpl: okFetch(200) });
  assert.equal(r.ok, true);
  assert.equal(r.steps.find((s) => s.name === 'http').detail.includes('匿名'), true);
});

await check('需要鉴权但两样凭据都没有 → 不 ok 并给出该补什么', async () => {
  const r = await m.probeDsh({
    baseUrl: 'http://127.0.0.1:3080', probeImpl: okProbe, fetchImpl: okFetch(401),
    authToken: '', hasSessionSecret: false
  });
  assert.equal(r.ok, false);
  assert.match(r.hints.join(), /credentials\.yaml|authToken/);
});

await check('远程 + 有 token + 没开 allowRemote → 拦住（安全闸）', async () => {
  const r = await m.probeDsh({
    baseUrl: 'http://192.168.1.2:3080', probeImpl: okProbe, fetchImpl: okFetch(401),
    authToken: 'x'.repeat(20), allowRemote: false
  });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === 'allowRemote').ok, false);
  assert.match(r.hints.join(), /allowRemote/);
});

await check('远程 + 有 token + 开了 allowRemote → ok', async () => {
  const r = await m.probeDsh({
    baseUrl: 'http://192.168.1.2:3080', probeImpl: okProbe, fetchImpl: okFetch(401),
    authToken: 'x'.repeat(20), allowRemote: true
  });
  assert.equal(r.ok, true);
});

await check('本机 + 只有会话密钥 → ok', async () => {
  const r = await m.probeDsh({
    baseUrl: 'http://127.0.0.1:3080', probeImpl: okProbe, fetchImpl: okFetch(401),
    hasSessionSecret: true
  });
  assert.equal(r.ok, true);
  assert.match(r.steps.find((s) => s.name === 'auth').detail, /会话密钥/);
});

await check('HTTP 直接炸了 → 不 ok，提示可能不是 DSH', async () => {
  const r = await m.probeDsh({
    baseUrl: 'http://127.0.0.1:3080', probeImpl: okProbe,
    fetchImpl: async () => { throw new Error('socket hang up'); }
  });
  assert.equal(r.ok, false);
  assert.match(r.hints.join(), /不是 DSH|代理/);
});


const streamWatch = await import(new URL('../src/dsh-stream-watch.js', import.meta.url).href);
const dshPortMod = await import(new URL('../src/dsh-port.js', import.meta.url).href);

await check('stream-watch：前两次 0 帧不提示，第 3 次给出"可能连错端口"的提示', () => {
  streamWatch.resetStreamWatch();
  assert.equal(streamWatch.noteStreamEnd(0), '');
  assert.equal(streamWatch.noteStreamEnd(0), '');
  const hint = streamWatch.noteStreamEnd(0, { baseUrl: 'http://127.0.0.1:9230' });
  assert.match(hint, /连续 3 次/);
  assert.match(hint, /9230/);
  assert.match(hint, /dsh\.baseUrl/);
});

await check('stream-watch：有帧就清零，不再提示', () => {
  streamWatch.resetStreamWatch();
  streamWatch.noteStreamEnd(0);
  streamWatch.noteStreamEnd(0);
  streamWatch.noteStreamEnd(5);      // 收到帧
  assert.equal(streamWatch.noteStreamEnd(0), '');
  assert.equal(streamWatch.streamWatchState().zeroStreak, 1);
});

await check('dsh-port：probeDshSignature 对 404 的端口判 no（真实事故：9230 上的别的服务）', async () => {
  const httpMod = await import('node:http');
  const srv = httpMod.createServer((req, res) => { res.statusCode = 404; res.end('not found'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const verdict = await dshPortMod.probeDshSignature(port, { timeoutMs: 1200 });
  srv.close();
  assert.equal(verdict, 'no');
});

await check('dsh-port：probeDshSignature 对 401 的端口判 yes（DSH 未鉴权时的正常响应）', async () => {
  const httpMod = await import('node:http');
  const srv = httpMod.createServer((req, res) => { res.statusCode = 401; res.end('unauthorized'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const verdict = await dshPortMod.probeDshSignature(port, { timeoutMs: 1200 });
  srv.close();
  assert.equal(verdict, 'yes');
});

await check('dsh-port：连不上的端口判 unknown（不能拿"没响应"当"不是 DSH"）', async () => {
  const verdict = await dshPortMod.probeDshSignature(9, { timeoutMs: 400 });
  assert.equal(verdict, 'unknown');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
