// 静默时段（src/quiet-hours.js）：边界优先，全部离线。
//
// 重点：跨零点、start===end、时区可注入、非法配置抛错而不是静默回退。

import assert from 'node:assert/strict';

const m = await import(new URL('../src/quiet-hours.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
// 固定东八区，避免测试机时区影响结果
const OFFSET = 480;
const at = (h, min = 0) => Date.UTC(2026, 0, 15, h - 8, min);   // 东八区 h 点对应的 UTC

check('parseQuietHours：合法值 / null / 关闭', () => {
  assert.deepEqual(m.parseQuietHours([23, 8]), [23, 8]);
  assert.deepEqual(m.parseQuietHours(['23', '8']), [23, 8]);
  assert.equal(m.parseQuietHours(null), null);
  assert.equal(m.parseQuietHours(undefined), null);
  assert.equal(m.parseQuietHours([8, 8]), null, 'start===end 视为关闭');
});

check('parseQuietHours：非法值抛错（不静默回退）', () => {
  assert.throws(() => m.parseQuietHours([24, 8]), /0~23/);
  assert.throws(() => m.parseQuietHours([-1, 8]), /0~23/);
  assert.throws(() => m.parseQuietHours([1.5, 8]), /0~23/);
  assert.throws(() => m.parseQuietHours([8]), /两个/);
  assert.throws(() => m.parseQuietHours('23-8'), /两个/);
});

check('inQuietHours：跨零点 23~8', () => {
  const r = [23, 8];
  assert.equal(m.inQuietHours(at(23), r, { offsetMin: OFFSET }), true, '23:00 属于');
  assert.equal(m.inQuietHours(at(2), r, { offsetMin: OFFSET }), true, '02:00 属于');
  assert.equal(m.inQuietHours(at(7, 59), r, { offsetMin: OFFSET }), true, '07:59 属于');
  assert.equal(m.inQuietHours(at(8), r, { offsetMin: OFFSET }), false, '08:00 已结束');
  assert.equal(m.inQuietHours(at(22, 59), r, { offsetMin: OFFSET }), false, '22:59 不算');
});

check('inQuietHours：同一天内 13~15', () => {
  const r = [13, 15];
  assert.equal(m.inQuietHours(at(12, 59), r, { offsetMin: OFFSET }), false);
  assert.equal(m.inQuietHours(at(13), r, { offsetMin: OFFSET }), true);
  assert.equal(m.inQuietHours(at(14, 59), r, { offsetMin: OFFSET }), true);
  assert.equal(m.inQuietHours(at(15), r, { offsetMin: OFFSET }), false);
});

check('inQuietHours：关闭时不静默', () => {
  assert.equal(m.inQuietHours(at(3), null, { offsetMin: OFFSET }), false);
  assert.equal(m.inQuietHours(at(3), m.parseQuietHours([8, 8]), { offsetMin: OFFSET }), false);
});

check('inQuietHours：时区偏移会影响判断', () => {
  const r = [23, 8];
  const t = at(23);                                    // 东八区 23:00 = UTC 15:00
  assert.equal(m.inQuietHours(t, r, { offsetMin: 480 }), true);
  assert.equal(m.inQuietHours(t, r, { offsetMin: 0 }), false, 'UTC 视角是 15:00');
});

check('shouldSilenceWake：admin / bootstrap 不受静默限制', () => {
  assert.equal(m.shouldSilenceWake('timeout'), true);
  assert.equal(m.shouldSilenceWake('atMention:小鲸鱼'), true);
  assert.equal(m.shouldSilenceWake('admin'), false);
  assert.equal(m.shouldSilenceWake('bootstrap'), false);
});

check('describeQuietHours：文案', () => {
  assert.match(m.describeQuietHours([23, 8]), /23:00 ~ 08:00/);
  assert.match(m.describeQuietHours(null), /未启用/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }