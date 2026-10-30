// 社交模式状态的加载/落盘契约（src/bridge.js 的 loadSocialV2State 等）
//
// 为什么先写测试再搬代码：这块 400+ 行是"把状态搬进 rt"的前置，
// 而它的正确性全靠几件看不见的事：
//   · 旧状态文件里的垃圾键要被清掉，不能被带进内存再回写
//   · 非法 key 要丢弃（否则一个文件里能塞任意会话）
//   · 同一份 agentToken 出现在两个会话里 → 必须重新生成
//   · lastReadThroughSeq 不能超过 lastUnreadSeq（否则"已读到未来"）
//   · 文件被别的实例改过 → 不能拿内存态覆盖回去
//
// 这些都没有单测。先把它们钉住，再动搬移。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { bridgeHarness } = await import(new URL('../scripts/audit-bridge-harness.mjs', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const KEY = 'group:456';

async function withState(conversations, extra = {}) {
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456'] } },
    files: { 'state/social-v2.json': { conversations, ...extra } }
  });
  return h;
}

await check('加载：非法 key 被丢弃，合法 key 保留', async () => {
  const h = await withState({
    'group:456': { recentMessages: [{ text: 'hi' }] },
    'not-a-key': { recentMessages: [] },
    'group:0': { recentMessages: [] }
  });
  assert.ok(h.socialV2.conversations.has(KEY), '合法会话应被加载');
  assert.equal(h.socialV2.conversations.has('not-a-key'), false);
  assert.equal(h.socialV2.conversations.has('group:0'), false, 'group:0 不是合法会话（id 必须 > 0）');
  await h.close();
});

await check('加载：wakeConfig.triggers 只保留白名单键（旧文件垃圾键被清）', async () => {
  const h = await withState({
    [KEY]: {
      wakeConfig: {
        mode: 'diving', infinite: true,
        triggers: { atMention: false, evilKey: 'x'.repeat(500), anotherJunk: 1 }
      }
    }
  });
  const st = h.getSocialV2State(KEY);
  assert.equal('evilKey' in st.wakeConfig.triggers, false, '垃圾键必须被清掉');
  assert.equal('anotherJunk' in st.wakeConfig.triggers, false);
  // 注意：confirmedBy 缺省 = 'default' → 按推荐值整体刷新，所以 atMention 会回到 true。
  // 这条不是 bug，而是"默认配置跟随推荐值"的设计；显式设过的（confirmedBy='owner'）才保留。
  assert.equal(st.wakeConfig.triggers.atMention, true, '默认配置应被刷新成推荐值');
  await h.close();
});

await check('加载：私聊会话的 speakerIds 被清空（私聊没有"指定群友"）', async () => {
  const h = await withState({
    'private:123': { wakeConfig: { triggers: { speakerIds: ['999'] } } }
  });
  const st = h.getSocialV2State('private:123');
  assert.equal(JSON.stringify(st.wakeConfig.triggers.speakerIds), '[]');
  await h.close();
});

await check('加载：两个会话共用同一 agentToken → 后者被重新生成', async () => {
  const h = await withState({
    [KEY]: { agentToken: 'dup-token' },
    'private:123': { agentToken: 'dup-token' }
  });
  const a = h.getSocialV2State(KEY).agentToken;
  const b = h.getSocialV2State('private:123').agentToken;
  assert.notEqual(a, b, `两个会话不能共用同一个 token（拿到 ${a} / ${b}）`);
  await h.close();
});

await check('加载：lastReadThroughSeq 不能超过 lastUnreadSeq', async () => {
  const h = await withState({ [KEY]: { lastUnreadSeq: 10, lastReadThroughSeq: 999 } });
  const st = h.getSocialV2State(KEY);
  assert.equal(st.lastReadThroughSeq, 10, '读水位必须被夹到未读水位');
  await h.close();
});

await check('加载：缺字段的旧文件用默认值补齐（不崩）', async () => {
  const h = await withState({ [KEY]: {} });
  const st = h.getSocialV2State(KEY);
  assert.equal(JSON.stringify(st.recentMessages), '[]');
  assert.equal(JSON.stringify(st.unread), '[]');
  assert.equal(st.bootstrapSent, false);
  assert.equal(typeof st.agentToken, 'string');
  assert.ok(st.wakeConfig && st.wakeConfig.triggers);
  await h.close();
});

await check('加载：文件不存在 → 空状态，不抛错', async () => {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['456'] } } });
  assert.equal(h.socialV2.conversations.size, 0);
  await h.close();
});

await check('加载：文件内容损坏 → 空状态，不抛错', async () => {
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456'] } },
    files: { 'state/social-v2.json': '{ this is not json' }
  });
  // 关键：**启动不能失败**。坏文件会被 state-schema 隔离成 *.corrupt-*，
  // 之后当作"没有这个文件"继续（曾经的表现是整个桥接起不来）。
  assert.equal(h.socialV2.conversations.size, 0);
    // 隔离要留证据：坏文件应被改名成 *.corrupt-<时间戳>，而不是删除或原地留着
  const quarantined = fs.readdirSync(path.join(h.temp, 'state')).filter((n) => n.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, `应该有 1 个隔离文件，实际 ${JSON.stringify(quarantined)}`);
await h.close();
});

await check('加载：paused 标记被读出来', async () => {
  const h = await withState({}, { paused: true });
  assert.equal(h.socialV2.paused, true);
  await h.close();
});

await check('加载：仍用默认唤醒配置的会话被同步到当前推荐值', async () => {
  const h = await withState({
    [KEY]: { wakeConfig: { mode: 'diving', infinite: true, confirmedBy: 'default', triggers: { atMention: false } } }
  });
  const st = h.getSocialV2State(KEY);
  assert.equal(st.wakeConfig.confirmedBy, 'default');
  assert.equal(st.wakeConfig.triggers.atMention, true, '默认配置应被刷新成推荐值');
  await h.close();
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }