#!/usr/bin/env node
// 文档链接守卫：Markdown 里的本地链接（文件 + 锚点）必须真的存在。
//
// 为什么值得进审计：这些文档是给人和 AI **照着排错**用的。
// 一个 404 的链接，AI 会当成"这条排错路径不存在"，人会觉得文档过期。
// 2026-10-30 首次跑：68 个 md 里有 81 处坏链（大多是 docs/guides 下少写一层 ../，
// 以及被 gitignore 的 design/research/audits 链接进了公开仓库）。
//
// 规则：
//   · 外链（http/https/mailto）跳过
//   · 本地文件必须存在
//   · 带 #锚点 的，目标文件里必须有对应标题（按 GitHub slug 规则近似）
//   · 允许用 <!-- linkcheck:ignore --> 所在行跳过（给"故意留的示例"用）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'state', 'audio', 'logs', 'temp']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** GitHub 标题 → 锚点（近似实现：小写、去标点、空格转连字符） */
function slug(heading) {
  return heading
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\u4e00-\u9fff\- ]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const headingCache = new Map();
function headingsOf(file) {
  if (!headingCache.has(file)) {
    const set = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.startsWith('#')) set.add(slug(line));
    }
    headingCache.set(file, set);
  }
  return headingCache.get(file);
}

const files = walk(ROOT);
let problems = 0;
let warnings = 0;

/** 宽容匹配：精确 / 折叠连字符 / 互为子串（迁就 slug 规则差异） */
function anchorExists(target, frag) {
  const heads = headingsOf(target);
  if (heads.has(frag)) return true;
  const squash = (s) => s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  const want = squash(frag);
  for (const h of heads) {
    const got = squash(h);
    if (got === want || got.includes(want) || want.includes(got)) return true;
  }
  return false;
}

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('linkcheck:ignore')) return;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = m[1];
      if (/^(https?|mailto):/i.test(link)) continue;
      const [p, frag] = link.split('#');
      if (!p) continue;
      const target = path.resolve(path.dirname(file), p);
      if (!fs.existsSync(target)) {
        problems += 1;
        console.error(`  FAIL ${rel}:${i + 1} 文件不存在 → ${link}`);
        continue;
      }
      if (frag && target.endsWith('.md') && !anchorExists(target, frag)) {
        // 锚点只警告：GitHub 的 slug 规则（emoji/全角标点/反引号）很难精确复刻，
        // 假失败会让人干脆关掉这个检查 —— 那比漏掉一个锚点更糟。
        warnings += 1;
        console.warn(`  warn ${rel}:${i + 1} 锚点可能失效 → ${link}`);
      }
    }
  });
}

if (problems) {
  console.error(`\n  ${problems} 处坏链（修法：补../层级，或去掉指向未入库文件的链接）`);
  process.exitCode = 1;
} else {
  if (warnings) console.log(`  ${warnings} 条锚点提示（不阻塞）`);
  console.log(`  链接检查通过（${files.length} 个 md）`);
}