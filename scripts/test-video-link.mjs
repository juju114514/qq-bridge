// 视频**链接**识别（B站 / 抖音）的契约测试。
//
// 这条链路的两个要害：
//   1) **白名单**：模型能把用户贴的链接交过来，所以必须只放行 B站/抖音 —— 否则等于给了一个
//      任意 URL 下载器（内网、任意站点都能被"看视频"这个动作触发下载）。
//   2) **只下前 N 秒**：实测 B 站 84MB/8s → 1.5MB/3s；不做分段会把磁盘和等待时间都吃掉。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { detectVideoLinks, isAllowedVideoUrl, VIDEO_SITES } = await import(
  new URL('../src/video-link.js', import.meta.url).href
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

// ── 1. 识别 ───────────────────────────────────────────────────────────────
check('B 站：视频页 / 番剧 / b23.tv 短链都能认出来', () => {
  const cases = [
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili'],
    ['https://bilibili.com/video/av170001', 'bilibili'],
    ['https://www.bilibili.com/bangumi/play/ep123456', 'bilibili'],
    ['【官方MV】 https://b23.tv/AbCd12 快看', 'bilibili'],
  ];
  for (const [text, site] of cases) {
    const links = detectVideoLinks(text);
    assert.equal(links[0]?.site, site, `没认出 ${text}`);
  }
});

check('抖音：短链 / video / iesdouyin 分享页都能认出来', () => {
  const cases = [
    ['7.41 复制打开抖音 https://v.douyin.com/iRNBho6/ 06/07', 'douyin'],
    ['https://www.douyin.com/video/7300000000000000000', 'douyin'],
    ['https://www.iesdouyin.com/share/video/7300000000000000000/', 'douyin'],
    ['https://www.douyin.com/note/7300000000000000000', 'douyin'],
  ];
  for (const [text, site] of cases) {
    assert.equal(detectVideoLinks(text)[0]?.site, site, `没认出 ${text}`);
  }
});

check('快手 / 小红书 / YouTube：视频形态能认，主页/播放列表不认', () => {
  const yes = [
    ['https://v.kuaishou.com/AbCdEf', 'kuaishou'],
    ['https://www.kuaishou.com/short-video/3xf8abc123', 'kuaishou'],
    ['https://xhslink.com/a/bCDeFg', 'xiaohongshu'],
    ['https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a', 'xiaohongshu'],
    ['https://www.youtube.com/watch?v=BaW_jenozKc', 'youtube'],
    ['https://youtu.be/BaW_jenozKc', 'youtube'],
    ['https://www.youtube.com/shorts/BaW_jenozKc', 'youtube'],
    ['https://m.youtube.com/watch?v=BaW_jenozKc', 'youtube'],
  ];
  for (const [url, site] of yes) {
    assert.equal(detectVideoLinks(url)[0]?.site, site, `没认出 ${url}`);
  }
  const no = [
    'https://www.kuaishou.com/profile/3xabc',           // 主页
    'https://www.xiaohongshu.com/user/profile/5f0a1b',  // 主页
    'https://www.youtube.com/playlist?list=PL123',      // 播放列表
    'https://www.youtube.com/@channel',                 // 频道
  ];
  for (const url of no) {
    assert.equal(detectVideoLinks(url).length, 0, `不该认出来：${url}`);
  }
});

check('非视频链接 / 假域名 / 专栏页一律不认', () => {
  for (const text of [
    'https://example.com/video/1',
    'https://evil-bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/read/cv123456',
    'https://b23.tv.evil.com/x',
    'https://evil-youtube.com/watch?v=BaW_jenozKc',
  ]) {
    assert.equal(detectVideoLinks(text).length, 0, `不该认出来：${text}`);
  }
});

check('一条消息里的链接去重、保序、默认最多 3 个', () => {
  const text = 'https://v.douyin.com/aaa/ https://v.douyin.com/aaa/ https://b23.tv/x1 https://b23.tv/x2 https://b23.tv/x3';
  const links = detectVideoLinks(text);
  assert.equal(links.length, 3, `应截断到 3，实际 ${links.length}`);
  assert.equal(new Set(links.map((l) => l.url)).size, links.length, '不能有重复');
});

// ── 2. 白名单（安全边界）─────────────────────────────────────────────────
check('isAllowedVideoUrl：只放行白名单站点 + 必须是 http(s)', () => {
  const allow = [
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://b23.tv/AbCd12',
    'https://v.douyin.com/iRNBho6/',
  ];
  for (const url of allow) assert.equal(isAllowedVideoUrl(url), true, `应放行 ${url}`);
  const allowMore = [
    'https://v.kuaishou.com/AbCdEf',
    'https://xhslink.com/a/bCDeFg',
    'https://youtu.be/BaW_jenozKc',
  ];
  for (const url of allowMore) assert.equal(isAllowedVideoUrl(url), true, `应放行 ${url}`);
  const deny = [
    'https://evil-bilibili.com/video/BV1xx411c7mD',
    'http://127.0.0.1:3100/api/status',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'https://www.bilibili.com/read/cv1',
    'https://youtube.com/watch?v=x',
    'not-a-url',
  ];
  for (const url of deny) assert.equal(isAllowedVideoUrl(url), false, `应拒绝 ${url}`);
});

check('站点表可裁剪（sites 参数），且 id 与中文名对得上', () => {
  const url = 'https://v.douyin.com/iRNBho6/';
  assert.equal(isAllowedVideoUrl(url, { sites: ['bilibili'] }), false, '只开 B站时抖音要被拒');
  assert.equal(isAllowedVideoUrl(url, { sites: ['douyin'] }), true);
  assert.deepEqual(VIDEO_SITES.map((s) => s.id), ['bilibili', 'douyin', 'kuaishou', 'xiaohongshu', 'youtube']);
});

// ── 3. 接线 ───────────────────────────────────────────────────────────────
check('bridge：有 /api/socialV2/video-link，且白名单/yt-dlp 都先判', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /'\/api\/socialV2\/video-link'/);
  assert.match(bridge, /isAllowedVideoUrl\(/, '路由里必须先过白名单');
  assert.match(bridge, /ytDlpAvailable\(/, 'yt-dlp 不可用要给出可读原因');
  assert.match(bridge, /async function videoLinkToModelParts/);
  assert.match(bridge, /只支持 B 站 \/ 抖音/, '拒绝文案要写清只支持两个站');
});

check('yt-dlp 下载：默认只取前 N 秒，失败退回整段', () => {
  const dl = read('src/video-download.js');
  assert.match(dl, /--download-sections/);
  assert.match(dl, /\*0-\$\{maxSeconds\}/);
  assert.match(dl, /partial/, '要标记"只取了一段"');
  assert.match(dl, /isAllowedVideoUrl/, '下载前再判一次白名单（双保险）');
  // 不许把任意 URL 直接拼进命令：必须走 args 数组 + '--' 分隔
  assert.match(dl, /'--', clean/);
  assert.match(dl, /--cookies'/, '必须支持 --cookies <file>（浏览器 app-bound 加密时唯一的活路）');
  assert.match(dl, /cookiesFile && fs\.existsSync/, 'cookies 文件优先于 cookiesFromBrowser');
});

check('失败原因会翻译成人话（抖音主页/直播/图文 → 不是视频）', async () => {
  const { explainYtDlpError } = await import(new URL('../src/video-download.js', import.meta.url).href);
  const os = await import('node:os');
  const tmps = [];
  const write = (body) => {
    const f = path.join(os.tmpdir(), `ytdlp-err-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    fs.writeFileSync(f, body);
    tmps.push(f);
    return f;
  };
  assert.match(explainYtDlpError(write('[generic] x\nERROR: Unsupported URL: https://www.iesdouyin.com/share/user/abc')),
    /不是视频/, '抖音主页链接应翻译成"不是视频"');
  assert.match(explainYtDlpError(write('ERROR: Sign in to confirm you are not a bot')), /登录态/);
  assert.match(explainYtDlpError(write('ERROR: HTTP Error 403: Forbidden')), /拒绝|风控/);
  assert.match(explainYtDlpError(write('ERROR: video is members-only')), /会员|权限/);
  assert.match(explainYtDlpError(write('ERROR: [XiaoHongShu] abc: No video formats found!')), /没有视频/,
    '小红书图文笔记应翻译成"没有视频"');
  assert.match(explainYtDlpError(write('ERROR: [youtube] abc: This video is unavailable')), /不可用/);
  assert.equal(explainYtDlpError(write('')), '', '空日志不该编原因');
  for (const f of tmps) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

check('MCP 暴露 qq_open_video（storyboard / transcript）', () => {
  const mcp = read('src/mcp-snowluma-safe.js');
  assert.match(mcp, /'qq_open_video'/);
  assert.match(mcp, /mode: z\.enum\(\['storyboard', 'transcript'\]\)/);
  assert.match(mcp, /api\/socialV2\/video-link/);
  assert.match(mcp, /只白名单 B站\/抖音|B站 \/ 抖音/, '描述里要提醒不支持其他站点');
});

check('工具可见性可诊断：MCP 启动汇总 + /api/socialV2/tools 端点', () => {
  const mcp = read('src/mcp-snowluma-safe.js');
  assert.match(mcp, /registeredTools\.push/, '要记录已注册的工具');
  assert.match(mcp, /工具注册完成：/, '启动时要打一行汇总（否则"关了哪个"是静默的）');
  assert.match(mcp, /按配置关闭（未注册/, '被关掉的工具要列出来');
  assert.match(mcp, /qq_open_video 未注册 ⇒/, '缺少视频工具时要给可操作的提示');
  const bridge = read('src/bridge.js');
  assert.match(bridge, /'\/api\/socialV2\/tools'/, '要有只读自检端点');
  assert.match(bridge, /socialV2\.tools\.getImages=false/, '端点要解释 getImages=false 的后果');
});

check('一条命令查工具可见性：diag-tools.mjs 存在、文档指向它、三种结论齐备', () => {
  const script = read('scripts/diag-tools.mjs');
  assert.match(script, /\/api\/socialV2\/tools/, '要查桥接侧');
  assert.match(script, /mcp-snowluma-safe\.js/, '要查代码侧/运行侧');
  assert.match(script, /原因①：socialV2\.tools\.getImages=false/, '要给出原因①的结论');
  assert.match(script, /原因③：代码里没有这些工具/, '要给出原因③的结论');
  assert.match(script, /process\.exit\(exitCode\)/, '要用退出码表达结论');
  const ts = read('TROUBLESHOOTING.md');
  assert.match(ts, /scripts\\diag-tools\.mjs/, 'TROUBLESHOOTING 要指向它');
  const fm = read('docs/FOLDER_MAP.md');
  assert.match(fm, /`diag-tools\.mjs`/, 'FOLDER_MAP 要登记');
});

check('配置项齐全（links 可整体关掉）', () => {
  const cfg = JSON.parse(read('config.example.json'));
  const links = cfg?.socialV2?.media?.video?.links;
  assert.ok(links, '缺 socialV2.media.video.links');
  for (const k of ['enabled', 'maxSeconds', 'maxBytes', 'timeoutMs', 'maxHeight', 'sites', 'cookiesPath', 'cookiesFromBrowser']) {
    assert.ok(k in links, `links 缺 ${k}`);
  }
  assert.deepEqual(links.sites, ['bilibili', 'douyin', 'kuaishou', 'xiaohongshu', 'youtube']);
});

console.log('');
if (failures === 0) console.log('  全部通过');
else {
  console.error(`  ${failures} 项失败`);
  process.exitCode = 1;
}
