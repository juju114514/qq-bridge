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
  assert.deepEqual(tools.map((t) => t.name).sort(), ['qq_mark_read', 'qq_reply', 'qq_send_message']);
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

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);