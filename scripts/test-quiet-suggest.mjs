// 静默时段建议（0.4.55）：从 7×24 热力图里找「连续 N 小时最安静」的窗口。
// 这个测试直接把 console.html 里的函数抽出来在 Node 里跑 —— 测的是**发布出去的那份代码**，
// 不是另写一份"应该一样"的实现。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const pick = (name) => {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `console.html 里找不到 ${name}`);
  let depth = 0;
  let i = html.indexOf('{', start);
  const from = i;
  for (; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
};
const sandbox = new Function(pick('suggestQuietWindow') + '\n' + pick('quietWindowScore') + '\nreturn { suggestQuietWindow, quietWindowScore };')();

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const emptyGrid = () => Array.from({ length: 7 }, () => new Array(24).fill(0));

check('全空：给出合法窗口（8 小时）', () => {
  const r = sandbox.suggestQuietWindow(emptyGrid(), 8);
  assert.equal(typeof r.start, 'number');
  assert.equal((r.start + 8) % 24, r.end);
  assert.equal(r.total, 0);
});

check('只有一个小时有消息：窗口会避开它', () => {
  const g = emptyGrid();
  for (let d = 0; d < 7; d += 1) g[d][15] = 5;
  const r = sandbox.suggestQuietWindow(g, 8);
  // 15 点不该落在 [start, start+8) 里
  for (let k = 0; k < 8; k += 1) assert.notEqual((r.start + k) % 24, 15, '不应把繁忙的小时圈进静默');
  assert.equal(r.total, 0);
});

check('跨零点窗口能被选中（凌晨最安静）', () => {
  const g = emptyGrid();
  for (let d = 0; d < 7; d += 1) { for (let hr = 8; hr < 22; hr += 1) g[d][hr] = 3; }
  const r = sandbox.suggestQuietWindow(g, 8);
  assert.equal(r.total, 0, '白天忙、凌晨空，应选出 0 条的窗口');
  const inWindow = (hr) => { for (let k = 0; k < 8; k += 1) if ((r.start + k) % 24 === hr) return true; return false; };
  assert.ok(inWindow(23) || inWindow(0) || inWindow(3), '凌晨应落在建议窗口内');
});

check('窗口长度可调（4 / 8 / 12）', () => {
  for (const L of [4, 8, 12]) {
    const r = sandbox.suggestQuietWindow(emptyGrid(), L);
    assert.equal((r.start + L) % 24, r.end, `L=${L} 的 end 应等于 start+L`);
  }
});

check('quietWindowScore：当前配置的窗口消息量', () => {
  const g = emptyGrid();
  g[0][23] = 4; g[1][0] = 1;
  assert.equal(sandbox.quietWindowScore(g, 23, 8), 5, '23→8 跨零点应统计 23 与 0 点');
  assert.equal(sandbox.quietWindowScore(g, 0, 0), 0, '同起点终点视为空窗口');
});

check('脏数据不炸', () => {
  const r = sandbox.suggestQuietWindow([[], undefined, null], 8);
  assert.equal(r.total, 0);
  assert.equal(typeof r.start, 'number');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }