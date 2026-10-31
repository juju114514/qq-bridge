// 一条命令把版本号改到所有该改的地方（0.4.88）
//
// 为什么需要：版本号曾经散在四处（package.json / compat.json / README 的「当前版本」/ 发布说明），
// 结果 README 停在 0.4.26 而代码已经 0.4.84 —— 差 58 个版本没人发现。
// 现在收敛成：跑这个脚本 + 写 CHANGELOG，其余别手改。
//
// 用法：
//   node scripts/bump-version.mjs 0.4.88          # 只改文件
//   node scripts/bump-version.mjs 0.4.88 --check  # 只校验当前是否一致（不改）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const want = String(args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || '');
const checkOnly = args.includes('--check');

const files = {
  pkg: path.join(root, 'package.json'),
  compat: path.join(root, 'compat.json'),
  readme: path.join(root, 'README.md')
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

const pkg = readJson(files.pkg);
const compat = readJson(files.compat);
const readme = fs.readFileSync(files.readme, 'utf8');

// README 里的文档版本标记（由本脚本维护，守卫会校验）
const MARKER_RE = /(文档版本[：:]\s*\*{0,2})(\d+\.\d+\.\d+)/;

const state = {
  'package.json': String(pkg.version || ''),
  'compat.json': String(compat.bridge || ''),
  'README 标记': (readme.match(MARKER_RE) || [])[2] || '(缺失)'
};

if (checkOnly) {
  const bad = Object.entries(state).filter(([, v]) => v !== state['package.json']);
  if (!bad.length) {
    console.log(`  ✓ 四处版本一致：${state['package.json']}`);
    process.exit(0);
  }
  console.error('  ✗ 版本不一致：');
  for (const [k, v] of Object.entries(state)) console.error(`     ${k.padEnd(12)} ${v}`);
  console.error('  修法：node scripts/bump-version.mjs <版本>');
  process.exit(1);
}

if (!want) {
  console.error('  用法：node scripts/bump-version.mjs 0.4.88');
  process.exit(2);
}

pkg.version = want;
compat.bridge = want;
compat.updatedAt = new Date().toISOString().slice(0, 10);
writeJson(files.pkg, pkg);
writeJson(files.compat, compat);

if (!MARKER_RE.test(readme)) {
  console.error('  ⚠ README 里没有「文档版本：x.y.z」标记，先把标记加进 README 顶部再跑');
  process.exit(1);
}
fs.writeFileSync(files.readme, readme.replace(MARKER_RE, `$1${want}`));

console.log(`  ✓ 已把版本改成 ${want}：package.json / compat.json / README 标记`);
console.log('  接下来：写 CHANGELOG 条目 → node scripts/test-audit.mjs → git commit/tag/push');
