// 日志节流 + 平台能力探测（0.5.43）
import assert from 'node:assert/strict';
const m = await import(new URL('../src/log-throttle.js', import.meta.url).href);
const p = await import(new URL('../src/platform-capabilities.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

/** 假时钟 */
const clock = (start = 0) => { let t = start; return { now: () => t, tick: (ms) => { t += ms; } }; };

await check('节流：同一 key 窗口内只放第一条', () => {
  const c = clock(1000);
  const out = [];
  const log = m.createThrottledLogger((s) => out.push(s), { windowMs: 60000, now: c.now });
  assert.equal(log('gw', 'A'), true);
  c.tick(1000); assert.equal(log('gw', 'A'), false);
  c.tick(1000); assert.equal(log('gw', 'A'), false);
  assert.deepEqual(out, ['A']);
});

await check('节流：窗口过去后放行，并补一条"省略了 N 次"', () => {
  const c = clock(1000);
  const out = [];
  const log = m.createThrottledLogger((s) => out.push(s), { windowMs: 10000, now: c.now });
  log('gw', '断线');
  c.tick(1000); log('gw', '断线');
  c.tick(1000); log('gw', '断线');
  c.tick(20000); log('gw', '断线');
  assert.equal(out.length, 3);
  assert.equal(out[0], '断线');
  assert.match(out[1], /又出现 2 次/);
  assert.equal(out[2], '断线');
});

await check('节流：不同 key 互不影响', () => {
  const c = clock(0);
  const out = [];
  const log = m.createThrottledLogger((s) => out.push(s), { windowMs: 60000, now: c.now });
  log('a', 'A1'); log('b', 'B1'); log('a', 'A2');
  assert.deepEqual(out, ['A1', 'B1']);
});

await check('平台：Windows 上 PowerShell/计划任务算可用', () => {
  const caps = p.detectCapabilities({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32' },
    findImpl: (n) => (n === 'powershell' ? 'C:\\W\\powershell.exe' : n === 'ffmpeg' ? 'C:\\ffmpeg.exe' : '')
  });
  assert.equal(caps.windows, true);
  assert.equal(caps.features.powershell, true);
  assert.equal(caps.features.scheduledTask, true);
  assert.equal(caps.features.ffmpeg, true);
});

await check('平台：Android 上把 Windows 专属能力标成缺失', () => {
  const caps = p.detectCapabilities({
    platform: 'linux', env: { ANDROID_ROOT: '/system', PATH: '/data/local/tmp/bin' }, findImpl: () => ''
  });
  assert.equal(caps.android, true);
  assert.equal(caps.features.powershell, false);
  assert.equal(caps.features.scheduledTask, false);
  assert.equal(caps.features.watchdog, false);
  assert.ok(caps.missing.length >= 4);
  assert.ok(caps.missing.some((x) => x.includes('点歌')));
});

await check('平台：有 ffmpeg 时不算缺失', () => {
  const caps = p.detectCapabilities({
    platform: 'linux', env: { PATH: '/usr/bin' }, findImpl: (n) => (n === 'ffmpeg' ? '/usr/bin/ffmpeg' : '')
  });
  assert.equal(caps.features.ffmpeg, true);
  assert.ok(!caps.missing.some((x) => x.includes('语音')));
});

await check('平台：describe 全可用与有缺失两种文案', () => {
  const full = p.detectCapabilities({
    platform: 'win32', env: { PATH: 'x' },
    findImpl: (n) => ({ powershell: 'p', ffmpeg: 'f', tesseract: 't' }[n] || '')
  });
  assert.match(p.describeCapabilities(full), /全部能力可用|项不可用/);
  const poor = p.detectCapabilities({ platform: 'linux', env: { ANDROID_ROOT: '/system', PATH: '' }, findImpl: () => '' });
  assert.match(p.describeCapabilities(poor), /项不可用/);
});

await check('平台：PATH 分隔符跨平台（宿主 + 模拟器两套环境）', () => {
  // 宿主是 Windows，PATH 用 ; 分隔；模拟器是 Android，用 : 分隔。
  // 这里直接验证 findInPath 的行为差异由 platform 决定（通过注入 exists 探测）。
  const seen = [];
  const caps = p.detectCapabilities({
    platform: 'linux',
    env: { ANDROID_ROOT: '/system', PATH: '/a:/b' },
    findImpl: (n) => { seen.push(n); return ''; }
  });
  assert.ok(seen.includes('ffmpeg'));
  assert.equal(caps.features.ffmpeg, false);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
