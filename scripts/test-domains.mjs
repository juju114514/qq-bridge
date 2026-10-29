#!/usr/bin/env node
// 架构边界检查（波次 0 立的规矩，波次 1 起生效）。
//
// 设计原则：**规矩是为了让人改得动，不是为了让项目合规。**
// 所以这里只有一条硬失败，其余都是"提示 + 预算"：
//
//   ❌ 硬失败：bridge.js 内联路由超过预算（棘轮，只许往下调）
//   ❌ 硬失败：跨域 import 超过预算（现在 5 处；用多了会露头，但不会拦死你）
//   ⚠️ 只警告：跨域 import 没写 `// cross-domain: 原因`（留痕，方便以后回看）
//   ⚠️ 只警告：单个 domain 文件 > 400 行（超过 600 才硬失败）
//
// 为什么不做"domains 之间禁止互相 import"：
//   规则太硬时，人会为了合规写更差的代码 —— 比如把同步函数调用改成事件，
//   或者把一堆无关助手塞进 runtime.js，把状态中心变成杂物间。
//   真要 import 就 import，**留一行注释说明为什么**就够了。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOMAINS_DIR = path.join(ROOT, 'src', 'domains');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');

const DOMAIN_WARN_LINES = 400;   // 超过就提醒（能一次读进上下文的大小）
const DOMAIN_FAIL_LINES = 600;   // 超过才硬失败
const CROSS_DOMAIN_BUDGET = 5;   // 全项目跨域 import 总预算
// 棘轮：只许往下调。搬走一条路由就把这个数改小。
// 2026-10-30 实测 55 条（计划文档里写的 48 是旧口径，已按真实 grep 修正）。
const INLINE_ROUTE_BUDGET = 55;

let failures = 0;
let warnings = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL ${msg}`); };
const warn = (msg) => { warnings += 1; console.warn(`  warn ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

// ── domains：预算 + 留痕，不做硬墙 ─────────────────────────────────────
if (!fs.existsSync(DOMAINS_DIR)) {
  ok('src/domains/ 尚未建立（波次 1 起生效，现在不算失败）');
} else {
  const files = fs.readdirSync(DOMAINS_DIR).filter((f) => f.endsWith('.js'));
  let crossTotal = 0;
  for (const name of files) {
    const full = path.join(DOMAINS_DIR, name);
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    if (lines.length > DOMAIN_FAIL_LINES) {
      fail(`src/domains/${name} 有 ${lines.length} 行 > ${DOMAIN_FAIL_LINES}（拆小一点，否则又读不进上下文）`);
    } else if (lines.length > DOMAIN_WARN_LINES) {
      warn(`src/domains/${name} 有 ${lines.length} 行 > ${DOMAIN_WARN_LINES}（还能读，但考虑再分）`);
    }
    for (const line of lines) {
      const m = /^import\s.*?from\s+['"]([^'"]+)['"]/.exec(line);
      if (!m) continue;
      const spec = m[1];
      const sameDomain = /^\.\/|^\.\.\/domains\//.test(spec) && name !== 'index.js';
      if (!sameDomain) continue;
      crossTotal += 1;
      if (!/cross-domain\s*:/.test(line)) {
        warn(`src/domains/${name} 跨域 import ${spec} 没写 \`// cross-domain: 原因\``);
      }
    }
  }
  if (crossTotal > CROSS_DOMAIN_BUDGET) {
    fail(`跨域 import 共 ${crossTotal} 处 > 预算 ${CROSS_DOMAIN_BUDGET}（考虑合并 domain，或把共用逻辑提到 runtime/api）`);
  } else {
    ok(`跨域 import ${crossTotal}/${CROSS_DOMAIN_BUDGET} 处（预算内，允许）`);
  }
  ok(`${files.length} 个 domain 文件体积检查完毕`);
}

// ── bridge.js 内联路由棘轮（唯一"真墙"）───────────────────────────────
if (fs.existsSync(BRIDGE)) {
  const text = fs.readFileSync(BRIDGE, 'utf8');
  const n = (text.match(/url\.pathname ===/g) ?? []).length;
  if (n > INLINE_ROUTE_BUDGET) {
    fail(`bridge.js 内联路由 ${n} 条 > 预算 ${INLINE_ROUTE_BUDGET}（新路由请直接写进 src/console/routes/）`);
  } else {
    ok(`bridge.js 内联路由 ${n} 条 ≤ 预算 ${INLINE_ROUTE_BUDGET}`);
  }
}

console.log('');
if (warnings) console.log(`  ${warnings} 条提示（不阻塞）`);
if (failures) { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
else console.log('  架构边界检查通过');