#!/usr/bin/env node
/**
 * 守卫：docs/ROUTES.md 必须是最新的。
 *
 * 为什么需要：手写端点表一定会过期；即使是"生成"的，也可能改了代码忘了重新生成。
 * 这条守卫拿「现在生成出来的内容」和「仓库里的文件」逐字节比 —— 不一致就红。
 *
 * 修法：node scripts/gen-route-index.mjs --write
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'ROUTES.md');

const fresh = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-route-index.mjs')], { encoding: 'utf8' });
const actual = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
if (fresh.trim() !== actual.trim()) {
  console.error('✗ docs/ROUTES.md 与代码不一致 —— 运行：node scripts/gen-route-index.mjs --write');
  process.exit(1);
}
console.log('✓ docs/ROUTES.md 是最新的');