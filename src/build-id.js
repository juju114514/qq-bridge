// 运行时构建指纹：buildId = 运行时清单的内容哈希。
//
// 为什么需要（2026-10-31 真机实测）：原来的 `commit` 读的是**部署目录自己的 .git HEAD**，
// 而我们用 rsync/复制同步文件，不 commit → 同步后 commit 不变，指纹等于失效。
//
// 设计取舍：
//   · buildId 只覆盖「影响运行行为的代码」：src/、plugin/、dsh/agent-presets/
//   · 排除：日志、state/、缓存、node_modules、.git、测试与文档
//   · 路径 + 内容一起进哈希（防止只改文件名但内容互换）
//   · 跨仓库同内容 → 同 buildId（这正是用来证明「部署的是同一份」）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 运行时清单：目录递归 + 单文件。改这里必须同步 docs/design/runtime-manifest.md 的说明。 */
export const RUNTIME_MANIFEST = [
  'src',
  'plugin',
  'dsh/agent-presets',
];

const IGNORE_DIRS = new Set(['node_modules', '.git', 'state', 'logs', 'coverage', 'dist', 'build', '.cache']);
const CODE_EXT = /\.(js|mjs|cjs|json|yml|yaml)$/;

function walk(root, relDir, out) {
  const abs = path.join(root, relDir);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = path.posix.join(relDir.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(root, rel, out);
    } else if (entry.isFile() && CODE_EXT.test(entry.name)) {
      out.push(rel);
    }
  }
}

/** 返回排序后的运行时文件列表（跨平台统一用 / 分隔）。 */
export function collectRuntimeFiles(root) {
  const files = [];
  for (const item of RUNTIME_MANIFEST) {
    const abs = path.join(root, item);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) walk(root, item, files);
    else if (CODE_EXT.test(item)) files.push(item);
  }
  return [...new Set(files)].sort();
}

/** buildId = sha256(相对路径 \0 内容 \0 …)，返回 `sha256:<64 hex>`（保留完整值）。 */
export function computeBuildId(root) {
  const hash = crypto.createHash('sha256');
  let count = 0;
  for (const rel of collectRuntimeFiles(root)) {
    let buf;
    try { buf = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    hash.update(rel);
    hash.update('\0');
    hash.update(buf);
    hash.update('\0');
    count += 1;
  }
  const hex = hash.digest('hex');
  return { buildId: `sha256:${hex}`, fileCount: count, short: hex.slice(0, 12) };
}

/** 来源 commit（部署目录自己的 git HEAD，仅作追溯线索，不参与相等性判断）。 */
export function readSourceCommit(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const p = path.join(root, '.git', ref);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim().slice(0, 12);
      const packed = path.join(root, '.git', 'packed-refs');
      if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(/\s+/);
          if (name === ref && sha) return sha.slice(0, 12);
        }
      }
      return '';
    }
    return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 12) : '';
  } catch { return ''; }
}
