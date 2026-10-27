// 抖音专用解析器：**绕过 yt-dlp** 拿真实播放地址。
//
// 为什么需要它（2026-10-28 实测）：
//   · yt-dlp 的 Douyin extractor 走 `www.douyin.com/aweme/v1/web/aweme/detail/`，
//     该接口要求 a_bogus 签名 → 无签名一律 403 → extractor 只能抛
//     「Fresh cookies (not necessarily logged in) are needed」，**即使登录了也一样**
//   · `--cookies-from-browser` 在 Chrome/Edge 127+ 上因 app-bound 加密读不出（DPAPI 失败）
//
// 能走通的路径（实测成功，8.4MB / 97 秒视频）：
//   `www.iesdouyin.com/share/video/<id>/` 的**分享页**会把 `play_addr.url_list` 内嵌在 HTML 里，
//   带上用户导出的 cookies + iPhone UA 就能拿到。把 `playwm`（带水印）换成 `play`（无水印）后可直接下载。
//
// 依赖：只需要一份 cookies.txt（浏览器扩展导出），**不需要**任何模型/账号密码。

import fs from 'node:fs';

const SHARE_HOST = 'www.iesdouyin.com';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 从各种抖音链接里取 aweme id（视频 id）。取不到返回空串。纯函数。 */
export function extractAwemeId(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return '';
  // 直接带 id 的形态：/video/<id>、/share/video/<id>、/note/<id>、?modal_id=<id>
  const patterns = [
    /\/(?:share\/)?video\/(\d{15,25})/,
    /\/note\/(\d{15,25})/,
    /[?&]modal_id=(\d{15,25})/,
    /[?&]aweme_id=(\d{15,25})/
  ];
  for (const re of patterns) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  return '';
}

/**
 * 读 Netscape cookies.txt，拼成只含指定站点的 Cookie 头。
 *
 * 为什么必须按域名过滤：文件里可能有别的站的会话 cookie，全塞进请求既不必要，
 * 也等于把无关凭据暴露给抖音域名。只挑 `douyin.com` 相关域。
 */
export function cookieHeaderFor(cookiesFile, host = 'douyin.com') {
  const domain = String(host).toLowerCase().replace(/^\./, '');
  const pairs = [];
  let text = '';
  try { text = fs.readFileSync(String(cookiesFile), 'utf8'); } catch { return ''; }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const ckDomain = String(parts[0]).toLowerCase().replace(/^\./, '');
    const name = parts[5];
    const value = parts[6];
    if (!name) continue;
    if (!(ckDomain === domain || ckDomain.endsWith(`.${domain}`))) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

/**
 * 解析 Netscape cookies.txt 的过期时间，给出"还能用多久"。
 *
 * 为什么要它：cookie 过期后表现和"视频不存在"几乎一样（分享页解析不出 play_addr），
 * 用户只会看到一句模糊的失败。提前判断就能直接告诉他"该重导了"。
 *
 * 字段顺序：domain 	 flag 	 path 	 secure 	 expiry(epoch秒) 	 name 	 value
 * expiry 为 0 表示**会话 cookie**（关浏览器就没了），不算过期。
 *
 * @returns {{total:number, expired:number, expiringSoon:number, session:number,
 *            earliestExpiry:number, host:string}}
 */
export function inspectCookies(cookiesFile, host = 'douyin.com', { now = Date.now(), soonDays = 3 } = {}) {
  const domain = String(host).toLowerCase().replace(/^\./, '');
  const soonMs = Math.max(1, Number(soonDays) || 3) * 86400000;
  let text = '';
  try { text = fs.readFileSync(String(cookiesFile), 'utf8'); } catch { }
  let total = 0;
  let expired = 0;
  let expiringSoon = 0;
  let session = 0;
  let earliest = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    const ckDomain = String(p[0]).toLowerCase().replace(/^\./, '');
    if (!(ckDomain === domain || ckDomain.endsWith(`.${domain}`))) continue;
    total += 1;
    const expiry = Number(p[4]) || 0;
    if (expiry <= 0) { session += 1; continue; }
    const at = expiry * 1000;
    if (at <= now) { expired += 1; continue; }
    if (at - now <= soonMs) expiringSoon += 1;
    if (earliest === 0 || at < earliest) earliest = at;
  }
  return { total, expired, expiringSoon, session, earliestExpiry: earliest, host: domain };
}

/**
 * 抖音 cookie 健康度 → 一句话结论（给用户看）。
 * @returns {{ok:boolean, code?:'cookie-missing'|'cookie-expired'|'cookie-aging', message?:string, stats:object}}
 */
export function cookieHealth(cookiesFile, opts = {}) {
  if (!cookiesFile || !fs.existsSync(String(cookiesFile))) {
    return {
      ok: false,
      code: 'cookie-missing',
      message: '抖音需要 cookies.txt：先运行 scripts\\set-video-cookies.ps1（浏览器扩展导出后一条命令接上）',
      stats: { total: 0, expired: 0, expiringSoon: 0, session: 0, earliestExpiry: 0 }
    };
  }
  const stats = inspectCookies(cookiesFile, opts.host || 'douyin.com', opts);
  if (stats.total === 0) {
    return { ok: false, code: 'cookie-missing', message: 'cookies.txt 里没有 douyin.com 的 cookie（导出时要在抖音页面上点导出）', stats };
  }
  if (stats.expired === stats.total) {
    return { ok: false, code: 'cookie-expired', message: `抖音 cookie **全部已过期**（${stats.total} 条），重新导出一次即可`, stats };
  }
  if (stats.expired > 0) {
    return {
      ok: true,
      code: 'cookie-aging',
      message: `抖音 cookie 有 ${stats.expired}/${stats.total} 条已过期，可能部分视频取不到；建议重导`,
      stats
    };
  }
  if (stats.expiringSoon > 0) {
    return {
      ok: true,
      code: 'cookie-aging',
      message: `抖音 cookie 有 ${stats.expiringSoon} 条将在 ${describeRemaining(stats.earliestExpiry)}内过期，届时重导一次`,
      stats
    };
  }
  return { ok: true, stats };
}

/** 剩余时间说人话：<1 天说小时，<0 说已过期。纯函数。 */
export function describeRemaining(atMs, now = Date.now()) {
  if (!(atMs > 0)) return '未知时间';
  const diff = atMs - now;
  if (diff <= 0) return '已过期';
  const hours = diff / 3600000;
  if (hours < 1) return `不到 1 小时`;
  if (hours < 24) return `约 ${Math.round(hours)} 小时`;
  return `约 ${Math.round(hours / 24)} 天`;
}

/** 把带水印地址换成无水印（同 video_id，只换路径段）。纯函数。 */
export function stripWatermark(playUrl) {
  const url = String(playUrl ?? '');
  return url.includes('/playwm/') ? url.replace('/playwm/', '/play/') : url;
}

/** 从分享页 HTML 里抠出 play_addr.url_list（页面里是 `\u002F` 转义过的 JSON）。纯函数。 */
export function parseSharePage(html) {
  const body = String(html ?? '').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  const block = /"play_addr"\s*:\s*\{[^}]*"url_list"\s*:\s*\[([^\]]+)\]/.exec(body);
  const urls = block
    ? [...block[1].matchAll(/"(https?:[^"]+)"/g)].map((m) => m[1])
    : [];
  const descMatch = /"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  const desc = descMatch ? descMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : '';
  const durMatch = /"duration"\s*:\s*(\d{2,7})/.exec(body);
  return {
    urls,
    desc,
    durationMs: durMatch ? Number(durMatch[1]) : 0
  };
}

/**
 * 解析一个抖音链接 → 可下载的播放地址。
 * @returns {Promise<{ok:boolean, playUrl?:string, awemeId?:string, desc?:string,
 *                    durationSec?:number, error?:string}>}
 */
export async function resolveDouyinPlayUrl(rawUrl, opts = {}) {
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 25000);
  // 先体检：过期/缺失直接说清该怎么修，别等到"分享页里没有 play_addr"再让用户猜
  const health = cookieHealth(opts.cookiesFile);
  if (!health.ok) return { ok: false, code: health.code, error: health.message };
  const cookie = cookieHeaderFor(opts.cookiesFile);
  if (!cookie) return { ok: false, code: 'cookie-missing', error: health.message || '抖音解析需要 cookies.txt' };
  const agingHint = health.code === 'cookie-aging' ? `${health.message}；` : '';
  let awemeId = extractAwemeId(rawUrl);
  let target = String(rawUrl ?? '').trim();
  try {
    // 短链（v.douyin.com/xxx）里没有 id：跟一次重定向拿到最终地址
    if (!awemeId) {
      const res = await fetch(target, {
        headers: { 'user-agent': UA_IPHONE, 'cookie': cookie, 'accept-language': 'zh-CN,zh;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      target = res.url || target;
      awemeId = extractAwemeId(target);
      if (!awemeId) {
        // 有的短链跳到主页/直播，不是视频
        return { ok: false, error: `${agingHint}这个抖音链接不是视频（可能是主页/直播/图文）` };
      }
    }
    const shareUrl = `https://${SHARE_HOST}/share/video/${awemeId}/?region=CN`;
    const res = await fetch(shareUrl, {
      headers: {
        'user-agent': UA_IPHONE,
        'cookie': cookie,
        'accept-language': 'zh-CN,zh;q=0.9',
        'referer': 'https://www.douyin.com/'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return { ok: false, code: res.status === 403 ? 'cookie-invalid' : '', error: `${agingHint}分享页 HTTP ${res.status}` };
    }
    const html = await res.text();
    const parsed = parseSharePage(html);
    if (!parsed.urls.length) {
      // 这两种情况最常见：cookie 失效（页面变成验证/登录页）或视频被删
      const looksLogin = /验证|登录|verify|login|captcha/i.test(html);
      const code = looksLogin ? 'cookie-invalid' : 'no-play-addr';
      const reason = looksLogin
        ? '分享页要求验证/登录 → cookie 已失效，重新导出一次'
        : '分享页里没有 play_addr（cookie 可能失效，或视频已删除/仅粉丝可见）';
      return { ok: false, code, error: `${agingHint}${reason}` };
    }
    return {
      ok: true,
      playUrl: stripWatermark(parsed.urls[0]),
      awemeId,
      desc: parsed.desc,
      durationSec: parsed.durationMs > 0 ? parsed.durationMs / 1000 : 0
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    const reason = /timeout|abort/i.test(message) ? '解析超时' : `解析失败：${message}`;
    return { ok: false, error: reason };
  }
}
