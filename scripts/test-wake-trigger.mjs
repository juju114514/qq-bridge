// 唤醒判定（src/domains/wake-trigger.js）—— 波次 2 第一块
//
// 这是社交行为的入口闸门，判错只有两种后果，而且都不报错：
//   该唤醒没唤醒 → AI 像死了一样不说话
//   不该唤醒却唤醒 → 每条群消息都烧一次 token
//
// 返回值是**对象** `{ reason, redPacket? }`（不是字符串）：
// 红包这种"带上下文的原因"要能把数据带下去，以后再加同类原因不用改签名。

import assert from 'node:assert/strict';

const { evaluateWakeTrigger } = await import(new URL('../src/domains/wake-trigger.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const base = (triggers = {}, over = {}) => ({ kind: 'group', wakeConfig: { triggers }, event: {}, plainContent: '', ...over });
const textEvent = (text) => ({ message: [{ type: 'text', data: { text } }] });
const reasonOf = (v) => (v ? v.reason : null);

check('私聊一律唤醒（不需要触发器）', () => {
  assert.equal(reasonOf(evaluateWakeTrigger(base({}, { kind: 'private' }))), 'private');
});

check('anyMessage：开着一律唤醒', () => {
  assert.equal(reasonOf(evaluateWakeTrigger(base({ anyMessage: true }))), 'anyMessage');
});

check('atMention：消息里有 at 机器人（数字 qq 比对）', () => {
  const ev = { self_id: 123, message: [{ type: 'at', data: { qq: '123' } }] };
  assert.equal(reasonOf(evaluateWakeTrigger(base({ atMention: true }, { event: ev }))), 'atMention');
});

check('atMention：at 的是别人 → 不唤醒', () => {
  const ev = { self_id: 123, message: [{ type: 'at', data: { qq: '999' } }] };
  assert.equal(evaluateWakeTrigger(base({ atMention: true }, { event: ev })), null);
});

check('atMention：官方通道没有 at 段，靠 __official.atBot 标记', () => {
  const ev = { __official: { atBot: true } };
  assert.equal(reasonOf(evaluateWakeTrigger(base({ atMention: true }, { event: ev }))), 'atMention');
});

check('atMention：引用了机器人的消息也算被叫', () => {
  assert.equal(reasonOf(evaluateWakeTrigger(base({ atMention: true }, { quoteTargetIsSelf: true }))), 'atMention');
});

check('nameMention：只认当前消息的文字，引用里的旧昵称不算', () => {
  const hits = evaluateWakeTrigger(base({ nameMention: true }, { selfNickname: '小鲸鱼', plainContent: '小鲸鱼在吗' }));
  assert.equal(reasonOf(hits), 'nameMention');
  const misses = evaluateWakeTrigger(base({ nameMention: true }, {
    selfNickname: '小鲸鱼',
    plainContent: '今天好热',
    textContent: '[引用 张三：小鲸鱼真可爱] 今天好热'
  }));
  assert.equal(misses, null, '引用里的昵称不能算叫名字');
});

check('keywords：长关键词用包含匹配', () => {
  assert.equal(reasonOf(evaluateWakeTrigger(base({ keywords: ['部署'] }, { plainContent: '今晚要部署一下' }))), 'keyword:部署');
});

check('keywords：<=4 位英文用词边界，避免 ADS/BDSM 误触发', () => {
  const tr = { keywords: ['DS'] };
  assert.equal(reasonOf(evaluateWakeTrigger(base(tr, { plainContent: 'DS 好用吗' }))), 'keyword:DS');
  assert.equal(evaluateWakeTrigger(base(tr, { plainContent: '这个 ADS 方案不错' })), null, 'ADS 不该命中 DS');
  assert.equal(evaluateWakeTrigger(base(tr, { plainContent: 'BDSM 话题' })), null);
});

check('question：只有"在问我"才唤醒', () => {
  const tr = { question: true };
  assert.equal(reasonOf(evaluateWakeTrigger(base(tr, { plainContent: '怎么用？', isDirectedAtAi: () => true }))), 'question');
  assert.equal(evaluateWakeTrigger(base(tr, { plainContent: '怎么用？', isDirectedAtAi: () => false })), null);
});

check('speakerIds：指定群友发言就唤醒，理由里带名字', () => {
  const ev = { user_id: 456, sender: { card: '老王' } };
  assert.equal(reasonOf(evaluateWakeTrigger(base({ speakerIds: ['456'] }, { event: ev }))), 'speaker:老王');
  assert.equal(evaluateWakeTrigger(base({ speakerIds: ['456'] }, { event: { user_id: 789 } })), null);
});

check('alwaysKeywords：常驻词命中就算唤醒（不受会话配置影响）', () => {
  const v = evaluateWakeTrigger(base({}, { plainContent: '小鲸鱼出来', alwaysKeywords: ['小鲸鱼'] }));
  assert.equal(reasonOf(v), 'always:小鲸鱼');
});

check('probability：随机插话；lockProbability 时忽略', () => {
  const tr = { probability: 0.5 };
  assert.equal(reasonOf(evaluateWakeTrigger(base(tr, { random: () => 0.1 }))), 'probability');
  assert.equal(evaluateWakeTrigger(base(tr, { random: () => 0.9 })), null);
  assert.equal(evaluateWakeTrigger(base(tr, { random: () => 0.1, lockProbability: true })), null, '锁定后一律不随机唤醒');
});

check('什么都不配 → 不唤醒（不是崩）', () => {
  assert.equal(evaluateWakeTrigger(base({})), null);
  assert.equal(evaluateWakeTrigger({ kind: 'group' }), null);
});

check('红包（真）：比 @ 还硬，直接唤醒并带上红包数据', () => {
  const ev = { message: [{ type: 'redbag', data: { greeting: '新年快乐' } }] };
  const v = evaluateWakeTrigger(base({ atMention: true }, { event: ev, plainContent: '抢' }));
  assert.equal(reasonOf(v), 'redPacket');
  assert.equal(v.redPacket.kind, 'real');
  assert.equal(v.redPacket.greeting, '新年快乐');
});

check('红包（假）：手打 [QQ红包] 也算，标成 fake', () => {
  const v = evaluateWakeTrigger(base({}, { event: textEvent('[QQ红包] 谁来一个') }));
  assert.equal(reasonOf(v), 'redPacket');
  assert.equal(v.redPacket.kind, 'fake');
});

check('红包优先于 anyMessage：同时成立时按红包记', () => {
  const ev = { message: [{ type: 'redbag', data: { greeting: '恭喜发财' } }] };
  const v = evaluateWakeTrigger(base({ anyMessage: true }, { event: ev }));
  assert.equal(reasonOf(v), 'redPacket', '红包带数据，不能被 anyMessage 盖掉');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }