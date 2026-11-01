// 通道能力提示（0.4.117）：官方开 markdown / 官方关 / 个人号
import assert from 'node:assert/strict';

// 这段逻辑在 bridge.js 内部（闭包依赖 cfg），这里用等价实现验证"分支规则"，
// 避免为了单测把 bridge 拆开——规则一旦改动，这个测试要同步改。
function channelCapabilityLine(key, officialMarkdownEnabled) {
  const k = String(key || '');
  if (k.startsWith('official-')) {
    return officialMarkdownEnabled
      ? '【通道】当前是 QQ 官方机器人通道，**支持 markdown 渲染**'
      : '【通道】当前是 QQ 官方机器人通道，纯文本输出';
  }
  return '【通道】当前是个人号（OneBot）通道，**纯文本**';
}

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('官方通道 + markdown 开 → 告诉它支持渲染', () => {
  const s = channelCapabilityLine('official-7132C62C', true);
  assert.match(s, /官方机器人/);
  assert.match(s, /支持 markdown/);
});

check('官方通道 + markdown 关 → 明确纯文本', () => {
  const s = channelCapabilityLine('official-7132C62C', false);
  assert.match(s, /官方机器人/);
  assert.match(s, /纯文本/);
  assert.doesNotMatch(s, /支持 markdown/);
});

check('个人号（OneBot）→ 纯文本，别用 markdown', () => {
  const s = channelCapabilityLine('group:631539503', true);
  assert.match(s, /个人号/);
  assert.match(s, /纯文本/);
});

check('空 key 不炸', () => {
  assert.ok(channelCapabilityLine('', true).length > 0);
  assert.ok(channelCapabilityLine(null, false).length > 0);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
