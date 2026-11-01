// 重启分类（0.4.102）：计划内 vs 真崩溃
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/restart-classify.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = () => path.join(os.tmpdir(), `planned-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
const now = Date.parse('2026-11-01T08:00:00+08:00');

check('部署 10 次 → 全部算计划内，不算崩溃', () => {
  const restarts = Array.from({ length: 10 }, (_, i) => ({ at: now - i * 60000, code: 1 }));
  const markers = Array.from({ length: 10 }, (_, i) => ({ at: now - i * 60000 + 5000, reason: 'deploy' }));
  const r = m.classifyRestarts(restarts, markers);
  assert.equal(r.plannedCount, 10);
  assert.equal(r.unplannedCount, 0);
});

check('真崩溃（没有计划标记）→ 全部未计划', () => {
  const r = m.classifyRestarts([{ at: now }, { at: now - 3600000 }], []);
  assert.equal(r.unplannedCount, 2);
  assert.equal(r.plannedCount, 0);
});

check('混合：3 次部署 + 2 次崩溃', () => {
  const restarts = [
    { at: now, code: 1 },
    { at: now - 60000, code: 1 },
    { at: now - 120000, code: 1 },
    { at: now - 3600000, code: 137 },
    { at: now - 7200000, code: 1 }
  ];
  const markers = [{ at: now + 1000 }, { at: now - 59000 }, { at: now - 121000 }];
  const r = m.classifyRestarts(restarts, markers);
  assert.equal(r.plannedCount, 3);
  assert.equal(r.unplannedCount, 2);
});

check('窗口外的不算计划内（默认 5 分钟）', () => {
  const r = m.classifyRestarts([{ at: now }], [{ at: now - 6 * 60000 }]);
  assert.equal(r.unplannedCount, 1);
  const r2 = m.classifyRestarts([{ at: now }], [{ at: now - 4 * 60000 }]);
  assert.equal(r2.plannedCount, 1);
});

check('标记文件：追加 / 读取 / 保留上限', () => {
  const f = tmp();
  for (let i = 0; i < 3; i += 1) m.addPlannedMarker(f, { at: now + i, reason: 'deploy' });
  const list = m.listPlannedMarkers(f);
  assert.equal(list.length, 3);
  assert.equal(list[0].reason, 'deploy');
  for (let i = 0; i < 210; i += 1) m.addPlannedMarker(f, { at: now + i });
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= m.PLANNED_KEEP, `实际 ${lines.length}`);
  fs.rmSync(f, { force: true });
});

check('缺文件 / 坏数据不炸', () => {
  assert.deepEqual(m.listPlannedMarkers(path.join(os.tmpdir(), 'nope-does-not-exist.jsonl')), []);
  const f = tmp();
  fs.writeFileSync(f, '{broken\n{"at":123}\n');
  const list = m.listPlannedMarkers(f);
  assert.equal(list.length, 1);
  fs.rmSync(f, { force: true });
  assert.deepEqual(m.classifyRestarts(null, null).unplannedCount, 0);
});

check('文案', () => {
  assert.match(m.describeRestarts({ total: 0 }), /没有重启/);
  assert.match(m.describeRestarts({ total: 10, plannedCount: 10, unplannedCount: 0 }), /全部是计划内/);
  assert.match(m.describeRestarts({ total: 5, plannedCount: 3, unplannedCount: 2 }), /计划内 3 次 · 未计划 2 次/);
  assert.match(m.describeRestarts({ total: 2, plannedCount: 0, unplannedCount: 2 }), /全部不是计划内/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
