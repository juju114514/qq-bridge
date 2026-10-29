// 网关自动选择（src/gateway-select.js）契约测试：全离线。
//
// 重点：默认 SnowLuma、连续失败才降级、降级后要连续成功才回切、冷却期内不切换。

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const m = await import(new URL('../src/gateway-select.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('默认主网关是 snowluma', () => {
  assert.equal(m.DEFAULT_GATEWAY_POLICY.preferred, 'snowluma');
  assert.equal(m.decideGateway({}, { current: 'snowluma', failStreak: 0 }).gateway, 'snowluma');
});

await check('失败没到阈值：不切（避免抖动）', () => {
  const r = m.decideGateway({}, { current: 'snowluma', failStreak: 2 });
  assert.equal(r.gateway, 'snowluma');
  assert.equal(r.reason, 'holding-preferred');
});

await check('连续失败到阈值：降级到 napcat', () => {
  const r = m.decideGateway({}, { current: 'snowluma', failStreak: 3 });
  assert.equal(r.gateway, 'napcat');
  assert.equal(r.switched, true);
  assert.equal(r.reason, 'failover');
});

await check('enableFallback=false 时永不降级', () => {
  const r = m.decideGateway({ enableFallback: false }, { current: 'snowluma', failStreak: 99 });
  assert.equal(r.gateway, 'snowluma');
});

await check('已在备选：恢复次数不够就保持', () => {
  const r = m.decideGateway({}, { current: 'napcat', recoverStreak: 4 });
  assert.equal(r.gateway, 'napcat');
  assert.equal(r.reason, 'holding-fallback');
});

await check('已在备选：连续成功够多则回切主网关', () => {
  const r = m.decideGateway({}, { current: 'napcat', recoverStreak: 5 });
  assert.equal(r.gateway, 'snowluma');
  assert.equal(r.reason, 'recover');
});

await check('冷却期内不来回切', () => {
  const now = 1_000_000;
  const r = m.decideGateway({ switchCooldownMs: 60_000 }, {
    current: 'snowluma', failStreak: 10, lastSwitchAt: now - 1000, now
  });
  assert.equal(r.gateway, 'snowluma');
});

await check('recordProbe：成功清零失败、累计恢复；失败反之', () => {
  let s = { current: 'snowluma', failStreak: 2, recoverStreak: 0 };
  s = m.recordProbe(s, false);
  assert.equal(s.failStreak, 3);
  assert.equal(s.recoverStreak, 0);
  s = m.recordProbe(s, true);
  assert.equal(s.failStreak, 0);
  assert.equal(s.recoverStreak, 1);
});

await check('probeOneBot：无 url / 超时 / 非 ok 都返回失败而不抛', async () => {
  assert.equal((await m.probeOneBot({})).error, 'no-url');
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const r1 = await m.probeOneBot({ httpUrl: 'http://x', fetchImpl: boom });
  assert.equal(r1.ok, false);
  const bad = async () => ({ status: 200, json: async () => ({ status: 'failed', wording: 'token verify failed!' }) });
  const r2 = await m.probeOneBot({ httpUrl: 'http://x', fetchImpl: bad });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /token/);
  const good = async () => ({ status: 200, json: async () => ({ status: 'ok', data: { nickname: 'n', user_id: 1 } }) });
  const r3 = await m.probeOneBot({ httpUrl: 'http://x', fetchImpl: good });
  assert.equal(r3.ok, true);
  assert.equal(r3.nickname, 'n');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
