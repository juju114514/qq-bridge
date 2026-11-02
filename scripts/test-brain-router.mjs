// 大脑路由（P1：在家用 PC、出门用手机）
import assert from 'node:assert/strict';

const { createBrainRouter, BRAIN_LOCAL, BRAIN_DSH } = await import(new URL('../src/agent/brain-router.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

/** 可控时钟 + 可控探测结果 */
function harness({ results, initial = BRAIN_LOCAL, opts = {} } = {}) {
  let t = 1_000_000;
  let i = 0;
  const router = createBrainRouter({
    initial,
    now: () => t,
    cooldownMs: opts.cooldownMs ?? 30000,
    failThreshold: opts.failThreshold ?? 3,
    recoverThreshold: opts.recoverThreshold ?? 2,
    probe: async () => ({ ok: results[Math.min(i++, results.length - 1)] }),
    log: () => {}
  });
  return { router, advance: (ms) => { t += ms; } };
}

await check('默认落在本地（没配中继就不该幻想有 PC）', () => {
  const { router } = harness({ results: [false] });
  assert.equal(router.brain, BRAIN_LOCAL);
});

await check('一次抖动不切换（连续失败 3 次才掉线）', async () => {
  const { router, advance } = harness({ results: [false, true, false], initial: BRAIN_DSH });
  advance(60000);
  await router.tick();          // 失败 1
  advance(60000);
  await router.tick();          // 成功 → 计数清零
  advance(60000);
  await router.tick();          // 失败 1
  assert.equal(router.brain, BRAIN_DSH, '不应该因为零星失败就切走');
});

await check('连续 3 次失败 → 切本地', async () => {
  const { router, advance } = harness({ results: [false], initial: BRAIN_DSH });
  for (let k = 0; k < 3; k += 1) { advance(60000); await router.tick(); }
  assert.equal(router.brain, BRAIN_LOCAL);
});

await check('冷却期内不切（防止边界反复横跳）', async () => {
  // 先制造一次切换（进入冷却），随后时钟不动，再怎么失败也不该再切
  const { router, advance } = harness({ results: [false], initial: BRAIN_DSH, opts: { cooldownMs: 10 * 60 * 1000 } });
  advance(60000);
  await router.tick();
  await router.tick();
  await router.tick();          // 第 3 次失败 → 切到 local，进入冷却
  assert.equal(router.brain, BRAIN_LOCAL);
  for (let k = 0; k < 4; k += 1) await router.tick();   // 时钟不动
  assert.equal(router.brain, BRAIN_LOCAL, '冷却期内不该再切');
});

await check('恢复：连续 2 次可达才回 DSH', async () => {
  const { router, advance } = harness({ results: [true], initial: BRAIN_LOCAL });
  advance(60000);
  await router.tick();
  assert.equal(router.brain, BRAIN_LOCAL, '一次可达还不够');
  advance(60000);
  await router.tick();
  assert.equal(router.brain, BRAIN_DSH);
});

await check('探测抛异常当作失败，不冒泡', async () => {
  let t = 0;
  const router = createBrainRouter({
    now: () => (t += 60000),
    cooldownMs: 0,
    failThreshold: 1,
    initial: BRAIN_DSH,
    probe: async () => { throw new Error('ECONNREFUSED'); },
    log: () => {}
  });
  const r = await router.tick();
  assert.equal(r.brain, BRAIN_LOCAL);
  assert.equal(r.probeOk, false);
});

await check('status 带历史（控制台要能看出"什么时候切的、为什么"）', async () => {
  const { router, advance } = harness({ results: [false], initial: BRAIN_DSH });
  for (let k = 0; k < 3; k += 1) { advance(60000); await router.tick(); }
  const s = router.status();
  assert.equal(s.brain, BRAIN_LOCAL);
  assert.ok(s.history.length >= 1);
  assert.match(s.history.at(-1).reason, /不可达/);
});

await check('手动切换会进入冷却（避免定时探测马上抢回去）', async () => {
  const { router, advance } = harness({ results: [true], initial: BRAIN_LOCAL, opts: { cooldownMs: 60000 } });
  router.force(BRAIN_DSH, 'manual');
  assert.equal(router.brain, BRAIN_DSH);
  advance(1000);
  await router.tick();     // 即便探测成功，冷却未过也不该再"切"
  assert.equal(router.brain, BRAIN_DSH);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
