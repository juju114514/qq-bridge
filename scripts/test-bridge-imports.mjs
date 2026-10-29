#!/usr/bin/env node
// 静态检查：bridge.js 里用到的工厂函数必须真的 import 了。
//
// 为什么需要它（真实事故 2026-10-30）：
//   拆分时我用"文本里有没有模块名"判断 import 是否已加，
//   结果模块名先出现在**分发注释**里，判断为真，import 被跳过。
//   node --check 只查语法，VM 审计又会按名字注入 —— 两处都发现不了，
//   线上表现是"任何一条消息进来就 ReferenceError，机器人完全不回"。
//
// 这里用"用到了必须能解析"的朴素规则补上这个盲区。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
// 去掉注释再扫：注释里写 "handleXxx(" 这种示例不该被当成真实调用
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// 收集 import 进来的名字（含多行 import）
const imported = new Set();
for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
  for (const n of m[1].split(',')) {
    const name = n.trim().split(/\s+as\s+/).pop().trim();
    if (name) imported.add(name);
  }
}
for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) imported.add(m[1]);

// 收集本文件里定义的名字
const defined = new Set();
for (const m of src.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
  for (const n of m[1].split(',')) {
    const name = n.trim().split(':').pop().trim();
    if (name) defined.add(name);
  }
}
for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
  for (const n of m[1].split(',')) {
    const name = n.trim();
    if (name) defined.add(name);
  }
}

// 关注的调用形态：createXxx(...) / handleXxx(
/** 只看"裸调用"：前面不能是点（`consoleDsh.handleModel(` 是方法调用，不算未定义） */
const used = new Set([...src.matchAll(/(?<![.\w$])((?:create|handle)[A-Z]\w*)\s*\(/g)].map((m) => m[1]));
const missing = [...used].filter((n) => !imported.has(n) && !defined.has(n));

if (missing.length) {
  console.error(`  ❌ bridge.js 用到但没有定义/导入：${missing.join(', ')}`);
  console.error('     这会让线上第一条消息就 ReferenceError；node --check 查不出来。');
  process.exitCode = 1;
} else {
  console.log(`  bridge.js 的 ${used.size} 个工厂/处理函数全部有来源（import 或本地定义）`);
}