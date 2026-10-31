// 文档索引守卫（0.4.67）
//
// 为什么需要它：**同一个疏漏反复发生** —— 新写的指南/设计文档忘了进 docs/README.md 索引，
// 读者在索引里找不到，等于没写。这一轮一次性查出 18 篇漏索引（guides 6 / design 5 / 顶层 7）。
//
// 规则（只约束"活文档"，不折腾历史归档）：
//   · docs/guides/**、docs/design/**、docs/*.md（顶层） → **必须**出现在 docs/README.md
//   · docs/audits/**、docs/releases/**、docs/reports/**、docs/validation/**、docs/sessions/** → 豁免（历史记录）
//
// 用法：node scripts/check-docs-index.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const indexPath = path.join(docsDir, 'README.md');

const EXEMPT_DIRS = ['audits', 'releases', 'reports', 'validation', 'sessions'];

const index = fs.readFileSync(indexPath, 'utf8');

/** 递归列出 docs 下的 md（相对 docs/ 的正斜杠路径） */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(path.relative(docsDir, full).replace(/\\/g, '/'));
  }
  return out;
}

const all = walk(docsDir).filter((rel) => {
  if (rel === 'README.md') return false;
  const top = rel.includes('/') ? rel.split('/')[0] : null;
  if (top && EXEMPT_DIRS.includes(top)) return false;
  return true;
});

const missing = all.filter((rel) => {
  const base = path.basename(rel);
  return !index.includes(rel) && !index.includes(base);
});

if (missing.length === 0) {
  console.log(`  ✓ 文档索引完整（${all.length} 篇活文档全部在 docs/README.md 里）`);
  process.exit(0);
}

console.error('  ✗ 这些文档没有进 docs/README.md 索引：');
for (const rel of missing) console.error(`     - ${rel}`);
console.error('');
console.error('  修法：在 docs/README.md 对应小节（guides / design / 顶层文档）的表格里补一行。');
console.error('  豁免：audits / releases / reports / validation / sessions（历史归档）');
process.exit(1);
