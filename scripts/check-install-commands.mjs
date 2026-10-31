// 安装命令守门（0.4.75）
//
// 为什么要有：文档里写错一个字符，用户就会装错。
// 真实翻车：`#main&path:/plugin` 在较新的 pnpm/DSH 上会被当成一个 ref，
// 解析失败后**退回装仓库根**（桥接应用本身），结果"装上了但插件不加载"。
// 正确写法只有一种：#path:/plugin（中间不能有 &）。
//
// 检查范围：面向使用者的活文档（README / llms.txt / AGENT-INSTALL / docs/guides / docs/design）。
// 豁免：CHANGELOG、docs/releases、docs/audits（历史记录，改了就是篡改历史）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'README.md',
  'llms.txt',
  'AGENT-INSTALL.md',
  'PLUGIN-MODE.md',
  'docs/README.md',
];
const DIRS = ['docs/guides', 'docs/design'];

const targets = [...FILES.map((f) => path.join(root, f)).filter((p) => fs.existsSync(p))];
for (const dir of DIRS) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (name.endsWith('.md')) targets.push(path.join(abs, name));
  }
}

const BAD = /#main&path:\/plugin/g;
const problems = [];

for (const file of targets) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const inWarning = (idx) => lines.slice(Math.max(0, idx - 2), idx + 1).some((l) => /不要写|别写|旧写法|×/.test(l));
  lines.forEach((line, i) => {
    if (!BAD.test(line)) return;
    BAD.lastIndex = 0;
    if (inWarning(i)) return; // 明确标注"不要这么写"的告警行允许出现
    problems.push(`${path.relative(root, file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
  });
  BAD.lastIndex = 0;
}

if (problems.length === 0) {
  console.log('  ✓ 安装命令写法一致（没有 #main&path:/plugin 这种会装错的写法）');
  process.exit(0);
}

console.error('  ✗ 这些地方还在教用户用会装错的写法：');
for (const p of problems) console.error(`     - ${p}`);
console.error('');
console.error('  正确写法：dsh plugin --profile desktop add github:juju114514/qq-bridge#path:/plugin');
process.exit(1);
