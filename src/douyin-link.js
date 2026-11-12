// 群聊里抖音链接的识别增强（只做解析与格式化，不下载、不碰账号写操作）。
//
// 为什么单独一个模块：抖音分享文案五花八门 —— 有短链、有 /video/、有 iesdouyin 分享页、
// 有 discover?modal_id=、还有「复制此链接，打开Dou音搜索」夹在中文里的裸链接。
// 原来 bridge.js 里只有一条 `v.douyin.com|www.douyin.com/video` 的正则，
// 漏掉的形态相当多；这里把「找出所有抖音链接」和「把元数据排成人看的卡片」集中起来，
// 好测也好改。

/** 19 位左右的 aweme id。 */
export const AWEME_ID_RE = /^\d{15,20}$/;

/** 常见的抖音链接形态（顺序无所谓，提取时逐个匹配）。 */
const LINK_PATTERNS = [
  // 短链
  /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+/i,
  // 标准视频页
  /https?:\/\/(?:www\.)?douyin\.com\/video\/\d+/i,
  // 图文 / note
  /https?:\/\/(?:www\.)?douyin\.com\/note\/\d+/i,
  // 精选页弹层
  /https?:\/\/(?:www\.)?douyin\.com\/discover\?[^\s]*modal_id=\d+/i,
  // 分享页（老版本分享出来的）
  /https?:\/\/(?:www\.)?iesdouyin\.com\/share\/video\/\d+/i,
  // 音乐/合集页也常带 modal_id
  /https?:\/\/(?:www\.)?douyin\.com\/[^\s]*[?&]modal_id=\d+/i
];

/** 从任意文本里挑出所有抖音链接（去重，保持出现顺序）。 */
export function extractDouyinLinks(text) {
  const s = String(text ?? '');
  if (!s || !/douyin\.com/i.test(s)) return [];
  const out = [];
  for (const re of LINK_PATTERNS) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(s))) {
      const url = m[0].replace(/[),.，。]+$/, '');
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

/** 链接里能不能直接看出 aweme id。 */
export function awemeIdFromLink(url) {
  const s = String(url ?? '');
  const m = s.match(/(?:video|note|share\/video)\/(\d{15,20})/) || s.match(/[?&]modal_id=(\d{15,20})/);
  return m ? m[1] : '';
}

/**
 * 把元数据排成一张「卡片」文本。
 * 比原来的 formatDouyinMeta 多了：互动数据、是否已解析出 id、封面单独一行（方便模型引用）。
 */
export function formatDouyinCard(meta = {}, url = '') {
  if (!meta?.ok) return '';
  const lines = ['【抖音】'];
  const title = String(meta.title || meta.desc || '').trim();
  if (title) lines.push(title.slice(0, 60));
  const who = String(meta.author || '').trim();
  if (who) lines.push(`@${who}${meta.authorId ? `（${meta.authorId}）` : ''}`);
  const facts = [];
  const secs = Math.round(Number(meta.durationSec) || 0);
  if (secs >= 1) facts.push(`${secs} 秒`);
  const st = meta.stats || meta.statistics || null;
  if (st) {
    for (const [k, label] of [['digg_count', '赞'], ['comment_count', '评'], ['share_count', '转'], ['collect_count', '藏']]) {
      const v = Number(st[k]);
      if (Number.isFinite(v) && v > 0) facts.push(`${label}${v >= 10000 ? (v / 10000).toFixed(1) + '万' : v}`);
    }
  }
  if (facts.length) lines.push(facts.join(' · '));
  const id = awemeIdFromLink(url) || meta.awemeId || '';
  if (id) lines.push(`id ${id}`);
  return lines.join('\n');
}

/**
 * 同一个群里同一条视频不要反复解析（省请求、也免得刷屏）。
 * 纯内存，进程重启即清空 —— 增强信息本来就是"锦上添花"，不需要持久化。
 */
export function createDouyinLinkDeduper(ttlMs = 10 * 60 * 1000) {
  const seen = new Map();
  return {
    /** 第一次见到返回 true，TTL 内重复返回 false。 */
    hit(key) {
      const now = Date.now();
      for (const [k, t] of seen) {
        if (now - t > ttlMs) seen.delete(k);
      }
      const last = seen.get(key);
      if (last && now - last <= ttlMs) return false;
      seen.set(key, now);
      return true;
    },
    size() { return seen.size; }
  };
}
