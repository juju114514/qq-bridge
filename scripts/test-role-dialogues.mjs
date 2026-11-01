// 人格示例对话（0.4.119）：解析 / 平衡 / 格式化 / 一步到位
import assert from 'node:assert/strict';

const m = await import(new URL('../src/role-dialogues.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const CARD = [
  '# 小鲸鱼',
  '',
  '你是一只懒散的鲸鱼，说话短，爱用省略号。',
  '',
  '## 示例对话',
  '用户：今天好累啊',
  '我：累就躺着，别硬撑。',
  '用户：可是活没干完',
  '我：明天再干，活又不会跑…',
  '',
  '## 其它设定',
  '不喜欢被叫"客服"。'
].join('\n');

check('能把「## 示例对话」节摘掉，正文其余保留', () => {
  const r = m.extractDialogues(CARD);
  assert.doesNotMatch(r.body, /示例对话/, '示例节应被摘掉');
  assert.doesNotMatch(r.body, /今天好累啊/, '对话内容不应留在正文');
  assert.match(r.body, /懒散的鲸鱼/, '正文要保留');
  assert.match(r.body, /其它设定/, '后面的小节要保留');
  assert.match(r.body, /不喜欢被叫/, '后面的内容要保留');
});

check('成对解析：交替 user / assistant', () => {
  const { pairs } = m.extractDialogues(CARD);
  assert.equal(pairs.length, 4);
  assert.equal(pairs[0].role, 'user');
  assert.equal(pairs[1].role, 'assistant');
  assert.equal(pairs[0].text, '今天好累啊');
  assert.equal(pairs[3].text, '明天再干，活又不会跑…');
});

check('奇数条 → 丢掉落单的最后一条', () => {
  const card = ['## 示例对话', '用户：a', '我：b', '用户：c'].join('\n');
  const { pairs } = m.extractDialogues(card);
  assert.equal(pairs.length, 2, '落单的「用户：c」应被丢掉');
});

check('支持英文写法 user:/assistant:', () => {
  const card = ['## Examples', 'user: hi', 'assistant: hello'].join('\n');
  const { pairs } = m.extractDialogues(card);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].role, 'user');
  assert.equal(pairs[1].role, 'assistant');
});

check('没有示例节时：正文原样返回，pairs 为空', () => {
  const r = m.extractDialogues('就是一段普通人格描述。');
  assert.equal(r.body, '就是一段普通人格描述。');
  assert.deepEqual(r.pairs, []);
});

check('空输入不炸', () => {
  assert.deepEqual(m.extractDialogues('').pairs, []);
  assert.deepEqual(m.extractDialogues(null).pairs, []);
});

check('格式化：带自称 + 明确「只学语气」', () => {
  const out = m.formatDialogues([
    { role: 'user', text: '在吗' },
    { role: 'assistant', text: '嗯…咋了' }
  ], { name: '小鲸鱼' });
  assert.match(out, /示例对话/);
  assert.match(out, /学语气/);
  assert.match(out, /对方：在吗/);
  assert.match(out, /小鲸鱼：嗯…咋了/);
});

check('格式化：没有名字就用「我」', () => {
  const out = m.formatDialogues([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }], {});
  assert.match(out, /我：b/);
});

check('格式化：空数组返回空串（调用方据此跳过拼接）', () => {
  assert.equal(m.formatDialogues([]), '');
  assert.equal(m.formatDialogues(null), '');
});

check('格式化：最多 6 条（3 轮），防止示例吃掉预算', () => {
  const pairs = [];
  for (let i = 0; i < 20; i++) pairs.push({ role: i % 2 ? 'assistant' : 'user', text: 'x' + i });
  const out = m.formatDialogues(pairs);
  assert.equal(out.split('\n').length - 1, 6, '应只保留 6 行对话');
});

check('splitForPrompt：一步返回剥离后的正文 + 注入块', () => {
  const r = m.splitForPrompt(CARD, '小鲸鱼');
  assert.doesNotMatch(r.body, /示例对话/);
  assert.match(r.block, /小鲸鱼：累就躺着/);
});

check('splitForPrompt：没有示例时 block 为空、正文不变', () => {
  const r = m.splitForPrompt('普通人格', '');
  assert.equal(r.block, '');
  assert.equal(r.body, '普通人格');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
