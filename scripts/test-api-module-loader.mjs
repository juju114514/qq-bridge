/**
 * scripts/lib/api-module-loader.mjs 的单元测试。
 *
 * 覆盖：
 *   · stripImports 处理单行/多行 import
 *   · stripExports 处理各种导出写法（含 export default）
 *   · collectExportNames 能认出 function/const/class
 *   · loadApiModules 在真实 vm context 里注入成功（用临时目录，不写仓库）
 *   · 注入失败时错误信息带文件名
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  stripImports,
  stripExports,
  collectExportNames,
  loadApiModules,
} from './lib/api-module-loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

// ── stripImports ────────────────────────────────────────────────────────────
t('删单行 import', () => {
  const out = stripImports("import fs from 'node:fs';\nconst a = 1;");
  assert.doesNotMatch(out, /import/);
  assert.match(out, /const a = 1;/);
});

t('删多行 import（不吞掉后续代码）', () => {
  const src = "import {\n  a,\n  b,\n} from './x.js';\nconst keep = 2;";
  const out = stripImports(src);
  assert.doesNotMatch(out, /import/);
  assert.match(out, /const keep = 2;/);
});

t('保留非 import 的 import.meta 之类文本', () => {
  const out = stripImports('const u = import.meta.url;');
  assert.match(out, /import\.meta\.url/);
});

// ── stripExports ────────────────────────────────────────────────────────────
t('export function → function', () => {
  assert.equal(stripExports('export function f() {}').trim(), 'function f() {}');
});

t('export const → const', () => {
  assert.equal(stripExports('export const A = 1;').trim(), 'const A = 1;');
});

t('export class → class', () => {
  assert.equal(stripExports('export class C {}').trim(), 'class C {}');
});

t('export default foo; 整行删除', () => {
  const out = stripExports('function f() {}\nexport default f;');
  assert.doesNotMatch(out, /export/);
  assert.match(out, /function f\(\)/);
});

t('export default function f 保留函数体', () => {
  const out = stripExports('export default function f() { return 1; }');
  assert.match(out, /function f\(\)/);
  assert.doesNotMatch(out, /export/);
});

t('export { a, b } 整行删除', () => {
  assert.equal(stripExports('export { a, b };').trim(), '');
});

t('export * from 删除', () => {
  assert.equal(stripExports("export * from './x.js';").trim(), '');
});

t('保留 JSDoc 里的 import(...) 类型注释', () => {
  const src = "/** @param {import('node:http').IncomingMessage} req */\nfunction f(req) {}";
  assert.match(stripExports(src), /import\('node:http'\)/);
});

// ── collectExportNames ──────────────────────────────────────────────────────
t('收集 function / const / class', () => {
  const src = [
    "import x from './y.js';",
    'export function a() {}',
    'async function b() {}',
    'export const c = 1;',
    'class D {}',
    'export default a;',
  ].join('\n');
  assert.deepEqual(collectExportNames(src).sort(), ['D', 'a', 'b', 'c']);
});

t('收集解构 const', () => {
  assert.deepEqual(collectExportNames('const { x, y: z } = obj;').sort(), ['x', 'z']);
});

// ── loadApiModules（真实 vm + 临时目录）────────────────────────────────────
t('注入模块到 vm context 并可调用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apimod-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src', 'api'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'src', 'api', 'demo.js'),
      [
        "import fs from 'node:fs';",
        'export function greet(name) { return `hi ${name}`; }',
        'export const VERSION = 1;',
        'export default greet;',
      ].join('\n'),
    );
    const context = vm.createContext({});
    const r = loadApiModules(context, { root: tmp, vm, fs, path });
    assert.deepEqual(r.files, ['demo.js']);
    assert.deepEqual(r.names.sort(), ['VERSION', 'greet']);
    assert.equal(context.greet('a'), 'hi a');
    assert.equal(context.VERSION, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

t('目录不存在时静默返回空', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apimod-'));
  try {
    const context = vm.createContext({});
    const r = loadApiModules(context, { root: tmp, vm, fs, path });
    assert.deepEqual(r, { files: [], names: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

t('注入失败时错误信息带文件名', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apimod-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'api', 'bad.js'), 'export function f( {');
    const context = vm.createContext({});
    assert.throws(
      () => loadApiModules(context, { root: tmp, vm, fs, path }),
      /bad\.js/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

t('真实仓库：src/api 不存在时不报错', () => {
  const context = vm.createContext({});
  const r = loadApiModules(context, { root: ROOT, vm, fs, path });
  assert.ok(Array.isArray(r.files));
});

console.log(`\n  ${pass} 项通过`);
if (process.exitCode) console.error('  有失败项');
