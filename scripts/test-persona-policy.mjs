// 人格语气策略（personaPolicy）：默认不放开、按群覆盖、成人确认、硬底线不可绕过
import assert from 'node:assert/strict';
import { isNeutral, policyBlock, resolvePolicy, hardLimitsBlock } from '../src/persona-policy.js';

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

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
