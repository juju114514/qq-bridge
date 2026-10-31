// 插件 vendor 副本的新鲜度守卫。
//
// 为什么需要：plugin/ 要能被单独安装（GitHub 子目录 / 拷走），所以把用到的
// src 模块复制了一份到 plugin/vendor/。副本一旦和源头漂移，就会出现
// "插件用的还是旧逻辑"这种非常难查的问题。
//
// 规则：plugin/vendor/X.js 必须与 src/... 下的源头**逐字节相同**（除首行加注记）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const PAIRS = [
  ['src/onebot-ws.js', 'plugin/vendor/onebot-ws.js'],
  ['src/domains/channel-mode.js', 'plugin/vendor/channel-mode.js'],
  ['src/domains/channel-mode-store.js', 'plugin/vendor/channel-mode-store.js'],
];

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let failed = 0;

for (const [src, dst] of PAIRS) {
  const s = path.join(root, src);
  const d = path.join(root, dst);
  assert.ok(fs.existsSync(s), `源头缺失：${src}`);
  assert.ok(fs.existsSync(d), `vendor 副本缺失：${dst}`);
  const same = hash(s) === hash(d);
  if (same) {
    console.log(`  ok   ${dst}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${dst} 与 ${src} 不一致 —— 重新复制一份（见 docs/guides/PLUGIN-MODE.md「vendor」节）`);
  }
}

// 再确认插件代码里没有跨包相对导入（否则单独安装会炸）
const indexSrc = fs.readFileSync(path.join(root, 'plugin/index.js'), 'utf8');
const cross = indexSrc.match(/import\('\.\.\/(?!vendor)[^']+'\)/g) ?? [];
if (cross.length) {
  failed += 1;
  console.log(`  FAIL plugin/index.js 仍有跨包导入：${cross.join(', ')}`);
} else {
  console.log('  ok   plugin/index.js 无跨包导入');
}

console.log(`\n结果：${PAIRS.length + 1 - failed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);