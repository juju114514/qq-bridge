// 抖音轻量解析（src/douyin-meta.js）：元数据 + 限流 + 失败原因，全部离线。
//
// 重点：
//   · 只解析分享页，**绝不下载视频**（下载是风控高风险动作）
//   · 同会话 10 秒冷却；先占坑再请求（防连点）
//   · 失败必须给可操作原因（cookie 失效 / 视频删除 / 不是视频）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import(new URL('../src/douyin-meta.js', import.meta.url).href);
const { parseSharePage } = await import(new URL('../src/douyin-resolve.js', import.meta.url).href);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

// 造一份"健康"的 cookies.txt（未来 30 天过期）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-'));
const cookiesFile = path.join(tmp, 'cookies.txt');
const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
fs.writeFileSync(cookiesFile, [
  '# Netscape HTTP Cookie File',
  `.douyin.com\tTRUE\t/\tTRUE\t${exp}\tttwid\tabc`,
  `.douyin.com\tTRUE\t/\tTRUE\t${exp}\tmsToken\tdef`,
  `.douyin.com\tTRUE\t/\tTRUE\t${exp}\ts_v_web_id\tghi`,
  `.douyin.com\tTRUE\t/\tTRUE\t${exp}\tpassport_csrf_token\tjkl`
].join('\n') + '\n');

const HTML = `
<script>window._ROUTER_DATA = {
 "loaderData": {"video_(id)/page": {"videoInfoRes": {"item_list": [{
   "aweme_id": "7300000000000000000",
   "desc": "今天试了下新相机\\n效果还行",
   "duration": 15000,
   "author": {"nickname": "小张", "unique_id": "xiaozhang"},
   "video": {"play_addr": {"url_list": ["https:\\u002F\\u002Faweme.snssdk.com\\u002Fplaywm\\u002F?x=1"]},
             "cover": {"url_list": ["https:\\u002F\\u002Fp3.douyinpic.com\\u002Fcover.jpeg"]}},
   "title": "新相机测试"
 }]}}}};</script>`;

await check('parseSharePage：抠出作者/标题/文案/时长/封面', () => {
  const p = parseSharePage(HTML);
  assert.equal(p.author, '小张');
  assert.equal(p.authorId, 'xiaozhang');
  assert.equal(p.title, '新相机测试');
  assert.match(p.desc, /新相机/);
  assert.equal(p.durationMs, 15000);
  assert.match(p.coverUrl, /douyinpic\.com/);
  assert.equal(p.urls.length, 1);
});

await check('resolveDouyinMeta：成功路径（只请求分享页，不下视频）', async () => {
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(String(u));
    return { ok: true, url: String(u), text: async () => HTML };
  };
  m.resetDouyinMetaCooldown();
  const r = await m.resolveDouyinMeta('https://www.douyin.com/video/7300000000000000000', {
    cookiesFile, fetchImpl, now: 1000
  });
  assert.equal(r.ok, true);
  assert.equal(r.author, '小张');
  assert.equal(r.title, '新相机测试');
  assert.equal(calls.length, 1, '有 awemeId 时只请求分享页一次');
  assert.match(calls[0], /share\/video/);
});

await check('冷却：同会话 10 秒内第二次直接拒绝（且不请求）', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return { ok: true, url: '', text: async () => HTML }; };
  m.resetDouyinMetaCooldown();
  const first = await m.resolveDouyinMeta('https://www.douyin.com/video/7300000000000000000', { cookiesFile, fetchImpl, key: 'group:1', now: 2000 });
  assert.equal(first.ok, true);
  const second = await m.resolveDouyinMeta('https://www.douyin.com/video/7300000000000000000', { cookiesFile, fetchImpl, key: 'group:1', now: 3000 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'cooldown');
  assert.equal(requests, 1, '冷却期内不该发请求');
});

await check('无 cookie：直接说清怎么修，不发请求', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return { ok: true, url: '', text: async () => HTML }; };
  m.resetDouyinMetaCooldown();
  const r = await m.resolveDouyinMeta('https://www.douyin.com/video/7300000000000000000', {
    cookiesFile: path.join(tmp, 'missing.txt'), fetchImpl, key: 'x', now: 4000
  });
  assert.equal(r.ok, false);
  assert.match(String(r.code), /cookie/);
  assert.equal(requests, 0);
});

await check('分享页变成验证页：判定 cookie 失效（可操作）', async () => {
  const fetchImpl = async () => ({ ok: true, url: '', text: async () => '<html>请先登录 verify</html>' });
  m.resetDouyinMetaCooldown();
  const r = await m.resolveDouyinMeta('https://www.douyin.com/video/7300000000000000000', { cookiesFile, fetchImpl, key: 'y', now: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cookie-invalid');
  assert.match(r.error, /cookie/);
});

await check('formatDouyinMeta：给模型看的一小段文本', () => {
  const text = m.formatDouyinMeta({ ok: true, author: '小张', authorId: 'xiaozhang', title: 'T', desc: 'D', durationSec: 15, awemeId: '1', coverUrl: 'http://c' });
  assert.match(text, /【抖音视频信息】/);
  assert.match(text, /作者：小张（@xiaozhang）/);
  assert.match(text, /时长：15 秒/);
  assert.equal(m.formatDouyinMeta({ ok: false }), '');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures === 0) console.log('  全部通过');
else { console.error(`  ${failures} 项失败`); process.exitCode = 1; }