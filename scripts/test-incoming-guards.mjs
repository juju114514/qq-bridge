// 入站闸门（src/incoming-guards.js）：顺序错一步就漏消息或吞消息。
//
// 重点用例：
//   · 只引用机器人、不附文字 → 必须继续（不能当空消息丢）
//   · 官方"只 @ 一下" → 合成一句上下文，不能丢
//   · 有挂起提问 → 当回答处理并停止
//   · 静默模式 → 群友消息停止、管理员继续

import assert from 'node:assert/strict';

const { createIncomingGuards } = await import(new URL('../src/incoming-guards.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

function makeGuards({ quote = false, mode = 'active', pendingEntry = null, allowed = true } = {}) {
  const calls = { activity: [], log: [], remembered: [], answered: [] };
  const g = createIncomingGuards({
    log: (m) => calls.log.push(m),
    appendActivity: (m) => calls.activity.push(m),
    getCfg: () => ({ ownerQQ: '10001' }),
    isSessionAllowedInCurrentMode: () => allowed,
    isQuoteTargetSelf: async () => quote,
    rememberPersonInMessage: (kind, id) => calls.remembered.push(`${kind}:${id}`),
    readRoleState: () => ({ mode }),
    handlePendingAnswer: async (p, text) => calls.answered.push(text),
    pending: new Map(pendingEntry ? [[pendingEntry.key, pendingEntry.value]] : [])
  });
  return { g, calls };
}

const base = { kind: 'private', id: '10001', textContent: 'hi', event: { user_id: '10001' } };

await check('普通消息：继续，返回 isOwner', async () => {
  const { g } = makeGuards();
  const r = await g.gate({ ...base, key: 'private:10001', plainContent: '你好' });
  assert.equal(r.stop, false);
  assert.equal(r.isOwner, true);
  assert.equal(r.plainContent, '你好');
});

await check('空消息且非 @/引用：停止（empty）', async () => {
  const { g } = makeGuards();
  const r = await g.gate({ ...base, key: 'group:2', plainContent: '' });
  assert.equal(r.stop, true);
  assert.equal(r.reason, 'empty');
});

await check('只引用机器人、不附文字：必须继续（不能当空消息丢）', async () => {
  const { g } = makeGuards({ quote: true });
  const r = await g.gate({ ...base, key: 'group:2', plainContent: '' });
  assert.equal(r.stop, false, '引用机器人自己 = 在跟它说话');
});

await check('官方只 @ 一下（带附件）：合成上下文并继续', async () => {
  const { g } = makeGuards();
  const event = { user_id: '20002', __official: { atBot: true, attachments: [{}, {}] } };
  const r = await g.gate({ ...base, key: 'group:official-x', event, plainContent: '' });
  assert.equal(r.stop, false);
  assert.match(r.plainContent, /带了 2 个附件/);
  assert.equal(r.isOwner, false);
});

await check('有挂起提问：当回答处理并停止', async () => {
  const { g, calls } = makeGuards({ pendingEntry: { key: 'private:10001', value: { kind: 'question' } } });
  const r = await g.gate({ ...base, key: 'private:10001', plainContent: '要' });
  assert.equal(r.stop, true);
  assert.equal(r.reason, 'pending-answer');
  assert.deepEqual(calls.answered, ['要']);
});

await check('静默模式：群友停止、管理员继续', async () => {
  const member = makeGuards({ mode: 'silent' });
  const r1 = await member.g.gate({ ...base, key: 'group:2', event: { user_id: '20002' }, plainContent: '在吗' });
  assert.equal(r1.stop, true);
  assert.equal(r1.reason, 'silent');
  assert.ok(member.calls.activity.length > 0, '静默模式要记一条 activity');

  const owner = makeGuards({ mode: 'silent' });
  const r2 = await owner.g.gate({ ...base, key: 'private:10001', plainContent: '在吗' });
  assert.equal(r2.stop, false, '管理员不受静默限制');
});

await check('会话不在当前模式允许范围：直接停止', async () => {
  const { g } = makeGuards({ allowed: false });
  const r = await g.gate({ ...base, key: 'group:2', plainContent: 'hi' });
  assert.equal(r.stop, true);
  assert.equal(r.reason, 'mode');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }