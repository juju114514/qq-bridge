// README 版本一致性守卫（0.4.85）
//
// 起因：README 的「版本怎么看」一直写着 v0.4.26，而 package.json 已经到 0.4.84 ——
// 差了 58 个版本没人发现，因为**没人跑机器检查**。人工对比靠不住，加个守卫。
//
// 规则（只抓"断言"，不抓示例）：
//   · 形如「当前 vX.Y.Z」「当前版本 `vX.Y.Z`」「本 fork 当前版本 …」的句子，必须与 package.json 一致
//   · `git log v0.4.26..v0.4.84` 这种**示例命令**不算断言，跳过
//   · CHANGELOG 里的历史版本号不管（那是历史记录）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = path.join(root, 'README.md');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '');

const text = fs.readFileSync(readme, 'utf8');
const lines = text.split('\n');

// 「当前」+ 版本号，且不是 git log / 示例命令
const CLAIM = /(当前[^。\n]{0,10}|本 fork 当前版本[^。\n]{0,4})v?(\d+\.\d+\.\d+)/g;
const SKIP = /git log|git checkout|releases\/tag\/v|^\s*>?\s*\|/;

const bad = [];
lines.forEach((line, i) => {
  if (SKIP.test(line)) return;
  let m;
  CLAIM.lastIndex = 0;
  while ((m = CLAIM.exec(line)) !== null) {
    const found = m[2];
    if (found !== version) {
      bad.push({ line: i + 1, found, text: line.trim().slice(0, 100) });
    }
  }
});

// 必须显式声明「文档版本」，且与 package.json 一致 —— 这样别人一眼能判断自己读的是不是最新
const MARKER_RE = /文档版本[：:]\s*\*{0,2}(\d+\.\d+\.\d+)/;
const marker = text.match(MARKER_RE);
if (!marker) {
  console.error('  ✗ README 顶部缺少「文档版本：x.y.z」标记（守卫无法判断文档新旧）');
  console.error('    修法：在「版本怎么看」下面加一行，或用 node scripts/bump-version.mjs <版本> 自动维护');
  process.exit(1);
}
if (marker[1] !== version) {
  bad.push({ line: text.slice(0, marker.index).split('\n').length, found: marker[1], text: '文档版本标记' });
}

if (!bad.length) {
  console.log(`  ✓ README 的版本断言与 package.json 一致（当前 ${version}）`);
  process.exit(0);
}

console.error('  ✗ README 里写的版本和 package.json 不一致：');
console.error(`     package.json = ${version}`);
for (const b of bad) console.error(`     README:${b.line}  写的是 ${b.found} —— ${b.text}`);
console.error('');
console.error('  修法：把断言改成"以 package.json 为准"，或直接改成当前版本号。');
process.exit(1);
