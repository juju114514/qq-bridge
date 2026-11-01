// QQ 官方 markdown 转换 + 降级判定（0.4.115）
import assert from 'node:assert/strict';

const md = await import(new URL('../src/md-to-qq-markdown.js', import.meta.url).href);
const err = await import(new URL('../src/official-errors.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// ── 转换 ──
check('保留官方支持的语法：标题 / 加粗 / 列表 / 引用 / 链接', () => {
  const src = '## 标题\n\n**加粗** 和 [链接](https://x.com)\n\n- 一\n- 二\n\n> 引用';
  const out = md.toQqMarkdown(src);
  assert.match(out, /^## 标题/);
  assert.match(out, /\*\*加粗\*\*/);
  assert.match(out, /\[链接\]\(https:\/\/x\.com\)/);
  assert.match(out, /- 一/);
  assert.match(out, /> 引用/);
});

check('代码块：去掉围栏保留内容', () => {
  const out = md.toQqMarkdown('看这个：\n```js\nconst a = 1;\n```\n完');
  assert.doesNotMatch(out, /```/);
  assert.match(out, /const a = 1;/);
});

check('行内 code：去掉反引号', () => {
  assert.equal(md.toQqMarkdown('跑 `npm test` 就行'), '跑 npm test 就行');
});

check('HTML 标签被删掉', () => {
  assert.equal(md.toQqMarkdown('前 <b>粗</b> 后'), '前 粗 后');
});

check('表格转成「· a · b」行，分隔行丢掉', () => {
  const out = md.toQqMarkdown('| 名称 | 值 |\n| --- | --- |\n| 权重 | 2.0 |');
  assert.doesNotMatch(out, /\|/);
  assert.match(out, /· 名称 · 值/);
  assert.match(out, /· 权重 · 2\.0/);
});

check('--- 分割线换成 ***（官方只演示 ***）', () => {
  const out = md.toQqMarkdown('上\n\n---\n\n下');
  assert.match(out, /\*\*\*/);
  assert.doesNotMatch(out, /^---$/m);
});

check('空输入 / null 返回空串', () => {
  assert.equal(md.toQqMarkdown(''), '');
  assert.equal(md.toQqMarkdown(null), '');
  assert.equal(md.toQqMarkdown('   '), '');
});

check('连续空行压成一行', () => {
  assert.equal(md.toQqMarkdown('a\n\n\n\nb'), 'a\n\nb');
});

// ── 是否值得走 markdown 通道 ──
check('纯文本不触发 markdown（省一次降级风险）', () => {
  assert.equal(md.hasMarkdownSyntax('今天天气不错'), false);
  assert.equal(md.hasMarkdownSyntax('好的，我知道了'), false);
  assert.equal(md.hasMarkdownSyntax(''), false);
});

check('有语法才触发', () => {
  assert.equal(md.hasMarkdownSyntax('## 标题'), true);
  assert.equal(md.hasMarkdownSyntax('**加粗**'), true);
  assert.equal(md.hasMarkdownSyntax('- 列表'), true);
  assert.equal(md.hasMarkdownSyntax('1. 列表'), true);
  assert.equal(md.hasMarkdownSyntax('> 引用'), true);
  assert.equal(md.hasMarkdownSyntax('[链接](https://a.b)'), true);
  assert.equal(md.hasMarkdownSyntax('~~删除~~'), true);
  assert.equal(md.hasMarkdownSyntax('***'), true);
});

check('降级文本复用 mdToPlain（去标记，不留星号）', () => {
  const out = md.markdownFallbackText('## 标题\n\n**加粗** 和 `code`');
  assert.doesNotMatch(out, /##/);
  assert.doesNotMatch(out, /\*\*/);
  assert.doesNotMatch(out, /`/);
});

// ── 降级 / 切分判定 ──
check('markdown 类错误 → 降级纯文本', () => {
  for (const code of [22006, 40034008, 40034009, 40034011, 40034124, 304061, 40034127, 304036]) {
    assert.equal(err.shouldFallbackToPlain(code), true, `${code} 应降级`);
  }
});

check('配额/权限类错误 → 不降级（等再久也没用）', () => {
  for (const code of [40034128, 40034100, 40034005, 304103, 40034006]) {
    assert.equal(err.shouldFallbackToPlain(code), false, `${code} 不该降级`);
  }
});

check('长度超限 → 是切分不是降级', () => {
  assert.equal(err.isLengthError(40054007), true);
  assert.equal(err.isLengthError(40054018), true);
  assert.equal(err.isLengthError(22006), false);
  assert.equal(err.shouldFallbackToPlain(40054007), false, '超长不该走降级');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
