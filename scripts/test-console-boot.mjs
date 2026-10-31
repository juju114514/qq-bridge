// 控制台首屏脚本完整性（0.4.64）
//
// 背景（真实事故）：`featureIndex` 里有一句 `section.querySelector('h2').textContent`。
// 新加的「记忆星图」section 忘了写 <h2>（用了 <strong>），于是这句抛 TypeError，
// **把整个 script 块后半段打断** —— 后面的状态轮询、首屏加载全都没执行。
// 用户看到的现象是：页面能渲染，但「正在连接…」「（加载中…）」永远不动，点一次刷新才正常。
//
// 这个测试守三件事：
//   1. 每个 section[data-page] 都有 <h2>（markup 层面的规范）
//   2. 那句代码保持"容错"写法（不能退回不带判断的 querySelector('h2').textContent）
//   3. 首屏加载有兜底（scheduleOverview），即使第一批 fetch 挂住也会重试
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('每个 section[data-page] 都有 <h2> 标题', () => {
  const starts = [...html.matchAll(/<section[^>]*data-page="([a-z0-9-]+)"[^>]*>/g)];
  assert.ok(starts.length >= 20, `section 数量异常：${starts.length}`);
  const missing = [];
  for (const m of starts) {
    const body = html.slice(m.index, html.indexOf('</section>', m.index));
    if (!/<h2[\s>]/.test(body)) missing.push(m[1]);
  }
  assert.deepEqual(missing, [], `这些 section 缺标题：${missing.join(', ')}`);
});

check('featureIndex 对缺 h2 的 section 容错（不再裸取 .textContent）', () => {
  assert.ok(
    !/section\.querySelector\('h2'\)\.textContent/.test(html),
    '代码里还有裸的 section.querySelector(\'h2\').textContent —— 一个忘了写 h2 的 section 就能打死整页脚本'
  );
  assert.ok(
    /const heading = section\.querySelector\('h2'\)/.test(html)
    && /heading \? heading\.textContent : \(section\.id \|\| page\)/.test(html),
    '没找到容错写法（const heading = ... / heading ? ... : ...）'
  );
});

check('首屏加载有兜底重试（scheduleOverview）', () => {
  assert.ok(/function scheduleOverview\(/.test(html), '缺 scheduleOverview 兜底');
  assert.ok(/document\.getElementById\('appDashboard'\)/.test(html), '兜底里应检查仪表盘容器是否还停在"加载中"');
});

check('关键初始化在脚本块末尾且未被 return 截断', () => {
  const tail = html.slice(html.lastIndexOf('bootConsolePage();'));
  assert.ok(/refresh\(\)/.test(tail), 'bootConsolePage 之后应继续执行 refresh()（说明脚本块没被异常打断）');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
