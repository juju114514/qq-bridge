// 风格模块（0.4.78）：风格目录 / 多选解析 / prompt 拼装 / 回复拆分
import assert from 'node:assert/strict';

const m = await import(new URL('../src/qzone-styles.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('目录包含 日常/吐槽/文艺/技术/让它自己定 五种', () => {
  const labels = m.STYLE_CATALOG.map((s) => s.label);
  assert.deepEqual(labels, ['日常', '吐槽', '文艺', '技术', '让它自己定']);
  for (const s of m.STYLE_CATALOG) {
    assert.ok(s.hint && s.hint.length > 6, `${s.id} 应有 hint`);
    assert.ok(Array.isArray(s.length) && s.length.length === 2, `${s.id} 应有长度建议`);
  }
});

check('resolveStyles：单个 / 多个 / 空 / 未知 / 去重 / 超上限', () => {
  assert.deepEqual(m.resolveStyles('daily'), ['daily']);
  assert.deepEqual(m.resolveStyles(['daily', 'funny']), ['daily', 'funny']);
  assert.deepEqual(m.resolveStyles([]), ['auto'], '空 → 回落 auto');
  assert.deepEqual(m.resolveStyles(['不存在']), ['auto'], '未知 → 回落 auto');
  assert.deepEqual(m.resolveStyles(['daily', 'daily']), ['daily'], '去重');
  assert.equal(m.resolveStyles(['daily', 'funny', 'soft', 'tech']).length, m.MAX_STYLES, '超上限截断');
});

check('单风格 prompt：只有一种语气，带长度与表情约束', () => {
  const p = m.buildStylePrompt({ styles: ['soft'] });
  assert.match(p, /风格：短句、留白/);
  assert.match(p, /30~90 字/);
  assert.match(p, /不要鸡汤/);
  assert.doesNotMatch(p, /每种风格各一条/);
});

check('多风格 prompt：要求每种一条并列出标签', () => {
  const p = m.buildStylePrompt({ styles: ['daily', 'funny'] });
  assert.match(p, /帮我写 2 条/);
  assert.match(p, /每种风格各一条/);
  assert.match(p, /【日常】/);
  assert.match(p, /【吐槽】/);
});

check('prompt 里带上主题与素材，且不超长', () => {
  const p = m.buildStylePrompt({ styles: ['daily'], hint: '今天修好了插件', recent: '群里聊了云服务器' });
  assert.match(p, /今天修好了插件/);
  assert.match(p, /群里聊了云服务器/);
  assert.ok(p.length < 2000);
});

check('parseStyleReply：带【风格】标签的多条', () => {
  const reply = '【日常】今天把插件装好了，能用了。\n【吐槽】折腾一晚上，就为了一行 import。';
  const out = m.parseStyleReply(reply, ['daily', 'funny']);
  assert.equal(out.length, 2);
  assert.equal(out[0].style, 'daily');
  assert.equal(out[0].text, '今天把插件装好了，能用了。');
  assert.equal(out[1].style, 'funny');
});

check('parseStyleReply：只有编号的多条也能拆', () => {
  const out = m.parseStyleReply('1. 第一句\n2. 第二句', ['daily', 'funny']);
  assert.equal(out.length, 1, '编号只当作第一条的正文起点');
  assert.match(out[0].text, /第一句/);
});

check('parseStyleReply：整段没有标签 → 单条草稿', () => {
  const out = m.parseStyleReply('今天有点累，但还撑得住。', ['auto']);
  assert.equal(out.length, 1);
  assert.equal(out[0].style, 'auto');
  assert.equal(out[0].text, '今天有点累，但还撑得住。');
});

check('parseStyleReply：空回复 → 空数组（不产生空草稿）', () => {
  assert.deepEqual(m.parseStyleReply('   ', ['daily']), []);
  assert.deepEqual(m.parseStyleReply(null, ['daily']), []);
});

check('describeStyles 给人看的中文串', () => {
  assert.equal(m.describeStyles(['daily', 'funny']), '日常 / 吐槽');
  assert.equal(m.describeStyles([]), '让它自己定');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
