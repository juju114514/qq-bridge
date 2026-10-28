// 死信（src/dead-letter.js）的契约测试：全离线。
//
// 这条东西的存在意义是"被丢弃的消息还能找回来"，所以测的是：能追加、能读回、
// 坏行不炸、文件超过上限会轮转、空/超长文本不搞坏 JSONL。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/dead-letter.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-dead-')), 'dropped.jsonl');

check('appendDropped：写一行 JSONL，readDropped 能原样读回', () => {
  const f = tmpFile();
  const r = m.appendDropped(f, { key: 'group:official-X', reason: 'queue-full', promptText: '抖音链接' });
  assert.equal(r.ok, true);
  const rows = m.readDropped(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'group:official-X');
  assert.equal(rows[0].reason, 'queue-full');
  assert.equal(rows[0].promptText, '抖音链接');
  assert.ok(rows[0].at, '要带时间戳');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('appendDropped：超长正文被截断，不会把 JSONL 撑爆', () => {
  const f = tmpFile();
  m.appendDropped(f, { key: 'k', reason: 'r', promptText: 'x'.repeat(9000) });
  const rows = m.readDropped(f);
  assert.ok(rows[0].promptText.length <= 4000, `实际 ${rows[0].promptText.length}`);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('readDropped：坏行跳过，不影响其它行', () => {
  const f = tmpFile();
  m.appendDropped(f, { key: 'a', reason: 'r1', promptText: 'one' });
  fs.appendFileSync(f, '{broken json\n', 'utf8');
  m.appendDropped(f, { key: 'b', reason: 'r2', promptText: 'two' });
  const rows = m.readDropped(f);
  assert.equal(rows.length, 2, '坏行应被跳过');
  assert.deepEqual(rows.map((r) => r.promptText), ['one', 'two']);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('appendDropped：超过上限自动轮转到 .1（保留一份历史，不无限膨胀）', () => {
  const f = tmpFile();
  m.appendDropped(f, { key: 'k', reason: 'r', promptText: 'x'.repeat(200) });
  // 用一个很小的上限触发轮转
  m.appendDropped(f, { key: 'k2', reason: 'r', promptText: 'y'.repeat(200) }, { maxBytes: 100 });
  assert.ok(fs.existsSync(`${f}.1`), '应有 .1 轮转文件');
  assert.equal(m.readDropped(f).length, 1, '当前文件只剩新的那条');
  assert.equal(m.readDropped(`${f}.1`).length, 1, '旧文件保留一条');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('summarizeDropped：按原因分组计数', () => {
  const f = tmpFile();
  m.appendDropped(f, { key: 'a', reason: 'queue-full', promptText: '1' });
  m.appendDropped(f, { key: 'b', reason: 'queue-full', promptText: '2' });
  m.appendDropped(f, { key: 'c', reason: 'unauthorized@chat', promptText: '3' });
  const s = m.summarizeDropped(f);
  assert.equal(s.total, 3);
  assert.equal(s.byReason['queue-full'], 2);
  assert.equal(s.byReason['unauthorized@chat'], 1);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

check('接线：三处队列满丢弃 + 补投未授权，都写死信', () => {
  const bridge = read('src/bridge.js');
  const hits = (bridge.match(/dropToDeadLetter\(/g) ?? []).length;
  assert.ok(hits >= 4, `至少 4 处调用（3 处队列满 + 1 处未授权），实际 ${hits}`);
  assert.match(bridge, /queue-full/, '要标明丢弃原因');
  assert.match(bridge, /pending-queue-dropped\.jsonl/, '死信文件路径');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
