#!/usr/bin/env node
/**
 * 生成 docs/ROUTES.md —— 控制台路由总表（自动生成，勿手改）。
 *
 * 为什么要生成而不是手写：手写的端点表**一定**会过期。
 * 同源分叉 AI-group-friends 的做法是「生成 + 守卫」：
 *   · 本脚本生成文档
 *   · check-route-inventory.mjs 校验"模块导出 vs 派发链"和"内联路由预算"
 *
 * 用法：
 *   node scripts/gen-route-index.mjs          # 打印到 stdout
 *   node scripts/gen-route-index.mjs --write  # 写进 docs/ROUTES.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const API_DIR = path.join(SRC, 'api');
const BRIDGE = path.join(SRC, 'bridge.js');
const OUT = path.join(ROOT, 'docs', 'ROUTES.md');
const write = process.argv.includes('--write');

const PATH_RE = /pathname\s*(?:===|!==)\s*'([^']+)'|pathname\.startsWith\(\s*'([^']+)'\)/g;

function scanApi(file) {
  const src = fs.readFileSync(path.join(API_DIR, file), 'utf8');
  const fileMethod = /req\.method\s*!==\s*'(GET|POST|PATCH|DELETE|PUT)'/.exec(src)?.[1] ?? null;
  const blocks = src.split(/(?=export (?:async )?function \w+)/).slice(1);
  const rows = [];
  for (const block of blocks) {
    const name = block.match(/^export (?:async )?function (\w+)/)?.[1];
    if (!name) continue;
    for (const line of block.split('\n')) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      const paths = [...line.matchAll(PATH_RE)].map((m) => m[1] ?? m[2]);
      if (!paths.length) continue;
      const method = /method\s*===\s*'(GET|POST|PATCH|DELETE|PUT)'/.exec(line)?.[1] ?? (fileMethod || 'ANY');
      for (const p of paths) rows.push({ method, path: p, where: `src/api/${file}`, handler: name });
    }
  }
  return rows;
}

const moduleRows = fs.readdirSync(API_DIR).filter((n) => n.endsWith('.js')).sort().flatMap(scanApi);

// bridge 里还没搬走的内联路由
const bridgeLines = fs.readFileSync(BRIDGE, 'utf8').split('\n');
const inlineRows = [];
for (let i = 0; i < bridgeLines.length; i += 1) {
  const line = bridgeLines[i];
  if (line.trim().startsWith('//')) continue;
  if (!/url\.pathname/.test(line) || !/(===|startsWith)/.test(line)) continue;
  const method = /method\s*===\s*'(GET|POST|PATCH|DELETE|PUT)'/.exec(line)?.[1] ?? 'ANY';
  for (const m of line.matchAll(PATH_RE)) {
    inlineRows.push({ method, path: m[1] ?? m[2], where: `src/bridge.js:${i + 1}`, handler: '(内联)' });
  }
}

const byModule = new Map();
for (const r of moduleRows) {
  if (!byModule.has(r.where)) byModule.set(r.where, []);
  byModule.get(r.where).push(r);
}

const lines = [
  '# 控制台路由总表',
  '',
  '> **自动生成，勿手改**：`node scripts/gen-route-index.mjs --write`',
  '> 守卫：`scripts/check-route-inventory.mjs`（模块导出 vs 派发链对账 + 内联路由预算）',
  '',
  `- 已搬进模块：**${moduleRows.length}** 条（${byModule.size} 个文件）`,
  `- 仍在 bridge 内联：**${inlineRows.length}** 条（波次 4 目标是 0）`,
  ''
];

for (const [file, rows] of [...byModule.entries()].sort()) {
  lines.push(`## ${file}（${rows.length} 条）`, '', '| 方法 | 路径 | handler |', '|---|---|---|');
  for (const r of rows.sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(`| ${r.method} | \`${r.path}\` | ${r.handler} |`);
  }
  lines.push('');
}

lines.push(`## src/bridge.js 内联（${inlineRows.length} 条，待迁移）`, '', '| 方法 | 路径 | 行号 |', '|---|---|---|');
for (const r of inlineRows) {
  lines.push(`| ${r.method} | \`${r.path}\` | ${r.where.replace('src/bridge.js:', 'L')} |`);
}
lines.push('');

const md = lines.join('\n');
if (write) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md, 'utf8');
  console.log(`✓ 已写入 ${path.relative(ROOT, OUT)}：模块 ${moduleRows.length} 条 / 内联 ${inlineRows.length} 条`);
} else {
  console.log(md);
}