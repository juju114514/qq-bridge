// 控制台"页面加载钩子"守卫（0.4.96）
//
// 起因：0.4.91 / 0.4.93 / 0.4.95 连续三次出现"函数写好了但没人调用"——
// 症状完全相同：语法过、单测绿，但页面上就是不出现。
// 现在所有页面初始化都收口到 public/console.html 里的 PAGE_HOOKS 一张表，
// 这个守卫防止有人再往回塞散落的 if (page === '…') 调用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'public', 'console.html');
const html = fs.readFileSync(file, 'utf8');

const problems = [];

// 1) 必须有注册表与执行器
if (!/const PAGE_HOOKS = \{/.test(html)) problems.push('找不到 PAGE_HOOKS 注册表');
if (!/function runPageHooks\(/.test(html)) problems.push('找不到 runPageHooks 执行器');
if (!/runPageHooks\(page\)/.test(html)) problems.push('setConsolePage 没有调用 runPageHooks(page)');

// 2) 不允许再出现散落的 if (page === '...') 初始化
const scattered = [...html.matchAll(/if \(page === '[^']+'/g)];
if (scattered.length) {
  problems.push(`还有 ${scattered.length} 处散落的 if (page === '…')，请改成往 PAGE_HOOKS 里加：${scattered.slice(0, 3).map((m) => m[0]).join(' / ')}`);
}

// 3) 注册表里的每个函数名，必须在同文件里定义过（否则就是"缺函数"）
const registryMatch = /const PAGE_HOOKS = \{([\s\S]*?)\n  \};/.exec(html);
if (registryMatch) {
  const names = [...registryMatch[1].matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]);
  const keys = [...registryMatch[1].matchAll(/^\s*'?([\w-]+)'?:\s*\[/gm)].map((m) => m[1]);
  for (const name of names) {
    if (keys.includes(name)) continue; // 这是页面 key，不是函数名
    const defined = new RegExp(`(function\\s+${name}\\s*\\(|const\\s+${name}\\s*=|let\\s+${name}\\s*=|async function\\s+${name}\\s*\\()`).test(html);
    if (!defined) problems.push(`PAGE_HOOKS 里的 ${name} 在本文件里没有定义（运行时会 warn「缺函数」）`);
  }
}

// 4) 每个页面 key 必须是 consolePages 里存在的页面（防止拼错导致钩子永不执行）
const pagesMatch = /const consolePages = \{([\s\S]*?)\n  \};/.exec(html);
if (pagesMatch) {
  const pageKeys = [...pagesMatch[1].matchAll(/^\s*'?([\w-]+)'?:\s*\[/gm)].map((m) => m[1]);
  for (const key of keysOf(registryMatch)) {
    if (!pageKeys.includes(key)) problems.push(`PAGE_HOOKS 里的页面 ${key} 不在 consolePages 里（钩子永远不会执行）`);
  }
}

function keysOf(m) {
  if (!m) return [];
  return [...m[1].matchAll(/^\s*'?([\w-]+)'?:\s*\[/gm)].map((x) => x[1]);
}

if (!problems.length) {
  console.log('  ✓ 页面钩子集中在 PAGE_HOOKS（没有散落的 if (page === …)）');
  process.exit(0);
}

console.error('  ✗ 页面钩子有问题：');
for (const p of problems) console.error('     ' + p);
process.exit(1);
