// 官方通道重连（0.4.129）：op 7 / 4009 之后必须自己回来
import assert from 'node:assert/strict';

const m = await import(new URL('../src/official-reconnect.js', import.meta.url).href);
const bot = await import(new URL('../src/qqbot-official.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('退避序列：1s → 2s → 4s → 8s（含 ±20% 抖动）', () => {
  const expect = [1000, 2000, 4000, 8000];
  for (let i = 0; i < expect.length; i++) {
    const d = m.officialReconnectDelay(i, { jitter: 0 });
    assert.equal(d, expect[i], `第 ${i} 次应为 ${expect[i]}ms，实际 ${d}`);
  }
});

check('退避封顶 30s', () => {
  const d = m.officialReconnectDelay(20, { jitter: 0 });
  assert.equal(d, 30000);
});

check('抖动不会把延迟打到下限以下', () => {
  for (let i = 0; i < 200; i++) {
    const d = m.officialReconnectDelay(0);
    assert.ok(d >= 500 && d <= 1200, `延迟越界：${d}`);
  }
});

check('负数 / 非数字 attempt 当作第 0 次', () => {
  assert.equal(m.officialReconnectDelay(-5, { jitter: 0 }), 1000);
  assert.equal(m.officialReconnectDelay('abc', { jitter: 0 }), 1000);
});

check('连接类持有 reconnector，close() 会停掉它', () => {
  const b = new bot.OfficialQqBot({ appid: '1', secret: 'x', log: () => {} });
  assert.ok(b.reconnector, 'reconnector 缺失');
  assert.equal(b.reconnector.stopped, false);
  b.close();
  assert.equal(b.reconnector.stopped, true, 'close() 应停掉重连');
  assert.equal(b.ready, false);
});

check('reconnector：停止后 onClose 返回 null，不再排定时器', () => {
  const r = m.createReconnector({ connect: async () => {} });
  r.stop();
  assert.equal(r.onClose(), null);
  assert.equal(r.timer, null);
});

check('reconnector：连上后 reset() 把次数归零', () => {
  const r = m.createReconnector({ connect: async () => {}, setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {} });
  r.onClose();
  assert.equal(r.attempt, 1);
  r.reset();
  assert.equal(r.attempt, 0);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
