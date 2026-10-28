// B 站增强（src/bili-enrich.js）的契约测试：纯函数 + 无网络 + 不 spawn 真 CLI。
//
// 这块的定位是"锦上添花"：拿不到必须安静降级。所以测的重点是
//   ① bvid 提取不能把任意字符串拼进命令行；② 各种返回形态都能容错；
//   ③ 拼给模型的文本有长度上限、不乱。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const m = await import(new URL('../src/bili-enrich.js', import.meta.url).href);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// ── bvid 提取 ────────────────────────────────────────────────────────────
check('extractBvid：从各种 URL 形态里取 bvid，取不到返回空串', () => {
  assert.equal(m.extractBvid('https://www.bilibili.com/video/BV1GJ411x7h7/'), 'BV1GJ411x7h7');
  assert.equal(m.extractBvid('https://b23.tv/abc'), '', '短链没有 bvid，交给 yt-dlp');
  assert.equal(m.extractBvid('BV1GJ411x7h7'), 'BV1GJ411x7h7');
  assert.equal(m.extractBvid('随便一段话'), '');
  assert.equal(m.extractBvid(null), '');
});

check('extractBvid：拒绝伪造形态（防命令注入）', () => {
  assert.equal(m.extractBvid('BV1GJ411x7h7; rm -rf /'), 'BV1GJ411x7h7', '只取合法片段');
  assert.equal(m.extractBvid('BV../../etc/passwd'), '');
  assert.equal(m.extractBvid('BV'), '');
});

// ── 字幕 ────────────────────────────────────────────────────────────────
check('pickSubtitle：优先中文，body/lines 两种形态都认', () => {
  const zh = m.pickSubtitle({ subtitles: [
    { lan: 'en', body: [{ content: 'hello' }] },
    { lan: 'zh-CN', body: [{ content: '你好' }, { content: '世界' }] }
  ] });
  assert.equal(zh.lan, 'zh-CN');
  assert.equal(zh.text, '你好\n世界');
  assert.equal(zh.lines, 2);

  const lines = m.pickSubtitle([{ lan: 'zh', lines: [{ text: 'a' }, { text: 'b' }] }]);
  assert.equal(lines.text, 'a\nb');
});

check('pickSubtitle：空/无正文返回 null（不能拼出空字幕块）', () => {
  assert.equal(m.pickSubtitle(null), null);
  assert.equal(m.pickSubtitle([]), null);
  assert.equal(m.pickSubtitle({ subtitles: [] }), null);
  assert.equal(m.pickSubtitle({ subtitles: [{ lan: 'zh', body: [] }] }), null);
});

// ── 评论 ────────────────────────────────────────────────────────────────
check('pickHotComments：按赞数降序、去空、截断条数', () => {
  const list = m.pickHotComments({ replies: [
    { member: { uname: 'A' }, like: 5, content: { message: '低赞' } },
    { member: { uname: 'B' }, like: 99, content: { message: '  高赞  ' } },
    { member: { uname: 'C' }, like: 1, content: { message: '' } }
  ] }, 2);
  assert.equal(list.length, 2);
  assert.equal(list[0].user, 'B');
  assert.equal(list[0].text, '高赞');
  assert.equal(list[0].likes, 99);
});

check('pickHotComments：bili-cli 1.2 形状（items + user.name + content 字符串）', () => {
  const list = m.pickHotComments({ items: [
    { user: { mid: 1, name: '老咸鱼A' }, content: '坏消息：被骗了\n好消息：真好听', like: 771083 },
    { user: { mid: 2, name: 'B' }, content: '第二条', like: 10 }
  ] }, 2);
  assert.equal(list[0].user, '老咸鱼A', '用户名不能是 [object Object]');
  assert.equal(list[0].text, '坏消息：被骗了 好消息：真好听', '换行要压成空格');
  assert.equal(list[0].likes, 771083);
});

check('pickHotComments：评论关闭/结构不同都返回空数组，不抛', () => {
  assert.deepEqual(m.pickHotComments(null), []);
  assert.deepEqual(m.pickHotComments({}), []);
  assert.deepEqual(m.pickHotComments({ replies: null }), []);
});

// ── 文本拼装 ────────────────────────────────────────────────────────────
check('formatBiliEnrich：元数据/字幕/热评都能拼出来，字幕有长度上限', () => {
  const text = m.formatBiliEnrich({
    ok: true,
    bvid: 'BV1GJ411x7h7',
    info: { title: '标题', owner: 'UP', stat: { view: 1, danmaku: 2, reply: 3 }, desc: '简介' },
    subtitle: { lan: 'zh-CN', text: 'x'.repeat(5000) },
    comments: [{ user: 'A', likes: 9, text: '说得对' }]
  }, { maxSubtitleChars: 100 });
  assert.match(text, /【B站视频】标题/);
  assert.match(text, /UP：UP/);
  assert.match(text, /【字幕·zh-CN】/);
  assert.match(text, /只取前 100 字/);
  assert.match(text, /【高赞评论】/);
  assert.match(text, /A（9赞）：说得对/);
});

check('formatBiliEnrich：没有增强数据时返回空串（不往 prompt 里塞空标题）', () => {
  assert.equal(m.formatBiliEnrich(null), '');
  assert.equal(m.formatBiliEnrich({ ok: false }), '');
  assert.equal(m.formatBiliEnrich({ ok: true, bvid: 'BV1', info: null, subtitle: null, comments: [] }), '');
});

// ── 接线 ────────────────────────────────────────────────────────────────
check('接线：bridge 在 B 站链接分析后调用增强，且失败不影响主流程', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /enrichBili\(/, '要调用增强');
  assert.match(bridge, /bilibili\\\.com\|b23\\\.tv/, '只对 B 站生效');
  assert.match(bridge, /biliEnrich !== false/, '要有开关');
  assert.match(bridge, /增强失败（不影响看视频）/, '失败必须降级');
});

check('resolveBili：不存在的配置路径会被跳过；返回的路径必须真实存在', () => {
  const r = m.resolveBili('D:\\definitely\\not\\exists\\bili.exe');
  // 本机 PATH 里可能真有 bili；要么空，要么是真实存在的文件
  assert.ok(r === '' || fs.existsSync(r), `返回了不存在的路径：${r}`);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }
