// 会话 key 解析（src/conv-key.js）的契约测试：官方 openid 必须与数字 QQ 号共存。
//
// 为什么单独立一套：这是"官方通道能不能发消息"的总闸。历史上这里有 21 处
// `/^(group|private):(\d+)$/`，官方会话撞上就报 "key 格式应为 group:群号"，
// 去掉前缀又被 agent token 拒（token 绑定的是带 official- 的 key）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { parseConvKey, convId, CONV_KEY_RE, canonicalConvKey } = await import(new URL('../src/conv-key.js', import.meta.url).href);

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

check('数字 id：群/私聊都解析成 Number', () => {
  assert.deepEqual(parseConvKey('group:123456789'), { kind: 'group', id: 123456789, official: false });
  assert.deepEqual(parseConvKey('private:123456789'), { kind: 'private', id: 123456789, official: false });
});

check('官方 id：openid 原样保留成字符串，official=true', () => {
  const k = 'group:official-7132C62C67081883180A9D9AFAC9B8B3';
  const r = parseConvKey(k);
  assert.equal(r.kind, 'group');
  assert.equal(r.id, 'official-7132C62C67081883180A9D9AFAC9B8B3');
  assert.equal(r.official, true);
  assert.equal(typeof r.id, 'string', 'openid 绝不能变成 Number（会 NaN）');
});

check('非法 key 一律 null（不造脏会话）', () => {
  for (const bad of ['group:abc', 'xxx:1', 'group:', 'group:official-', 'group:1 2', '']) {
    assert.equal(parseConvKey(bad), null, bad);
  }
});

check('convId：官方原样、数字转换、非法 NaN', () => {
  assert.equal(convId('official-X'), 'official-X');
  assert.equal(convId('123'), 123);
  assert.ok(Number.isNaN(convId('abc')));
  assert.ok(Number.isNaN(convId('0')), '0 不是合法 QQ 号/群号');
});

check('发送端点已改用共享解析（不再各自写数字正则）', () => {
  for (const rel of ['src/api/send.js', 'src/api/socialV2-send.js']) {
    const src = read(rel);
    assert.match(src, /conv-key\.js/, `${rel} 必须 import 共享解析`);
    assert.match(src, /CONV_KEY_RE\.exec/, `${rel} 必须用 CONV_KEY_RE`);
    assert.ok(!/\^\(group\|private\):\(\\d\+\)\$/.test(src), `${rel} 还残留裸数字正则`);
  }
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }

// ── canonicalConvKey：会话 key 的唯一形式 ──────────────────────────────────
// 这条规则防的是"同一个人两套记忆"：group:0123 与 group:123 若被当成两个会话，
// 状态各自累积，AI 会记错上下文。
check('canonicalConvKey：数字 id 去掉前导零', () => {
  assert.equal(canonicalConvKey('group:0123'), 'group:123');
  assert.equal(canonicalConvKey('private:0001'), 'private:1');
});

check('canonicalConvKey：官方 openid 原样保留（不能走 Number）', () => {
  assert.equal(canonicalConvKey('private:official-AbC-123'), 'private:official-AbC-123');
});

check('canonicalConvKey：非法 key 返回 null', () => {
  assert.equal(canonicalConvKey('group:abc'), null);
  assert.equal(canonicalConvKey('group:0'), null);
  assert.equal(canonicalConvKey(''), null);
  assert.equal(canonicalConvKey(null), null);
});

check('canonicalConvKey：首尾空白被容忍', () => {
  assert.equal(canonicalConvKey('  group:123  '), 'group:123');
});
