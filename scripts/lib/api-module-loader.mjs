/**
 * 把 src/api/*.js 里导出的东西注入到 VM 上下文（审计 harness 用）。
 *
 * 背景：`scripts/audit-bridge-harness.mjs` 是在 `node:vm` 里跑 bridge.js 的，
 * 并且会**先删掉所有顶层 import**（VM 里没有模块系统）。所以 bridge.js 一旦
 * 开始 `import { xxx } from './api/xxx.js'`，VM 里就会 `xxx is not defined`。
 *
 * 这个模块负责把「被 import 的那个文件」也搬进 VM：读源码 → 去掉 ESM 语法 →
 * 在同一 context 里执行 → 把导出挂到 globalThis。
 *
 * 只做纯文本变换 + 一次 vm 执行，不碰网络/文件系统之外的东西，方便单测。
 */

/** 删掉顶层 import（支持多行 import；与 harness 里对 bridge.js 的处理保持一致）。 */
export function stripImports(source) {
  const acc = { out: [], dropping: false };
  for (const line of String(source).split(/\r?\n/)) {
    if (acc.dropping) {
      if (/;\s*$/.test(line)) acc.dropping = false;
      continue;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.dropping = true;
      continue;
    }
    acc.out.push(line);
  }
  return acc.out.join('\n');
}

/**
 * 去掉 ESM 导出语法（保留声明本体），返回可在 VM 里裸跑的代码。
 *
 * 处理：
 *   export function foo()      → function foo()
 *   export const foo = ...     → const foo = ...
 *   export class Foo {}        → class Foo {}
 *   export default foo;        → （整行删除；名字由 collectExportNames 从声明里取）
 *   export default function f  → function f
 *   export { a, b };           → （整行删除）
 *   export * from './x';       → （整行删除）
 */
export function stripExports(source) {
  const out = [];
  for (const line of String(source).split(/\r?\n/)) {
    const t = line.trim();
    if (/^export\s+default\s*[A-Za-z_$][\w$]*\s*;?$/.test(t)) continue;      // export default foo;
    if (/^export\s*\{[^}]*\}\s*;?$/.test(t)) continue;                        // export { a, b };
    if (/^export\s*\*\s*from\s*['"].*['"]\s*;?$/.test(t)) continue;           // export * from './x';
    if (/^export\s+default\s+(function|class)\b/.test(t)) {
      out.push(line.replace(/^(\s*)export\s+default\s+/, '$1'));
      continue;
    }
    out.push(line.replace(/^(\s*)export\s+/, '$1'));
  }
  return out.join('\n');
}

/**
 * 收集该文件会暴露到 globalThis 的名字。
 *
 * 取：顶层 function / const / let / var / class 声明名。
 * （不解析 `export {}` 列表——那种写法在 src/api 里不用；真要用得加。）
 */
export function collectExportNames(source) {
  const names = new Set();
  const text = stripExports(stripImports(source));
  for (const line of text.split(/\r?\n/)) {
    let m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) { names.add(m[1]); continue; }
    m = /^class\s+([A-Za-z_$][\w$]*)\b/.exec(line);
    if (m) { names.add(m[1]); continue; }
    m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m) { names.add(m[1]); continue; }
    m = /^(?:const|let|var)\s*\{([^}]*)\}\s*=/.exec(line);
    if (m) {
      for (const part of m[1].split(',')) {
        const n = part.split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
      }
    }
  }
  return [...names];
}

/**
 * 把 apiDir 下所有 .js 注入 VM context。
 *
 * @param {object} context  vm.createContext(...) 的返回值
 * @param {object} opts
 * @param {string} opts.root       仓库根目录
 * @param {import('node:vm')} opts.vm
 * @param {object} opts.fs         node:fs
 * @param {object} opts.path       node:path
 * @param {string} [opts.apiDir]   相对 root 的目录，默认 'src/api'
 * @returns {{ files: string[], names: string[] }}
 */
export function loadApiModules(context, { root, vm, fs, path, apiDir = 'src/api' }) {
  const dir = path.join(root, apiDir);
  if (!fs.existsSync(dir)) return { files: [], names: [] };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const injected = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const body = stripExports(stripImports(raw));
    const names = collectExportNames(raw);
    if (names.length === 0) continue;
    try {
      vm.runInContext(
        `Object.assign(globalThis, (() => {\n${body}\nreturn { ${names.join(', ')} };\n})())`,
        context,
        { filename: `${apiDir}/${file}` },
      );
      injected.push(...names);
    } catch (error) {
      // 注入失败必须**明确炸**：静默跳过会让 bridge 在 VM 里报 "xxx is not defined"，
      // 而真实原因（模块语法/顶层 await）被埋掉。
      error.message = `注入 ${apiDir}/${file} 失败：${error.message}`;
      throw error;
    }
  }
  return { files, names: injected };
}
