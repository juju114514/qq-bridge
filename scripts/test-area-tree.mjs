// 行政区三级树（0.4.105）：解析 / 层级 / 缓存
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/area-tree.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('解析省级列表（真实格式）', () => {
  const list = m.parseAreaList('01|北京,02|上海,03|天津,04|重庆,05|黑龙江');
  assert.equal(list.length, 5);
  assert.deepEqual(list[4], { code: '05', name: '黑龙江' });
});

check('解析区县列表', () => {
  const list = m.parseAreaList('010101|北京,010102|海淀,010103|朝阳');
  assert.deepEqual(list[1], { code: '010102', name: '海淀' });
});

check('脏数据不炸：空串 / 缺字段 / 非数字 code', () => {
  assert.deepEqual(m.parseAreaList(''), []);
  assert.deepEqual(m.parseAreaList(null), []);
  assert.deepEqual(m.parseAreaList('xx|坏,0101|好'), [{ code: '0101', name: '好' }]);
  assert.deepEqual(m.parseAreaList('01|'), []);
});

check('URL：省 / 市 / 区 分别拼不同文件', () => {
  assert.match(m.areaUrl(''), /city\.xml$/);
  assert.match(m.areaUrl('01'), /city01\.xml$/);
  assert.match(m.areaUrl('0101'), /city0101\.xml$/);
  assert.equal(m.areaUrl('010101'), '', '6 位不该再往下一层');
  assert.equal(m.areaUrl('bad'), '');
});

check('层级判断', () => {
  assert.equal(m.areaLevel(''), 1);
  assert.equal(m.areaLevel('01'), 2);
  assert.equal(m.areaLevel('0101'), 3);
  assert.equal(m.areaLevel('010101'), 0);
});

check('缓存：取不到网络时用磁盘缓存', async () => {
  const file = path.join(os.tmpdir(), `area-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ root: { at: Date.now(), items: [{ code: '01', name: '北京' }] } }));
  const tree = m.createAreaTree({ cacheFile: file, log: () => {} });
  const list = await tree.children('');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '北京');
  fs.rmSync(file, { force: true });
});

check('缓存过期 → 不用过期值（会去网络，拿真实数据）', async () => {
  const file = path.join(os.tmpdir(), `area2-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ root: { at: Date.now() - 10 * 24 * 3600 * 1000, items: [{ code: '99', name: '过期省' }] } }));
  const tree = m.createAreaTree({ cacheFile: file, log: () => {}, ttlMs: 7 * 24 * 3600 * 1000 });
  const list = await tree.children('');
  assert.ok(!list.some((x) => x.name === '过期省'), '过期缓存不该被当作有效数据');
  fs.rmSync(file, { force: true });
});

check('findPath：找不到返回空数组（不抛）', async () => {
  const file = path.join(os.tmpdir(), `area3-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ root: { at: Date.now(), items: [{ code: '01', name: '北京' }] }, '01': { at: Date.now(), items: [] } }));
  const tree = m.createAreaTree({ cacheFile: file, log: () => {} });
  assert.deepEqual(await tree.findPath('不存在的地方'), []);
  fs.rmSync(file, { force: true });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
