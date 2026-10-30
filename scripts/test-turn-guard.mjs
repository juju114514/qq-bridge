// 回合收尾"无行动计数"（src/turn-guard.js）
//
// 这段逻辑原来是 pumpMux 里 25 行内联代码，三处坑都是真实事故：
//   1. turn/start 丢了（重连补发）→ 不能记 miss（否则连续 3 次就重置 AI 自己的唤醒配置）
//   2. 静默回合（摘要投喂）→ 不算无行动
//   3. 只有 turn/start 存在时才能用 lastActionAt 判断"这一轮做了什么"

import assert from 'node:assert/strict';

const { decideNoAction } = await import(new URL('../src/turn-guard.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const base = { mode: 'reserved2', key: 'group:1', turnStart: 1000, limit: 3 };

check('有行动（发过消息）→ 计数清零', () => {
  const r = decideNoAction({ ...base, noActionCount: 2, sendToolHit: true });
  assert.equal(r.count, 0);
  assert.equal(r.reset, false);
});

check('有行动（lastActionAt >= turnStart）→ 计数清零', () => {
  const r = decideNoAction({ ...base, noActionCount: 2, lastActionAt: 1500 });
  assert.equal(r.count, 0);
});

check('没行动 → 计数 +1', () => {
  const r = decideNoAction({ ...base, noActionCount: 0, lastActionAt: 0 });
  assert.equal(r.count, 1);
  assert.equal(r.reset, false);
});

check('连续到阈值 → 要求重置唤醒配置', () => {
  const r = decideNoAction({ ...base, noActionCount: 2, lastActionAt: 0 });
  assert.equal(r.count, 3);
  assert.equal(r.reset, true);
});

check('**turn/start 缺失** → 跳过计数（不能冤枉重连补发的回合）', () => {
  const r = decideNoAction({ ...base, turnStart: 0, noActionCount: 1 });
  assert.equal(r.count, 1, '计数保持原值');
  assert.equal(r.reset, false);
  assert.equal(r.skip, 'no-turn-start');
});

check('静默回合 → 不计数', () => {
  const r = decideNoAction({ ...base, isSilentTurn: true, noActionCount: 1 });
  assert.equal(r.count, 1);
  assert.equal(r.skip, 'silent-turn');
});

check('非 reserved2 / 无 key → 不参与', () => {
  assert.equal(decideNoAction({ ...base, mode: 'chat' }).skip, 'not-reserved2');
  assert.equal(decideNoAction({ ...base, key: '' }).skip, 'not-reserved2');
});

check('阈值可配置，且非法值有兜底', () => {
  const r = decideNoAction({ ...base, noActionCount: 4, limit: 5 });
  assert.equal(r.count, 5);
  assert.equal(r.reset, true);
  const r2 = decideNoAction({ ...base, noActionCount: 0, limit: 0 });
  assert.equal(r2.reset, false, 'limit=0 应兜底成 3');
});

check('turn/start 晚于 lastActionAt → 仍算无行动（上轮的行动不能算到本轮）', () => {
  const r = decideNoAction({ ...base, turnStart: 2000, lastActionAt: 1500 });
  assert.equal(r.count, 1);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }