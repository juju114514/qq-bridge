// 红包识别（src/domains/red-packet.js）—— 移植自同源分叉 AI-group-friends
//
// 为什么单独测：真假判据调过好几轮，而且两种误判都很伤 ——
//   · 真红包判成假 → 群友发钱你不理，像死了
//   · 假红包判成真 → 别人手打一句「[QQ红包]」你就当真的去反应，更尴尬

import assert from 'node:assert/strict';

const { detectRedPacket, groupStyleHint } = await import(new URL('../src/domains/red-packet.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const textEvent = (text) => ({ message: [{ type: 'text', data: { text } }] });

check('真红包（redbag 段）：带留言', () => {
  const hit = detectRedPacket({ message: [{ type: 'redbag', data: { greeting: '新年快乐', url: 'https://x', bill_no: 'B1' } }] });
  assert.equal(hit.kind, 'real');
  assert.equal(hit.greeting, '新年快乐');
  assert.equal(hit.isDefaultGreeting, false);
  assert.equal(hit.billNo, 'B1');
});

check('真红包：默认留言「恭喜发财」标记为不值得回应', () => {
  const hit = detectRedPacket({ message: [{ type: 'redbag', data: { greeting: '恭喜发财' } }] });
  assert.equal(hit.isDefaultGreeting, true);
});

check('真红包：没有留言也算真红包（不是假红包）', () => {
  const hit = detectRedPacket({ message: [{ type: 'redbag', data: {} }] });
  assert.equal(hit.kind, 'real');
  assert.equal(hit.isDefaultGreeting, true);
});

check('兜底文案「请使用新版手机QQ」→ 当真红包（degraded），绝不判成假', () => {
  const hit = detectRedPacket(textEvent('[QQ红包]请使用新版手机QQ查收红包。'));
  assert.equal(hit.kind, 'real');
  assert.equal(hit.degraded, true, '这是"解不出来"，不是"手打的"');
});

check('假红包：手打 [QQ红包] 括号', () => {
  const hit = detectRedPacket(textEvent('[QQ红包] 谁发一个'));
  assert.equal(hit.kind, 'fake');
  assert.ok(hit.text.includes('谁发一个'));
});

check('假红包：【微信红包】也认', () => {
  assert.equal(detectRedPacket(textEvent('【微信红包】来了')).kind, 'fake');
});

check('假红包：红包 + 金额（没有括号也算）', () => {
  assert.equal(detectRedPacket(textEvent('我发个红包 5块')).kind, 'fake');
  assert.equal(detectRedPacket(textEvent('红包 88.8 元')).kind, 'fake');
});

check('不是红包：普通聊天', () => {
  assert.equal(detectRedPacket(textEvent('今天好饿')), null);
  assert.equal(detectRedPacket(textEvent('红包什么时候发')), null, '只提"红包"没金额/括号不算');
});

check('空消息 / 无 message 字段 → null（不崩）', () => {
  assert.equal(detectRedPacket({}), null);
  assert.equal(detectRedPacket({ message: [] }), null);
  assert.equal(detectRedPacket(null), null);
});

check('图文混合：只有图片没有文字 → null', () => {
  assert.equal(detectRedPacket({ message: [{ type: 'image', data: {} }] }), null);
});

check('群聊风格提示：火药味 / 玩梗 / 平和', () => {
  const hot = groupStyleHint([{ text: '傻逼' }, { text: '滚蛋' }]);
  assert.match(hot, /互怼/);
  const fun = groupStyleHint([{ text: '哈哈哈哈' }, { text: '笑死我了' }, { text: '玩梗' }]);
  assert.match(fun, /玩梗/);
  const calm = groupStyleHint([{ text: '今天天气不错' }]);
  assert.match(calm, /平和/);
});

check('群聊风格：没有消息 → 空串', () => {
  assert.equal(groupStyleHint([]), '');
  assert.equal(groupStyleHint(null), '');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }