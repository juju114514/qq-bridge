// 抖音"轻量解析"：只取 作者 / 标题 / 文案 / 时长 / 封面，**不下载视频**。
//
// 为什么单独做一条轻量路径：
//   完整链路（yt-dlp 下载 → 抽帧 → ASR）一条要十几秒、还被风控盯得紧；
//   而"群里有人发个抖音，让 AI 知道这是谁的什么视频"——大部分时候只要元数据。
//   轻量路径只请求一次分享页，拿不到就老实说失败，绝不静默降级成"下载全套"。
//
// 风控相关（来自真实经验，写进代码以防后人乱改）：
//   · 必须有 cookies.txt（抖音分享页不带 cookie 会跳验证页）
//   · **不要并发**：同一时间只解析一条，且同一会话 10 秒内最多一次
//   · 失败要给出可操作原因（cookie 过期 / 视频删除 / 仅粉丝可见），不要只说"失败"
//
// 纯逻辑集中在 parseSharePage（douyin-resolve.js），这里只负责网络与限流。

import { cookieHealth, parseSharePage, extractAwemeId, cookieHeaderFor } from './douyin-resolve.js';

const DEFAULT_COOLDOWN_MS = 10_000;
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const SHARE_HOST = 'www.iesdouyin.com';

/** 每个会话上次解析时间（内存；重启即清） */
const lastParseAt = new Map();

export function resetDouyinMetaCooldown() { lastParseAt.clear(); }

export function douyinMetaCooldownLeft(key, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS) {
  const last = lastParseAt.get(String(key ?? ''));
  // 没有记录 ≠ 上次在 0 时刻；否则第一次调用就会被误判成"冷却中"
  // （真实 bug：测试里用 now=1000，结果 cooldown 算成 9 秒，成功路径全红）
  if (!last) return 0;
  return Math.max(0, cooldownMs - (now - last));
}

/** 把元数据拼成给模型看的一小段文本。 */
export function formatDouyinMeta(meta = {}) {
  if (!meta?.ok) return '';
  const lines = ['【抖音视频信息】'];
  if (meta.author) lines.push(`作者：${meta.author}${meta.authorId ? `（@${meta.authorId}）` : ''}`);
  if (meta.title) lines.push(`标题：${meta.title}`);
  if (meta.desc) lines.push(`文案：${meta.desc}`);
  if (meta.durationSec) lines.push(`时长：${Math.round(meta.durationSec)} 秒`);
  if (meta.awemeId) lines.push(`视频 ID：${meta.awemeId}`);
  if (meta.coverUrl) lines.push(`封面：${meta.coverUrl}`);
  return lines.join('\n');
}

/**
 * 解析抖音链接的元数据（不下载）。
 * @param {string} rawUrl
 * @param {{cookiesFile?:string, timeoutMs?:number, key?:string, now?:number, cooldownMs?:number, fetchImpl?:Function}} opts
 * @returns {Promise<{ok:boolean, code?:string, error?:string, author?:string, authorId?:string,
 *                    title?:string, desc?:string, durationSec?:number, coverUrl?:string, awemeId?:string}>}
 */
export async function resolveDouyinMeta(rawUrl, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const key = String(opts.key ?? 'global');
  const cooldownMs = Number.isFinite(opts.cooldownMs) ? Number(opts.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const left = douyinMetaCooldownLeft(key, now, cooldownMs);
  if (left > 0) {
    return { ok: false, code: 'cooldown', error: `解析太快了，等 ${Math.ceil(left / 1000)} 秒再试` };
  }

  const url = String(rawUrl ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, code: 'bad-url', error: '不是 http(s) 链接' };

  const health = cookieHealth(opts.cookiesFile);
  if (!health.ok) return { ok: false, code: health.code, error: health.message };
  const cookie = cookieHeaderFor(opts.cookiesFile);
  if (!cookie) return { ok: false, code: 'cookie-missing', error: health.message || '抖音解析需要 cookies.txt' };

  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 20000);
  lastParseAt.set(key, now);   // 先占坑，防并发/连点

  try {
    let awemeId = extractAwemeId(url);
    let target = url;
    if (!awemeId) {
      const res = await doFetch(target, {
        headers: { 'user-agent': UA_IPHONE, cookie, 'accept-language': 'zh-CN,zh;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      target = res.url || target;
      awemeId = extractAwemeId(target);
      if (!awemeId) return { ok: false, code: 'not-video', error: '这个抖音链接不是视频（可能是主页/直播/图文）' };
    }

    const shareUrl = `https://${SHARE_HOST}/share/video/${awemeId}/?region=CN`;
    const res = await doFetch(shareUrl, {
      headers: {
        'user-agent': UA_IPHONE, cookie,
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: 'https://www.douyin.com/'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return { ok: false, code: res.status === 403 ? 'cookie-invalid' : 'http-error', error: `分享页 HTTP ${res.status}` };
    }
    const html = await res.text();
    const parsed = parseSharePage(html);
    if (!parsed.desc && !parsed.title && !parsed.author) {
      const looksLogin = /验证|登录|verify|login|captcha/i.test(html);
      return looksLogin
        ? { ok: false, code: 'cookie-invalid', error: '分享页要求验证/登录 → cookie 已失效，重新导出一次' }
        : { ok: false, code: 'no-meta', error: '分享页里没有元数据（视频可能已删除/仅粉丝可见）' };
    }
    return {
      ok: true,
      awemeId,
      author: parsed.author,
      authorId: parsed.authorId,
      title: parsed.title,
      desc: parsed.desc,
      durationSec: parsed.durationMs > 0 ? parsed.durationMs / 1000 : 0,
      coverUrl: parsed.coverUrl
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    return { ok: false, code: /timeout|abort/i.test(message) ? 'timeout' : 'network', error: `解析失败：${message}` };
  }
}