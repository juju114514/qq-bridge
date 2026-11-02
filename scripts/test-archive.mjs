// 原文归档 + 字面检索（0.5.57）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const A = await import(new URL('../src/agent/archive.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-arc-'));

await check('追加后能按原文找到（字面匹配，不区分大小写）', () => {
  const dir = tmp();
  A.appendArchive({ stateDir: dir, key: 'private:10001', sender: '甲', text: '明天去钓鱼吗', at: Date.now() });
  A.appendArchive({ stateDir: dir, key: 'private:10001', sender: '我', text: '去，带上鱼竿', at: Date.now() });
  const r = A.findArchive({ stateDir: dir, q: '钓鱼' });
  assert.equal(r.total, 1);
  assert.match(r.hits[0].text, /钓鱼/);
  assert.match(r.hits[0].ref, /\.md:\d+$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('按会话过滤（只在指定 key 里找）', () => {
  const dir = tmp();
  A.appendArchive({ stateDir: dir, key: 'private:1', text: '苹果' });
  A.appendArchive({ stateDir: dir, key: 'group:2', text: '苹果' });
  assert.equal(A.findArchive({ stateDir: dir, q: '苹果' }).total, 2);
  assert.equal(A.findArchive({ stateDir: dir, q: '苹果', key: 'group:2' }).total, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('分页：limit/offset 生效', () => {
  const dir = tmp();
  for (let i = 0; i < 12; i += 1) A.appendArchive({ stateDir: dir, key: 'private:1', text: `第${i}条 关键词` });
  const p1 = A.findArchive({ stateDir: dir, q: '关键词', limit: 5 });
  const p2 = A.findArchive({ stateDir: dir, q: '关键词', limit: 5, offset: 5 });
  assert.equal(p1.hits.length, 5);
  assert.equal(p2.hits.length, 5);
  assert.notEqual(p1.hits[0].ref, p2.hits[0].ref);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('limit 有硬上限（不能一次拉爆上下文）', () => {
  const dir = tmp();
  for (let i = 0; i < 60; i += 1) A.appendArchive({ stateDir: dir, key: 'private:1', text: `k${i} hit` });
  const r = A.findArchive({ stateDir: dir, q: 'hit', limit: 999 });
  assert.equal(r.hits.length, A.ARCHIVE_LIMITS.MAX_FIND);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('read：按 ref 读原文，且受字符上限截断', () => {
  const dir = tmp();
  for (let i = 0; i < 200; i += 1) A.appendArchive({ stateDir: dir, key: 'private:1', text: `第${i}行 内容内容内容内容内容` });
  const hit = A.findArchive({ stateDir: dir, q: '第150行' }).hits[0];
  const full = A.readArchive({ stateDir: dir, ref: hit.ref, limit: 100000 });
  assert.ok(full.ok);
  assert.match(full.text, /第150行/);
  const cut = A.readArchive({ stateDir: dir, ref: hit.ref, limit: 200 });
  assert.ok(cut.text.length <= 200, `长度 ${cut.text.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('坏 ref / 不存在的文件 → 明确失败，不崩', () => {
  const dir = tmp();
  assert.equal(A.readArchive({ stateDir: dir, ref: '乱写' }).ok, false);
  assert.equal(A.readArchive({ stateDir: dir, ref: '2026-01-01/nope.md:1' }).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('空查询 → 0 条（不返回全部历史）', () => {
  const dir = tmp();
  A.appendArchive({ stateDir: dir, key: 'private:1', text: '一些内容' });
  assert.equal(A.findArchive({ stateDir: dir, q: '' }).total, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('会话 key 里的冒号等字符不会逃出目录', () => {
  const dir = tmp();
  A.appendArchive({ stateDir: dir, key: '../../etc/passwd', text: 'x' });
  const day = fs.readdirSync(path.join(dir, 'archive'))[0];
  const names = fs.readdirSync(path.join(dir, 'archive', day));
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes('..'), names[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
