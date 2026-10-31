// N1 第一批工具的离线测试：qq_send_message / qq_reply / qq_mark_read
// 用假 channel + 假 sidecar，不联网、不需要 QQ。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugin');
const mod = await import(pathToFileURL(path.join(pluginDir, 'tools.js')).href);

const results = [];
const check = (n, f) => { try { f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };
const checkAsync = async (n, f) => { try { await f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };

function fakeChannel() {
  const sent = [];
  const called = [];
  return {
    sent, called,
    send(key, text) { sent.push({ key, text }); return Promise.resolve({ data: { message_id: 42 } }); },
    call(action, params) { called.push({ action, params }); return Promise.resolve({ data: { message_id: 43 } }); },
  };
}

const byName = (tools, name) => tools.find((t) => t.name === name);

check('三个工具都注册了，且名字与清单一致', () => {
  const tools = mod.createTools({ channel: fakeChannel() });
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'qq_get_prompt', 'qq_get_recent_messages', 'qq_get_unread_messages',
    'qq_mark_read', 'qq_reply', 'qq_send_message', 'qq_wait_for_messages',
  ]);
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function');
    assert.equal(typeof t.output.render, 'function');
    assert.ok(['object','array','string','number','integer','boolean','null'].includes(t.output.schema.type));
  }
});

check('parseChatId：只认 group:/private: + 数字', () => {
  assert.deepEqual(mod.parseChatId('group:123'), { kind: 'group', id: 123, key: 'group:123' });
  assert.deepEqual(mod.parseChatId('private:456'), { kind: 'private', id: 456, key: 'private:456' });
  assert.equal(mod.parseChatId('group:abc'), null);
  assert.equal(mod.parseChatId('123'), null);
  assert.equal(mod.parseChatId(''), null);
});

await checkAsync('qq_send_message：正常发送并回传 messageId', async () => {
  const ch = fakeChannel();
  const t = byName(mod.createTools({ channel: ch }), 'qq_send_message');
  const r = await t.execute({ chat_id: 'group:1', text: '你好' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 42);
  assert.deepEqual(ch.sent[0], { key: 'group:1', text: '你好' });
});

await checkAsync('qq_send_message：chat_id 非法 / 空文本 / 无通道 都返回 ok:false 且说明原因', async () => {
  const t = byName(mod.createTools({ channel: fakeChannel() }), 'qq_send_message');
  assert.match((await t.execute({ chat_id: 'oops', text: 'x' })).message, /chat_id/);
  assert.match((await t.execute({ chat_id: 'group:1', text: '   ' })).message, /text/);
  const noCh = byName(mod.createTools({}), 'qq_send_message');
  assert.match((await noCh.execute({ chat_id: 'group:1', text: 'x' })).message, /通道未启动/);
});

await checkAsync('qq_reply：用 reply 段 + 文本段，群聊走 send_group_msg', async () => {
  const ch = fakeChannel();
  const t = byName(mod.createTools({ channel: ch }), 'qq_reply');
  const r = await t.execute({ chat_id: 'group:9', message_id: '-77', text: '收到' }, {});
  assert.equal(r.ok, true);
  assert.equal(ch.called[0].action, 'send_group_msg');
  assert.equal(ch.called[0].params.group_id, 9);
  assert.deepEqual(ch.called[0].params.message[0], { type: 'reply', data: { id: '-77' } });
  assert.deepEqual(ch.called[0].params.message[1], { type: 'text', data: { text: '收到' } });
});

await checkAsync('qq_reply：私聊走 send_private_msg 且用 user_id', async () => {
  const ch = fakeChannel();
  const t = byName(mod.createTools({ channel: ch }), 'qq_reply');
  await t.execute({ chat_id: 'private:5', message_id: '1', text: 'hi' }, {});
  assert.equal(ch.called[0].action, 'send_private_msg');
  assert.equal(ch.called[0].params.user_id, 5);
});

await checkAsync('qq_mark_read：sidecar 不在 → degraded 而不是抛错', async () => {
  const t = byName(mod.createTools({ channel: fakeChannel() }), 'qq_mark_read');
  const r = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.message, /sidecar/);
});

await checkAsync('qq_mark_read：sidecar 在 → 发 read.mark 意图', async () => {
  const calls = [];
  const sidecar = { postIntent: async (x) => { calls.push(x); } };
  const t = byName(mod.createTools({ channel: fakeChannel(), sidecar }), 'qq_mark_read');
  const r = await t.execute({ chat_id: 'group:1', through_seq: 88 }, {});
  assert.equal(r.ok, true);
  assert.equal(calls[0].intent, 'read.mark');
  assert.equal(calls[0].payload.throughSeq, 88);
});

await checkAsync('qq_mark_read：sidecar 抛错也降级，不把异常抛给模型', async () => {
  const sidecar = { postIntent: async () => { throw new Error('ECONNREFUSED'); } };
  const t = byName(mod.createTools({ channel: fakeChannel(), sidecar }), 'qq_mark_read');
  const r = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(r.degraded, true);
  assert.match(r.message, /sidecar 调用失败/);
});

check('render 输出可读文本（失败时带“失败：”前缀）', () => {
  const t = byName(mod.createTools({ channel: fakeChannel() }), 'qq_send_message');
  assert.equal(t.output.render({}, { ok: true, message: '已发送' })[0].text, '已发送');
  assert.equal(t.output.render({}, { ok: false, message: '坏了' })[0].text, '失败：坏了');
});

await checkAsync('qq_get_prompt：sidecar 未连接 → degraded，不抛错', async () => {
  const t = byName(mod.createTools({ channel: fakeChannel() }), 'qq_get_prompt');
  const r = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.message, /sidecar/);
});

await checkAsync('qq_get_prompt：有快照 → 返回人格卡 / 交接段 / 最近消息', async () => {
  const sidecar = {
    snapshot: async (key) => ({
      ok: true,
      notModified: false,
      etag: 'x',
      state: {
        key,
        role: { name: 'xiaojingyu', hint: '你是小鲸鱼' },
        people: { level: 2 },
        wake: { sleepMs: 60000 },
        memory: { text: '## §〇 交接\n\n### 上次聊到哪\n聊了歌单\n' },
        recent: [{ text: 'a' }, { text: 'b' }],
      },
    }),
  };
  const t = byName(mod.createTools({ channel: fakeChannel(), sidecar }), 'qq_get_prompt');
  const r = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.role.name, 'xiaojingyu');
  assert.match(r.handoff, /聊了歌单/);
  assert.equal(r.recent.length, 2);
});

await checkAsync('qq_get_prompt：304 缓存命中 → notModified=true', async () => {
  const sidecar = { snapshot: async () => ({ ok: true, notModified: true, etag: 'x', state: { memory: { text: 'm' } } }) };
  const t = byName(mod.createTools({ channel: fakeChannel(), sidecar }), 'qq_get_prompt');
  const r = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(r.notModified, true);
});

// ── 消息类工具（chatLog）──────────────────────────────────────────────
const { createChatLog } = await import(pathToFileURL(path.join(pluginDir, 'chat-log.js')).href);

function withLog() {
  const chatLog = createChatLog();
  chatLog.append('group:1', { text: '早', userId: 'u1' });
  chatLog.append('group:1', { text: '在吗', userId: 'u2' });
  chatLog.append('group:1', { text: '我在', userId: 'self', self: true });
  return { chatLog, tools: mod.createTools({ channel: fakeChannel(), chatLog }) };
}

await checkAsync('qq_get_recent_messages：按条数返回，含自己发的', async () => {
  const { tools } = withLog();
  const t = byName(tools, 'qq_get_recent_messages');
  const r = await t.execute({ chat_id: 'group:1', limit: 2 }, {});
  assert.equal(r.ok, true);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[1].text, '我在');
});

await checkAsync('qq_get_unread_messages：不含自己发的；mark_read 后清零', async () => {
  const { chatLog, tools } = withLog();
  const t = byName(tools, 'qq_get_unread_messages');
  const before = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(before.messages.length, 2, '自己发的不算未读');
  chatLog.markRead('group:1');
  const after = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(after.messages.length, 0);
});

await checkAsync('qq_get_unread_messages：没有 chatLog → degraded', async () => {
  const t = byName(mod.createTools({ channel: fakeChannel() }), 'qq_get_unread_messages');
  const r = await t.execute({ chat_id: 'group:1' }, {});
  assert.equal(r.degraded, true);
});

await checkAsync('qq_wait_for_messages：有新消息立即返回，超时返回 timeout（不是错误）', async () => {
  const { chatLog, tools } = withLog();
  const t = byName(tools, 'qq_wait_for_messages');
  const p = t.execute({ chat_id: 'group:1', timeout_ms: 1000 }, {});
  setTimeout(() => chatLog.append('group:1', { text: '来了', userId: 'u3' }), 30);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.text, '来了');

  const r2 = await t.execute({ chat_id: 'group:1', timeout_ms: 1000 }, {});
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, 'timeout');
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);