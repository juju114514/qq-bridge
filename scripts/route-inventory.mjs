#!/usr/bin/env node
/**
 * 路由清单：把 src/bridge.js 里平铺的 HTTP 路由 if 链抽成一张表。
 *
 * 用途：
 *   1. 重构前的「现状盘点」——知道到底有多少端点、分散在哪
 *   2. 重构中的「迁移进度」——按 domain 分组，逐组搬走
 *   3. 长期：作为文档自动生成（防止 README 里的端点列表过期）
 *
 * 用法：
 *   node scripts/route-inventory.mjs            # Markdown 表
 *   node scripts/route-inventory.mjs --json     # JSON
 *   node scripts/route-inventory.mjs --stats    # 只看统计
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const API_DIR = path.join(ROOT, 'src', 'api');
// 路由可能已经被拆到 src/api/*.js —— 清单必须两边都扫，否则迁移后计数会"凭空变少"，
// 失去「路由守恒」这个重构安全网的作用。
const FILES = [BRIDGE];
if (fs.existsSync(API_DIR)) {
  for (const f of fs.readdirSync(API_DIR).filter((x) => x.endsWith('.js')).sort()) {
    FILES.push(path.join(API_DIR, f));
  }
}

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const statsOnly = args.has('--stats');

const sources = FILES.map((f) => ({ file: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));
const src = sources.map((s) => s.src).join('\n');

/** 一条路由：{ method, path, kind, line, guard } */
const routes = [];
let currentMethod = null;
let currentGuard = null;

const RE_EXACT = /(?:url\.)?pathname\s*===\s*'([^']+)'/;
const RE_PREFIX = /(?:url\.)?pathname\.startsWith\('([^']+)'\)/;
const RE_PATHNAME_VAR = /url\.pathname\s*===?\s*rid/;
const RE_METHOD_EQ = /(?:req\.method|method)\s*===\s*'([A-Z]+)'/;
const RE_METHOD_NE = /(?:req\.method|method)\s*!==\s*'([A-Z]+)'/;

// 路由分组：按路径前缀归类，方便按域迁移
const GROUPS = [
  ['status', /^\/api\/(status|security)$/],
  ['send', /^\/api\/send\//],
  ['roles', /^\/api\/role/],
  ['socialV2', /^\/api\/socialV2\//],
  ['social(v1)', /^\/api\/social(\/|$)/],
  ['slang', /^\/api\/slang/],
  ['stickers', /^\/api\/stickers/],
  ['sessions', /^\/api\/session/],
  ['images', /^\/api\/images\//],
  ['voice', /^\/api\/voice/],
  ['qzone', /^\/api\/qzone/],
  ['tokens', /^\/api\/tokens/],
  ['feedback', /^\/api\/(feedback|report)/i],
  ['console-static', /^\/($|console|index|assets\/)/],
  ['other', /.*/],
];

function groupOf(p) {
  for (const [name, re] of GROUPS) if (re.test(p)) return name;
  return 'other';
}

for (const { file, src: fileSrc } of sources) {
const lines = fileSrc.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const ln = i + 1;

  // 记下当前 if 链里的 method / guard（简单状态机：遇到新的 if 就重置）
  if (/\bif\s*\(/.test(line)) {
    currentMethod = null;
    currentGuard = /\bx-agent-token\b/.test(line) ? 'agent-rejected' : null;
  }
  const me = RE_METHOD_EQ.exec(line);
  if (me) currentMethod = me[1];
  const mn = RE_METHOD_NE.exec(line);
  if (mn && !currentMethod) currentMethod = `!=${mn[1]}`;
  if (/adminOnlyV2Paths|agentAllowed/.test(line)) currentGuard = 'agent-restricted';

  const ex = RE_EXACT.exec(line);
  if (ex) {
    routes.push({
      method: currentMethod || '?(同链)',
      path: ex[1],
      kind: 'exact',
      file,
      line: ln,
      guard: currentGuard || '',
      group: groupOf(ex[1]),
    });
    continue;
  }
  const px = RE_PREFIX.exec(line);
  if (px) {
    routes.push({
      method: currentMethod || '?(同链)',
      path: px[1] + '*',
      kind: 'prefix',
      file,
      line: ln,
      guard: currentGuard || '',
      group: groupOf(px[1]),
    });
  }
}

}
// ── 统计 ────────────────────────────────────────────────────────────────────
const byGroup = new Map();
for (const r of routes) {
  const g = byGroup.get(r.group) || { count: 0, methods: new Set(), first: r.line };
  g.count++;
  g.methods.add(r.method);
  g.first = Math.min(g.first, r.line);
  byGroup.set(r.group, g);
}

const stats = {
  files: sources.map((s) => s.file),
  lines: src.split('\n').length,
  bytes: Buffer.byteLength(src, 'utf8'),
  routeHits: routes.length,
  uniquePaths: new Set(routes.map((r) => r.path)).size,
  methodChecks: (src.match(/req\.method\s*(===|!==)/g) || []).length,
  pathChecks: (src.match(/url\.pathname/g) || []).length,
  groups: [...byGroup.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, g]) => ({ name, count: g.count, methods: [...g.methods], firstLine: g.first })),
};

if (asJson) {
  console.log(JSON.stringify({ stats, routes }, null, 2));
  process.exit(0);
}

if (statsOnly) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

// ── Markdown 输出 ──────────────────────────────────────────────────────────
console.log(`# 路由清单（自动生成）\n`);
console.log(`来源：${stats.files.map((f) => `\`${f}\``).join(' + ')}（共 ${stats.lines} 行 / ${(stats.bytes / 1024).toFixed(0)} KB）\n`);
console.log(`| 指标 | 数值 |`);
console.log(`| --- | --- |`);
console.log(`| 路由命中（含前缀） | ${stats.routeHits} |`);
console.log(`| 唯一路径 | ${stats.uniquePaths} |`);
console.log(`| \`url.pathname\` 比较次数 | ${stats.pathChecks} |`);
console.log(`| \`req.method\` 判断次数 | ${stats.methodChecks} |`);
console.log('');

console.log(`## 按域分组\n`);
console.log(`| 分组 | 路由数 | 方法 | 起始行 |`);
console.log(`| --- | ---: | --- | ---: |`);
for (const g of stats.groups) {
  console.log(`| ${g.name} | ${g.count} | ${g.methods.join(' / ')} | ${g.firstLine} |`);
}
console.log('');

console.log(`## 全部路由\n`);
console.log(`| # | 文件 | 行 | 方法 | 路径 | 类型 | 限制 |`);
console.log(`| ---: | --- | ---: | --- | --- | --- | --- |`);
routes
  .sort((a, b) => a.line - b.line)
  .forEach((r, i) => {
    console.log(`| ${i + 1} | ${r.file} | ${r.line} | ${r.method} | \`${r.path}\` | ${r.kind} | ${r.guard || '-'} |`);
  });
console.log('');
console.log(`> 迁移时按「分组」逐个搬：每搬完一组，重跑本脚本，对照路由数是否守恒。`);
