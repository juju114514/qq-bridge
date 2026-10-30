// 社交模式纯规则（src/domains/social-v2-rules.js）
//
// 四个函数各对应一次线上事故：
//   名单脏数据绕过防永眠 / 历史"晚安"让每轮都退场 /
//   active 模式被误判成沉睡 / 永眠配置没提示

import assert from 'node:assert/strict';

const { normalizeSpeakerIds, hasExplicitEnd, isSleepingConfig, computeWakeSafety } =
  await import(new URL('../src/domains/social-v2-rules.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('名单：只留正整数，去重，上限 20', () => {
  assert.deepEqual(normalizeSpeakerIds(['123', '123', 'null', {}, '-5', '0', '456']), ['123', '456']);
  const many = Array.from({ length: 30 }, (_, i) => String(1000 + i));
  assert.equal(normalizeSpeakerIds(many).length, 20);
});

check('名单：字符串形式也支持（逗号/空格/中文逗号）', () => {
  assert.deepEqual(normalizeSpeakerIds('111, 222，333 444'), ['111', '222', '333', '444']);
});

check('名单：null/undefined → 空数组（不启用）', () => {
  assert.deepEqual(normalizeSpeakerIds(null), []);
  assert.deepEqual(normalizeSpeakerIds(undefined), []);
});

const END_RE = /(?:晚安|睡了|拜拜|88)/;

check('退场：最后一条别人的话是道别 → true', () => {
  assert.equal(hasExplicitEnd({ recentMessages: [{ text: '晚安' }] }, END_RE), true);
});

check('退场：只看最后一条别人说的（自己的话不算）', () => {
  const st = { recentMessages: [{ text: '晚安' }, { text: '那我睡了', isSelf: true }] };
  assert.equal(hasExplicitEnd(st, END_RE), true, '最后一条别人说的仍是晚安');
});

check('退场：更早的道别不算（历史里的晚安不能让每轮都退场）', () => {
  const st = { recentMessages: [{ text: '晚安' }, { text: '今天加班好累' }] };
  assert.equal(hasExplicitEnd(st, END_RE), false);
});

check('退场：没有消息 / 正则非法 → false（不崩）', () => {
  assert.equal(hasExplicitEnd({}, END_RE), false);
  assert.equal(hasExplicitEnd({ recentMessages: [{ text: '晚安' }] }, 'not-a-regex'), false);
});

check('沉睡判定：diving 且非 anyMessage → 沉睡', () => {
  assert.equal(isSleepingConfig({ mode: 'diving' }), true);
  assert.equal(isSleepingConfig({ mode: 'active' }), false);
  assert.equal(isSleepingConfig({ mode: 'diving', triggers: { anyMessage: true } }), false);
  assert.equal(isSleepingConfig(null), false);
});

check('唤醒安全：有 @ 触发器 → hard + guaranteed', () => {
  const r = computeWakeSafety({ triggers: { atMention: true } }, { now: 1000 });
  assert.equal(r.hard, true);
  assert.equal(r.guaranteed, true);
});

check('唤醒安全：全关且无限期 → 永眠（guaranteed=false）', () => {
  const r = computeWakeSafety({ infinite: true, triggers: {} }, { now: 1000 });
  assert.equal(r.guaranteed, false);
});

check('唤醒安全：有限潜水未到期算 timed', () => {
  const r = computeWakeSafety({ infinite: false, sleepUntil: new Date(5000).toISOString(), triggers: {} }, { now: 1000 });
  assert.equal(r.timed, true);
  assert.equal(r.guaranteed, true);
});

check('唤醒安全：指定群友（脏数据）清洗后为空 → 不算 hard', () => {
  const r = computeWakeSafety({ triggers: { speakerIds: ['null', {}] } }, { now: 1000 });
  assert.equal(r.hard, false);
});

check('唤醒安全：超过 24 小时没确认 → stale', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(computeWakeSafety({ triggers: { atMention: true }, confirmedAt: 1000 }, { now: 1000 + day + 1 }).stale, true);
  assert.equal(computeWakeSafety({ triggers: { atMention: true }, confirmedAt: 1000 }, { now: 1000 + day - 1 }).stale, false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }