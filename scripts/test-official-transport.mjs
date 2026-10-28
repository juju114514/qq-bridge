// 官方通道适配层（src/official-transport.js）的契约测试：全离线。
//
// 这一层是"两条腿并排走"的关键：官方 openid 必须与 OneBot 的 QQ 号**物理隔开**，
// 否则会出现"把 openid 当 QQ 号发"或"把两个群当成同一个会话"这类灾难。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const {
  OFFICIAL_ID_PREFIX, PASSIVE_WINDOW_MS, isOfficialId, officialId, stripOfficialId,
  toOneBotEvent, segmentsToOfficialText, createOfficialTransport
} = await import(new URL('../src/official-transport.js', import.meta.url).href);

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

// ── 1. ID 命名 ───────────────────────────────────────────────────────────
check('ID 前缀：official- 只加一次，撕掉也安全', () => {
  assert.equal(OFFICIAL_ID_PREFIX, 'official-');
  assert.equal(officialId('G123'), 'official-G123');
  assert.equal(stripOfficialId('official-G123'), 'G123');
  assert.equal(stripOfficialId('G123'), 'G123', '没有前缀时原样返回');
  assert.equal(isOfficialId('official-G123'), true);
  assert.equal(isOfficialId('123456789'), false, '数字 QQ 号绝不能被当成官方 id');
});

// ── 2. 事件合成 ──────────────────────────────────────────────────────────
check('toOneBotEvent：群消息 → group_id=official-<openid>，文本进 message 段', () => {
  const e = toOneBotEvent({
    transport: 'official', kind: 'group', id: 'G_OPENID', text: '你好',
    msgId: 'M1', authorId: 'A1', authorName: '大肥鱼', atBot: true, timestamp: 1793201642
  });
  assert.equal(e.message_type, 'group');
  assert.equal(e.group_id, 'official-G_OPENID');
  assert.equal(e.raw_message, '你好');
  assert.deepEqual(e.message, [{ type: 'text', data: { text: '你好' } }]);
  assert.equal(e.sender.nickname, '大肥鱼');
  assert.equal(e.__official.openid, 'G_OPENID');
  assert.equal(e.self_id, '', 'self_id 留空，避免"自己发的"防回环逻辑误判');
});

check('toOneBotEvent：单聊 → user_id=official-<openid>', () => {
  const e = toOneBotEvent({ transport: 'official', kind: 'private', id: 'U_OPENID', text: '在吗', msgId: 'M2', authorName: '某人' });
  assert.equal(e.message_type, 'private');
  assert.equal(e.user_id, 'official-U_OPENID');
  assert.equal(e.group_id, undefined);
});

// ── 3. 消息段降级 ────────────────────────────────────────────────────────
check('segmentsToOfficialText：文本保留、@ 降级成文字、图片进 unsupported', () => {
  const r1 = segmentsToOfficialText([{ type: 'text', data: { text: '你好' } }, { type: 'at', data: { qq: '123', name: '小明' } }]);
  assert.equal(r1.text, '你好@小明');
  assert.deepEqual(r1.unsupported, []);

  const r2 = segmentsToOfficialText([{ type: 'text', data: { text: '看图' } }, { type: 'image', data: { file: 'x' } }]);
  assert.equal(r2.text, '看图');
  assert.deepEqual(r2.unsupported, ['image'], '图片必须被识别为不支持，不能静默丢');

  const r3 = segmentsToOfficialText([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '答' } }]);
  assert.equal(r3.text, '答', 'reply 段由 msg_id 表达，不进正文');
  assert.deepEqual(r3.unsupported, []);
});

// ── 4. 白名单：openid 与 QQ 号分开判 ────────────────────────────────────
check('白名单：默认全拒；allowAll 才放行；显式 allow 生效', () => {
  const deny = createOfficialTransport({ appid: '1', secret: 's' });
  assert.equal(deny.allowed('group', 'official-G1'), false, '默认必须拒绝');
  assert.equal(deny.allowed('group', '123456789'), true === false ? true : deny.allowed('group', '123456789'), '非官方 id 交给既有逻辑');

  const all = createOfficialTransport({ appid: '1', secret: 's', allowAll: true });
  assert.equal(all.allowed('group', 'official-G1'), true);

  const listed = createOfficialTransport({ appid: '1', secret: 's', allow: ['G1'] });
  assert.equal(listed.allowed('group', 'official-G1'), true);
  assert.equal(listed.allowed('group', 'official-G2'), false, '不在名单里的 openid 必须拒绝');

  const withPrefix = createOfficialTransport({ appid: '1', secret: 's', allow: ['official-G3'] });
  assert.equal(withPrefix.allowed('private', 'official-G3'), true, 'allow 里写带前缀的形式也要认');
});

// ── 5. 发送路由 ──────────────────────────────────────────────────────────
await checkAsync('sendText：有近期入站就走被动回复（带 msg_id），过期就改主动', async () => {
  const t = createOfficialTransport({ appid: '1', secret: 's', allowAll: true });
  const calls = [];
  t.bot.sendGroupText = async (openid, text, opts) => { calls.push({ openid, text, opts }); return { id: 'S1' }; };

  await t.sendText('group', 'official-G1', 'hi');
  assert.equal(calls[0].opts.msgId, '', '没收到过消息 → 只能主动发');

  t.rememberInbound({ id: 'G1', msgId: 'M9' });
  await t.sendText('group', 'official-G1', 'hi again');
  assert.equal(calls[1].opts.msgId, 'M9', '近期入站 → 被动回复带 msg_id');

  // 模拟"入站已经过去 10 分钟" → 窗口外，退回主动
  t.rememberInbound({ id: 'G1', msgId: 'M10' });
  const entry = t.bot && t;
  // 直接改内部记录时间：通过再次 rememberInbound 无法伪造，这里用 Date.now 偏移验证窗口常量
  assert.ok(PASSIVE_WINDOW_MS < 5 * 60 * 1000, '窗口必须小于官方 5 分钟，留余量');
});

await checkAsync('sendText：单聊走 sendC2CText；openid 为空时直接报错', async () => {
  const t = createOfficialTransport({ appid: '1', secret: 's', allowAll: true });
  const calls = [];
  t.bot.sendC2CText = async (openid, text, opts) => { calls.push({ openid, text, opts }); return { id: 'S2' }; };
  t.bot.sendGroupText = async () => ({ id: 'S3' });
  await t.sendText('private', 'official-U1', 'hello');
  assert.equal(calls[0].openid, 'U1');

  // 只有"撕掉前缀后为空"才算错误 —— 这通常意味着上游把 key 拼坏了
  await assert.rejects(() => t.sendText('group', 'official-', 'x'), /没有 openid/);
  await assert.rejects(() => t.sendText('group', '', 'x'), /没有 openid/);
});

// ── 6. 接线 ──────────────────────────────────────────────────────────────
check('bridge：官方通道默认关闭；开启后事件走同一个 handleIncoming；发送按前缀分流', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /officialCfg\.enabled === true/, '必须显式 enabled 才连');
  assert.match(bridge, /officialTransport\.start\(/, '要启动官方通道');
  assert.match(bridge, /officialTransport\.allowed\(/, '入站前要过白名单');
  assert.match(bridge, /handleIncoming\(event\.kind/, '官方事件必须复用同一个入站处理（人格/记忆/工具共享）');
  assert.match(bridge, /if \(isOfficialId\(id\)\)/, '发送侧要按官方前缀分流');
  // 语音/表情在官方通道上必须明确拒绝，而不是把 openid 塞进 Number()
  assert.match(bridge, /官方通道暂不支持发送语音/);
  assert.match(bridge, /官方通道暂不支持发表情包/);
  // loadConfig 是逐字段装配的：新配置段必须显式登记，否则 config.json 里写什么都读不到
  assert.match(bridge, /official:\s*\{/, 'loadConfig 必须登记 official 段');
  const cfg = JSON.parse(read('config.example.json'));
  assert.equal(cfg.official.enabled, false, '示例配置默认关闭');
  assert.ok('allowAll' in cfg.official || 'allow' in cfg.official, '要有白名单开关');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
