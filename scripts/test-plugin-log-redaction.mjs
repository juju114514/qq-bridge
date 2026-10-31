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

check('结果摘要：错误默认只记长度（0.4.49.1 起；原文需 verbose）', () => {
  const s = m.describeToolResult('qqb_reply', { ok: false, error: 'no such message' });
  assert.match(s, /fail/);
  assert.match(s, /err:\d+字/, '默认不应出现错误原文');
  assert.ok(!s.includes('no such message'), '默认不应出现错误原文');
});

check('verbose 开关默认关闭；显式 =1 才开', () => {
  assert.equal(m.verboseLogEnabled({}), false);
  assert.equal(m.verboseLogEnabled({ QQ_PLUGIN_LOG_VERBOSE: '0' }), false);
  assert.equal(m.verboseLogEnabled({ QQ_PLUGIN_LOG_VERBOSE: '1' }), true);
});

// ── 0.4.49.1（R49-02 / R49-04）：残留收口 ──────────────────────────────
const LEAK = '这段是群友原话-9c2f-不该进日志';

check('describeError：默认不带 message（只给 name/code + 长度）', () => {
  const e = Object.assign(new Error(LEAK), { code: 'E_TEST' });
  const s = m.describeError(e, { verbose: false });
  assert.ok(!s.includes(LEAK), '错误信息泄漏：' + s);
  assert.match(s, /E_TEST/);
  assert.match(s, /message \d+ 字/);
});

check('describeError：verbose 才输出原文首行', () => {
  const e = new Error(LEAK + '\n第二行');
  const s = m.describeError(e, { verbose: true });
  assert.ok(s.includes(LEAK));
  assert.ok(!s.includes('第二行'), '只应给首行');
});

check('工具结果的 error 字段：默认只记长度', () => {
  const s = m.describeToolResult('qqb_reply', { ok: false, error: LEAK });
  assert.ok(!s.includes(LEAK), '结果错误字段泄漏正文：' + s);
  assert.match(s, /err:\d+字/);
  assert.match(s, /fail/);
});

check('工具结果的 error 字段：verbose 保留首行（排障用）', () => {
  const prev = process.env.QQ_PLUGIN_LOG_VERBOSE;
  process.env.QQ_PLUGIN_LOG_VERBOSE = '1';
  try {
    const s = m.describeToolResult('qqb_reply', { ok: false, error: LEAK });
    assert.ok(s.includes(LEAK));
  } finally {
    if (prev === undefined) delete process.env.QQ_PLUGIN_LOG_VERBOSE;
    else process.env.QQ_PLUGIN_LOG_VERBOSE = prev;
  }
});

check('源码层：发送成功日志不再用 JSON.stringify 兜底', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../plugin/index.js', import.meta.url), 'utf8');
  assert.ok(!/发送成功[^`]*JSON\.stringify/.test(src), '发送成功日志仍会 stringify 整个响应');
  assert.ok(src.includes("message_id=${r?.message_id"), '应只取明确 message_id');
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
