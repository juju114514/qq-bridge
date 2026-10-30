// 唤醒配置域（src/domains/wake-config.js）
//
// 波次 1 第一个真正"搬出来的域"。三条规则都必须钉住：
//   1. 显式设过的会话不能被默认值覆盖（覆盖 = AI 自己设的唤醒条件被吞）
//   2. 硬边界优先于推荐区间（否则配了 sleepMax 也不生效）
//   3. 触发器白名单（防垃圾键撑大状态文件）

import assert from 'node:assert/strict';

const { createWakeConfigDomain, WAKE_TRIGGER_KEYS } = await import(new URL('../src/domains/wake-config.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const domainWith = (wake = {}) => createWakeConfigDomain({ getCfg: () => ({ socialV2: { wake } }) });

check('默认：潜水模式、无限期、触发器按推荐值给', () => {
  const d = domainWith();
  const w = d.defaultWakeConfig();
  assert.equal(w.mode, 'diving');
  assert.equal(w.infinite, true);
  assert.equal(w.sleepUntil, null);
  assert.equal(w.triggers.atMention, true);
  assert.deepEqual(w.triggers.speakerIds, []);
  assert.equal(w.confirmedBy, 'default');
  assert.equal(w.noActionCount, 0);
});

check('推荐 active 模式 → anyMessage 自动打开', () => {
  const d = domainWith({ defaultMode: 'active' });
  const w = d.defaultWakeConfig();
  assert.equal(w.mode, 'active');
  assert.equal(w.triggers.anyMessage, true);
});

check('有限潜水：时长落在推荐区间内，且 sleepUntil 是未来时间', () => {
  const fixed = 1_000_000;
  const d = createWakeConfigDomain({
    getCfg: () => ({ socialV2: { wake: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 60000, recommendedSleepMaxMs: 120000 } } }),
    now: () => fixed
  });
  const w = d.defaultWakeConfig();
  assert.equal(w.infinite, false);
  const at = Date.parse(w.sleepUntil);
  assert.ok(at - fixed >= 60000 && at - fixed <= 120000, `应在 60~120 秒之间，实际 ${at - fixed}`);
});

check('硬边界优先：推荐区间超出 sleepMax 时被夹住', () => {
  const fixed = 1_000_000;
  const d = createWakeConfigDomain({
    getCfg: () => ({ socialV2: { wake: { recommendedDefaultInfinite: false, recommendedSleepMinMs: 600000, recommendedSleepMaxMs: 900000, sleepMaxMs: 120000 } } }),
    now: () => fixed
  });
  const w = d.defaultWakeConfig();
  assert.equal(Date.parse(w.sleepUntil) - fixed, 120000, '必须被 sleepMaxMs 夹到 120 秒');
});

check('刷新：confirmedBy=default 才会被覆盖，且保留统计字段', () => {
  const d = domainWith();
  const st = { wakeConfig: { ...d.defaultWakeConfig(), lastWakeAt: 123, wakeCount: 7, noActionCount: 2 } };
  const changed = d.refreshDefault(st);
  assert.equal(changed, true);
  assert.equal(st.wakeConfig.lastWakeAt, 123, '统计字段要保留');
  assert.equal(st.wakeConfig.wakeCount, 7);
  assert.equal(st.wakeConfig.noActionCount, 2);
});

check('刷新：AI 显式设过的**绝不覆盖**', () => {
  const d = domainWith();
  const st = { wakeConfig: { ...d.defaultWakeConfig(), confirmedBy: 'owner', triggers: { keywords: ['上线'] } } };
  const changed = d.refreshDefault(st);
  assert.equal(changed, false);
  assert.deepEqual(st.wakeConfig.triggers.keywords, ['上线'], '显式设置必须原样保留');
});

check('刷新：没有 wakeConfig 的会话不报错', () => {
  const d = domainWith();
  assert.equal(d.refreshDefault({}), false);
  assert.equal(d.refreshDefault(null), false);
});

check('触发器白名单：未知键被丢弃，缺省回落到 fallback', () => {
  const d = domainWith();
  const out = d.pickTriggers({ atMention: false, evilKey: 'x'.repeat(1000) }, { poke: true });
  assert.equal(out.atMention, false);
  assert.equal(out.poke, true);
  assert.equal('evilKey' in out, false, '未知键必须被丢掉');
  for (const k of Object.keys(out)) assert.ok(WAKE_TRIGGER_KEYS.includes(k), `非法键外泄: ${k}`);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }