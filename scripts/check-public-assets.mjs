#!/usr/bin/env node
// 守卫：console.html 里引用的本地静态资源必须真实存在，并且**必须能进 git**。
//
// 真实事故（2026-11-04）：.gitignore 写了 `public/*` 只放行 console.html，
// 于是 vendor/qrcode.min.js、icons/、manifest.webmanifest、sw.js 全被忽略。
// 本地跑得好好的，别人 clone 下来控制台缺件 —— 二维码库缺失会直接让扫码功能报错。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONSOLE = path.join(PUBLIC, 'console.html');

const IGNORE_PREFIX = new Set(['http:', 'https:', '//', 'data:', '#', 'mailto:', 'blob:']);

const html = fs.readFileSync(CONSOLE, 'utf8');
const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
const local = [...new Set(refs)].filter((r) => r && !IGNORE_PREFIX.has(r.slice(0, 7)) && !/^(https?:|\/\/|data:|#|mailto:|blob:)/.test(r));

const missing = [];
const ignored = [];
for (const ref of local) {
  // 只检查指向 public 静态文件的引用，跳过 /api/... 这类运行时接口
  if (ref.startsWith('/api/')) continue;
  const rel = ref.replace(/^\//, '').split('?')[0].split('#')[0];
  const abs = path.join(PUBLIC, rel);
  if (!fs.existsSync(abs)) {
    missing.push(ref);
    continue;
  }
  // 是否被 .gitignore 排掉（--no-index 只看规则，不要求已跟踪）
  try {
    execFileSync('git', ['-C', ROOT, 'check-ignore', '-q', `public/${rel}`], { stdio: 'pipe' });
    ignored.push(ref);   // exit 0 = 被忽略
  } catch { /* exit 1 = 没被忽略，正是我们要的 */ }
}

let bad = false;
if (missing.length) {
  bad = true;
  console.error('  ✗ console.html 引用了不存在的资源：');
  for (const m of missing) console.error('      ' + m);
}
if (ignored.length) {
  bad = true;
  console.error('  ✗ 这些资源存在但被 .gitignore 忽略（clone 下来会缺）：');
  for (const m of ignored) console.error('      ' + m);
}
if (!bad) {
  console.log(`  ✓ 控制台静态资源完整（检查 ${local.length} 个本地引用，全部存在且可入库）`);
}
process.exit(bad ? 1 : 0);
