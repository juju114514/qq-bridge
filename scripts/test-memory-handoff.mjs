// 群记忆交接段（§〇）的离线测试：渲染 / 提取 / 覆盖写 / 字节上限 / check
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(path.join(here, '..', 'src', 'domains', 'memory-handoff.js')).href);

const results = [];
const check = (n, f) => { try { f(); results.push(['ok', n]); } catch (e) { results.push(['FAIL', n + ' — ' + (e?.message ?? e)]); } };

check('renderHandoff：固定四个子项，缺的写（暂无）', () => {
  const t = m.renderHandoff({ lastTalkedAbout: '聊了歌单' });
  assert.match(t, /## §〇 交接/);
  assert.match(t, /### 上次聊到哪\n聊了歌单/);
  assert.match(t, /### 当前话题\n（暂无）/);
});

check('truncateBytes 按 UTF-8 字节截断（中文 3 字节）', () => {
  const s = '中'.repeat(2000);              // 6000 字节
  const cut = m.truncateBytes(s, 3000);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 3000);
  assert.equal(cut.length, 1000);           // 1000 个汉字
});

check('renderHandoff 超过 4KB 会被截断而不是抛错', () => {
  const t = m.renderHandoff({ currentTopics: '啊'.repeat(5000) });
  assert.ok(Buffer.byteLength(t, 'utf8') <= m.HANDOFF_MAX_BYTES);
});

check('extractHandoff：只取交接段，不吞后面的 §1', () => {
  const file = '## §〇 交接\n\n### 上次聊到哪\nA\n\n## §1 群印象\nB\n';
  const h = m.extractHandoff(file);
  assert.match(h, /A/);
  assert.doesNotMatch(h, /B/);
});

check('upsertHandoff：没有交接段时插到文件开头，保留原内容', () => {
  const out = m.upsertHandoff('## §1 群印象\nB\n', '## §〇 交接\nX\n');
  assert.ok(out.startsWith('## §〇 交接'));
  assert.match(out, /## §1 群印象\nB/);
});

check('upsertHandoff：已有交接段时覆盖它，不影响后续小节', () => {
  const file = '## §〇 交接\nOLD\n\n## §1 群印象\nB\n';
  const out = m.upsertHandoff(file, '## §〇 交接\nNEW\n');
  assert.match(out, /NEW/);
  assert.doesNotMatch(out, /OLD/);
  assert.match(out, /## §1 群印象\nB/);
});

check('upsertHandoff：文件为空 → 只有交接段', () => {
  const out = m.upsertHandoff('', '## §〇 交接\nX\n');
  assert.equal(out.trim(), '## §〇 交接\nX');
});

check('checkHandoff：缺失 / 全空 / 正常 三种结论', () => {
  assert.equal(m.checkHandoff('## §1 群印象\nB').reason, 'missing');
  assert.equal(m.checkHandoff(m.renderHandoff({})).reason, 'empty');
  const ok = m.checkHandoff(m.renderHandoff({ lastTalkedAbout: '聊了群规' }));
  assert.equal(ok.ok, true);
  assert.ok(ok.bytes > 0);
});

const failed = results.filter(([s]) => s !== 'ok');
for (const [s, n] of results) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'} ${n}`);
console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);