// 装机体检（src/doctor.js）的契约测试：全离线。
//
// 这块的目标是"把卡点说人话 + 给能复制的修法"，所以要钉住：
//   ① Node 版本判定边界 ② DSH 目录优先级 ③ SnowLuma 多端口 ④ 官方通道缺什么说清楚
//   ⑤ 报告里失败项一定带修法（FAQ 里没修法的报错等于没报）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/doctor.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

await check('Node 版本边界：21 不行、22 可以、版本号缺失算不行', () => {
  assert.equal(m.parseNodeVersion('21.9.9').ok, false);
  assert.equal(m.parseNodeVersion('v22.0.0').ok, true);
  assert.equal(m.parseNodeVersion('22.23.2').major, 22);
  assert.equal(m.parseNodeVersion('').ok, false);
  assert.equal(m.parseNodeVersion('weird').ok, false);
});

await check('DSH 目录：DSH_HOME 优先于家目录，全都找不到时 ok=false', () => {
  const homeDsh = path.join('/home/u', '.dsh');
  const exists = (p) => p === 'C:\\custom-dsh' || p === homeDsh;
  const found = m.findDsh({ env: { DSH_HOME: 'C:\\custom-dsh' }, homedir: '/home/u', exists });
  assert.equal(found.ok, true);
  assert.equal(found.home, 'C:\\custom-dsh');

  const onlyHome = m.findDsh({ env: {}, homedir: '/home/u', exists });
  assert.equal(onlyHome.home, homeDsh, '家目录下的 .dsh 要被认出来');

  const none = m.findDsh({ env: {}, homedir: '/home/u', exists: () => false });
  assert.equal(none.ok, false);
  assert.ok(none.candidates.length >= 2, '候选列表要非空，便于提示用户试过哪些');
});

await check('SnowLuma：任一端口在线就算可用；5099 在线时给出扫码页', async () => {
  const only3000 = await m.checkSnowLuma({ probe: async (h, p) => p === 3000 });
  assert.equal(only3000.ok, true);
  assert.equal(only3000.qrUrl, '');

  const with5099 = await m.checkSnowLuma({ probe: async (h, p) => p === 5099 });
  assert.equal(with5099.qrUrl, 'http://127.0.0.1:5099');

  const none = await m.checkSnowLuma({ probe: async () => false });
  assert.equal(none.ok, false);
});

await check('官方通道：未启用/缺凭证/白名单空 三种问题都要说清楚', () => {
  const disabled = m.checkOfficial({ config: { official: { enabled: false } } });
  assert.equal(disabled.ok, false);
  assert.ok(disabled.problems.some((p) => p.includes('未启用')));

  const noCreds = m.checkOfficial({ config: { official: { enabled: true, allow: ['x'] } } });
  assert.ok(noCreds.problems.some((p) => p.includes('AppID')));

  const noAllow = m.checkOfficial({ config: { official: { enabled: true, appid: 'a', secret: 'b' } } });
  assert.ok(noAllow.problems.some((p) => p.includes('白名单')));

  const good = m.checkOfficial({ config: { official: { enabled: true, appid: 'a', secret: 'b', allow: ['g1'] } } });
  assert.equal(good.ok, true);
  assert.equal(good.allowCount, 1);
});

await check('报告：失败项必须带修法，且能数出 fail/warn', () => {
  const { lines, failed, warned } = m.renderReport([
    { level: 'ok', title: 'Node 22.0.0' },
    { level: 'fail', title: 'SnowLuma 没起', fix: '启动它' },
    { level: 'warn', title: 'DSH 目录没找到' }
  ]);
  assert.equal(failed, 1);
  assert.equal(warned, 1);
  assert.ok(lines.some((l) => l.includes('→ 启动它')), '失败项必须带修法');
  assert.equal(lines.length, 4, '3 条 + 1 条修法');
});

await check('diagnose 汇总：四项齐全，修法可执行（含 setup.ps1 指引）', async () => {
  const items = await m.diagnose({
    nodeVersion: '20.1.0',
    env: {},
    homedir: '/home/u',
    exists: () => false,
    config: {},
    probe: async () => false
  });
  assert.deepEqual(items.map((i) => i.key), ['node', 'dsh', 'snowluma', 'official']);
  const node = items.find((i) => i.key === 'node');
  assert.equal(node.level, 'fail');
  assert.match(node.fix, /setup\.ps1|winget/);
  const dsh = items.find((i) => i.key === 'dsh');
  assert.match(dsh.fix, /DSH_HOME/);
});

await check('接线：npm run doctor 与 setup.ps1 都指向这个体检', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts?.doctor, 'package.json 要有 doctor 脚本');
  assert.match(pkg.scripts.doctor, /doctor\.js/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'setup.ps1')), 'setup.ps1 要存在');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
