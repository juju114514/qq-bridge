// 抖音专用解析器（douyin-resolve.js）的契约测试。
//
// 为什么要单独钉：
//   · 这条路的**唯一**价值就是"绕过 yt-dlp 拿播放地址"——一旦分享页结构变了，
//     必须立刻在离线测试里看得见，而不是等用户发链接时才发现
//   · 它要读 cookies.txt，所以"只挑抖音域名"这条必须钉死（别把别的站凭据发出去）
//
// 全程离线：不联网、不发 cookies、不下载。
// 另外用 scripts/fixtures/video/ 下的**页面快照**做结构回归：上游改版时这里会红。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { extractAwemeId, cookieHeaderFor, stripWatermark, parseSharePage, inspectCookies, cookieHealth, describeRemaining } = await import(
  new URL('../src/douyin-resolve.js', import.meta.url).href
);
const { isAllowedMediaHost, MEDIA_HOST_SUFFIXES } = await import(
  new URL('../src/video-download.js', import.meta.url).href
);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 1. 取视频 id ──────────────────────────────────────────────────────────
check('extractAwemeId：视频页/分享页/note/modal_id 都能取到 id', () => {
  const id = '7698702561587924403';
  const cases = [
    `https://www.douyin.com/video/${id}`,
    `https://www.iesdouyin.com/share/video/${id}/?region=CN`,
    `https://www.douyin.com/note/${id}`,
    `https://www.douyin.com/discover?modal_id=${id}`,
    `https://www.douyin.com/aweme/v1/?aweme_id=${id}`
  ];
  for (const url of cases) assert.equal(extractAwemeId(url), id, `没取到：${url}`);
});

check('extractAwemeId：短链/主页/乱码一律返回空（交给重定向去解析）', () => {
  for (const url of ['https://v.douyin.com/0Y8RGQ9vLK8/', 'https://www.douyin.com/user/MS4wLjABAAAA', '不是链接']) {
    assert.equal(extractAwemeId(url), '', `不该取到 id：${url}`);
  }
});

// ── 2. cookies 只挑抖音域名 ───────────────────────────────────────────────
check('cookieHeaderFor：只挑 douyin 域，别的站凭据不外发', () => {
  const tmp = path.join(os.tmpdir(), `ck-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, [
    '# Netscape HTTP Cookie File',
    '.douyin.com\tTRUE\t/\tFALSE\t1999999999\tttwid\tAAA',
    '.www.douyin.com\tTRUE\t/\tFALSE\t1999999999\tmsToken\tBBB',
    '.bilibili.com\tTRUE\t/\tFALSE\t1999999999\tSESSDATA\tSECRET',
    '.example.com\tTRUE\t/\tFALSE\t1999999999\tsession\tSECRET2'
  ].join('\n'));
  const header = cookieHeaderFor(tmp);
  assert.match(header, /ttwid=AAA/);
  assert.match(header, /msToken=BBB/);
  assert.doesNotMatch(header, /SECRET/, '把别的站的 cookie 也带上了');
  fs.unlinkSync(tmp);
  assert.equal(cookieHeaderFor(path.join(os.tmpdir(), 'does-not-exist.txt')), '', '文件不存在应返回空串，不能抛');
});

// ── 3. 去水印 ────────────────────────────────────────────────────────────
check('stripWatermark：playwm→play，其它不动', () => {
  const url = 'https://aweme.snssdk.com/aweme/v1/playwm/?line=0&ratio=720p&video_id=v1abc';
  assert.match(stripWatermark(url), /\/aweme\/v1\/play\//);
  assert.doesNotMatch(stripWatermark(url), /playwm/);
  const plain = 'https://aweme.snssdk.com/aweme/v1/play/?video_id=v1abc';
  assert.equal(stripWatermark(plain), plain);
});

// ── 4. 分享页解析 ────────────────────────────────────────────────────────
check('parseSharePage：抠出 \\u002F 转义的 play_addr.url_list 与 desc', () => {
  // 这是实测页面的形状（转义 + url_list 数组）
  const html = `<script>{"aweme_detail":{"desc":"测试视频\\n第二行","duration":96600,
    "video":{"play_addr":{"uri":"v1e00fgi0000",
    "url_list":["https:\\u002F\\u002Faweme.snssdk.com\\u002Faweme\\u002Fv1\\u002Fplaywm\\u002F?ratio=720p&video_id=v1e00fgi0000"]}}}}</script>`;
  const parsed = parseSharePage(html);
  assert.equal(parsed.urls.length, 1);
  assert.match(parsed.urls[0], /^https:\/\/aweme\.snssdk\.com\/aweme\/v1\/playwm\//);
  assert.equal(parsed.desc, '测试视频 第二行');
  assert.equal(parsed.durationMs, 96600);
});

check('parseSharePage：没有 play_addr 时返回空数组（不抛、不编造）', () => {
  const parsed = parseSharePage('<html><body>没有数据</body></html>');
  assert.deepEqual(parsed.urls, []);
  assert.equal(parsed.desc, '');
});

// ── 4.5 cookie 体检（过期就别让用户猜「为什么看不了」）────────────────────
check('inspectCookies：过期/将过期/会话 cookie 分开统计', () => {
  const tmp = path.join(os.tmpdir(), `ckh-${process.pid}-${Date.now()}.txt`);
  const now = Date.parse('2026-10-28T00:00:00Z');
  const sec = (ms) => Math.floor(ms / 1000);
  fs.writeFileSync(tmp, [
    '# Netscape HTTP Cookie File',
    `.douyin.com\tTRUE\t/\tFALSE\t${sec(now - 86400000)}\told\t1`,       // 已过期
    `.douyin.com\tTRUE\t/\tFALSE\t${sec(now + 3600000)}\tsoon\t2`,        // 1 小时内到期
    `.douyin.com\tTRUE\t/\tFALSE\t${sec(now + 30 * 86400000)}\tfresh\t3`, // 还很久
    '.douyin.com\tTRUE\t/\tFALSE\t0\tsession\t4',                          // 会话 cookie
    '.bilibili.com\tTRUE\t/\tFALSE\t0\tx\ty'                                // 别的站，不该计入
  ].join('\n'));
  const stats = inspectCookies(tmp, 'douyin.com', { now });
  assert.equal(stats.total, 4, `只该统计抖音域，实际 ${stats.total}`);
  assert.equal(stats.expired, 1);
  assert.equal(stats.expiringSoon, 1);
  assert.equal(stats.session, 1);
  fs.unlinkSync(tmp);
});

check('cookieHealth：缺文件/全过期/部分过期 给出可操作结论', () => {
  assert.equal(cookieHealth('').code, 'cookie-missing');
  assert.equal(cookieHealth(path.join(os.tmpdir(), 'nope-not-here.txt')).code, 'cookie-missing');

  const tmp = path.join(os.tmpdir(), `ckh2-${process.pid}-${Date.now()}.txt`);
  const past = Math.floor(Date.now() / 1000) - 1000;
  fs.writeFileSync(tmp, [
    `.douyin.com\tTRUE\t/\tFALSE\t${past}\ta\t1`,
    `.douyin.com\tTRUE\t/\tFALSE\t${past}\tb\t2`
  ].join('\n'));
  const allExpired = cookieHealth(tmp);
  assert.equal(allExpired.code, 'cookie-expired');
  assert.match(allExpired.message, /重新导出/);

  fs.writeFileSync(tmp, [
    `.douyin.com\tTRUE\t/\tFALSE\t${past}\ta\t1`,
    `.douyin.com\tTRUE\t/\tFALSE\t0\tb\t2`,
    `.douyin.com\tTRUE\t/\tFALSE\t0\tc\t3`
  ].join('\n'));
  const partial = cookieHealth(tmp);
  assert.equal(partial.ok, true, '部分过期不算致命');
  assert.equal(partial.code, 'cookie-aging');
  assert.match(partial.message, /1\/3/);
  fs.unlinkSync(tmp);
});

check('describeRemaining：小时/天/已过期 都说人话', () => {
  const now = Date.now();
  assert.equal(describeRemaining(now + 20 * 60000, now), '不到 1 小时');
  assert.equal(describeRemaining(now + 5 * 3600000, now), '约 5 小时');
  assert.equal(describeRemaining(now + 3 * 86400000, now), '约 3 天');
  assert.equal(describeRemaining(now - 1000, now), '已过期');
  assert.equal(describeRemaining(0, now), '未知时间');
});

// ── 5. 接线 ──────────────────────────────────────────────────────────────
// ── 4.6 fixture 回归：上游页面结构一变，这里必须红 ─────────────────────────
check('fixture：真实形态的分享页能被解析出 playwm 地址（含 \u002F 转义）', () => {
  const html = read('scripts/fixtures/video/douyin-share-page.html');
  const parsed = parseSharePage(html);
  assert.equal(parsed.urls.length, 1, 'fixture 里应抠出恰好 1 个播放地址');
  assert.match(parsed.urls[0], /^https:\/\/aweme\.snssdk\.com\//, '域名解析错了');
  assert.match(parsed.urls[0], /\/playwm\//, '原地址应是带水印的 playwm');
  assert.match(stripWatermark(parsed.urls[0]), /\/play\//, '去水印应换成 /play/');
  assert.match(parsed.desc, /fixture/, 'desc 也要解析出来（补投/展示要用）');
  assert.equal(parsed.durationMs, 12345);
});

check('fixture：风控/验证页要优雅返回空，不许编造地址', () => {
  const html = read('scripts/fixtures/video/douyin-verify-page.html');
  const parsed = parseSharePage(html);
  assert.deepEqual(parsed.urls, [], '验证页里没有 play_addr，不能凭空造一个');
  assert.equal(parsed.desc, '');
});

// ── 4.7 播放地址白名单（解析结果是不可信输入）─────────────────────────────
check('isAllowedMediaHost：只放行抖音/字节媒体域，其余一律拒', () => {
  const allow = [
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=x',
    'https://v3-web.douyinvod.com/abc.mp4',
    'https://p3-pc-sign.douyinpic.com/x.jpg',
    'https://v26-web.douyincdn.com/x.mp4'
  ];
  for (const url of allow) assert.equal(isAllowedMediaHost(url), true, `应放行 ${url}`);
  const deny = [
    'https://evil-snssdk.com/aweme/v1/play/',            // 后缀伪装
    'https://aweme.snssdk.com.evil.com/x',               // 前缀伪装
    'https://v3-default.ixigua.com/abc.mp4',             // 未列入的字节域
    'http://127.0.0.1:3100/api/status',                  // 内网
    'http://169.254.169.254/latest/meta-data/',          // 元数据服务
    'file:///C:/Windows/win.ini',
    'not-a-url'
  ];
  for (const url of deny) assert.equal(isAllowedMediaHost(url), false, `应拒绝 ${url}`);
  assert.ok(MEDIA_HOST_SUFFIXES.includes('snssdk.com'), '白名单里应有 snssdk.com');
});

check('video-download：直链下载**每一跳**都校验域名，跳数上限 3', () => {
  const dl = read('src/video-download.js');
  assert.match(dl, /export function isAllowedMediaHost/);
  const body = dl.slice(dl.indexOf('async function downloadDirect'), dl.indexOf('function cleanDir'));
  assert.match(body, /MAX_HOPS = 3/, '跳数要收紧');
  assert.match(body, /if \(!isAllowedMediaHost\(current\)\)/, '每跳都要校验');
  assert.match(body, /不在媒体白名单内/, '拒绝时要说清原因');
  // 校验必须在 fetch 之前（否则等于没校验）
  assert.ok(body.indexOf('isAllowedMediaHost(current)') < body.indexOf('await fetch(current'),
    '校验必须发生在请求之前');
});

check('video-download：抖音先走专用解析器，失败才回退 yt-dlp，且挂 cleanup', () => {
  const dl = read('src/video-download.js');
  assert.match(dl, /from '\.\/douyin-resolve\.js'/, '必须导入解析器');
  assert.match(dl, /if \(isDouyin && opts\.cookiesFile\)/, '抖音且给了 cookies 才走解析器');
  assert.match(dl, /__douyinError/, '解析失败的原因要保留，和 yt-dlp 的错误一起报');
  assert.match(dl, /got\.cleanup = cleanup/, '解析成功也必须挂 cleanup（曾漏，报 r.cleanup is not a function）');
  assert.match(dl, /function downloadDirect/, '需要直链下载（播放地址会 302 到 CDN）');
});

check('bridge：抖音成功时预告 cookie 老化，并有体检端点', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /cookieHealth\(videoLinkConfig\(\)\.cookiesPath\)/, '抖音成功分支要体检');
  assert.match(bridge, /cookie-aging/, '只对"将过期/部分过期"预告，不是每次都喊');
  assert.match(bridge, /'\/api\/socialV2\/video-cookies'/, '要有只读体检端点');
  assert.match(bridge, /describeRemaining/, '端点要给出"还能用多久"');
});

check('解析器：cookie 不可用时提前返回可操作原因（code + 中文）', () => {
  const res = read('src/douyin-resolve.js');
  assert.match(res, /code: 'cookie-missing'/);
  assert.match(res, /code: 'cookie-expired'/);
  assert.match(res, /cookie-invalid/, 'cookie 失效要有单独的 code（分享页变验证页/403）');
  assert.match(res, /重新导出一次/, '失效时要说清怎么修');
});

check('bridge 把 cookiesPath 传给下载器（否则解析器拿不到 cookie）', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /cookiesFile: videoLinkConfig\(\)\.cookiesPath/);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
