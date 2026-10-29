// 官方通道：被动窗口判定 + 发图接线（离线）
import assert from 'node:assert/strict';
import fs from 'node:fs';

const m = await import(new URL('../src/official-transport.js', import.meta.url).href);
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('shouldUsePassiveWindow：窗口内且非主动 → 用 msg_id', () => {
  const now = 1_000_000;
  assert.equal(m.shouldUsePassiveWindow({ msgId: 'M', at: now - 1000 }, { now }), true);
});

check('shouldUsePassiveWindow：超窗口 / 无记录 / 主动消息 → 不用', () => {
  const now = 1_000_000;
  assert.equal(m.shouldUsePassiveWindow({ msgId: 'M', at: now - 10 * 60 * 1000 }, { now }), false);
  assert.equal(m.shouldUsePassiveWindow(undefined, { now }), false);
  assert.equal(m.shouldUsePassiveWindow({ msgId: '', at: now }, { now }), false);
  assert.equal(m.shouldUsePassiveWindow({ msgId: 'M', at: now }, { now, proactive: true }), false);
});

check('shouldUsePassiveWindow：窗口可配置（默认 4.5 分钟）', () => {
  const now = 1_000_000;
  const near = { msgId: 'M', at: now - 4 * 60 * 1000 };
  assert.equal(m.shouldUsePassiveWindow(near, { now }), true);
  assert.equal(m.shouldUsePassiveWindow(near, { now, windowMs: 60_000 }), false);
});

check('接线：transport 暴露 sendImage，且上传后立刻发送（不缓存 file_info）', () => {
  const src = fs.readFileSync(new URL('../src/official-transport.js', import.meta.url), 'utf8');
  assert.match(src, /async function sendImage\(/, '缺 sendImage');
  assert.match(src, /sendImage,/, 'sendImage 没导出到返回对象');
  assert.match(src, /uploadMedia\(kind === 'group' \? 'group' : 'user'/, '上传该按 kind 选端点');
  assert.match(src, /if \(!check\.ok\) throw/, '发图前必须过格式/体积闸门');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }