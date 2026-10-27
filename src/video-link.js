// 视频**链接**识别：B 站 / 抖音（以及将来别的站）的地址 → 站点 + 可交给 yt-dlp 的 URL。
//
// 为什么单独一个模块：
//   1) 只允许**白名单站点**（这是安全边界：不能让模型拿任意 URL 去跑 yt-dlp 下载）
//   2) 链接形态很多（BV 号 / b23.tv 短链 / 抖音短链 / iesdouyin 分享页），集中在一处测
//   3) 纯函数，零依赖，便于单测（不联网、不 spawn）
//
// 注意：这里只做**识别**，不下载。下载在 bridge 里调 yt-dlp（见 docs/guides/VIDEO.md）。

/** 站点白名单：id → { label, hosts, patterns } */
export const VIDEO_SITES = [
  {
    id: 'bilibili',
    label: 'B站',
    hosts: ['bilibili.com', 'b23.tv', 'bili2233.cn'],
    // 视频页、番剧播放页、短链都收
    patterns: [
      /https?:\/\/(?:www\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)/i,
      /https?:\/\/(?:www\.)?bilibili\.com\/bangumi\/play\/(?:ep|ss)\d+/i,
      /https?:\/\/b23\.tv\/[0-9A-Za-z]+/i,
      /https?:\/\/bili2233\.cn\/[0-9A-Za-z]+/i
    ]
  },
  {
    id: 'douyin',
    label: '抖音',
    hosts: ['douyin.com', 'v.douyin.com', 'iesdouyin.com'],
    patterns: [
      /https?:\/\/v\.douyin\.com\/[0-9A-Za-z_-]+\/?/i,
      /https?:\/\/(?:www\.)?douyin\.com\/video\/\d+/i,
      /https?:\/\/(?:www\.)?iesdouyin\.com\/share\/video\/\d+/i,
      /https?:\/\/(?:www\.)?douyin\.com\/note\/\d+/i
    ]
  }
];

/** 从一段文本里挑出所有受支持的视频链接（去重、保序、最多 limit 个）。 */
export function detectVideoLinks(text, { limit = 3, sites = null } = {}) {
  const body = String(text ?? '');
  if (!body) return [];
  const allowed = Array.isArray(sites) && sites.length
    ? VIDEO_SITES.filter((s) => sites.includes(s.id))
    : VIDEO_SITES;
  const out = [];
  const seen = new Set();
  for (const site of allowed) {
    for (const re of site.patterns) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const match of body.matchAll(global)) {
        const url = String(match[0]).replace(/[，。,.\s]+$/, '');
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ site: site.id, label: site.label, url });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** 这个 URL 是否在受支持站点里（**唯一**的放行判断，下载前必过）。 */
export function isAllowedVideoUrl(rawUrl, { sites = null } = {}) {
  let url;
  try { url = new URL(String(rawUrl ?? '').trim()); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  const allowed = Array.isArray(sites) && sites.length
    ? VIDEO_SITES.filter((s) => sites.includes(s.id))
    : VIDEO_SITES;
  for (const site of allowed) {
    // host 必须精确匹配白名单（或它的子域），别用 includes 免得 evil-bilibili.com 混进来
    const hostOk = site.hosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!hostOk) continue;
    if (site.patterns.some((re) => re.test(url.toString()))) return true;
  }
  return false;
}

/** 站点 id → 中文名（写日志/说明用）。 */
export function siteLabel(id) {
  return VIDEO_SITES.find((s) => s.id === id)?.label ?? String(id ?? '');
}
