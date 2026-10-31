// 运行时指纹：version / commit / presetHash（2026-10-31，外部评审「运行时到底执行什么」）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import(new URL('../src/build-info.js', import.meta.url).href);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

const info = mod.readBuildInfo(root);

check('version 来自 package.json', () => {
  assert.ok(info.version, 'version 不能为空');
  assert.equal(info.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
});
check('preset 指向被加载的那份（dsh/agent-presets/...）', () => {
  assert.ok(info.preset, 'preset 名不能为空');
  assert.match(info.presetSource, /^dsh\/agent-presets\//);
});
check('presetHash 是 12 位 hex', () => {
  assert.match(info.presetHash, /^[0-9a-f]{12}$/);
});
check('指纹行包含三项', () => {
  const line = mod.fingerprintLine(info);
  assert.match(line, /version=/);
  assert.match(line, /preset=/);
  if (info.commit) assert.match(line, /commit=/);
});
check('仓库没有 .git 时也要能降级（不抛错）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-'));
  const out = mod.readBuildInfo(tmp);
  assert.equal(out.commit, '');
  assert.equal(out.preset, null);
});

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
