import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function scanFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scanFiles(p, out); continue; }
    if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [path.join(root, 'src/bridge.js'), ...scanFiles(path.join(root, 'src/api')), ...scanFiles(path.join(root, 'src/http'))];
const rows = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f).replace(/\\/g, '/');
  // GET/POST 精确路径
  for (const m of text.matchAll(/req\.method === '(GET|POST)' && (?:url\.)?pathname === '([^']+)'/g)) {
    rows.push({ file: rel, method: m[1], path: m[2] });
  }
  // 模块里常见写法：method === 'GET' && pathname === '...'
  for (const m of text.matchAll(/method === '(GET|POST)' && pathname === '([^']+)'/g)) {
    rows.push({ file: rel, method: m[1], path: m[2] });
  }
}

const seen = new Map();
for (const r of rows) {
  const key = `${r.method} ${r.path}`;
  if (!seen.has(key)) seen.set(key, r);
}
const list = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
console.log(JSON.stringify({ total: list.length, routes: list }, null, 2));
