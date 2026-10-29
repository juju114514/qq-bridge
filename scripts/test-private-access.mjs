// 私聊准入（src/private-access.js）契约测试：全离线。
//
// 要点：① 默认关闭 ② 好友放行 ③ 临时会话一律拒（网关不稳）
// ④ 白名单优先 ⑤ 好友列表 TTL 与收敛

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const m = await import(new URL('../src/private-access.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('未启用时一律拒绝（新人安装默认不开）', () => {
  assert.equal(m.decidePrivateAccess({}, { isFriend: true }).allowed, false);
  assert.equal(m.decidePrivateAccess({}, { isFriend: true }).reason, m.PRIVATE_DENY.DISABLED);
});

check('启用后好友放行、陌生人拒绝', () => {
  const on = { enabled: true };
  assert.equal(m.decidePrivateAccess(on, { isFriend: true }).allowed, true);
  assert.equal(m.decidePrivateAccess(on, { isFriend: true }).reason, 'friend');
  assert.equal(m.decidePrivateAccess(on, { isFriend: false }).allowed, false);
});

check('临时会话一律拒绝（即使 allowStrangers=true）', () => {
  const on = { enabled: true, allowStrangers: true };
  const r = m.decidePrivateAccess(on, { isFriend: false, isTemp: true });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, m.PRIVATE_DENY.TEMP_SESSION);
});

check('白名单优先：不是好友也放行', () => {
  const r = m.decidePrivateAccess({ enabled: true }, { isFriend: false, inAllowList: true });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'allowlist');
});

check('allowFriends=false 时好友也被拒', () => {
  const r = m.decidePrivateAccess({ enabled: true, allowFriends: false }, { isFriend: true });
  assert.equal(r.allowed, false);
});

check('friendListStale：无缓存必刷，超 TTL 才刷', () => {
  const now = 1_000_000_000;
  assert.equal(m.friendListStale(0, now), true);
  assert.equal(m.friendListStale(now - 1000, now), false);
  assert.equal(m.friendListStale(now - 11 * 60 * 1000, now), true);
});

check('toFriendSet：只收 QQ 号，脏数据跳过', () => {
  const s = m.toFriendSet([{ user_id: 123 }, { userId: '456' }, {}, null, { user_id: '' }]);
  assert.deepEqual([...s].sort(), ['123', '456']);
});

check('conversationScopeOf：group 前缀 → group，其余 → private', () => {
  assert.equal(m.conversationScopeOf('group:1'), 'group');
  assert.equal(m.conversationScopeOf('private:1'), 'private');
  assert.equal(m.conversationScopeOf(''), 'private');
});

check('classifyOneBotPrivate：friend / group(临时) / other 区分正确', () => {
  assert.equal(m.classifyOneBotPrivate({ sub_type: 'friend', user_id: 1 }).isFriend, true);
  const temp = m.classifyOneBotPrivate({ sub_type: 'group', user_id: 1 });
  assert.equal(temp.isTemp, true);
  assert.equal(temp.isFriend, false);
  assert.equal(m.classifyOneBotPrivate({ sub_type: 'other' }).isTemp, true);
});

check('decideFromOneBot（SnowLuma 场景）：好友列表不可用 → 只认白名单', () => {
  const r1 = m.decideFromOneBot({ enabled: true }, { sub_type: 'friend', user_id: '9' }, { friends: null, allowList: [] });
  assert.equal(r1.allowed, false);
  assert.equal(r1.knownFriends, false);
  assert.match(String(r1.hint), /白名单/);
  const r2 = m.decideFromOneBot({ enabled: true }, { sub_type: 'friend', user_id: '9' }, { friends: null, allowList: ['9'] });
  assert.equal(r2.allowed, true);
});

check('decideFromOneBot（NapCat 场景）：好友列表可用 → 好友放行、临时会话拒', () => {
  const friends = new Set(['100']);
  assert.equal(m.decideFromOneBot({ enabled: true }, { sub_type: 'friend', user_id: '100' }, { friends }).allowed, true);
  const temp = m.decideFromOneBot({ enabled: true }, { sub_type: 'group', user_id: '100' }, { friends });
  assert.equal(temp.allowed, false);
  assert.equal(temp.reason, m.PRIVATE_DENY.TEMP_SESSION);
});

check('describeGatewayCapability：两种网关各有提示', () => {
  assert.match(m.describeGatewayCapability({ hasFriendList: true }), /allowFriends/);
  assert.match(m.describeGatewayCapability({ hasFriendList: false }), /SnowLuma/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
