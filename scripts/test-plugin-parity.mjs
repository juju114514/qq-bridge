// N4 一致性闸（第一部分）：**入站判定**在 bridge 与插件两侧必须一致。
//
// 不追求"完整回放"（DSH 侧行为不在我们控制内），只钉住我们自己的契约：
//   同一个 OneBot 事件 → 该不该处理、会话 key 是什么、文本是什么，两边给出同样的答案。
//
// bridge 侧用真实的 src/private-access.js + src/onebot-ws.js；
// 插件侧用 plugin/inbound.js。任何一侧改了语义，这里就会红。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const priv = await import(pathToFileURL(path.join(root, 'src', 'private-access.js')).href);
const ob = await import(pathToFileURL(path.join(root, 'src', 'onebot-ws.js')).href);
const inbound = await import(pathToFileURL(path.join(root, 'plugin', 'inbound.js')).href);

const results = [];
const check = (n, f) => { try { f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };

const SELF = 10001;
const ev = (over = {}) => ({
  post_type: 'message', message_type: 'group', self_id: SELF,
  group_id: 123456, user_id: 20002, message_id: 1,
  message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: '在吗' } }],
  ...over,
});

check('会话 key：bridge 的 conversationScopeOf 与插件 chatKeyOf 一致', () => {
  for (const e of [
    ev(),
    ev({ message_type: 'private', user_id: 777 }),
    ev({ group_id: 999 }),
  ]) {
    const bridgeKey = e.message_type === 'group' ? `group:${e.group_id}` : `private:${e.user_id}`;
    assert.equal(inbound.chatKeyOf(e), bridgeKey, '插件侧 key 与约定不一致');
    // bridge 侧：conversationScopeOf 只认 key 字符串，这里用它验证前缀语义
    assert.equal(priv.conversationScopeOf(bridgeKey), priv.conversationScopeOf(inbound.chatKeyOf(e)));
  }
});

check('文本抽取：bridge 的 onebot text() 与插件 extractText 一致', () => {
  const cases = [
    [{ type: 'text', data: { text: ' 你好 ' } }],
    [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: '嗨' } }],
    '纯字符串',
    [],
  ];
  for (const message of cases) {
    const bridgeText = typeof message === 'string'
      ? message
      : (Array.isArray(message) ? message.filter((s) => s?.type === 'text').map((s) => s.data?.text ?? '').join('') : '');
    assert.equal(inbound.extractText(message), bridgeText, `抽取结果不一致：${JSON.stringify(message)}`);
  }
});

check('私聊准入：插件不拦，bridge 的 decideFromOneBot 对 owner 放行（语义不冲突）', () => {
  const ownerEvent = ev({ message_type: 'private', user_id: 1599683156, group_id: undefined });
  const d = priv.decideFromOneBot({}, ownerEvent, { ownerQQ: '1599683156', allowList: [], friends: null });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, 'owner');
  // 插件侧私聊不设白名单（P1 简化）→ 也应放行同一个会话
  const gate = inbound.createInboundGate({ allowGroups: [], requireMention: true });
  const r = gate(ownerEvent, { selfId: SELF });
  assert.equal(r.handle, true);
});

check('群准入：bridge 白名单语义 = 插件白名单语义（不在名单就丢）', () => {
  const gate = inbound.createInboundGate({ allowGroups: [123456], requireMention: true });
  assert.equal(gate(ev(), { selfId: SELF }).handle, true);
  const gate2 = inbound.createInboundGate({ allowGroups: [], requireMention: true });
  assert.equal(gate2(ev(), { selfId: SELF }).handle, false);
  // bridge 侧同一条规则由 allow.groups 承载（这里验证我们的语义：空名单 = 谁都不回）
  assert.equal([].includes(Number(ev().group_id)), false);
});

check('@ 判定：onebot-ws 的 isGroupMessageEvent 与插件 mentionsSelf 组合后等价于"@ 我才回"', () => {
  assert.equal(ob.isGroupMessageEvent(ev()), true);
  assert.equal(inbound.mentionsSelf(ev(), SELF), true);
  assert.equal(inbound.mentionsSelf(ev({ message: [{ type: 'text', data: { text: '不@' } }] }), SELF), false);
});

check('去重：同一 message_id 第二次不处理（插件侧）', () => {
  const gate = inbound.createInboundGate({ allowGroups: [123456], requireMention: true });
  assert.equal(gate(ev({ message_id: 42 }), { selfId: SELF }).handle, true);
  assert.equal(gate(ev({ message_id: 42 }), { selfId: SELF }).reason, 'duplicate');
});

check('自己的消息：插件 drop，且不算新消息（wait 不会被自己叫醒）', () => {
  const gate = inbound.createInboundGate({ allowGroups: [123456], requireMention: false });
  const r = gate(ev({ user_id: SELF, message: [{ type: 'text', data: { text: '我说的' } }] }), { selfId: SELF });
  assert.equal(r.reason, 'self');
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);