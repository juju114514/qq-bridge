#!/usr/bin/env node
// 文件体积闸门：防止再长回 1.3 万行。
//
// 背景：bridge.js 曾经 12,029 行，花了很久才拆到 9,600。
// 光靠"下次注意"没用 —— 这里用**棘轮**（ratchet）把它钉住：
//   · 每个文件都有基线行数（scripts/file-size-baseline.json）
//   · 超过基线 + SLACK 就失败
//   · 新文件超过 NEW_FILE_MAX 也失败
//
// 想让某个文件合法变长：改完跑 `node scripts/test-file-size.mjs --update`
// 更新基线，并在提交信息里说明为什么长。这是**有意**的，不是偷偷放过。
//
// 用法：
//   node scripts/test-file-size.mjs            # 检查
//   node scripts/test-file-size.mjs --update   # 更新基线

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'scripts', 'file-size-baseline.json');
const SLACK = 50;          // 允许的增量（写几行注释不算违规）
const NEW_FILE_MAX = 800;  // 新文件上限
// 硬上限只许往下压，不许回调 —— 它防的是"拆分成果被新功能慢慢吃回去"。
// 2026-10-30：11,400 → 10,800（当日收尾 10,771，留 29 行余量）。
// 压到离实测很近是刻意的：加超过约 30 行就该先拆，而不是先加。
const BRIDGE_HARD_MAX = 10800;

function listJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'state', 'logs', 'tmp'].includes(entry.name)) continue;
      listJs(full, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

function countLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').length;
}

const files = listJs(path.join(ROOT, 'src'));
const sizes = {};
for (const f of files) sizes[path.relative(ROOT, f).replace(/\\/g, '/')] = countLines(f);

if (process.argv.includes('--update')) {
  const payload = {
    _说明: '各文件行数基线。改完代码要合法变长，跑 node scripts/test-file-size.mjs --update 并说明原因。',
    _slack: SLACK,
    _newFileMax: NEW_FILE_MAX,
    files: Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)))
  };
  fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`  基线已更新：${Object.keys(sizes).length} 个文件`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const base = baseline.files || {};
const problems = [];

for (const [rel, lines] of Object.entries(sizes)) {
  const was = base[rel];
  if (was === undefined) {
    if (lines > NEW_FILE_MAX) problems.push(`${rel}：新文件 ${lines} 行 > 上限 ${NEW_FILE_MAX}`);
    continue;
  }
  if (lines > was + SLACK) problems.push(`${rel}：${was} → ${lines} 行（+${lines - was}，超出允许增量 ${SLACK}）`);
  if (rel === 'src/bridge.js' && lines > BRIDGE_HARD_MAX) problems.push(`${rel}：${lines} 行 > 硬上限 ${BRIDGE_HARD_MAX}，该拆了`);
}

for (const rel of Object.keys(base)) {
  if (!(rel in sizes)) console.log(`  note ${rel} 已不存在（若是有意删除，跑 --update 更新基线）`);
}

const total = Object.values(sizes).reduce((a, b) => a + b, 0);
console.log(`  扫描 ${Object.keys(sizes).length} 个文件，共 ${total.toLocaleString()} 行`);
if (problems.length === 0) {
  console.log('  体积检查通过');
} else {
  for (const p of problems) console.error(`  ❌ ${p}`);
  console.error(`  ${problems.length} 个文件超标 —— 请拆分，或说明理由后 --update 基线`);
  process.exitCode = 1;
}