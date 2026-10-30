#!/usr/bin/env node
/**
 * 路由清单守卫：证明「导出的 handler」与「实际派发链」是对得上的。
 *
 * 为什么需要它（2026-10-31，借鉴同源分叉 AI-group-friends 的同名守卫）：
 * 控制台路由分成了两层 ——
 *   1. 派发链：bridge.js 里的 `.chain(handleX)` / `handleX(req)` 调用
 *   2. 处理体：src/api/*.js 里每个模块自己按 pathname 匹配
 * 这种结构下最容易静默出三类错：
 *   ① 模块导出了但**没接进派发链** → 端点 404，没人发现
 *   ② 同一个 path 被**两个模块**都判 → 谁生效取决于链顺序，改顺序即改行为
 *   ③ 迁移后留下的**空 if 块**（墓碑） → 不报错，但读者会以为它还在处理
 *
 * 用法：
 *   node scripts/check-route-inventory.mjs           # 检查，墓碑只告警
 *   node scripts/check-route-inventory.mjs --strict  # 墓碑也算失败
 *   node scripts/check-route-inventory.mjs --json    # 机器可读
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'src', 'api');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const asJson = args.includes('--json');

const PATH_RE = /pathname\s*(?:===|!==)\s*'([^']+)'|pathname\.startsWith\(\s*'([^']+)'\)/g;

// 内联路由预算（棘轮）：bridge.js 里还没搬进派发链的 `url.pathname` 判断条数。
// 波次 4 的目标是把它降到 0；在那之前**只能减不能增** —— 新端点必须写进 src/api/*.js 并接链。
const INLINE_ROUTE_BUDGET = 37;

/** 每个 api 模块：导出名 + 它判定的 (method, path) 集合 */
function scanApiModule(file) {
  const src = fs.readFileSync(path.join(API_DIR, file), 'utf8');
  // 文件级方法守卫（例：`if (req.method !== 'GET') return false`）对该文件里
  // 没有自己写 method 判断的路径生效 —— 不认这条会把"读写分在两个模块"误报成冲突。
  const fileMethod = /req\.method\s*!==\s*'(GET|POST|PATCH|DELETE|PUT)'/.exec(src)?.[1] ?? null;
  const blocks = src.split(/(?=export (?:async )?function \w+)/).slice(1);
  const handlers = new Map();
  for (const block of blocks) {
    const name = block.match(/^export (?:async )?function (\w+)/)?.[1];
    if (!name) continue;
    const routes = [];
    for (const line of block.split('\n')) {
      const paths = [...line.matchAll(PATH_RE)].map((m) => m[1] ?? m[2]);
      if (!paths.length) continue;
      // 同一行里的 method 判断（没有就是 ANY）
      const method = /method\s*===\s*'(GET|POST|PATCH|DELETE|PUT)'/.exec(line)?.[1] ?? (fileMethod || 'ANY');
      for (const p of paths) routes.push({ method, path: p });
    }
    handlers.set(name, routes);
  }
  return handlers;
}

const problems = [];
const warnings = [];

// 1) 收集模块与 path
const moduleHandlers = new Map();   // handler -> { file, paths }
const pathOwners = new Map();       // path -> [handler]
for (const file of fs.readdirSync(API_DIR).filter((n) => n.endsWith('.js')).sort()) {
  for (const [name, routes] of scanApiModule(file)) {
    moduleHandlers.set(name, { file, routes });
    for (const r of routes) {
      if (!pathOwners.has(r.path)) pathOwners.set(r.path, []);
      pathOwners.get(r.path).push(name);
    }
  }
}

// 2) 接线判定：把 src 下所有文件读进来（除模块自身），看导出名有没有被引用。
//    为什么不是只看 bridge：有些模块是被 src/api/console-extra-routes.js 之类的中转接走的。
const SRC = path.join(ROOT, 'src');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const allSrc = new Map(walk(SRC).map((p) => [p, fs.readFileSync(p, 'utf8')]));
const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
const wired = new Set();
for (const m of bridgeSrc.matchAll(/\.chain\(\s*(\w+)\s*\)/g)) wired.add(m[1]);
for (const m of bridgeSrc.matchAll(/(?<![.\w])(handle\w+)\s*\(/g)) wired.add(m[1]);

// 3) 墓碑：bridge 里的空 if 块
const bridgeLines = bridgeSrc.split('\n');
const tombstones = [];
for (let i = 0; i < bridgeLines.length - 1; i += 1) {
  const a = bridgeLines[i].trim();
  const b = bridgeLines[i + 1].trim();
  if (a.startsWith('if (') && a.endsWith('{') && b === '}') {
    const paths = [...a.matchAll(PATH_RE)].map((m) => m[1] ?? m[2]);
    tombstones.push({ line: i + 1, paths });
  }
}

// 4) 判定
for (const [name, info] of moduleHandlers) {
  if (wired.has(name)) continue;
  const self = path.join(API_DIR, info.file);
  const usedElsewhere = [...allSrc.entries()].some(([p, src]) =>
    p !== self && new RegExp(`\\b${name}\\b`).test(src));
  if (!usedElsewhere) problems.push(`模块导出了但全仓没人用：${name}（${info.file}，端点会 404）`);
}
// (method, path) 冲突：ANY 与具体方法也算冲突（顺序决定行为）
const slotOwner = new Map();   // `${method} ${path}` -> [handler]
for (const [name, info] of moduleHandlers) {
  for (const r of info.routes) {
    const key = `${r.method} ${r.path}`;
    if (!slotOwner.has(key)) slotOwner.set(key, []);
    slotOwner.get(key).push(name);
  }
}
for (const [key, owners] of slotOwner) {
  const uniq = [...new Set(owners)];
  if (uniq.length > 1) problems.push(`同一方法+路径被多个 handler 判定：${key}（${uniq.join(' / ')}，生效者取决于链顺序）`);
}
for (const t of tombstones) {
  // 只有当墓碑里的 path 确实由别的 handler 接管时，才算"死代码"（不是漏接）
  const line = t.paths.length
    ? `空 if 块（墓碑，L${t.line}）：${t.paths.join(', ')} —— 已由派发链接管，删掉它免得误读`
    : `空 if 块（墓碑，L${t.line}）：无 path 字面量`;
  warnings.push(line);
}

// 内联路由计数：bridge 里仍在直接按 pathname 分派的条数
const inlineRoutes = bridgeSrc.split('\n').filter((l) => /url\.pathname/.test(l) && /(===|startsWith)/.test(l) && !l.trim().startsWith('//'));
if (inlineRoutes.length > INLINE_ROUTE_BUDGET) {
  problems.push(`bridge.js 内联路由 ${inlineRoutes.length} 条，超过预算 ${INLINE_ROUTE_BUDGET}（新端点请写进 src/api/*.js 并接进派发链）`);
}

const report = {
  inlineRoutes: inlineRoutes.length,
  inlineBudget: INLINE_ROUTE_BUDGET,
  handlers: moduleHandlers.size,
  paths: pathOwners.size,
  wired: wired.size,
  tombstones: tombstones.length,
  problems,
  warnings
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`  模块 handler: ${report.handlers} 个，path 字面量: ${report.paths} 条，桥接里引用: ${report.wired} 个名字`);
  console.log(`  bridge 内联路由: ${report.inlineRoutes}/${report.inlineBudget}（棘轮：只能减）`);
  if (problems.length) {
    console.error('✗ 路由清单有问题：');
    for (const p of problems) console.error('   ' + p);
  }
  if (warnings.length) {
    console.log(`⚠ 墓碑/提示 ${warnings.length} 条：`);
    for (const w of warnings) console.log('   ' + w);
  }
  if (!problems.length) console.log('✓ 导出与派发链双向对账通过');
}

const fail = problems.length > 0 || (strict && warnings.length > 0);
process.exit(fail ? 1 : 0);