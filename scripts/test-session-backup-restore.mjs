// 会话备份恢复（0.4.99）：合并去重 / 老备份兜底 / 计数
import assert from 'node:assert/strict';

const m = await import(new URL('../src/session-backup-restore.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('合并：live 优先，snapshot 里多出来的补进去，按 seq 排序', () => {
  const live = [{ seq: 2, messageId: 'b', text: 'live-2' }, { seq: 3, messageId: 'c', text: 'live-3' }];
  const snap = [{ seq: 1, messageId: 'a', text: 'snap-1' }, { seq: 2, messageId: 'b', text: 'snap-2' }];
  const r = m.mergeMessages(live, snap);
  assert.deepEqual(r.list.map((x) => x.text), ['snap-1', 'live-2', 'live-3']);
  assert.equal(r.added, 1, '只补了 1 条');
});

check('去重按 messageId 优先于 seq', () => {
  const live = [{ messageId: 'X', text: 'a' }];
  const snap = [{ messageId: 'X', text: 'a-again' }];
  const r = m.mergeMessages(live, snap);
  assert.equal(r.list.length, 1);
  assert.equal(r.added, 0);
});

check('最多保留 max 条（默认 200）', () => {
  const live = Array.from({ length: 150 }, (_, i) => ({ seq: i, text: `l${i}` }));
  const snap = Array.from({ length: 150 }, (_, i) => ({ seq: 1000 + i, text: `s${i}` }));
  const r = m.mergeMessages(live, snap);
  assert.equal(r.list.length, 200);
  assert.equal(r.list[r.list.length - 1].text, 's149', '保留最新的');
});

check('老备份（只有 unread）也能恢复', () => {
  const snapshot = { key: 'group:100000001', messages: [], unread: [{ seq: 445, messageId: 'a', text: '有备份' }, { seq: 446, messageId: 'b', text: '烧烧你的' }] };
  const patch = m.buildRestorePatch({ snapshot, live: {} });
  assert.equal(patch.recentMessages.length, 2, 'unread 应兜底进历史');
  assert.equal(patch.addedRecent, 2);
  assert.equal(patch.unread.length, 0, '默认不把历史塞进未读（否则会触发旧消息回复）');
  const withUnread = m.buildRestorePatch({ snapshot, live: {}, includeUnread: true });
  assert.equal(withUnread.unread.length, 2, '显式 includeUnread 时才恢复未读');
});

check('恢复不重复：live 已有同样的消息 → added 为 0', () => {
  const msg = { seq: 445, messageId: 'a', text: '有备份' };
  const patch = m.buildRestorePatch({
    snapshot: { key: 'group:1', unread: [msg] },
    live: { recentMessages: [msg], unread: [msg] }
  });
  assert.equal(patch.addedRecent, 0);
  assert.equal(patch.addedUnread, 0);
});

check('snapshot 有 recentMessages 时优先用它（新备份）', () => {
  const patch = m.buildRestorePatch({
    snapshot: { key: 'group:1', recentMessages: [{ seq: 1, text: 'new' }], unread: [{ seq: 9, text: 'u' }] },
    live: {}
  });
  assert.equal(patch.recentMessages.length, 1);
  assert.equal(patch.recentMessages[0].text, 'new');
});

check('restorableCount：三种来源取最大，界面上显示"能恢复几条"', () => {
  assert.deepEqual(m.restorableCount({ unread: [1, 2] }), { recent: 2, unread: 2, longTerm: 0 });
  assert.deepEqual(m.restorableCount({ recentMessages: [1, 2, 3], unread: [1] }), { recent: 3, unread: 1, longTerm: 0 });
  assert.deepEqual(m.restorableCount({}), { recent: 0, unread: 0, longTerm: 0 });
});

check('乱数据不炸（null / 非数组 / 缺字段）', () => {
  assert.deepEqual(m.mergeMessages(null, undefined).list, []);
  assert.deepEqual(m.buildRestorePatch({}).recentMessages, []);
  assert.deepEqual(m.restorableCount(null), { recent: 0, unread: 0, longTerm: 0 });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
