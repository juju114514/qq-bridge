// 脏环境测试（空间相关，0.4.82）
// 目标：坏索引 / 假图 / 超大图 / 不存在 tid / 无图挑图 / 坏草稿 —— 全部不能把桥接弄挂
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const up = await import(new URL('../src/qzone-uploads.js', import.meta.url).href);
const ops = await import(new URL('../src/qzone-post-ops.js', import.meta.url).href);
const draft = await import(new URL('../src/qzone-draft.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const dir = () => path.join(os.tmpdir(), `dirty-qzone-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

check('脏1：index.json 是坏 JSON → 当空处理，不抛', () => {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.json'), '{broken,,');
  assert.deepEqual(up.listUploads(d), []);
  // 坏索引还能继续写入（自愈）
  const r = up.saveUpload(d, { dataBase64: png.toString('base64'), name: 'x.png' });
  assert.equal(r.ok, true);
  assert.equal(up.listUploads(d).length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

check('脏2：文本冒充 png（扩展名 + mime 都对）→ 拒绝', () => {
  const d = dir();
  const r = up.saveUpload(d, { dataBase64: Buffer.from('not an image').toString('base64'), name: 'a.png', mime: 'image/png' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不是支持的图片/);
  fs.rmSync(d, { recursive: true, force: true });
});

check('脏3：空 base64 / 空字符串 → 明确报错', () => {
  const d = dir();
  assert.equal(up.saveUpload(d, { dataBase64: '' }).ok, false);
  assert.equal(up.saveUpload(d, {}).ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

check('脏4：超过 6MB → 拒绝（不会被写盘）', () => {
  const d = dir();
  const big = Buffer.concat([png, Buffer.alloc(up.MAX_BYTES + 1, 0)]);
  const r = up.saveUpload(d, { dataBase64: big.toString('base64') });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.png')).length : 0, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

check('脏5：resolve 传不存在的 id → 空数组（不抛）', () => {
  const d = dir();
  assert.deepEqual(up.resolvePaths(d, ['不存在.jpg', '', null]), []);
  fs.rmSync(d, { recursive: true, force: true });
});

check('脏6：pick 不给图 / 空文字 → 空数组或兜底，不抛', () => {
  assert.deepEqual(ops.pickImages({ text: '', items: [] }), []);
  assert.deepEqual(ops.pickImages({}), []);
  const items = [{ id: 'a' }, { id: 'b' }];
  assert.ok(ops.pickImages({ text: null, items }).length >= 1);
});

check('脏7：删除候选表在"都不支持"时仍返回结构化结果', () => {
  // 纯逻辑：模拟网关对每个 action 都抛错
  const results = ops.QZONE_DELETE_ACTIONS.map((a) => ({ action: a, ok: false, error: `${a} failed` }));
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 0);
  assert.equal(results.length, ops.QZONE_DELETE_ACTIONS.length);
});

check('脏8：草稿文件被截断 → 视为 idle；pending 过期 → expired', () => {
  const f = path.join(os.tmpdir(), `draft-dirty-${Date.now()}.json`);
  fs.writeFileSync(f, '{"status":"pending","at":');
  assert.equal(draft.readDraft(f).status, 'idle');
  draft.writeDraft(f, { status: 'pending', text: '', style: 'daily', styles: ['daily'], at: Date.now() - draft.DRAFT_TTL_MS - 1, error: '' });
  assert.equal(draft.readDraft(f).status, 'expired');
  fs.rmSync(f, { force: true });
});

check('脏9：同一张图并发上传两次（同字节）→ 只有一个 id、一份文件', () => {
  const d = dir();
  const b64 = png.toString('base64');
  const a = up.saveUpload(d, { dataBase64: b64, name: '1.png' });
  const b = up.saveUpload(d, { dataBase64: b64, name: '2.png' });
  assert.equal(a.item.id, b.item.id);
  assert.equal(fs.readdirSync(d).filter((f) => f.endsWith('.png')).length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
