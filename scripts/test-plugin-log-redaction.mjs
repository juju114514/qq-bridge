// P2-4（v0.4.49）：plugin.log 默认不得出现 QQ 正文。
//
// 旧行为：`工具调用：qqb_send_message {"text":"<群聊原文>",...}` → 正文永久落盘
// （还会被轮转保留一份）。
import assert from 'node:assert/strict';

const m = await import(new URL('../plugin/index.js', import.meta.url).href);
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const SECRET = '群里的原话-7f3a9-不该出现在日志里';

check('参数摘要：正文不出现，只留长度', () => {
  const s = m.describeToolArgs('qqb_send_message', { key: 'group:123456', text: SECRET });
  assert.ok(!s.includes(SECRET), '正文泄漏进日志：' + s);
  assert.ok(!s.includes('群里的原话'), '正文片段泄漏');
  assert.match(s, /text:\d+字/, '应给出正文长度');
  assert.match(s, /qqb_send_message/, '工具名必须保留（取证重点）');
});

check('参数摘要：非敏感短字段可读（key 这类不敏感）', () => {
  const s = m.describeToolArgs('qqb_mark_read', { key: 'group:123456' });
  assert.match(s, /group:123456/);
});

check('参数摘要：嵌套对象只给键数，不展开', () => {
  const s = m.describeToolArgs('x', { data: { text: SECRET, a: 1, b: 2 } });
  assert.ok(!s.includes(SECRET));
  assert.match(s, /data:\{3键\}/);  // 三个键（含敏感的那个也只报数量）
});

check('参数摘要：JSON 字符串参数也能解析', () => {
  const s = m.describeToolArgs('qqb_send_message', JSON.stringify({ text: SECRET }));
  assert.ok(!s.includes(SECRET));
  assert.match(s, /text:\d+字/);
});

check('结果摘要：不落正文，只给状态与长度', () => {
  const s = m.describeToolResult('qqb_get_recent_messages', { ok: true, messages: [SECRET, SECRET] });
  assert.ok(!s.includes(SECRET), '结果正文泄漏：' + s);
  assert.match(s, /ok/);
});

check('结果摘要：字符串结果只给长度', () => {
  const s = m.describeToolResult('qqb_get_prompt', SECRET);
  assert.ok(!s.includes(SECRET));
  assert.match(s, new RegExp(String(SECRET.length) + '字'));
});

check('结果摘要：错误信息保留首行（便于排障），但不带正文', () => {
  const s = m.describeToolResult('qqb_reply', { ok: false, error: 'no such message' });
  assert.match(s, /fail/);
  assert.match(s, /no such message/);
});

check('verbose 开关默认关闭；显式 =1 才开', () => {
  assert.equal(m.verboseLogEnabled({}), false);
  assert.equal(m.verboseLogEnabled({ QQ_PLUGIN_LOG_VERBOSE: '0' }), false);
  assert.equal(m.verboseLogEnabled({ QQ_PLUGIN_LOG_VERBOSE: '1' }), true);
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
