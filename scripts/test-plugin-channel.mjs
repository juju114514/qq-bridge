// P1 第三步的离线测试：入站判定 + Agent 驱动。
// 不连 QQ、不连 DSH —— 用假事件和假 ctx.agents，把这层"决策"先钉住。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugin');
const inbound = await import(pathToFileURL(path.join(pluginDir, 'inbound.js')).href);
const driverMod = await import(pathToFileURL(path.join(pluginDir, 'agent-driver.js')).href);

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e?.message ?? e)]); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e?.message ?? e)]); }
};

const SELF = 10001;
const groupEvent = (over = {}) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: SELF,
  group_id: 123456,
  user_id: 20002,
  message_id: 9001,
  message: [
    { type: 'at', data: { qq: String(SELF) } },
    { type: 'text', data: { text: ' 在吗' } },
  ],
  ...over,
});

// ── 入站策略 ────────────────────────────────────────────────────────────
check('extractText 拼接文本段；兼容 message 是字符串', () => {
  assert.equal(inbound.extractText([{ type: 'text', data: { text: 'a' } }, { type: 'image', data: {} }, { type: 'text', data: { text: 'b' } }]), 'ab');
  assert.equal(inbound.extractText('纯文本'), '纯文本');
  assert.equal(inbound.extractText(undefined), '');
});

check('mentionsSelf 只认 @ 自己', () => {
  assert.equal(inbound.mentionsSelf(groupEvent(), SELF), true);
  assert.equal(inbound.mentionsSelf(groupEvent({ message: [{ type: 'at', data: { qq: '999' } }] }), SELF), false);
});

check('chatKeyOf：群/私聊格式与桥接一致', () => {
  assert.equal(inbound.chatKeyOf({ message_type: 'group', group_id: 5 }), 'group:5');
  assert.equal(inbound.chatKeyOf({ message_type: 'private', user_id: 7 }), 'private:7');
  assert.equal(inbound.chatKeyOf({}), '');
});

check('白名单为空 → 群里谁都不回（不是"全回"）', () => {
  const decide = inbound.createInboundGate({ allowGroups: [], requireMention: true });
  assert.deepEqual(decide(groupEvent(), { selfId: SELF }).reason, 'group-not-allowed');
});

check('白名单命中 + 有 @ → 处理，并抽出文本/会话 key', () => {
  const decide = inbound.createInboundGate({ allowGroups: [123456], requireMention: true });
  const r = decide(groupEvent(), { selfId: SELF });
  assert.equal(r.handle, true);
  assert.equal(r.key, 'group:123456');
  assert.equal(r.text, '在吗');
});

check('白名单命中但没 @ 且 requireMention → 不处理', () => {
  const decide = inbound.createInboundGate({ allowGroups: [123456], requireMention: true });
  const r = decide(groupEvent({ message: [{ type: 'text', data: { text: '随便说说' } }] }), { selfId: SELF });
  assert.equal(r.handle, false);
  assert.equal(r.reason, 'no-mention');
});

check('requireMention=false 时群里不 @ 也处理', () => {
  const decide = inbound.createInboundGate({ allowGroups: [123456], requireMention: false });
  const r = decide(groupEvent({ message: [{ type: 'text', data: { text: '不@也说话' } }] }), { selfId: SELF });
  assert.equal(r.handle, true);
});

check('私聊不看白名单（P1 简化），但空文本仍丢', () => {
  const decide = inbound.createInboundGate({ allowGroups: [], requireMention: true });
  const ok = decide({ post_type: 'message', message_type: 'private', self_id: SELF, user_id: 7, message_id: 1, message: [{ type: 'text', data: { text: 'hi' } }] }, { selfId: SELF });
  assert.equal(ok.handle, true);
  const empty = decide({ post_type: 'message', message_type: 'private', self_id: SELF, user_id: 7, message_id: 2, message: [] }, { selfId: SELF });
  assert.equal(empty.reason, 'empty');
});

check('同一个 message_id 第二次被当成 duplicate', () => {
  const decide = inbound.createInboundGate({ allowGroups: [123456], requireMention: true });
  assert.equal(decide(groupEvent(), { selfId: SELF }).handle, true);
  assert.equal(decide(groupEvent(), { selfId: SELF }).reason, 'duplicate');
});

check('自己发的消息直接丢（self）', () => {
  const decide = inbound.createInboundGate({ allowGroups: [123456], requireMention: false });
  const r = decide(groupEvent({ user_id: SELF, message: [{ type: 'text', data: { text: '我说的' } }] }), { selfId: SELF });
  assert.equal(r.reason, 'self');
});

// ── Agent 驱动 ──────────────────────────────────────────────────────────
const fakeCreate = () => {
  const created = [];
  return {
    created,
    agents: {
      async create(args) {
        if (args.sessionId.includes('qqbridge:group:123456') && !args.sessionId.includes('#')) {
          // 模拟"旧会话占了同一 id"
          if (created.length === 0) throw new Error('session id exists');
        }
        created.push(args);
        return {
          agent: {
            session: { id: args.sessionId },
            whenIdle: async () => {},
            followup: async (m) => { created.push({ followup: m }); },
          },
          dispose: async () => {},
        };
      },
    },
  };
};

await checkAsync('sessionId 稳定：同一 chatKey 生成同一 id', async () => {
  assert.equal(driverMod.sessionIdFor('group:1'), 'qqbridge:group:1');
  assert.equal(driverMod.sessionIdFor('private:2'), 'qqbridge:private:2');
  assert.equal(driverMod.sessionIdFor('group:1'), driverMod.sessionIdFor('group:1'));
});

await checkAsync('deliver：create 失败会换 id 重试，然后 followup 收到 user message', async () => {
  const fake = fakeCreate();
  const driver = driverMod.createAgentDriver({
    agents: fake.agents,
    loadCreateUserMessage: async () => (input) => ({ ...input, id: 'generated', role: 'user' }),
  });
  await driver.deliver('group:123456', '在吗');
  const followups = fake.created.filter((x) => x.followup);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].followup.role, 'user');
  assert.equal(followups[0].followup.content[0].text, '在吗');
  assert.equal(driver.sessions.size, 1);
});

await checkAsync('deliver：同一 chatKey 第二次不重新 create', async () => {
  const fake = fakeCreate();
  const driver = driverMod.createAgentDriver({
    agents: fake.agents,
    loadCreateUserMessage: async () => (input) => ({ ...input, id: 'g', role: 'user' }),
  });
  await driver.deliver('group:123456', 'a');
  const createdAfterFirst = fake.created.filter((x) => x.sessionId).length;
  await driver.deliver('group:123456', 'b');
  assert.equal(fake.created.filter((x) => x.sessionId).length, createdAfterFirst);
});

await checkAsync('deliver：加载不到 dsh-llm 时抛可读错误', async () => {
  const fake = fakeCreate();
  const driver = driverMod.createAgentDriver({
    agents: fake.agents,
    loadCreateUserMessage: async () => { throw new Error('MODULE_NOT_FOUND'); },
  });
  await assert.rejects(() => driver.deliver('private:9', 'x'), /createUserMessage/);
});

check('disposeAll 清空会话并调用 dispose', async () => {
  const disposed = [];
  const agents = {
    async create(args) { return { agent: { session: { id: args.sessionId }, whenIdle: async () => {}, followup: async () => {} }, dispose: async () => { disposed.push(1); } }; },
  };
  const driver = driverMod.createAgentDriver({ agents, loadCreateUserMessage: async () => (x) => x });
  await driver.deliver('private:1', 'x');
  await driver.disposeAll();
  assert.equal(disposed.length, 1);
  assert.equal(driver.sessions.size, 0);
});

// ── OneBot 通道（假 Client，不联网）────────────────────────────────────
const channelMod = await import(pathToFileURL(path.join(pluginDir, 'channel.js')).href);

function fakeClient() {
  const calls = [];
  let handlers = {};
  return {
    calls,
    class: class {
      constructor(opts) { this.opts = opts; }
      on(ev, fn) { (handlers[ev] ??= []).push(fn); }
      async connect() { (handlers.open ?? []).forEach((f) => f()); }
      action(action, params) { calls.push({ action, params }); return Promise.resolve({ status: 'ok' }); }
      close() { calls.push({ action: 'close' }); }
      emit(ev, payload) { (handlers[ev] ?? []).forEach((f) => f(payload)); }
    },
    emit: (ev, payload) => (handlers[ev] ?? []).forEach((f) => f(payload)),
  };
}

await checkAsync('channel.start 连接并把事件交给 onInbound', async () => {
  const fake = fakeClient();
  const seen = [];
  const ch = channelMod.createChannel({
    Client: fake.class,
    clientOptions: { url: 'ws://x' },
    onInbound: (e) => seen.push(e),
  });
  await ch.start();
  assert.equal(ch.started, true);
  fake.emit('event', { post_type: 'message', message_type: 'group', group_id: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].group_id, 1);
});

await checkAsync('channel.send：群/私聊分别用正确 action 与参数', async () => {
  const fake = fakeClient();
  const ch = channelMod.createChannel({ Client: fake.class, clientOptions: { url: 'ws://x' } });
  await ch.start();
  await ch.send('group:123', 'hi');
  await ch.send('private:456', 'yo');
  assert.deepEqual(fake.calls[0], { action: 'send_group_msg', params: { group_id: 123, message: 'hi' } });
  assert.deepEqual(fake.calls[1], { action: 'send_private_message', params: { user_id: 456, message: 'yo' } });
});

check('channel.send：空文本不发（避免 QQ 报错刷屏）', () => {
  const fake = fakeClient();
  const ch = channelMod.createChannel({ Client: fake.class, clientOptions: { url: 'ws://x' } });
  assert.equal(ch.send('group:1', '   '), null);
});

check('channel.send：未 start 时抛可读错误', () => {
  const fake = fakeClient();
  const ch = channelMod.createChannel({ Client: fake.class, clientOptions: { url: 'ws://x' } });
  assert.throws(() => ch.send('group:1', 'x'), /通道未启动/);
});

check('channel.close 调 client.close 且 started 归 false', async () => {
  const fake = fakeClient();
  const ch = channelMod.createChannel({ Client: fake.class, clientOptions: { url: 'ws://x' } });
  await ch.start();
  ch.close();
  assert.equal(ch.started, false);
  assert.ok(fake.calls.some((c) => c.action === 'close'));
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);