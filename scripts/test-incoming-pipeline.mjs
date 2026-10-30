// 进线主流程的端到端测试（波次 3 的前置回归网）
//
// 目的：在把 handleIncoming 串成"显式管道"之前，先把**它现在到底做了什么**钉住。
// 这里不测内部实现，只测用户能感知的结果：
//   · 允许的群 + 被 @ → 真的排了唤醒
//   · 不在白名单的群 → 什么都不做（连状态都不建）
//   · 没人叫它 → 只记未读，不唤醒
//   · 静默时段 + 只有概率触发 → 不唤醒

import assert from 'node:assert/strict';

const { bridgeHarness } = await import(new URL('../scripts/audit-bridge-harness.mjs', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const GROUP = '456';
const USER = 789;

function groupEvent(text, { atBot = false } = {}) {
  const message = [];
  if (atBot) message.push({ type: 'at', data: { qq: '123' } });
  message.push({ type: 'text', data: { text } });
  return {
    post_type: 'message', message_type: 'group', group_id: Number(GROUP), user_id: USER,
    self_id: 123, message_id: 1001, raw_message: text, message,
    sender: { user_id: USER, nickname: '老王', card: '老王' }
  };
}

async function setup(cfgOver = {}) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 123,
      allow: { private: ['123'], groups: [GROUP] },
      socialV2: { enabled: true, wake: { batchWindowMs: 1000, ...(cfgOver.socialV2?.wake ?? {}) }, ...(cfgOver.socialV2 ?? {}) },
      ...cfgOver
    }
  });
  h.setMode('reserved2');
  return h;
}


/** 把会话标成"已经 bootstrap 过"，否则第一条消息总是会触发首次唤醒（那是设计，不是 bug）。 */
function primeBootstrap(h, key = `group:${GROUP}`) {
  const st = h.getSocialV2State(key);
  st.bootstrapSent = true;
  return st;
}

const wokeUp = (h, key = `group:${GROUP}`) => {
  const st = h.socialV2.conversations.get(key);
  return Boolean(st && (st.pendingWakeTimer || st.pendingWakeReasons?.length));
};

await check('白名单群 + @机器人 → 排了唤醒', async () => {
  const h = await setup();
  await h.handleIncoming('group', GROUP, groupEvent('你好', { atBot: true }), h.cfg);
  await wait(200);
  assert.ok(wokeUp(h), '被 @ 之后必须有待唤醒定时器');
  await h.close();
});

await check('不在白名单的群 → 什么都不做（不建状态）', async () => {
  const h = await setup();
  await h.handleIncoming('group', '999999', groupEvent('你好', { atBot: true }), h.cfg);
  await wait(200);
  assert.equal(h.socialV2.conversations.has('group:999999'), false, '没权限的群不该留下状态');
  await h.close();
});

await check('没人叫它（无 @、无关键词）→ 只记未读，不唤醒', async () => {
  const h = await setup();
  // 先标记 bootstrap 已发：否则首条消息按设计会触发"首次唤醒"（带人设介绍）
  primeBootstrap(h);
  await h.handleIncoming('group', GROUP, groupEvent('今天天气不错'), h.cfg);
  await wait(200);
  const st = h.socialV2.conversations.get(`group:${GROUP}`);
  assert.ok(st, '应该记录会话状态（要能读到未读）');
  assert.equal(Boolean(st.pendingWakeTimer), false, '不该排唤醒');
  assert.ok((st.unread?.length ?? 0) > 0, '应该记进未读');
  await h.close();
});

await check('静默时段 + 只有概率触发 → 不唤醒', async () => {
  // 把静默时段设成"全天"，概率换成 1（必然命中概率），观察是否被静默拦下
  const h = await setup({
    socialV2: {
      enabled: true,
      // 静默时段是**数组** [startHour, endHour]（0~23 整数，start===end 视为关闭）
      quietHours: [0, 23],
      wake: { batchWindowMs: 1000, alwaysKeywords: [] }
    }
  });
  const key = `group:${GROUP}`;
  const st = primeBootstrap(h, key);
  st.wakeConfig.triggers = { ...st.wakeConfig.triggers, probability: 1, atMention: false, nameMention: false, keywords: [] };
  await h.handleIncoming('group', GROUP, groupEvent('随便说点什么'), h.cfg);
  await wait(200);
  const after = h.getSocialV2State(key);
  assert.equal(Boolean(after.pendingWakeTimer), false, '静默时段不该被概率唤醒叫起来');
  await h.close();
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }