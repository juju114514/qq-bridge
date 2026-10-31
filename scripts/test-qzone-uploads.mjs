// 空间配图上传（0.4.79）：落盘/限额/类型嗅探/索引/发布路径
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/qzone-uploads.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const tmpDir = () => path.join(os.tmpdir(), `qzone-up-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// 造三种真实文件头
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const txt = Buffer.from('hello world, not an image at all', 'utf8');

check('文件头嗅探：png / jpg 认得，文本不认', () => {
  assert.equal(m.sniffExt(png), 'png');
  assert.equal(m.sniffExt(jpg), 'jpg');
  assert.equal(m.sniffExt(txt), '');
});

check('保存一张 png → 落盘 + 进索引', () => {
  const dir = tmpDir();
  const r = m.saveUpload(dir, { dataBase64: png.toString('base64'), name: 'test.png', mime: 'image/png' });
  assert.equal(r.ok, true);
  assert.match(r.item.id, /^[0-9a-f]{16}\.png$/);
  assert.ok(fs.existsSync(path.join(dir, r.item.id)));
  assert.equal(m.listUploads(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('假扩展名骗不过嗅探（.png 里是文本 → 拒绝）', () => {
  const dir = tmpDir();
  const r = m.saveUpload(dir, { dataBase64: txt.toString('base64'), name: 'evil.png', mime: 'image/png' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不是支持的图片格式/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('超过 6MB 拒绝', () => {
  const dir = tmpDir();
  const big = Buffer.concat([png, Buffer.alloc(m.MAX_BYTES + 10, 0)]);
  const r = m.saveUpload(dir, { dataBase64: big.toString('base64') });
  assert.equal(r.ok, false);
  assert.match(r.error, /6MB/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('同一张图上传两次 → 内容寻址去重，不重复占空间', () => {
  const dir = tmpDir();
  const a = m.saveUpload(dir, { dataBase64: png.toString('base64'), name: 'a.png' });
  const b = m.saveUpload(dir, { dataBase64: png.toString('base64'), name: 'b.png' });
  assert.equal(a.item.id, b.item.id);
  assert.equal(m.listUploads(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('描述可写可读；删除会清文件', () => {
  const dir = tmpDir();
  const r = m.saveUpload(dir, { dataBase64: jpg.toString('base64'), name: 'x.jpg' });
  assert.equal(m.setDesc(dir, r.item.id, '一只在沙滩上的水豚'), true);
  assert.equal(m.listUploads(dir)[0].desc, '一只在沙滩上的水豚');
  assert.equal(m.removeUpload(dir, r.item.id), true);
  assert.equal(m.listUploads(dir).length, 0);
  assert.equal(fs.existsSync(path.join(dir, r.item.id)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('resolvePaths：只返回选中的、且是绝对路径、最多 9 张', () => {
  const dir = tmpDir();
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const buf = Buffer.concat([png, Buffer.from([i])]);
    const r = m.saveUpload(dir, { dataBase64: buf.toString('base64'), name: `p${i}.png` });
    ids.push(r.item.id);
  }
  const picked = m.resolvePaths(dir, ids.slice(0, 3));
  assert.equal(picked.length, 3);
  for (const p of picked) assert.ok(path.isAbsolute(p));
  assert.ok(m.resolvePaths(dir, ids).length <= m.MAX_FILES);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('索引坏了不炸（当空处理）', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), '{oops');
  assert.deepEqual(m.listUploads(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
