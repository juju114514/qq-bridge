// QQ 官方机器人客户端（src/qqbot-official.js）的契约测试：全离线，不联网。
//
// 这套协议与 OneBot 完全不同（token / gateway / openid / msg_id 被动回复 5 次上限），
// 所以纯函数与计数逻辑必须钉住——真机上出问题最难查的就是这几处约定。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { stripMention, toBridgeEvent, ReplySeqTracker, OfficialQqBot, INTENT_GROUP_AND_C2C } = await import(
  new URL('../src/qqbot-official.js', import.meta.url).href
);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 1. 文本清洗 ──────────────────────────────────────────────────────────
check('stripMention：去掉 <@!id> 占位符与首部空白，不动正文', () => {
  assert.equal(stripMention('<@!123456> 你好呀'), '你好呀');
  assert.equal(stripMention('<@123>  /role 小鲸鱼'), '/role 小鲸鱼');
  assert.equal(stripMention('  前后空白  '), '前后空白');
  assert.equal(stripMention(''), '');
  assert.equal(stripMention(null), '');
  // 正文里的尖括号不应被误删
  assert.equal(stripMention('看 <b> 标签'), '看 <b> 标签');
});

// ── 2. 事件翻译 ──────────────────────────────────────────────────────────
check('toBridgeEvent：群 @ 消息 → kind=group + group_openid', () => {
  const e = toBridgeEvent('GROUP_AT_MESSAGE_CREATE', {
    id: 'MSG1',
    content: '<@!999> 今天吃什么',
    group_openid: 'G_OPENID_1',
    author: { member_openid: 'M_OPENID_9', username: '大肥鱼' },
    timestamp: '1793201642'
  });
  assert.equal(e.transport, 'official');
  assert.equal(e.kind, 'group');
  assert.equal(e.id, 'G_OPENID_1', 'id 必须是 group_openid，不是 QQ 号');
  assert.equal(e.text, '今天吃什么');
  assert.equal(e.authorName, '大肥鱼');
  assert.equal(e.atBot, true);
  assert.equal(e.msgId, 'MSG1');
});

check('toBridgeEvent：全量群消息（GROUP_MESSAGE_CREATE）标记 atBot=false', () => {
  const e = toBridgeEvent('GROUP_MESSAGE_CREATE', { id: 'M2', content: '随便聊聊', group_openid: 'G1', author: {} });
  assert.equal(e.kind, 'group');
  assert.equal(e.atBot, false, '全量消息不是 @ 来的，拟人策略要能区分');
});

check('toBridgeEvent：单聊 → kind=private + user_openid', () => {
  const e = toBridgeEvent('C2C_MESSAGE_CREATE', {
    id: 'M3', content: '在吗', author: { user_openid: 'U_1', username: '某人' }
  });
  assert.equal(e.kind, 'private');
  assert.equal(e.id, 'U_1');
  assert.equal(e.text, '在吗');
});

check('toBridgeEvent：缺 openid / 非消息事件 一律 null（不造脏事件）', () => {
  assert.equal(toBridgeEvent('GROUP_AT_MESSAGE_CREATE', { content: 'x' }), null);
  assert.equal(toBridgeEvent('C2C_MESSAGE_CREATE', { content: 'x' }), null);
  assert.equal(toBridgeEvent('READY', { user: {} }), null);
  assert.equal(toBridgeEvent('GROUP_AT_MESSAGE_CREATE', null), null);
});

// ── 3. 被动回复次数 ─────────────────────────────────────────────────────
check('ReplySeqTracker：同一 msg_id 递增到 5 后返回 null（官方上限）', () => {
  const t = new ReplySeqTracker();
  const seqs = [1, 2, 3, 4, 5].map(() => t.next('MSG'));
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(t.next('MSG'), null, '第 6 次必须返回 null，让调用方合并');
  assert.equal(t.next('OTHER'), 1, '换一条消息重新计数');
  assert.equal(t.next(''), null, '没有 msg_id 时不能瞎编 seq');
});

check('ReplySeqTracker：最多保留 500 条记录（不会无限增长）', () => {
  const t = new ReplySeqTracker();
  for (let i = 0; i < 800; i += 1) t.next(`M${i}`);
  assert.ok(t.map.size <= 500, `实际 ${t.map.size}`);
});

// ── 4. 客户端行为（不打网络，只验约定）──────────────────────────────────
check('构造：sandbox 切换 API 基址；intents 默认 GROUP_AND_C2C', () => {
  const prod = new OfficialQqBot({ appid: '1', secret: 's' });
  const sand = new OfficialQqBot({ appid: '1', secret: 's', sandbox: true });
  assert.equal(prod.api, 'https://api.sgroup.qq.com');
  assert.equal(sand.api, 'https://sandbox.api.sgroup.qq.com');
  assert.equal(prod.intents, INTENT_GROUP_AND_C2C);
  assert.equal(INTENT_GROUP_AND_C2C, 1 << 25);
});

check('reply()：被动回复带 msg_id + msg_seq；超限抛错而不是静默丢', async () => {
  const bot = new OfficialQqBot({ appid: '1', secret: 's' });
  const sent = [];
  bot._post = async (pathName, body) => { sent.push({ pathName, body }); return { id: 'ok' }; };
  const ev = { kind: 'group', id: 'G1', msgId: 'M1' };
  await bot.reply(ev, '第一条');
  await bot.reply(ev, '第二条');
  assert.equal(sent[0].pathName, '/v2/groups/G1/messages');
  assert.equal(sent[0].body.msg_id, 'M1');
  assert.equal(sent[0].body.msg_seq, 1);
  assert.equal(sent[1].body.msg_seq, 2);
  assert.equal(sent[0].body.msg_type, 0);

  for (let i = 0; i < 3; i += 1) await bot.reply(ev, 'x');
  await assert.rejects(() => bot.reply(ev, '第六条'), /5 次/);
});

check('reply()：单聊走 /v2/users/<openid>/messages', async () => {
  const bot = new OfficialQqBot({ appid: '1', secret: 's' });
  const sent = [];
  bot._post = async (pathName, body) => { sent.push({ pathName, body }); return {}; };
  await bot.reply({ kind: 'private', id: 'U1', msgId: 'M2' }, 'hi');
  assert.equal(sent[0].pathName, '/v2/users/U1/messages');
});

// ── 5. 不与个人号通道混淆 ───────────────────────────────────────────────
check('桥接侧：官方事件必须带 transport=official（避免与 OneBot 的 group_id 混用）', () => {
  const e = toBridgeEvent('GROUP_AT_MESSAGE_CREATE', { id: 'M', content: 'x', group_openid: 'G' });
  assert.equal(e.transport, 'official');
  // OneBot 的群号是纯数字；openid 是字符串，绝不能互相当成同一个 key
  const onebotKey = `group:${123456789}`;
  const officialKey = `official-group:${e.id}`;
  assert.notEqual(onebotKey.split(':')[1], e.id);
  assert.match(officialKey, /^official-group:/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
