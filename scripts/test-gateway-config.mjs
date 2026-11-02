// 网关抽象（0.5.45）
import assert from 'node:assert/strict';
const m = await import(new URL('../src/gateway-config.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('空配置 → SnowLuma 默认（向后兼容）', () => {
  const g = m.normalizeGateway({});
  assert.equal(g.provider, 'snowluma');
  assert.equal(g.wsUrl, 'ws://127.0.0.1:3001');
  assert.equal(g.httpUrl, 'http://127.0.0.1:3000');
  assert.equal(g.legacy, false);
  assert.equal(g.capabilities.qzone, true);
});

await check('老写法 snowluma.* → 原样生效并标 legacy', () => {
  const g = m.normalizeGateway({ snowluma: { wsUrl: 'ws://127.0.0.1:3999', httpToken: 'abc' } });
  assert.equal(g.provider, 'snowluma');
  assert.equal(g.wsUrl, 'ws://127.0.0.1:3999');
  assert.equal(g.httpToken, 'abc');
  assert.equal(g.legacy, true);
});

await check('新写法 gateway.provider=napcat → 用 NapCat 预设端点', () => {
  const g = m.normalizeGateway({ gateway: { provider: 'napcat' } });
  assert.equal(g.provider, 'napcat');
  assert.equal(g.label, 'NapCatQQ');
  assert.equal(g.httpUrl, 'http://127.0.0.1:6099');
  assert.equal(g.wsUrl, 'ws://127.0.0.1:6199');
});

await check('NapCat 能力矩阵：SnowLuma 扩展标记为不支持', () => {
  const g = m.normalizeGateway({ gateway: { provider: 'napcat' } });
  assert.equal(g.capabilities.sendText, true);
  assert.equal(g.capabilities.voice, true);
  assert.equal(g.capabilities.faceEntity, false);
  assert.equal(g.capabilities.stickers, false);
  assert.equal(g.capabilities.qzone, false);
  const d = m.describeGatewayLimits(g);
  assert.match(d, /不支持/);
  assert.match(d, /收藏表情/);
});

await check('gateway.* 优先于 snowluma.*（同时存在时）', () => {
  const g = m.normalizeGateway({
    gateway: { provider: 'napcat', wsUrl: 'ws://10.0.0.2:7000' },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'old' }
  });
  assert.equal(g.provider, 'napcat');
  assert.equal(g.wsUrl, 'ws://10.0.0.2:7000');
});

await check('onebot.* 也能被识别（历史配置）', () => {
  const g = m.normalizeGateway({ onebot: { http: 'http://1.2.3.4:5000', ws: 'ws://1.2.3.4:5001', token: 't0' } });
  assert.equal(g.httpUrl, 'http://1.2.3.4:5000');
  assert.equal(g.wsUrl, 'ws://1.2.3.4:5001');
  assert.equal(g.accessToken, 't0');
});

await check('未知 provider → 不崩，标 unknownProvider，能力按 SnowLuma 兜底', () => {
  const g = m.normalizeGateway({ gateway: { provider: 'llonebot' } });
  assert.equal(g.unknownProvider, true);
  assert.match(g.label, /未知网关/);
  assert.equal(g.capabilities.sendText, true);
});

await check('URL 末尾斜杠会被去掉（避免拼出 //api）', () => {
  const g = m.normalizeGateway({ gateway: { httpUrl: 'http://127.0.0.1:3000/', wsUrl: 'ws://127.0.0.1:3001/' } });
  assert.equal(g.httpUrl, 'http://127.0.0.1:3000');
  assert.equal(g.wsUrl, 'ws://127.0.0.1:3001');
});

await check('toLegacySnowlumaShape 映射成桥接在读的字段', () => {
  const g = m.normalizeGateway({ gateway: { provider: 'napcat', token: 'tk' } });
  const legacy = m.toLegacySnowlumaShape(g);
  assert.equal(legacy.wsUrl, g.wsUrl);
  assert.equal(legacy.httpUrl, g.httpUrl);
  assert.equal(legacy.accessToken, 'tk');
  assert.equal(legacy.provider, 'napcat');
  assert.equal(legacy.capabilities.stickers, false);
});

await check('describe 对完整能力给出"能力完整"', () => {
  const g = m.normalizeGateway({});
  assert.match(m.describeGatewayLimits(g), /能力完整/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
