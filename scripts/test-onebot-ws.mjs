// OneBot WS 客户端的行为回归（替代 @snowluma/sdk 之后的自保测试）。
//
// 为什么必须有：`src/onebot-ws.js` 是**手写的协议层**，它坏了的表现是
// 「机器人突然不说话 / 消息发错人 / 断线不自愈」，而这些都不会让任何业务测试变红。
// 这里用可注入的假 WebSocket 把协议语义钉住，不连网、不依赖真实网关。
//
// 断言与 SDK 原实现逐条对齐（照 node_modules/@snowluma/sdk/dist 抄的语义）：
//   · 鉴权走 URL query `?access_token=`
//   · 动作 send({action, params, echo})，响应靠 echo 配对
//   · 事件按 post_type / message_type / notice_type 分发
//   · call() 在 status!=ok 或 retcode!=0 时抛错
//   · 超时 reject、close 时 reject 所有 pending、close 后按退避重连

import assert from 'node:assert/strict';
import { createOneBotWsClientForTest, onebotWsInternals } from './lib/onebot-ws-test-double.mjs';

const { text, normalizeMessage, OneBotWsClient } = await import('../src/onebot-ws.js');

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
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 消息段与归一化 ──────────────────────────────────────────────────────
check('text() 产出标准文本段', () => {
  assert.deepEqual(text('你好'), { type: 'text', data: { text: '你好' } });
  assert.deepEqual(text(undefined), { type: 'text', data: { text: '' } });
});
check('normalizeMessage 透明处理三种输入', () => {
  assert.deepEqual(normalizeMessage('hi'), [text('hi')]);
  const seg = text('x');
  assert.deepEqual(normalizeMessage(seg), [seg]);
  const arr = [text('a'), text('b')];
  assert.equal(normalizeMessage(arr), arr);
});

// ── 2. 连接与鉴权 ─────────────────────────────────────────────────────────
await checkAsync('connect 把 access_token 拼进 URL query', async () => {
  const c = createOneBotWsClientForTest({ url: 'ws://127.0.0.1:3001/', accessToken: 'tok-123', reconnect: false });
  await c.client.connect();
  assert.match(c.lastUrl(), /access_token=tok-123/);
  assert.equal(c.client.isConnected, true);
  c.client.close();
});

await checkAsync('重复 connect 复用同一个连接（不新建 socket）', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  await c.client.connect();
  assert.equal(c.sockets.length, 1, `实际建了 ${c.sockets.length} 个 socket`);
  c.client.close();
});

// ── 3. 动作与 echo 配对 ───────────────────────────────────────────────────
await checkAsync('动作以 {action, params, echo} 发出', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const p = c.client.getLoginInfo();
  await sleep(5);
  const sent = JSON.parse(c.lastSent());
  assert.equal(sent.action, 'get_login_info');
  assert.deepEqual(sent.params, {});
  assert.ok(sent.echo, '缺 echo');
  c.reply({ status: 'ok', retcode: 0, data: { user_id: 1 }, echo: sent.echo });
  assert.deepEqual(await p, { user_id: 1 });
  c.client.close();
});

await checkAsync('并发动作按 echo 各归各（不会串台）', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const a = c.client.call('action_a', { n: 1 });
  const b = c.client.call('action_b', { n: 2 });
  await sleep(5);
  const sentA = JSON.parse(c.sentAt(0));
  const sentB = JSON.parse(c.sentAt(1));
  // 故意反序回复
  c.reply({ status: 'ok', retcode: 0, data: { which: 'b' }, echo: sentB.echo });
  c.reply({ status: 'ok', retcode: 0, data: { which: 'a' }, echo: sentA.echo });
  assert.deepEqual(await a, { which: 'a' });
  assert.deepEqual(await b, { which: 'b' });
  c.client.close();
});

await checkAsync('call 在 retcode!=0 时抛错并带上 retcode', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const p = c.client.sendPrivateMessage(42, text('hi'));
  await sleep(5);
  const sent = JSON.parse(c.lastSent());
  c.reply({ status: 'failed', retcode: 100, wording: 'no permission', echo: sent.echo });
  await assert.rejects(p, (error) => {
    assert.match(error.message, /retcode=100/);
    assert.equal(error.retcode, 100);
    return true;
  });
  c.client.close();
});

await checkAsync('request 返回原始信封（不抛错）', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const p = c.client.request('fetch_custom_face_detail', { count: 5 });
  await sleep(5);
  const sent = JSON.parse(c.lastSent());
  c.reply({ status: 'failed', retcode: 7, wording: 'nope', echo: sent.echo });
  const response = await p;
  assert.equal(response.retcode, 7);
  assert.equal(response.wording, 'nope');
  c.client.close();
});

await checkAsync('动作超时 reject（不挂死）', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false, requestTimeoutMs: 60 });
  await c.client.connect();
  await assert.rejects(c.client.call('slow_action', {}), /timed out/);
  c.client.close();
});

// ── 4. 事件分发（与 SDK guards 对齐）───────────────────────────────────────
await checkAsync('私聊/群聊/notify/bot_status/meta 各自只触发对应回调', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const hits = [];
  c.client.onPrivateMessage(() => hits.push('private'));
  c.client.onGroupMessage(() => hits.push('group'));
  c.client.onNotice('notify', () => hits.push('notify'));
  c.client.onBotStatus(() => hits.push('bot_status'));
  c.client.onMetaEvent(() => hits.push('meta'));
  c.client.onEvent(() => hits.push('event'));

  c.push({ post_type: 'message', message_type: 'private', user_id: 1, raw_message: 'a' });
  c.push({ post_type: 'message', message_type: 'group', group_id: 2, raw_message: 'b' });
  c.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke' });
  c.push({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'online', user_id: 3 });
  c.push({ post_type: 'meta_event', meta_event_type: 'heartbeat' });
  await sleep(10);

  assert.deepEqual(hits, ['event', 'private', 'event', 'group', 'event', 'notify', 'event', 'bot_status', 'event', 'meta']);
  c.client.close();
});

await checkAsync('bot_status 只认 notice_type=bot_status + online/offline + user_id 为数字', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const hits = [];
  c.client.onBotStatus(() => hits.push('hit'));
  c.push({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'offline', user_id: '9' }); // user_id 非数字
  c.push({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'weird', user_id: 9 });    // sub_type 非法
  c.push({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'online', user_id: 9 });   // 合法
  await sleep(10);
  assert.deepEqual(hits, ['hit']);
  c.client.close();
});

await checkAsync('message_sent 也算消息事件（自己发的回显）', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const hits = [];
  c.client.onGroupMessage(() => hits.push('group'));
  c.push({ post_type: 'message_sent', message_type: 'group', group_id: 5 });
  await sleep(10);
  assert.deepEqual(hits, ['group']);
  c.client.close();
});

await checkAsync('非 JSON 帧只报 error、不崩溃', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const errors = [];
  c.client.on('error', (e) => errors.push(String(e?.message ?? e)));
  c.pushRaw('not-json{{');
  await sleep(10);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /non-JSON/);
  assert.equal(c.client.isConnected, true, '不该因为脏帧断开');
  c.client.close();
});

// ── 5. 断线与重连 ─────────────────────────────────────────────────────────
await checkAsync('close 后 pending 全部 reject（不会永远挂着）', async () => {
  const c = createOneBotWsClientForTest({ reconnect: false });
  await c.client.connect();
  const p = c.client.call('some_action', {});
  await sleep(5);              // 让 request 真正进 pending，再断线
  c.serverClose(1006, 'abnormal');
  await assert.rejects(p, /closed/);
});

await checkAsync('异常断开会按退避重连（closedByUser 不算）', async () => {
  const c = createOneBotWsClientForTest({
    reconnect: { retries: 2, minDelayMs: 10, maxDelayMs: 20, factor: 1 },
  });
  await c.client.connect();
  assert.equal(c.sockets.length, 1);
  c.serverClose(1006, 'abnormal');
  await sleep(60);
  assert.ok(c.sockets.length >= 2, `没有重连（sockets=${c.sockets.length}）`);
  c.client.close();
});

await checkAsync('主动 close 不重连', async () => {
  const c = createOneBotWsClientForTest({
    reconnect: { retries: 5, minDelayMs: 10, maxDelayMs: 20, factor: 1 },
  });
  await c.client.connect();
  const before = c.sockets.length;
  c.client.close();
  await sleep(60);
  assert.equal(c.sockets.length, before, '主动关闭后不该再建连接');
});

// ── 6. 对外 API 面完整性（防止换实现时漏方法）────────────────────────────
check('bridge 用到的 21 个成员都存在', () => {
  const c = new OneBotWsClient({ url: 'ws://x/', webSocket: class { addEventListener() {} close() {} } });
  for (const name of [
    'connect', 'close', 'isConnected', 'on', 'once', 'off', 'when', 'onEvent',
    'onPrivateMessage', 'onGroupMessage', 'onNotice', 'onRequest', 'onBotStatus', 'onMetaEvent',
    'request', 'call', 'raw', 'rawResponse', 'sendMsg', 'sendPrivateMessage', 'sendGroupMessage',
    'getLoginInfo', 'getStatus', 'getVersionInfo', 'getMessage', 'getImage', 'fetchFaceEntity',
    'getGroupMemberList', 'getGroupMemberInfo',
  ]) {
    assert.equal(typeof c[name] === 'function' || c[name] !== undefined, true, `缺 ${name}`);
  }
  assert.equal(c.url, 'ws://x/');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
void onebotWsInternals;
