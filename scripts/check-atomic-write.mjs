#!/usr/bin/env node
/**
 * 静态守卫：全仓的"原子写"只允许 src/atomic-write.js 一个实现。
 *
 * 为什么需要它（从同源分叉 AI-group-friends 学来的教训）：
 * 「别自己写 tmp+rename」这条规矩写在注释里**拦不住下一份抄写** —— 他们历史上先后有
 * 6 处各自重抄，其中 2 处用的还是被点名禁止的固定临时名（并发/符号链接攻击面）。
 * 规矩要靠机器守，不能靠自觉。
 *
 * 允许的例外（都要在文件里标 `// guard-allow: renameSync <原因>`）：
 *   · 轮转/隔离：把旧文件改名成 .1 或 .corrupt-<ts>，不是原子写
 *
 * 用法：node scripts/check-atomic-write.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const ALLOWED_IMPL = path.join(SRC, 'atomic-write.js');

const PATTERNS = [
  { re: /renameSync\(/, why: 'renameSync 只允许出现在 src/atomic-write.js' },
  { re: /writeFileSync\([^)]*\.tmp/, why: '直接写 .tmp 临时文件：请改用 src/atomic-write.js 的 atomicWriteJson/atomicWriteText' }
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const problems = [];
let allowMarked = 0;
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (file === ALLOWED_IMPL) continue;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const hasMark = lines.some((l) => l.includes('guard-allow: renameSync'));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;   // 注释里提到不算
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue;
      if (hasMark) { allowMarked += 1; continue; }
      problems.push(`${rel}:${i + 1} ${p.why}\n      ${line.trim().slice(0, 100)}`);
    }
  }
}

if (problems.length) {
  console.error('✗ 原子写守卫：');
  for (const p of problems) console.error('   ' + p);
  console.error('\n  例外要用注释标明：// guard-allow: renameSync <为什么这不是原子写>');
  process.exit(1);
}
console.log(`✓ 原子写唯一实现（src/atomic-write.js）；带 guard-allow 标记的例外 ${allowMarked} 处`);