// 人格语气策略（personaPolicy）：默认不放开、按群覆盖、成人确认、硬底线不可绕过
import assert from 'node:assert/strict';
import { isNeutral, policyBlock, resolvePolicy, hardLimitsBlock, isSafetyWordText, resolveSafetyWords, DEFAULT_SAFETY_WORDS, resolveSafetyConfig, safetyGate, withPause, pauseRemainingSeconds, desiredRoleFor } from '../src/persona-policy.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('默认策略是 neutral，不注入任何东西', () => {
  const p = resolvePolicy({ cfg: {}, key: 'group:1' });
  assert.equal(p.profanity, 'off');
  assert.equal(p.nsfw, 'off');
  assert.equal(isNeutral(p), true);
  assert.equal(policyBlock(p), '');
});

check('全局放开骂人 → 块里有骂人许可、但不含成人内容', () => {
  const p = resolvePolicy({ cfg: { personaPolicy: { profanity: 'strong' } }, key: 'group:1' });
  const block = policyBlock(p);
  assert.match(block, /允许骂人/);
  assert.doesNotMatch(block, /成人向内容/);
});

check('按群覆盖：只对指定群放开', () => {
  const cfg = { personaPolicy: { perGroup: { 'group:42': { profanity: 'mild' } } } };
  assert.equal(resolvePolicy({ cfg, key: 'group:42' }).profanity, 'mild');
  assert.equal(resolvePolicy({ cfg, key: 'group:99' }).profanity, 'off');
});

check('explicit 需要成年确认，没确认自动降级成 suggestive', () => {
  const cfg = { personaPolicy: { nsfw: 'explicit' } };
  const p = resolvePolicy({ cfg, key: 'group:7', adultOk: false });
  assert.equal(p.nsfw, 'suggestive');
  assert.ok(p.downgraded);
  const ok = resolvePolicy({ cfg, key: 'group:7', adultOk: true });
  assert.equal(ok.nsfw, 'explicit');
});

check('requireAdultConfirm=false 时 explicit 不降级', () => {
  const cfg = { personaPolicy: { nsfw: 'explicit', requireAdultConfirm: false } };
  assert.equal(resolvePolicy({ cfg, key: 'group:7' }).nsfw, 'explicit');
});

check('非法档位回落默认（不是抛错）', () => {
  const p = resolvePolicy({ cfg: { personaPolicy: { profanity: 'ultra', nsfw: 'yes' } }, key: 'group:1' });
  assert.equal(p.profanity, 'off');
  assert.equal(p.nsfw, 'off');
});

check('硬底线永远出现在放开后的块里', () => {
  const p = resolvePolicy({ cfg: { personaPolicy: { profanity: 'strong', nsfw: 'explicit', requireAdultConfirm: false } }, key: 'group:1' });
  const block = policyBlock(p);
  assert.match(block, /未成年人/);
  assert.match(block, /真实人物/);
  assert.match(hardLimitsBlock(), /违法内容/);
});

check('note 会透传（按群 note 覆盖全局）', () => {
  const cfg = { personaPolicy: { note: '全局备注', perGroup: { 'group:3': { note: '群备注' } } } };
  assert.match(policyBlock(resolvePolicy({ cfg, key: 'group:3', adultOk: true })), /群备注/);
});


check('安全词：默认清单命中', () => {
  assert.equal(isSafetyWordText('安全词'), true);
  assert.equal(isSafetyWordText('嗯 安全词！'), true);
  assert.equal(isSafetyWordText('今天天气不错'), false);
});

check('安全词：配置覆盖 / 空数组关闭', () => {
  assert.deepEqual(resolveSafetyWords({ personaPolicy: { safetyWords: ['停'] } }), ['停']);
  assert.equal(isSafetyWordText('安全词', resolveSafetyWords({ personaPolicy: { safetyWords: ['停'] } })), false);
  assert.deepEqual(resolveSafetyWords({}), DEFAULT_SAFETY_WORDS);
});


check('安全词动作开关：off 时完全不生效', () => {
  const cfg = { personaPolicy: { safetyAction: 'off' } };
  assert.equal(resolveSafetyConfig(cfg).enabled, false);
  assert.equal(safetyGate({ cfg, key: 'group:1', text: '安全词', paused: {} }).skip, false);
});

check('安全词动作开关：reset 只关策略、不静默', () => {
  const cfg = { personaPolicy: { safetyAction: 'reset' } };
  const g = safetyGate({ cfg, key: 'group:1', text: '安全词', paused: {} });
  assert.equal(g.skip, true);
  assert.equal(g.resetPolicy, true);
  assert.equal(g.pauseMinutes, 0);
  assert.match(g.notify, /已关闭/);
});

check('安全词动作开关：pause 关策略 + 静默 N 分钟', () => {
  const cfg = { personaPolicy: { safetyAction: 'pause', safetyPauseMinutes: 10 } };
  const g = safetyGate({ cfg, key: 'group:1', text: '安全词', paused: {} });
  assert.equal(g.pauseMinutes, 10);
  assert.match(g.notify, /静默 10 分钟/);
});

check('静默期内：普通消息也被跳过（left > 0）', () => {
  const cfg = { personaPolicy: { safetyAction: 'pause', safetyPauseMinutes: 10 } };
  const paused = withPause({}, 'group:1', 10);
  const g = safetyGate({ cfg, key: 'group:1', text: '在吗', paused });
  assert.equal(g.skip, true);
  assert.equal(g.resetPolicy, false);
  assert.ok(g.left > 0);
});

check('静默过期后恢复', () => {
  const paused = { 'group:1': Date.now() - 1000 };
  assert.equal(pauseRemainingSeconds(paused, 'group:1'), 0);
});


check('不开时用基础卡，开了切「放开版」（两张卡，避免示例串台）', () => {
  const cfg = { personaPolicy: { baseRole: '基础卡', intenseRole: '放开版' } };
  assert.equal(desiredRoleFor(resolvePolicy({ cfg: {}, key: 'group:1' }), cfg), '基础卡');
  assert.equal(desiredRoleFor({ profanity: 'strong', nsfw: 'off' }, cfg), '放开版');
  assert.equal(desiredRoleFor({ profanity: 'off', nsfw: 'suggestive' }, cfg), '放开版');
});

check('autoSwitchRole=false 时不切卡', () => {
  const cfg = { personaPolicy: { autoSwitchRole: false, baseRole: '基础卡', intenseRole: '放开版' } };
  assert.equal(desiredRoleFor({ profanity: 'strong' }, cfg), '');
});

check('没配 intenseRole 时不开也回基础卡', () => {
  const cfg = { personaPolicy: { baseRole: '基础卡' } };
  assert.equal(desiredRoleFor({ profanity: 'strong' }, cfg), '');
  assert.equal(desiredRoleFor({ profanity: 'off' }, cfg), '基础卡');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
