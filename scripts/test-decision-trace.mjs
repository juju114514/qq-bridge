// 决策追踪（src/decision-trace.js）：/诊断 的数据来源。
//
// 重点：
//   · 环形缓冲：超上限丢最旧的，不会无限涨
//   · 只记截断文本（隐私）
//   · formatReport 要能说清"卡在哪一步"

import assert from 'node:assert/strict';

const { createDecisionTrace } = await import(new URL('../src/decision-trace.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

let clock = 1_000_000;
const mk = (opts = {}) => createDecisionTrace({ now: () => clock, ...opts });

check('记录一条完整决策链', () => {
  const t = mk();
  const rec = t.begin({ key: 'group:1', kind: 'group', messageId: 42, sender: '小明', text: '在吗' });
  t.step(rec, '闸门', '通过');
  t.step(rec, '唤醒', '未命中', '概率 0.15');
  t.finish(rec, '已入未读（等唤醒）');
  const text = t.formatReport({ key: 'group:1' });
  assert.match(text, /【诊断】group:1 最近 1 条/);
  assert.match(text, /· 闸门：通过/);
  assert.match(text, /· 唤醒：未命中（概率 0\.15）/);
  assert.match(text, /结果：已入未读（等唤醒）/);
});

check('环形缓冲：超上限丢最旧', () => {
  const t = mk({ max: 3 });
  for (let i = 1; i <= 5; i += 1) {
    const r = t.begin({ key: 'k', text: `m${i}` });
    t.finish(r, 'x');
  }
  assert.equal(t.size(), 3);
  const list = t.recent({ limit: 10 });
  assert.deepEqual(list.map((r) => r.text), ['m3', 'm4', 'm5']);
});

check('文本截断到 60 字（不把整段聊天抄进内存日志）', () => {
  const t = mk();
  const long = '啊'.repeat(200);
  const r = t.begin({ key: 'k', text: long });
  assert.ok(r.text.length <= 61, `实际 ${r.text.length}`);
  assert.ok(r.text.endsWith('…'));
});

check('按 key 过滤 + 按 seq/消息ID 查找', () => {
  const t = mk();
  const a = t.begin({ key: 'group:1', messageId: 100 });
  const b = t.begin({ key: 'private:2', messageId: 200 });
  t.finish(a, 'ok');
  t.finish(b, 'ok');
  assert.equal(t.recent({ key: 'group:1' }).length, 1);
  assert.equal(t.find(a.seq).key, 'group:1');
  assert.equal(t.find(200).key, 'private:2', '应按 QQ messageId 找到');
  assert.equal(t.find(999), null);
});

check('没有记录时给出可读提示（而不是空字符串）', () => {
  const t = mk();
  assert.match(t.formatReport(), /最近没有消息记录/);
  assert.match(t.formatReport({ key: 'group:9' }), /group:9 最近没有收到消息/);
});

check('fail-soft：传入空记录不抛错', () => {
  const t = mk();
  assert.doesNotThrow(() => { t.step(null, '闸门', '通过'); t.finish(null, 'x'); });
  assert.equal(t.formatOne(null), '');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }