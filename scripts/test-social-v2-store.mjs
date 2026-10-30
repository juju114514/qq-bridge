// 社交状态的落盘整形（src/domains/social-v2-store.js）
//
// 这些裁剪上限就是"state/social-v2.json 不会无限变大"的唯一保证：
//   一条群消息可能带 3 张图 + 转发 id，recentMessages 不裁 → 文件几十 MB
//   每次发送都 push 一条 sendTimes，不裁 → 一天上万条
// 另外落盘**不能抛**：它在消息路径上，抛了就把消息处理打断。

import assert from 'node:assert/strict';

const { buildSocialV2Snapshot, saveSocialV2StateTo, SOCIAL_V2_TRIM } =
  await import(new URL('../src/domains/social-v2-store.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const st = (over = {}) => ({
  wakeConfig: { mode: 'diving' },
  recentMessages: [],
  unread: [],
  lastWakeReason: '',
  lastAiReplyAt: 0,
  lastActionAt: 0,
  agentToken: 'tok',
  bootstrapSent: false,
  wakeTimes: [],
  sendTimes: [],
  stickerCollectTimes: [],
  activeTopics: [],
  pendingThoughts: [],
  memberImpressions: {},
  ...over
});

check('基本结构：paused + conversations', () => {
  const snap = buildSocialV2Snapshot({ conversations: new Map([['group:1', st()]]), paused: true });
  assert.equal(snap.paused, true);
  assert.deepEqual(Object.keys(snap.conversations), ['group:1']);
  assert.equal(snap.conversations['group:1'].agentToken, 'tok');
});

check('裁剪：recentMessages / unread 只留尾部上限', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ text: `m${i}` }));
  const snap = buildSocialV2Snapshot({ conversations: new Map([['group:1', st({ recentMessages: many, unread: many })]]) });
  const conv = snap.conversations['group:1'];
  assert.equal(conv.recentMessages.length, SOCIAL_V2_TRIM.recentMessages);
  assert.equal(conv.unread.length, SOCIAL_V2_TRIM.unread);
  assert.equal(conv.recentMessages.at(-1).text, 'm499', '必须保留最新的那条');
});

check('裁剪：sendTimes 500 / wakeTimes 200 / topics 50', () => {
  const many = Array.from({ length: 1000 }, (_, i) => i);
  const snap = buildSocialV2Snapshot({
    conversations: new Map([['group:1', st({ sendTimes: many, wakeTimes: many, activeTopics: many, pendingThoughts: many })]])
  });
  const c = snap.conversations['group:1'];
  assert.equal(c.sendTimes.length, 500);
  assert.equal(c.wakeTimes.length, 200);
  assert.equal(c.activeTopics.length, 50);
  assert.equal(c.pendingThoughts.length, 50);
  assert.equal(c.sendTimes.at(-1), 999, '保留最新的');
});

check('非数组字段落盘成空数组（不是 undefined）', () => {
  const snap = buildSocialV2Snapshot({ conversations: new Map([['group:1', st({ recentMessages: undefined, sendTimes: 'oops' })]]) });
  assert.deepEqual(snap.conversations['group:1'].recentMessages, []);
  assert.deepEqual(snap.conversations['group:1'].sendTimes, []);
});

check('seenForwardIds：从独立 Map 取，且有上限', () => {
  const ids = new Set(Array.from({ length: 1500 }, (_, i) => `f${i}`));
  const snap = buildSocialV2Snapshot({
    conversations: new Map([['group:1', st()]]),
    seenForwardIds: new Map([['group:1', ids]])
  });
  const list = snap.conversations['group:1'].seenForwardIds;
  assert.equal(list.length, SOCIAL_V2_TRIM.seenForwardIds);
  assert.equal(list.at(-1), 'f1499', '保留最新的');
});

check('memberImpressions：非对象 → {}（防止写进 undefined 让读的时候炸）', () => {
  const snap = buildSocialV2Snapshot({ conversations: new Map([['g:1', st({ memberImpressions: 'bad' })]]) });
  assert.deepEqual(snap.conversations['g:1'].memberImpressions, {});
});

check('落盘失败只记日志、不抛（消息路径不能被打断）', () => {
  const logs = [];
  const r = saveSocialV2StateTo({
    file: 'x', conversations: new Map(), atomicWriteJson: () => { throw new Error('disk full'); },
    log: (...a) => logs.push(a.join(' '))
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /disk full/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /保存 socialV2 状态失败/);
});

check('落盘成功返回 ok:true 并把整理后的对象交给 writer', () => {
  let written = null;
  const r = saveSocialV2StateTo({
    file: 'x', conversations: new Map([['g:1', st()]]), atomicWriteJson: (_f, obj) => { written = obj; }
  });
  assert.equal(r.ok, true);
  assert.equal(written.paused, false);
  assert.ok(written.conversations['g:1']);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }