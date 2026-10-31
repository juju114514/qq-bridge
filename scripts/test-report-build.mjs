// 运行报告（0.4.74）：纯函数，不碰 IO —— 便于单测，也保证"报告逻辑"本身不会把桥接弄挂。
import assert from 'node:assert/strict';

const m = await import(new URL('../src/report-build.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const now = Date.parse('2026-11-01T04:00:00+08:00');
const base = {
  version: '0.4.74',
  buildId: 'sha256:abcdef0123456789abcdef',
  now,
  processInfo: { pid: 1234, uptimeMs: 8 * 24 * 3600 * 1000, rssMb: 210, heapMb: 80, startedAt: now - 8 * 24 * 3600 * 1000 },
  services: { dsh: 'connected', gateway: 'connected', official: 'connected' },
  supervisor: { restarts24h: 0, exits24h: 0, watchdog24h: 0 },
  gatewayStats: { disconnects: 3, lastRecoverAt: now - 3600_000 },
  messages: { runs: 120, errors: 0 },
  disk: { freeGb: 20, totalGb: 60, path: '<repo>' },
  configSummary: { mode: 'reserved2', ownerQQ: '1599683156', groups: 2, privates: 1, officialEnabled: true, officialProbe: false }
};

check('健康状态 → 总体 PASS，且包含关键小节', () => {
  const r = m.buildReport(base);
  assert.equal(r.overall, 'PASS', JSON.stringify(r.checks, null, 2));
  for (const sec of ['# qq-bridge 运行报告', '## 一、检查结论', '## 二、通道', '## 三、稳定性', '## 四、配置摘要', '## 五、怎么用这份报告']) {
    assert.ok(r.markdown.includes(sec), `缺少小节：${sec}`);
  }
  assert.ok(r.markdown.includes('8 天'), '应显示连续运行天数');
});

check('网关断开 → FAIL，并给出"去 5099 扫码"的指引', () => {
  const r = m.buildReport({ ...base, services: { ...base.services, gateway: 'disconnected' } });
  assert.equal(r.overall, 'FAIL');
  const row = r.checks.find((c) => c.title.includes('网关'));
  assert.ok(row && row.level === 'bad');
  assert.match(row.detail, /5099/);
});

check('重启过多 → FAIL；重启 1~2 次 → WARN', () => {
  assert.equal(m.buildReport({ ...base, supervisor: { ...base.supervisor, restarts24h: 5 } }).overall, 'FAIL');
  const warn = m.buildReport({ ...base, supervisor: { ...base.supervisor, restarts24h: 1 } });
  assert.equal(warn.overall, 'WARN');
});

check('内存过高 → 至少 WARN（1.6G 以上 FAIL）', () => {
  const hi = m.buildReport({ ...base, processInfo: { ...base.processInfo, rssMb: 900 } });
  assert.equal(hi.overall, 'WARN');
  const too = m.buildReport({ ...base, processInfo: { ...base.processInfo, rssMb: 1700 } });
  assert.equal(too.overall, 'FAIL');
});

check('磁盘不足 → FAIL / 偏紧 → WARN', () => {
  assert.equal(m.buildReport({ ...base, disk: { freeGb: 1, totalGb: 60 } }).overall, 'FAIL');
  assert.equal(m.buildReport({ ...base, disk: { freeGb: 4, totalGb: 60 } }).overall, 'WARN');
});

check('运行不足 1 天 → WARN（不吹"稳定"）', () => {
  const r = m.buildReport({ ...base, processInfo: { ...base.processInfo, uptimeMs: 3 * 3600 * 1000 } });
  assert.equal(r.overall, 'WARN');
  assert.ok(r.checks.some((c) => c.detail.includes('跑起来了')));
});

check('脱敏：长数字、十六进制、路径、令牌都不原样出现', () => {
  const r = m.buildReport({
    ...base,
    repoPath: 'D:\\deepseek工作区\\qq-bridge',
    messages: { runs: 10, errors: 1, lastError: '发送失败 uid=3976372760 path=D:\\deepseek工作区\\qq-bridge\\state\\x.log token=sk-abcdef1234567890' }
  });
  assert.ok(!r.markdown.includes('3976372760'), '完整 QQ 号不应出现');
  assert.ok(!r.markdown.includes('D:\\deepseek工作区'), '私有路径不应出现');
  assert.ok(!r.markdown.includes('sk-abcdef1234567890'), '令牌不应出现');
  assert.ok(r.markdown.includes('<repo>') || r.markdown.includes('***'), '应留下脱敏痕迹');
});

check('脏数据不炸（全空 / 字段类型不对）', () => {
  for (const bad of [{}, { processInfo: null }, { services: null, supervisor: null }, { disk: null, messages: null }]) {
    const r = m.buildReport(bad);
    assert.ok(typeof r.markdown === 'string' && r.markdown.length > 50);
    assert.ok(['PASS', 'WARN', 'FAIL'].includes(r.overall));
  }
});

check('断电：本次启动前非正常关闭 → WARN，并给出断档时长', () => {
  const r = m.buildReport({
    ...base,
    bootWatch: {
      uncleanThisBoot: true,
      thisBoot: { at: now, lastSeenAt: now - 3 * 3600 * 1000, gapMs: 3 * 3600 * 1000, reason: 'unexpected' },
      incidents7d: 1,
      recent: [{ at: now, lastSeenAt: now - 3 * 3600 * 1000, gapMs: 3 * 3600 * 1000 }],
      describe: (x) => `上次心跳 ${Math.round((x.gapMs || 0) / 60000)} 分钟前`
    }
  });
  assert.equal(r.overall, 'WARN');
  assert.ok(r.checks.some((c) => c.title.includes('非正常关闭')), '应有非正常关闭检查项');
  assert.match(r.markdown, /## 三·五、异常关机/);
  assert.match(r.markdown, /断档约 180 分钟/);
});

check('断电：近 7 天 3 次以上 → FAIL', () => {
  const r = m.buildReport({ ...base, bootWatch: { uncleanThisBoot: false, incidents7d: 4, recent: [] } });
  assert.equal(r.overall, 'FAIL');
});

check('没有异常关机 → 有一条 ok，且不出现异常关机小节', () => {
  const r = m.buildReport({ ...base, bootWatch: { uncleanThisBoot: false, incidents7d: 0, recent: [] } });
  assert.ok(r.checks.some((c) => c.title.includes('没有异常关机')));
  assert.ok(!r.markdown.includes('## 三·五、异常关机'));
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
