// 家庭中继（P3）
import assert from 'node:assert/strict';
import net from 'node:net';

const mod = await import(new URL('../src/dsh-relay.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('私有网段识别：10/172.16-31/192.168/127 都算内网', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.9', '172.31.255.1', '192.168.1.20', '::ffff:192.168.1.7']) {
    assert.equal(mod.isPrivateAddress(ip), true, ip);
  }
});

await check('公网地址不算内网（拦掉被暴露的风险）', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '203.0.113.5', '']) {
    assert.equal(mod.isPrivateAddress(ip), false, ip);
  }
});

await check('真实转发：写进去的数据能从 echo 服务回来', async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;

  const relay = mod.createRelay({
    target: { host: '127.0.0.1', port: echoPort },
    listen: { host: '127.0.0.1', port: 0 },
    log: () => {}
  });
  await relay.start();
  const rp = relay.address().port;

  const got = await new Promise((resolve, reject) => {
    const c = net.connect(rp, '127.0.0.1');
    const chunks = [];
    c.on('connect', () => c.write('hello-relay'));
    c.on('data', (d) => { chunks.push(d); if (Buffer.concat(chunks).toString() === 'hello-relay') { c.end(); resolve(Buffer.concat(chunks).toString()); } });
    c.on('error', reject);
    setTimeout(() => reject(new Error('超时没收到回包')), 3000);
  });
  assert.equal(got, 'hello-relay');
  assert.ok(relay.stats().connections >= 1);
  await relay.stop();
  echo.close();
});

await check('目标端口关闭时：客户端被断开而不是挂死', async () => {
  const relay = mod.createRelay({
    target: { host: '127.0.0.1', port: 1 },
    listen: { host: '127.0.0.1', port: 0 },
    log: () => {}
  });
  await relay.start();
  const rp = relay.address().port;
  const ended = await new Promise((resolve) => {
    const c = net.connect(rp, '127.0.0.1');
    c.on('close', () => resolve(true));
    c.on('error', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });
  assert.equal(ended, true);
  await relay.stop();
});

await check('stop 之后端口释放（能再次绑定）', async () => {
  const relay = mod.createRelay({ target: { host: '127.0.0.1', port: 1 }, listen: { host: '127.0.0.1', port: 0 }, log: () => {} });
  await relay.start();
  const p = relay.address().port;
  await relay.stop();
  const again = net.createServer();
  await new Promise((r, j) => { again.once('error', j); again.listen(p, '127.0.0.1', r); });
  again.close();
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
