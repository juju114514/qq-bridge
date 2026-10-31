#!/usr/bin/env node
// 生成 preset 的部署副本（单一真源 → 产物）。
//
// 背景（2026-10-31）：三份 qq-tool-restrict.mjs 里，**只有 dsh/agent-presets/<preset>/
// 那份会被 DSH 真正加载**。因为改错了副本，白名单整整一天没生效，而且没有任何报错。
//
// 现在的规则：
//   真源  plugins/qq-agent-presets/qq-tool-restrict.mjs
//   产物  dsh/agent-presets/qq-chat/qq-tool-restrict.mjs
//         dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs
// 只允许改真源，然后跑一次 `node scripts/build-presets.mjs`。
//
// 产物写入时会附一行 hash 注释；`check-preset-fresh.mjs` 用它校验运行的就是真源。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(root, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
export const TARGETS = [
  path.join(root, 'dsh', 'agent-presets', 'qq-chat', 'qq-tool-restrict.mjs'),
  path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'qq-tool-restrict.mjs'),
];
export const HASH_MARK = '// source-sha256: ';

export function sourceHash() {
  const buf = fs.readFileSync(SOURCE);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function stamp(text, hash) {
  const body = text.replace(new RegExp(`^${HASH_MARK}[0-9a-f]{64}\\n`, 'm'), '');
  return `${HASH_MARK}${hash}\n` + body;
}

function main() {
  const hash = sourceHash();
  const text = fs.readFileSync(SOURCE, 'utf8');
  let changed = 0;
  for (const target of TARGETS) {
    const next = stamp(text, hash);
    const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (prev === next) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next, 'utf8');
    changed += 1;
    console.log(`  ✓ 已生成 ${path.relative(root, target)}`);
  }
  console.log(`  真源 hash: ${hash.slice(0, 12)}…  目标: ${TARGETS.length} 份  更新: ${changed} 份`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
