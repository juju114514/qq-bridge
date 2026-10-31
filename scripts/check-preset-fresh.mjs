#!/usr/bin/env node
// 守卫：**DSH 实际加载的 preset 必须与单一真源一致**。
//
// 这条守的是 2026-10-31 那次事故：改的是 plugins 副本，DSH 加载的是 dsh/agent-presets 副本，
// 于是「代码改了、真机没变、日志也没变」，排查了一小时。
import fs from 'node:fs';
import path from 'node:path';
import { SOURCE, TARGETS, HASH_MARK, sourceHash } from './build-presets.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const hash = sourceHash();
check('真源存在且可读', () => {
  if (!fs.existsSync(SOURCE)) throw new Error(`找不到真源：${path.relative(root, SOURCE)}`);
});

for (const target of TARGETS) {
  check(`产物与真源一致：${path.relative(root, target)}`, () => {
    if (!fs.existsSync(target)) throw new Error('产物不存在，先跑 node scripts/build-presets.mjs');
    const text = fs.readFileSync(target, 'utf8');
    const m = text.match(new RegExp(`${HASH_MARK}([0-9a-f]{64})`));
    if (!m) throw new Error('产物里没有 source-sha256 标记，先跑 build-presets.mjs');
    if (m[1] !== hash) {
      throw new Error(`产物 hash ${m[1].slice(0, 12)}… ≠ 真源 ${hash.slice(0, 12)}… —— 改完真源忘了 build？`);
    }
  });
}

check('产物之间完全一致（防止只更新了其中一份）', () => {
  const bodies = TARGETS.filter((t) => fs.existsSync(t))
    .map((t) => fs.readFileSync(t, 'utf8').replace(new RegExp(`^${HASH_MARK}[0-9a-f]{64}\\n`, 'm'), ''));
  for (const b of bodies) {
    if (b !== bodies[0]) throw new Error('两份产物的正文不一致');
  }
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}（真源 hash ${hash.slice(0, 12)}…）`);
process.exit(failures ? 1 : 0);
