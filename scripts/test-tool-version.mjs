// 外部工具探测（src/tool-version.js）：/自检 里那一行 yt-dlp 的数据来源。
//
// 重点：缓存（不能每次自检都 spawn 子进程）、失败不抛、版本号解析。

import assert from 'node:assert/strict';

const { createToolProbe, parseYtDlpVersion } = await import(new URL('../src/tool-version.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('parseYtDlpVersion：从 --version 输出取版本', () => {
  assert.equal(parseYtDlpVersion('2026.10.21\n'), '2026.10.21');
  assert.equal(parseYtDlpVersion('yt-dlp 2026.10.21'), '2026.10.21');
  assert.equal(parseYtDlpVersion('2026.10.21.232202'), '2026.10.21.232202');
  assert.equal(parseYtDlpVersion(''), '');
  assert.equal(parseYtDlpVersion('garbage'), '');
});

check('探测成功：available=true 且带版本', () => {
  const probe = createToolProbe({
    ytdlpPath: 'D:/tools/yt-dlp.exe',
    now: () => 1000,
    runVersion: () => '2026.10.21'
  });
  const v = probe.getYtdlp();
  assert.equal(v.available, true);
  assert.equal(v.version, '2026.10.21');
  assert.equal(v.path, 'D:/tools/yt-dlp.exe');
});

check('探测失败：available=false，不抛错', () => {
  const probe = createToolProbe({ ytdlpPath: 'x', now: () => 1000, runVersion: () => { throw new Error('ENOENT'); } });
  const v = probe.getYtdlp();
  assert.equal(v.available, false);
  assert.equal(v.version, '');
});

check('缓存：TTL 内不重复 spawn，过期后重探', () => {
  let calls = 0;
  let clock = 1000;
  const probe = createToolProbe({
    ytdlpPath: 'x', now: () => clock, ttlMs: 5000,
    runVersion: () => { calls += 1; return '2026.10.21'; }
  });
  probe.getYtdlp();
  probe.getYtdlp();
  assert.equal(calls, 1, 'TTL 内应命中缓存');
  clock += 6000;
  probe.getYtdlp();
  assert.equal(calls, 2, '过期后应重探');
});

check('force 绕过缓存；reset 清空', () => {
  let calls = 0;
  const probe = createToolProbe({ ytdlpPath: 'x', runVersion: () => { calls += 1; return '1'; } });
  probe.getYtdlp();
  probe.getYtdlp({ force: true });
  assert.equal(calls, 2);
  probe.reset();
  probe.getYtdlp();
  assert.equal(calls, 3);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }