// /api/official 路由契约（0.4.65）：不启动桥接，用假 deps 直接调 handler。
// 验证的是「接线对不对」：字段齐不齐、probe 文件读没读、runtime 有没有进 gate。
import assert from 'node:assert/strict';

const { handleExtraRoutes } = await import(new URL('../src/api/console-extra-routes.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const call = async (deps) => {
  let out = null;
  const handled = await handleExtraRoutes({
    req: { method: 'GET', headers: {} },
    url: new URL('http://x/api/official'),
    sendJson: (body) => { out = body; },
    deps: () => deps,
  });
  return { handled, out };
};

const cfgWith = (official) => ({ official });

await check('齐全 + 运行时已连接 → allowed=true，且带上 gate 字段', async () => {
  const { handled, out } = await call({
    getCfg: () => cfgWith({ enabled: true, appid: 'a', secret: 's', allow: ['x'] }),
    readFile: () => '',
    files: { probe: '/nope/official-probe.json' },
    getOfficialRuntime: () => ({ enabled: true, ready: true, lastError: '' }),
  });
  assert.equal(handled, true);
  assert.equal(out.ok, true);
  assert.equal(out.allowed, true);
  assert.equal(out.probeSource, 'runtime');
  assert.ok(Array.isArray(out.missing));
});

await check('缺 appid/secret → allowed=false 且 missing 有内容', async () => {
  const { out } = await call({
    getCfg: () => cfgWith({ enabled: false }),
    readFile: () => '',
    files: { probe: '/nope' },
    getOfficialRuntime: () => ({}),
  });
  assert.equal(out.allowed, false);
  const keys = out.missing.map((x) => x.key);
  assert.ok(keys.includes('appid') && keys.includes('secret'));
});

await check('probe 标记文件存在 → probeSource=marker', async () => {
  const { out } = await call({
    getCfg: () => cfgWith({ enabled: true, appid: 'a', secret: 's', allowAll: true }),
    readFile: () => '{"at":1}',
    files: { probe: '/state/official-probe.json' },
    getOfficialRuntime: () => ({}),
  });
  assert.equal(out.probeSource, 'marker');
  assert.equal(out.allowed, true);
});

await check('deps 全空也不炸（返回 ok:true + 未就绪）', async () => {
  const { handled, out } = await call({});
  assert.equal(handled, true);
  assert.equal(out.ok, true);
  assert.equal(out.allowed, false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
