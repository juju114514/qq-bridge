// 人物卡外观照片（0.4.97）：安全文件名 / 文件头嗅探 / 大小限制 / 换图即作废旧描述
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/role-image.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const dir = () => path.join(os.tmpdir(), `role-img-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 3)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 5)]);

check('safeRoleId：斜杠/冒号/空格都变下划线', () => {
  assert.equal(m.safeRoleId('xiao-jing-yu'), 'xiao-jing-yu');
  assert.equal(m.safeRoleId('../../etc'), '.._.._etc');
  assert.equal(m.safeRoleId('a b:c'), 'a_b_c');
  assert.equal(m.safeRoleId(''), 'role');
});

check('文件头嗅探：按内容判断，不信扩展名', () => {
  assert.equal(m.sniffImageExt(png), 'png');
  assert.equal(m.sniffImageExt(jpg), 'jpg');
  assert.equal(m.sniffImageExt(Buffer.from('GIF89a......')), 'gif');
  assert.equal(m.sniffImageExt(Buffer.from('not an image at all')), '');
});

check('存图：成功返回 ext，文件真的落盘', () => {
  const d = dir();
  const r = m.saveRoleImage(d, 'whale', png.toString('base64'));
  assert.equal(r.ok, true);
  assert.equal(r.ext, 'png');
  assert.ok(fs.existsSync(r.file));
  fs.rmSync(d, { recursive: true, force: true });
});

check('文本冒充 png → 拒绝', () => {
  const d = dir();
  const r = m.saveRoleImage(d, 'whale', Buffer.from('definitely not png').toString('base64'));
  assert.equal(r.ok, false);
  assert.match(r.error, /不是支持的图片/);
  fs.rmSync(d, { recursive: true, force: true });
});

check('空数据 / 超 4MB → 拒绝', () => {
  const d = dir();
  assert.equal(m.saveRoleImage(d, 'x', '').ok, false);
  const big = Buffer.concat([png, Buffer.alloc(m.MAX_BYTES + 1, 0)]);
  const r = m.saveRoleImage(d, 'x', big.toString('base64'));
  assert.equal(r.ok, false);
  assert.match(r.error, /MB/);
  fs.rmSync(d, { recursive: true, force: true });
});

check('换图（png → jpg）会删掉旧文件，只留一张', () => {
  const d = dir();
  m.saveRoleImage(d, 'whale', png.toString('base64'));
  m.saveRoleImage(d, 'whale', jpg.toString('base64'));
  const files = fs.readdirSync(d).filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
  assert.equal(files.length, 1, `实际 ${files.join(',')}`);
  assert.match(files[0], /\.jpg$/);
  fs.rmSync(d, { recursive: true, force: true });
});

check('外貌描述：写/读，换图后旧描述作废', () => {
  const d = dir();
  m.saveRoleImage(d, 'whale', png.toString('base64'));
  assert.equal(m.writeRoleAppearance(d, 'whale', '蓝色短发、白衬衫、看起来很温和'), true);
  assert.match(m.readRoleAppearance(d, 'whale'), /蓝色短发/);
  m.saveRoleImage(d, 'whale', jpg.toString('base64'));
  assert.equal(m.readRoleAppearance(d, 'whale'), '', '换图后描述应为空');
  fs.rmSync(d, { recursive: true, force: true });
});

check('删除：图与描述一起清掉', () => {
  const d = dir();
  m.saveRoleImage(d, 'whale', png.toString('base64'));
  m.writeRoleAppearance(d, 'whale', '描述');
  assert.equal(m.removeRoleImage(d, 'whale'), true);
  assert.equal(m.findRoleImage(d, 'whale'), null);
  assert.equal(m.readRoleAppearance(d, 'whale'), '');
  fs.rmSync(d, { recursive: true, force: true });
});

check('提示词行：没描述就返回空串（不塞空话）', () => {
  assert.equal(m.appearancePromptLine(''), '');
  assert.equal(m.appearancePromptLine(null), '');
  assert.match(m.appearancePromptLine('黑色长发'), /你的外貌（来自用户提供的照片）：黑色长发/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
