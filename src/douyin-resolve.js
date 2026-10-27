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
  const cookie = opts.cookiesFile ? cookieHeaderFor(opts.cookiesFile) : '';
  if (!cookie) {
    return { ok: false, error: '抖音解析需要 cookies.txt（socialV2.media.video.links.cookiesPath）' };
  }
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
        return { ok: false, error: '这个抖音链接不是视频（可能是主页/直播/图文）' };
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
    if (!res.ok) return { ok: false, error: `分享页 HTTP ${res.status}` };
    const html = await res.text();
    const parsed = parseSharePage(html);
    if (!parsed.urls.length) {
      return { ok: false, error: '分享页里没有 play_addr（可能需要重新导出 cookies，或视频已删除）' };
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
