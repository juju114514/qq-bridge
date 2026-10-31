// 核心库（src/core/*）的纯度守卫。
//
// 目的：给"薄插件 + 复用核心"（docs/design/plugin-mode-2026-10-31.md）留一条硬边界 ——
// 核心模块必须能在没有任何 IO 的情况下被 import 与单测，插件和 sidecar 才能共用同一份逻辑。
//
// 检查两件事：
//  1. 静态：不允许 import fs / net / http(s) / child_process / os / process 相关模块
//  2. 动态：能 import 且导出非空（防止门面文件写空）
//
// 例外：src/core/session-router.mjs 是早先就有的、带状态的路由器，不在本守卫范围内。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, '..', 'src', 'core');
const EXEMPT = new Set(['session-router.mjs', 'session-router.test.mjs']);
const FORBIDDEN = /^node:(fs|fs\/promises|net|http|https|child_process|dgram|dns|os|worker_threads)$/;

const files = fs.readdirSync(coreDir).filter((f) => f.endsWith('.js') && !EXEMPT.has(f));
assert.ok(files.length >= 6, `src/core 里的模块应至少有 6 个，实际 ${files.length}`);

let failed = 0;
for (const f of files) {
  const full = path.join(coreDir, f);
  const src = fs.readFileSync(full, 'utf8');
  const imports = [...src.matchAll(/^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const reexports = [...src.matchAll(/^\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const badImports = imports.filter((spec) => FORBIDDEN.test(spec) || spec === 'fs' || spec === 'http');

  try {
    assert.equal(badImports.length, 0, `禁止的 import：${badImports.join(', ')}`);
    // 只允许相对路径（防止偷偷依赖 npm 包里的副作用模块）
    for (const spec of [...imports, ...reexports]) {
      assert.ok(spec.startsWith('.'), `只允许相对导入，发现：${spec}`);
    }
    const mod = await import(pathToFileURL(full).href);
    assert.ok(Object.keys(mod).length > 0, '导出为空：门面文件可能写错了');
    console.log(`  ok   ${f.padEnd(14)} 导出 ${String(Object.keys(mod).length).padStart(2)} 个，无 IO import`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${f} — ${e?.message ?? e}`);
  }
}

console.log(`\n结果：${files.length - failed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);