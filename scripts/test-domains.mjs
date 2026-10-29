#!/usr/bin/env node
// 架构边界守卫（波次 0 立规矩，波次 1 起生效）。
//
// 为什么需要它：拆分最怕的不是"拆得慢"，而是"拆完又长回去"。
// 昨天 bridge.js 里出现过三件事，这个脚本各钉住一条：
//
//   ① src/domains/* 只许依赖 runtime / api / node 内置 / 第三方
//      禁止 domains 之间互相 import —— 跨域通信走 rt.events（唯一接缝）
//   ② 单个 domain 文件 ≤ 400 行（能一次读进上下文）
//   ③ bridge.js 的内联路由只许减少：`url.pathname ===` 的出现次数是**棘轮**
//      （现在是 48，明天 15，最终 0 —— 全部搬进 src/console/routes/）
//
// 现在 domains/ 还不存在，脚本会报"尚未建立"，不算失败。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOMAINS_DIR = path.join(ROOT, 'src', 'domains');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const DOMAIN_MAX_LINES = 400;
// 棘轮：只许往下调。搬走一条路由就把这个数改小。
// 2026-10-30 实测 55 条（计划文档里写的 48 是旧口径，已按真实 grep 修正）。
const INLINE_ROUTE_BUDGET = 55;

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

// ── ① + ② domains ────────────────────────────────────────────────────
if (!fs.existsSync(DOMAINS_DIR)) {
  ok('src/domains/ 尚未建立（波次 1 起生效，现在不算失败）');
} else {
  const allowed = /^\.\.\/(runtime|api\/|core\/)|^\.\/(runtime|index)\.js$|^(node:|[a-z@][\w@/.-]*$)/;
  const files = fs.readdirSync(DOMAINS_DIR).filter((f) => f.endsWith('.js'));
  for (const name of files) {
    const full = path.join(DOMAINS_DIR, name);
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    if (lines.length > DOMAIN_MAX_LINES) {
      fail(`src/domains/${name} 有 ${lines.length} 行 > ${DOMAIN_MAX_LINES}（拆小一点，否则又读不进上下文）`);
    }
    for (const line of lines) {
      const m = /^import\s.*?from\s+['"]([^'"]+)['"]/.exec(line);
      if (!m) continue;
      const spec = m[1];
      if (/^\.\/|^\.\.\/domains\//.test(spec) && name !== 'index.js') {
        fail(`src/domains/${name} 直接 import 了同域文件 ${spec}（跨域请走 rt.events）`);
      } else if (!allowed.test(spec)) {
        fail(`src/domains/${name} 依赖了不该依赖的 ${spec}`);
      }
    }
  }
  if (!failures) ok(`${files.length} 个 domain 文件：依赖边界与体积都合格`);
}

// ── ③ bridge.js 内联路由棘轮 ─────────────────────────────────────────
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
if (failures) { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
else console.log('  架构边界检查通过');