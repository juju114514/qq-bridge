// 官方通道：错误分类 / 退避 / 去重 / 被动配额（0.4.113）
import assert from 'node:assert/strict';

const err = await import(new URL('../src/official-errors.js', import.meta.url).href);
const bot = await import(new URL('../src/qqbot-official.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// ── 退避 ──
check('429 尊重 retry-after', () => {
  assert.equal(err.retryDelayMs({ status: 429, retryAfterHeader: '2', attempt: 1, maxAttempts: 3 }), 2000);
});

check('429 无头时指数退避（400~700 / 800~1100）', () => {
  const a1 = err.retryDelayMs({ status: 429, attempt: 1, maxAttempts: 3 });
  const a2 = err.retryDelayMs({ status: 429, attempt: 2, maxAttempts: 3 });
  assert.ok(a1 >= 400 && a1 < 700, `第一次 ${a1}`);
  assert.ok(a2 >= 800 && a2 < 1100, `第二次 ${a2}`);
});

check('retry-after 过大截到 10s；次数用完返回 null', () => {
  assert.equal(err.retryDelayMs({ status: 429, retryAfterHeader: '600', attempt: 1 }), 10000);
  assert.equal(err.retryDelayMs({ status: 429, attempt: 3, maxAttempts: 3 }), null);
});

check('4xx（非 429）不重试；5xx 重试', () => {
  assert.equal(err.retryDelayMs({ status: 400, attempt: 1 }), null);
  assert.ok(err.retryDelayMs({ status: 504, attempt: 1 }) > 0);
});

// ── 结果分类（201/202 坑 + 去重码）──
check('200 + 无 err_code = 成功', () => {
  assert.equal(err.classifyOfficialResult(200, { id: 'x' }).ok, true);
});

check('201 带 error body = 失败（不能只看 res.ok）', () => {
  const r = err.classifyOfficialResult(201, { err_code: 40034128, message: '被动回复超限' });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false, '配额类不该重试');
  assert.match(r.reason, /被动回复/);
});

check('40054005 = 去重，当成功处理', () => {
  const r = err.classifyOfficialResult(400, { err_code: 40054005 });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
});

check('40054005 即使 HTTP 200 返回也认作已发送', () => {
  assert.equal(err.classifyOfficialResult(200, { err_code: 40054005 }).duplicate, true);
});

check('429 可重试；40034006（内容违规）不重试', () => {
  assert.equal(err.classifyOfficialResult(429, {}).retryable, true);
  const bad = err.classifyOfficialResult(400, { err_code: 40034006 });
  assert.equal(bad.retryable, false);
  assert.match(bad.reason, /违规/);
});

// ── 错误码表：只认有出处的 ──
check('码表用订正后的真码', () => {
  assert.match(err.describeOfficialError(400, { err_code: 40034128 }), /被动回复/);
  assert.match(err.describeOfficialError(400, { err_code: 304103 }), /过期/);
  assert.match(err.describeOfficialError(400, { err_code: 40054005 }), /msg_seq/);
  // 旧版瞎编的几条不该再出现
  assert.doesNotMatch(err.describeOfficialError(400, { err_code: 11241 }), /markdown/);
  assert.doesNotMatch(err.describeOfficialError(400, { err_code: 304023 }), /风控/);
});

check('未知码只给原始信息，不编造提示', () => {
  const s = err.describeOfficialError(500, { err_code: 999999, message: 'boom' });
  assert.match(s, /HTTP 500/);
  assert.doesNotMatch(s, /提示：/);
});

// ── 被动回复配额 ──
check('群聊 5 条；第 6 次返回 null', () => {
  const t = new bot.ReplySeqTracker();
  const now = Date.now();
  for (let i = 1; i <= 5; i++) assert.equal(t.next('m1', 'group', now), i);
  assert.equal(t.next('m1', 'group', now), null);
});

check('单聊只有 4 条（以前错当 5 条）', () => {
  const t = new bot.ReplySeqTracker();
  const now = Date.now();
  for (let i = 1; i <= 4; i++) assert.equal(t.next('m2', 'private', now), i);
  assert.equal(t.next('m2', 'private', now), null);
});

check('群聊 5 分钟过期重置；单聊 60 分钟', () => {
  const t = new bot.ReplySeqTracker();
  const now = Date.now();
  for (let i = 1; i <= 5; i++) t.next('m3', 'group', now);
  assert.equal(t.next('m3', 'group', now), null);
  assert.equal(t.next('m3', 'group', now + 5 * 60 * 1000 + 1), 1);

  const t2 = new bot.ReplySeqTracker();
  for (let i = 1; i <= 4; i++) t2.next('m4', 'private', now);
  assert.equal(t2.next('m4', 'private', now + 10 * 60 * 1000), null, '单聊 10 分钟还没过期');
  assert.equal(t2.next('m4', 'private', now + 61 * 60 * 1000), 1, '单聊 61 分钟应重置');
});

check('空 msgId 返回 null', () => {
  assert.equal(new bot.ReplySeqTracker().next('', 'group'), null);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
