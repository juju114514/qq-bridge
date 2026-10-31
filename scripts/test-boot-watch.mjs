// 断电/崩溃检测（0.4.84）：纯逻辑，模拟各种"上次怎么死的"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/boot-watch.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = (suffix) => path.join(os.tmpdir(), `bw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
const now = Date.parse('2026-11-01T10:00:00+08:00');

check('首次运行（没有 marker 也没有心跳）→ 不算异常', () => {
  const r = m.detectUncleanShutdown({ marker: null, heartbeat: null, now });
  assert.equal(r.unclean, false);
  assert.equal(r.reason, 'first-run');
});

check('正常退出（clean=true）→ 不算异常，哪怕过了很久', () => {
  const r = m.detectUncleanShutdown({
    marker: { clean: true, at: now - 8 * 3600 * 1000 },
    heartbeat: { at: now - 8 * 3600 * 1000 },
    now
  });
  assert.equal(r.unclean, false);
  assert.equal(r.reason, 'clean-exit');
});

check('断电：clean=false + 心跳断档 3 小时 → 判定为异常', () => {
  const lastSeen = now - 3 * 3600 * 1000;
  const r = m.detectUncleanShutdown({
    marker: { clean: false, startedAt: lastSeen, pid: 1234 },
    heartbeat: { at: lastSeen, pid: 1234 },
    now
  });
  assert.equal(r.unclean, true);
  assert.equal(r.reason, 'unexpected');
  assert.ok(r.gapMs >= 3 * 3600 * 1000 - 1000);
});

check('快速重启（只断 20 秒）→ 不误判成断电', () => {
  const lastSeen = now - 20 * 1000;
  const r = m.detectUncleanShutdown({
    marker: { clean: false, startedAt: lastSeen },
    heartbeat: { at: lastSeen },
    now
  });
  assert.equal(r.unclean, false);
  assert.equal(r.reason, 'fast-restart');
});

check('只有心跳没有 marker（旧版本升级上来）也能判断', () => {
  const r = m.detectUncleanShutdown({ marker: null, heartbeat: { at: now - 2 * 3600 * 1000 }, now });
  assert.equal(r.unclean, true);
});

check('阈值可调（tests 用 60 秒）', () => {
  const r = m.detectUncleanShutdown({ marker: { clean: false }, heartbeat: { at: now - 61 * 1000 }, now, gapMs: 60 * 1000 });
  assert.equal(r.unclean, true);
});

check('心跳/标记能读写', () => {
  const hb = tmp('.hb.json');
  const mk = tmp('.mk.json');
  assert.equal(m.writeHeartbeat(hb, { pid: 42, now }), true);
  assert.equal(JSON.parse(fs.readFileSync(hb, 'utf8')).pid, 42);
  assert.equal(m.markRunning(mk, { pid: 42, now, version: '0.4.84' }), true);
  const marker = JSON.parse(fs.readFileSync(mk, 'utf8'));
  assert.equal(marker.clean, false);
  assert.equal(m.markCleanExit(mk, { pid: 42, now: now + 1000 }), true);
  assert.equal(JSON.parse(fs.readFileSync(mk, 'utf8')).clean, true);
  fs.rmSync(hb, { force: true });
  fs.rmSync(mk, { force: true });
});

check('事件文件：追加 / 倒序读 / 统计近 7 天 / 只留 50 条', () => {
  const f = tmp('.jsonl');
  // 按时间**递增**追加（真实场景就是越写越新），读的时候应倒序
  for (let i = 0; i < 3; i += 1) {
    m.appendIncident(f, { at: now + i * 1000, gapMs: 3600000, reason: 'unexpected' });
  }
  const list = m.listIncidents(f);
  assert.equal(list.length, 3);
  assert.ok(list[0].at >= list[1].at, '新的在前');
  assert.equal(m.countRecentIncidents(f, { days: 7, now }), 3);

  // 灌满，确认只留 50
  for (let i = 0; i < 80; i += 1) m.appendIncident(f, { at: now + i, gapMs: 1000 });
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= m.INCIDENT_KEEP, `实际 ${lines.length} 条`);
  fs.rmSync(f, { force: true });
});

check('损坏的事件文件 → 空数组，不抛', () => {
  const f = tmp('.jsonl');
  fs.writeFileSync(f, '{broken\nnope\n');
  assert.deepEqual(m.listIncidents(f), []);
  assert.equal(m.countRecentIncidents(f, { now }), 0);
  fs.rmSync(f, { force: true });
});

check('describeIncident 给人看的句子', () => {
  const s = m.describeIncident({ at: now, lastSeenAt: now - 3600000, gapMs: 3600000 });
  assert.match(s, /断了约 60 分钟/);
  assert.equal(m.describeIncident(null), '');
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
