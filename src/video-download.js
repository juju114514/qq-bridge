// 用 yt-dlp 把 B 站 / 抖音的视频下载到本地（只给"链接识别"这条路用）。
//
// 设计约束：
//   · **只接受白名单站点的 URL**（调用方必须先用 video-link.js 的 isAllowedVideoUrl 判过；
//     这里再判一次，双保险）——模型不能拿任意地址指挥本机下载
//   · **进程间只走文件**：yt-dlp 的 stdio 全部 ignore，产物落在临时目录，靠扫目录拿文件
//     （受限沙箱下 spawn+pipe 会 EPERM，和 voice-core/media-normalize 同一条教训）
//   · **超时 + 体积上限**：抖音/B站有的视频几百 MB，必须限，否则一次调用能把磁盘吃满
//   · 失败必须给可读原因（找不到 yt-dlp / 需要登录 / 超时 / 没有视频流）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isAllowedVideoUrl } from './video-link.js';
import { resolveDouyinPlayUrl, extractAwemeId } from './douyin-resolve.js';

const VIDEO_EXT = /\.(mp4|mkv|webm|flv|mov|m4v|ts)$/i;

/** 找 yt-dlp：显式配置 > 环境变量 > 常见安装位置 > PATH。 */
export function resolveYtDlp(opts = {}) {
  const candidates = [
    opts.ytdlpPath,
    process.env.QQBOT_YTDLP,
    process.env.YTDLP_PATH,
    // 故意**不写死任何盘符路径**：换机器必须能用。本机路径请写进
    // config.json 的 socialV2.media.video.links.ytdlpPath（示例配置里留空）
    'yt-dlp.exe',
    'yt-dlp'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate; // 交给 PATH/PATHEXT 解析；找不到时 spawn 会报 ENOENT
  }
  return 'yt-dlp';
}

/** yt-dlp 是否可用（跑一次 --version，结果缓存）。 */
let ytdlpCache = null;
export function ytDlpAvailable(opts = {}) {
  if (ytdlpCache !== null) return ytdlpCache;
  const exe = resolveYtDlp(opts);
  try {
    const r = spawnSync(exe, ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    ytdlpCache = r.status === 0;
  } catch { ytdlpCache = false; }
  return ytdlpCache;
}

/** 供运维/测试手动清缓存（刚装完 yt-dlp 时用）。 */
export function resetYtDlpCache() { ytdlpCache = null; }

/**
 * 把 yt-dlp 的 stderr 归类成人话。
 *
 * 为什么要它：抖音的链接形态很多（视频 / 主页 / 直播 / 图文），yt-dlp 对后三者的报错都是
 * `Unsupported URL`，直接把这句丢给用户等于没说。这里按关键字翻译，让人一眼知道"换个链接"还是"要登录"。
 */
export function explainYtDlpError(errFile) {
  let text = '';
  try { text = fs.readFileSync(errFile, 'utf8'); } catch { return ''; }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-6).join('\n');
  if (/No video formats found/i.test(tail)) return '这个链接里没有视频（可能是图文笔记/纯图片）';
  if (/This video is unavailable|Video unavailable/i.test(tail)) return '视频不可用（可能已删除/区域限制/需要登录）';
  if (/Unsupported URL/i.test(tail)) return '这个链接不是视频（可能是主页/直播/图文/已删除）';
  if (/needs? to log ?in|login required|cookies|Sign in to confirm/i.test(tail)) return '需要登录态（可在 socialV2.media.video.links.cookiesFromBrowser 填 edge/chrome）';
  if (/Private video|members-only|VIP|premium|会员/i.test(tail)) return '该视频需要会员/权限';
  if (/HTTP Error 404|not found|已删除|404/i.test(tail)) return '视频不存在或已删除';
  if (/HTTP Error 403|Forbidden|风控/i.test(tail)) return '被站点拒绝（风控/版权限制）';
  const firstError = lines.find((l) => /^ERROR/i.test(l));
  return firstError ? firstError.slice(0, 160) : '';
}

/**
 * 抖音专用：用分享页的 play_addr 直接下载（不经过 yt-dlp）。
 * 成功返回和 yt-dlp 分支同形状的对象，调用方无需区分。
 */
async function tryDouyinResolver(url, dir, opts) {
  const resolved = await resolveDouyinPlayUrl(url, {
    cookiesFile: opts.cookiesFile,
    timeoutMs: Math.min(30000, Number(opts.timeoutMs) || 25000)
  });
  if (!resolved.ok) return resolved;
  const dest = path.join(dir, `douyin-${extractAwemeId(url) || 'video'}.mp4`);
  try {
    const got = await downloadDirect(resolved.playUrl, dest, {
      maxBytes: Math.max(1024 * 1024, Number(opts.maxBytes) || 200 * 1024 * 1024),
      timeoutMs: Math.max(10000, Number(opts.timeoutMs) || 180000)
    });
    return { ok: true, file: got.file, bytes: got.bytes, partial: false, source: 'douyin-share-page' };
  } catch (error) {
    return { ok: false, error: `播放地址下载失败：${error?.message ?? error}` };
  }
}

/** 直链下载（跟随重定向）。抖音播放地址会 302 到 CDN，所以手动跟几跳。 */
async function downloadDirect(rawUrl, dest, opts) {
  let current = String(rawUrl);
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, {
      headers: { 'user-agent': 'Mozilla/5.0', 'referer': 'https://www.douyin.com/' },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs)
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error(`重定向缺少 Location（${res.status}）`);
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lengthHeader = Number(res.headers.get('content-length') || 0);
    if (lengthHeader > opts.maxBytes) throw new Error(`文件超过上限（${Math.round(lengthHeader / 1024 / 1024)}MB）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > opts.maxBytes) throw new Error(`文件超过上限（${Math.round(buf.length / 1024 / 1024)}MB）`);
    if (buf.length < 50 * 1024) throw new Error(`内容太小（${buf.length}B），疑似错误页`);
    fs.writeFileSync(dest, buf);
    return { file: dest, bytes: buf.length };
  }
  throw new Error('重定向次数过多');
}

function cleanDir(dir) {
  try {
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
  } catch { /* ignore */ }
}

function runYtDlp(exe, args, timeoutMs, errFile = '') {
  return new Promise((resolve) => {
    let child;
    let errFd = null;
    try {
      if (errFile) {
        try { errFd = fs.openSync(errFile, 'w'); } catch { errFd = null; }
      }
      const stdio = errFd === null ? 'ignore' : ['ignore', 'ignore', errFd];
      child = spawn(exe, args, { windowsHide: true, stdio });
    } catch (error) {
      resolve({ ok: false, error: `yt-dlp 启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      settle({ ok: false, error: `yt-dlp 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT'
        ? '找不到 yt-dlp（在 config.json 的 socialV2.media.video.links.ytdlpPath 指定路径，或装到 PATH）'
        : `yt-dlp 不可用：${error?.message ?? error}`
    }));
    child.on('close', (code) => {
      if (errFd !== null) { try { fs.closeSync(errFd); } catch { /* ignore */ } }
      settle(code === 0 ? { ok: true } : { ok: false, error: `yt-dlp 退出码 ${code}` });
    });
  });
}

/**
 * 下载一个受支持的视频链接。
 * @param {string} url
 * @param {{ytdlpPath?:string, maxBytes?:number, timeoutMs?:number, cookiesFromBrowser?:string,
 *          maxHeight?:number, sites?:string[]}} opts
 * @returns {Promise<{ok:boolean, file?:string, bytes?:number, title?:string, site?:string,
 *                    cleanup?:()=>void, error?:string}>}
 */
export async function downloadVideoLink(url, opts = {}) {
  const clean = String(url ?? '').trim();
  if (!isAllowedVideoUrl(clean, { sites: opts.sites })) {
    return { ok: false, error: '不是受支持的视频链接（只允许 B 站 / 抖音）' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-vlink-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
  // 抖音先走专用解析器（yt-dlp 的 Douyin extractor 需要 a_bogus 签名，未登录/无签名一律 403，
  // 实测即使导入了 cookies 也只会得到「Fresh cookies needed」）。
  const host = (() => { try { return new URL(clean).hostname.toLowerCase(); } catch { return ''; } })();
  const isDouyin = host === 'douyin.com' || host.endsWith('.douyin.com');
  if (isDouyin && opts.cookiesFile) {
    const got = await tryDouyinResolver(clean, dir, opts);
    // 关键：必须挂上 cleanup，否则调用方拿到的临时目录永远删不掉（踩过：r.cleanup is not a function）
    if (got.ok) { got.cleanup = cleanup; got.partial = false; return got; }
    // 解析器失败就把原因记下来，等 yt-dlp 也失败时一起给出（否则用户只看到第二层的错）
    opts.__douyinError = got.error;
  }

  const exe = resolveYtDlp(opts);
  const maxHeight = Math.max(240, Math.min(1080, Number(opts.maxHeight) || 720));
  const maxBytes = Math.max(1024 * 1024, Number(opts.maxBytes) || 200 * 1024 * 1024);
  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || 180000);
  const outTpl = path.join(dir, 'video.%(ext)s');
  const maxSeconds = Math.max(5, Math.min(600, Number(opts.maxSeconds) || 180));
  const baseArgs = [
    '--no-playlist', '--no-warnings', '--no-progress', '--no-call-home',
    '--no-part', '--restrict-filenames', '--merge-output-format', 'mp4',
    '-f', `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/b[height<=${maxHeight}]/bv*[height<=${maxHeight}]/b`,
    '--max-filesize', String(maxBytes),
    '-o', outTpl
  ];
  // 两条路：① 直接给 cookies.txt（最稳，不受浏览器加密/锁库影响）
  //         ② 从浏览器读（--cookies-from-browser，Chrome/Edge 127+ 可能因 app-bound 加密失败）
  if (opts.cookiesFile && fs.existsSync(String(opts.cookiesFile))) {
    baseArgs.push('--cookies', String(opts.cookiesFile));
  } else if (opts.cookiesFromBrowser) {
    baseArgs.push('--cookies-from-browser', String(opts.cookiesFromBrowser));
  }

  // 只要看前 N 秒：实测 B 站 84MB/8s → 1.5MB/3s。省流量也省磁盘。
  // 有些站不支持分段下载（yt-dlp 会报错），那就退回整段。
  const errFile = path.join(dir, 'ytdlp.err.log');
  let run = await runYtDlp(exe, [...baseArgs, '--download-sections', `*0-${maxSeconds}`, '--', clean], timeoutMs, errFile);
  let partial = true;
  if (!run.ok) {
    cleanDir(dir);
    partial = false;
    run = await runYtDlp(exe, [...baseArgs, '--', clean], timeoutMs, errFile);
  }
  if (!run.ok) {
    const friendly = explainYtDlpError(errFile);
    cleanup();
    const base = friendly || run.error;
    return { ok: false, error: opts.__douyinError ? `${base}（抖音解析也失败：${opts.__douyinError}）` : base };
  }
  let file = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (VIDEO_EXT.test(name)) { file = path.join(dir, name); break; }
    }
  } catch { /* ignore */ }
  if (!file) { cleanup(); return { ok: false, error: 'yt-dlp 没产出视频文件（可能需要登录/版权限制/被风控）' }; }
  const bytes = fs.statSync(file).size;
  if (bytes > maxBytes) {
    cleanup();
    return { ok: false, error: `视频超过大小上限（${(bytes / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB）` };
  }
  return { ok: true, file, bytes, partial, cleanup };
}
