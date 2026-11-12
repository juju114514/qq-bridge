// 人格卡「按需小节」标签的**会话隔离**守卫。
//
// 事故（2026-11-13）：roleActiveNeedTags 原来是模块级的单个 Set，
// 任何会话只要有一句提到「攻略/配队/唱歌」，随后 2 分钟内**所有**会话的提示词
// 都会注入人格卡里那些按需小节 —— 表现是别的群问视频，AI 却答游戏攻略。
//
// 这类"串味"用端到端测很难抓住（要两个群 + 时序），但用静态契约能钉住：
//   · 不允许再出现全局 Set
//   · setRoleNeedTagsFromText 必须带 key（第二个参数）
//   · 过期清理必须按 key 清，而不是清空全局
//
// 改这块代码时先看这条测试，别把隔离改回全局。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bridge.js'), 'utf8');

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log('  ✓', name); };

check('不再有全局 roleActiveNeedTags', () => {
  assert.equal(/roleActiveNeedTags/.test(src), false, 'still references roleActiveNeedTags');
});

check('标签容器是按会话的 Map', () => {
  assert.match(src, /roleNeedTagsByKey\s*=\s*new Map\(\)/);
});

check('setRoleNeedTagsFromText 接收 key', () => {
  const m = src.match(/function setRoleNeedTagsFromText\(([^)]*)\)/);
  assert.ok(m, 'function not found');
  assert.ok(/key/.test(m[1]), `signature should take key, got: ${m[1]}`);
});

check('写入时按 key 取容器', () => {
  assert.match(src, /roleNeedTagsByKey\.get\(k\)/);
  assert.match(src, /roleNeedTagsByKey\.set\(k,\s*tags\)/);
});

check('过期清理按 key 清（不是清空全局）', () => {
  assert.match(src, /setTimeout\(\(\)\s*=>\s*clearRoleNeedTags\(k\)/);
});

check('提示词取用按当前会话过滤', () => {
  assert.match(src, /roleNeedTagsByKey\.get\(key\)/);
});

check('调用点把 key 传进去', () => {
  const call = src.match(/setRoleNeedTagsFromText\(`[^`]*`,\s*key\)/);
  assert.ok(call, 'call site should pass key');
});

check('会话数有上限（不会无限长）', () => {
  assert.match(src, /ROLE_NEED_TAG_MAX_KEYS/);
});

console.log(`\n按需小节隔离：${n} 项通过`);
