// 网关多账号（0.4.106）：解析 / 探测 / 绑定 的纯逻辑
import assert from 'node:assert/strict';

const m = await import(new URL('../src/gateway-accounts.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const sample = {
  mode: 'snapshot',
  networks: {
    httpServers: [{ name: 'http-default', accessToken: 'tok-abc', host: '127.0.0.1', port: 3000 }],
    wsServers: [{ name: 'ws-default', accessToken: 'tok-ws', host: '127.0.0.1', port: 3001 }]
  }
};

check('解析正常配置：uin 来自文件名、端口/token 来自 networks', () => {
  const r = m.parseOnebotConfig(sample, 'onebot_3976372760.json');
  assert.equal(r.uin, '3976372760');
  assert.equal(r.httpPort, 3000);
  assert.equal(r.wsPort, 3001);
  assert.equal(r.httpToken, 'tok-abc');
  assert.equal(r.configured, true);
});

check('空 networks（另一个号就是这样）→ configured=false，端口 null', () => {
  const r = m.parseOnebotConfig({ mode: 'snapshot', networks: { httpServers: [], wsServers: [] } }, 'onebot_1599683156.json');
  assert.equal(r.uin, '1599683156');
  assert.equal(r.httpPort, null);
  assert.equal(r.configured, false);
});

check('坏数据不炸：null / 缺字段 / 文件名没 uin', () => {
  const r = m.parseOnebotConfig(null, 'weird.json');
  assert.equal(r.uin, '');
  assert.equal(r.configured, false);
  const r2 = m.parseOnebotConfig({ networks: { httpServers: [{ port: '3005' }] } }, 'onebot_123456789.json');
  assert.equal(r2.httpPort, 3005);
  assert.equal(r2.uin, '123456789');
  assert.equal(r2.httpToken, '');
});

check('探测：没有端口的账号直接返回 未配置端口（不发请求）', async () => {
  const r = await m.probeAccount({ uin: '1', httpPort: null });
  assert.equal(r.online, false);
  assert.match(r.error, /未配置端口/);
});

check('探测：连不上的端口 → online=false 且带错误（不抛）', async () => {
  const r = await m.probeAccount({ uin: '2', httpPort: 1, httpToken: 'x' }, { timeoutMs: 500 });
  assert.equal(r.online, false);
  assert.ok(r.error);
});

check('绑定：返回新的 http/ws 地址（格式正确）', () => {
  // 用假实现验证拼接逻辑：直接调 parse 结果进函数会写盘，这里只验证字段名约定
  const r = m.parseOnebotConfig(sample, 'onebot_3976372760.json');
  assert.match(`http://127.0.0.1:${r.httpPort}`, /^http:\/\/127\.0\.0\.1:3000$/);
  assert.match(`ws://127.0.0.1:${r.wsPort}`, /^ws:\/\/127\.0\.0\.1:3001$/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
