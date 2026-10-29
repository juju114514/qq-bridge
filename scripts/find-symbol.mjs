#!/usr/bin/env node
// 找符号：定义在哪、被谁用。
//
// 为什么单独做一个命令：bridge.js 还有 1 万行时，"改一个函数"最贵的成本不是改，
// 而是**先把整文件读进上下文**。这个命令用一次 grep 回答两个问题：
//   1) 它定义在哪个文件哪一行
//   2) 它在哪些文件被调用（按次数排序）
//
// 用法：
//   node scripts/find-symbol.mjs scheduleWakeV2
//   node scripts/find-symbol.mjs wakeConfig --def-only
//   node scripts/find-symbol.mjs deliverPrompt --max 40

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const symbol = String(args.find((a) => !a.startsWith('--')) ?? '').trim();
const defOnly = args.includes('--def-only');
const maxIdx = args.indexOf('--max');
const maxHits = maxIdx >= 0 ? Math.max(5, Number(args[maxIdx + 1]) || 30) : 30;

if (!symbol) {
  console.error('用法：node scripts/find-symbol.mjs <符号名> [--def-only] [--max N]');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const defRe = new RegExp(`(?:function|class|const|let|var)\\s+${esc}\\s*(?:[=(:])`);
const useRe = new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`);

const defs = [];
const uses = new Map();

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (defRe.test(line)) defs.push({ rel, line: i + 1, text: line.trim() });
    else if (useRe.test(line)) {
      if (!uses.has(rel)) uses.set(rel, []);
      uses.get(rel).push({ line: i + 1, text: line.trim() });
    }
  });
}

console.log(`\n符号：${symbol}`);
console.log('─'.repeat(64));
if (defs.length === 0) console.log('  （没有找到定义 —— 可能来自第三方库，或名字拼错了）');
for (const d of defs) {
  console.log(`  定义  ${d.rel}:${d.line}`);
  console.log(`        ${d.text.slice(0, 110)}`);
}

if (!defOnly) {
  const total = [...uses.values()].reduce((n, v) => n + v.length, 0);
  console.log(`\n使用点：${total} 处，分布在 ${uses.size} 个文件`);
  const sorted = [...uses.entries()].sort((a, b) => b[1].length - a[1].length);
  let shown = 0;
  for (const [rel, list] of sorted) {
    if (shown >= maxHits) { console.log(`  …（还有更多，用 --max N 调大）`); break; }
    console.log(`  ${rel}  ×${list.length}`);
    for (const u of list) {
      if (shown >= maxHits) break;
      console.log(`    L${u.line}: ${u.text.slice(0, 100)}`);
      shown += 1;
    }
  }
}
console.log('');