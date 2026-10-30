// 进线媒体阶段（src/incoming-media.js）—— 波次 3 第一块
//
// 两条硬约束都不能破：
//   · 表情记录失败**绝不影响收消息**（整段 try/catch，失败静默返回 0）
//   · 媒体引用必须**有界**（超上限删最旧，否则长跑必涨内存）

import assert from 'node:assert/strict';

const { capturePendingStickers, rememberMessageMedia } =
  await import(new URL('../src/incoming-media.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const stickerEvent = (types) => ({
  message_id: 9001,
  sender: { card: '老王' },
  message: types.map((t) => ({ type: t, data: {} }))
});

check('表情：图/表情都入队，带会话 scope 与来源', () => {
  const added = [];
  const n = capturePendingStickers({
    enabled: true, key: 'group:1', event: stickerEvent(['image', 'face', 'mface']),
    stickerScopeOf: () => 'group:1', stickerPending: { add: (sc, item) => added.push([sc, item]) }
  });
  assert.equal(n, 3);
  assert.equal(added[0][0], 'group:1');
  assert.equal(added[0][1].id, '9001:0', 'id 要能定位到这条消息的第几个媒体');
  assert.equal(added[0][1].from, '老王');
});

check('表情：一条消息最多取 3 个（防止刷屏塞爆队列）', () => {
  let count = 0;
  capturePendingStickers({
    enabled: true, key: 'group:1', event: stickerEvent(['image', 'image', 'image', 'image', 'image']),
    stickerScopeOf: () => 'group:1', stickerPending: { add: () => { count += 1; } }
  });
  assert.equal(count, 3);
});

check('表情：功能关闭 → 不入队', () => {
  let count = 0;
  const n = capturePendingStickers({
    enabled: false, key: 'group:1', event: stickerEvent(['image']),
    stickerScopeOf: () => 'x', stickerPending: { add: () => { count += 1; } }
  });
  assert.equal(n, 0);
  assert.equal(count, 0);
});

check('表情：**记录失败绝不影响收消息**（不抛、返回 0）', () => {
  const n = capturePendingStickers({
    enabled: true, key: 'group:1', event: stickerEvent(['image']),
    stickerScopeOf: () => { throw new Error('boom'); },
    stickerPending: { add: () => {} }
  });
  assert.equal(n, 0, '失败必须静默');
});

check('媒体引用：按 message_id 与 seq 各存一份', () => {
  const store = new Map();
  const media = [{ type: 'image' }];
  const n = rememberMessageMedia({ key: 'group:1', event: { message_id: 111, message_seq: 222 }, mediaList: media, messageMediaStore: store });
  assert.equal(n, 2);
  assert.deepEqual(store.get('group:1').get('111'), media);
  assert.deepEqual(store.get('group:1').get('222'), media);
});

check('媒体引用：没有媒体 / 没有引用 id → 不写', () => {
  const store = new Map();
  assert.equal(rememberMessageMedia({ key: 'g', event: { message_id: 1 }, mediaList: [], messageMediaStore: store }), 0);
  assert.equal(rememberMessageMedia({ key: 'g', event: {}, mediaList: [{ type: 'image' }], messageMediaStore: store }), 0);
  assert.equal(store.size, 0);
});

check('媒体引用：**有界**，超上限删最旧', () => {
  const store = new Map();
  for (let i = 1; i <= 10; i += 1) {
    rememberMessageMedia({ key: 'g', event: { message_id: i }, mediaList: [{ i }], messageMediaStore: store, maxPerKey: 3 });
  }
  const byRef = store.get('g');
  assert.equal(byRef.size, 3, '只留 3 条');
  assert.equal(byRef.has('1'), false, '最旧的被删');
  assert.equal(byRef.has('10'), true, '最新的还在');
});

check('媒体引用：不同会话各自一个 Map（群聊的图绝不喂给私聊）', () => {
  const store = new Map();
  rememberMessageMedia({ key: 'group:1', event: { message_id: 1 }, mediaList: [{ a: 1 }], messageMediaStore: store });
  rememberMessageMedia({ key: 'private:2', event: { message_id: 1 }, mediaList: [{ b: 2 }], messageMediaStore: store });
  assert.equal(store.get('group:1').size, 1);
  assert.equal(store.get('private:2').size, 1);
  assert.notDeepEqual(store.get('group:1').get('1'), store.get('private:2').get('1'));
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }