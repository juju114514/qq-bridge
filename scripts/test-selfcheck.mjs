// 自检报告（src/selfcheck.js）：格式 + 危险信息的边界。
//
// 重点不是"字符串对不对"，而是：
//   ① 各状态都有明确的 ✅/❌ 与一句"这意味着什么"
//   ② 队列积压/死信能被标出来（而不是藏在数字里）
//   ③ shortStatus 只回一行（群友可见版本，不泄露内部）

import assert from 'node:assert/strict';

const m = await import(new URL('../src/selfcheck.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('humanDuration：秒→分→时→天', () => {
  assert.equal(m.humanDuration(30_000), '30秒');
  assert.equal(m.humanDuration(5 * 60_000), '5分0秒');
  assert.equal(m.humanDuration(3 * 3600_000 + 25 * 60_000), '3小时25分');
  assert.equal(m.humanDuration(2 * 86400_000 + 3600_000), '2天1小时0分');
  assert.equal(m.humanDuration(-5), '0秒', '负数不该输出怪值');
});

check('全部正常：四行都打 ✅', () => {
  const now = 1_000_000_000;
  const text = m.buildSelfCheckReport({
    now, startedAt: now - 3600_000, mode: 'reserved2', dshReady: true,
    snowluma: { connected: true, lastEventAt: now - 60_000 },
    official: { enabled: true, ready: true },
    queues: { queued: 0, pending: 0, deadLetters: 0 },
    people: 208, stickers: 66
  });
  assert.match(text, /【自检】/);
  assert.match(text, /运行：1小时0分/);
  assert.match(text, /DSH：✅/);
  assert.match(text, /队列：✅/);
  assert.match(text, /人物 208/);
  assert.match(text, /最近错误：✅ 无/);
});

check('DSH 掉线 / 网关掉线：必须显式标 ❌ 并说明后果', () => {
  const text = m.buildSelfCheckReport({
    now: 1_000_000, startedAt: 0, mode: 'reserved2',
    dshReady: false, snowluma: { connected: false },
    official: { enabled: false }, queues: {}
  });
  assert.match(text, /DSH：❌/);
  assert.match(text, /回复会全部卡住/);
  assert.match(text, /网关\(SnowLuma\)：❌/);
  assert.match(text, /收不到群消息/);
  assert.ok(!text.includes('官方通道'), '未启用时不该出现官方通道一行');
});

check('队列积压 / 有死信：标 ⚠️（不能只是数字）', () => {
  const a = m.buildSelfCheckReport({ now: 1, startedAt: 0, dshReady: true, snowluma: { connected: true }, queues: { queued: 30 } });
  assert.match(a, /队列：⚠️/);
  const b = m.buildSelfCheckReport({ now: 1, startedAt: 0, dshReady: true, snowluma: { connected: true }, queues: { deadLetters: 2 } });
  assert.match(b, /死信 2/);
  assert.match(b, /队列：⚠️/);
});

check('最近错误：最多列 3 条且截断', () => {
  const text = m.buildSelfCheckReport({
    now: 1, startedAt: 0, dshReady: true, snowluma: { connected: true }, queues: {},
    recentErrors: ['e1', 'e2', 'e3', 'e4']
  });
  assert.match(text, /最近错误/);
  // slice(-3) 保留最后三条：e2 / e3 / e4
  assert.match(text, /- e2/);
  assert.match(text, /- e4/);
  assert.ok(!text.includes('- e1'), 'e1 是最旧的，应该被切掉');
});

check('shortStatus：群友版本只有一行，不含内部细节', () => {
  assert.equal(m.shortStatus({ dshReady: true, snowluma: { connected: true } }), '在线');
  assert.match(m.shortStatus({ dshReady: false }), /维护/);
  assert.ok(!m.shortStatus({ dshReady: false }).includes('网关'));
});


check('网关重连过：标 ⚠️ 并给出最近一次时间（0 次时不显示）', () => {
  const now = 10_000_000;
  const withLoss = m.buildSelfCheckReport({
    now, startedAt: now - 3600_000, dshReady: true,
    snowluma: { connected: true, reconnects: 3, lastLossAt: now - 120_000 },
    queues: {}
  });
  assert.match(withLoss, /网关重连：⚠️ 3 次/);
  assert.match(withLoss, /最近 2分0秒 前/);

  const noLoss = m.buildSelfCheckReport({
    now, startedAt: now - 3600_000, dshReady: true,
    snowluma: { connected: true, reconnects: 0 }, queues: {}
  });
  assert.ok(!noLoss.includes('网关重连'), '0 次不该出现这一行');
});


check('抖音 cookies：健康显示剩余、临期标 ⚠️、失效标 ❌', () => {
  const now = 1_000_000;
  const ok = m.buildSelfCheckReport({
    now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {},
    douyin: { healthy: true, code: 'ok', remaining: '约 20 天' }
  });
  assert.match(ok, /抖音 cookies：✅ 剩余 约 20 天/);

  const aging = m.buildSelfCheckReport({
    now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {},
    douyin: { healthy: true, code: 'cookie-aging', remaining: '约 5 天' }
  });
  assert.match(aging, /抖音 cookies：⚠️/);

  const bad = m.buildSelfCheckReport({
    now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {},
    douyin: { healthy: false, code: 'cookie-expired', message: 'cookies.txt 已过期' }
  });
  assert.match(bad, /抖音 cookies：❌ cookie-expired/);

  const none = m.buildSelfCheckReport({ now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {} });
  assert.ok(!none.includes('抖音 cookies'), '没有该项时不显示');
});


check('版本行：显示版本与 state schema（升级排查第一句）', () => {
  const now = 1_000_000;
  const text = m.buildSelfCheckReport({
    now, startedAt: now - 1000, mode: 'reserved2', dshReady: true,
    snowluma: { connected: true }, queues: {}, version: '0.3.0', schemaVersion: 2
  });
  assert.match(text, /· 版本：0\.3\.0（schema v2）/);
  const noVer = m.buildSelfCheckReport({ now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {} });
  assert.match(noVer, /· 版本：未知/, '拿不到版本时也不能崩');
});


check('yt-dlp 行：可用显示版本，不可用给出修法', () => {
  const now = 1_000_000;
  const ok = m.buildSelfCheckReport({
    now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {},
    ytdlp: { available: true, version: '2026.10.21', path: 'D:/QQBot/tts/Scripts/yt-dlp.exe' }
  });
  assert.match(ok, /· yt-dlp：✅ 2026\.10\.21/);

  const bad = m.buildSelfCheckReport({
    now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {},
    ytdlp: { available: false, version: '' }
  });
  assert.match(bad, /· yt-dlp：❌ 不可用/);
  assert.match(bad, /ytdlpPath/, '不可用时要给出修法');

  const none = m.buildSelfCheckReport({ now, startedAt: now - 1000, dshReady: true, snowluma: { connected: true }, queues: {} });
  assert.ok(!none.includes('yt-dlp'), '没有该项时不显示');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }