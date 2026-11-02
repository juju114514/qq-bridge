// 本机文件索引（P3）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createFileIndex } = await import(new URL('../src/file-index.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

/** 造一棵小目录树 */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-idx-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  fs.writeFileSync(path.join(root, 'docs', '设计文档.md'), 'x');
  fs.writeFileSync(path.join(root, 'docs', 'photo.png'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.writeFileSync(path.join(root, 'debug.log'), 'x');
  return root;
}

const idxFor = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-idxdb-'));
  return { idx: createFileIndex({ dbFile: path.join(dir, 'hub.db') }), dir };
};

await check('扫描：只收文件、跳过 node_modules 与 .log', async () => {
  const root = makeTree();
  const { idx } = idxFor();
  const r = await idx.scan([root]);
  assert.equal(r.ok, true);
  const all = await idx.search('', {});
  assert.ok(r.scanned >= 3, `扫描到 ${r.scanned} 个`);
  const names = (await idx.search('design', {})).concat(await idx.search('README', {}), await idx.search('��计', {}));
  assert.ok(names.length >= 1);
  const png = await idx.search('photo', {});
  assert.equal(png.length, 1);
  const nm = await idx.search('index.js', {});
  assert.equal(nm.length, 0, 'node_modules 里的文件不该被索引');
  const log = await idx.search('debug.log', {});
  assert.equal(log.length, 0, '.log 不该被索引');
  fs.rmSync(root, { recursive: true, force: true });
});

await check('搜索：中文文件名能命中', async () => {
  const root = makeTree();
  const { idx } = idxFor();
  await idx.scan([root]);
  const r = await idx.search('设计', {});
  assert.equal(r.length, 1);
  assert.match(r[0].name, /设计文档/);
  fs.rmSync(root, { recursive: true, force: true });
});

await check('搜索：只回元数据，不回文件内容', async () => {
  const root = makeTree();
  const { idx } = idxFor();
  await idx.scan([root]);
  const [one] = await idx.search('README', {});
  assert.ok(one.path && one.name && one.ext === '.md');
  assert.equal('content' in one, false);
  fs.rmSync(root, { recursive: true, force: true });
});

await check('搜索：limit 生效且不超过 200', async () => {
  const root = makeTree();
  const { idx } = idxFor();
  await idx.scan([root]);
  const r = await idx.search('', { limit: 2 });
  assert.ok(r.length <= 2);
  fs.rmSync(root, { recursive: true, force: true });
});

await check('搜索：% 和 _ 被当字面量，不当通配符', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-idx-'));
  fs.writeFileSync(path.join(root, 'a%b.txt'), 'x');
  fs.writeFileSync(path.join(root, 'axb.txt'), 'x');
  const { idx } = idxFor();
  await idx.scan([root]);
  const r = await idx.search('a%b', {});
  assert.equal(r.length, 1);
  assert.match(r[0].name, /a%b/);
  fs.rmSync(root, { recursive: true, force: true });
});

await check('重复扫描同一目录不会产生重复行（INSERT OR REPLACE）', async () => {
  const root = makeTree();
  const { idx } = idxFor();
  await idx.scan([root]);
  const n1 = (await idx.stats()).total;
  await idx.scan([root]);
  const n2 = (await idx.stats()).total;
  assert.equal(n1, n2);
  fs.rmSync(root, { recursive: true, force: true });
});

await check('目录不存在 → 明确失败，不崩', async () => {
  const { idx } = idxFor();
  const r = await idx.scan(['/no/such/dir/at/all']);
  assert.equal(r.ok, false);
  assert.match(r.error, /没有可扫描的目录/);
});

await check('clear 之后搜不到', async () => {
  const root = makeTree();
  const { idx } = idxFor();
  await idx.scan([root]);
  assert.ok((await idx.search('README', {})).length > 0);
  await idx.clear();
  assert.equal((await idx.search('README', {})).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
