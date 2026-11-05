// biligame wiki（MediaWiki）检索（0.5.63）
//
// 为什么用它当攻略主源：
//   · 有结构化 API（search / parse），不用搜索引擎
//   · 内容是玩家维护的 wiki，比"官网首页"靠谱
//   · 拿得到正文，不像论坛 SPA 那样要 JS
//
// 注意：这个站**不要走代理**（实测走 127.0.0.1:7897 会返回空），直连正常。
import { htmlToText } from './guide-fetch.js';

const API = (wiki) => `https://wiki.biligame.com/${wiki}/api.php`;

/** 游戏名 → biligame wiki 子域 */
export const WIKI_MAP = {
  原神: 'ys',
  崩坏星穹铁道: 'sr',
  星穹铁道: 'sr',
  崩铁: 'sr',
  鸣潮: 'mc',
  明日方舟: 'arknights',
  蔚蓝档案: 'ba',
  碧蓝档案: 'ba',
  战双帕弥什: 'pgr',
  深空之眼: 'shenkong',
  无期迷途: 'wqmt',
  重返未来1999: '1999',
  绝区零: 'zzz',
  鸣潮2: 'mc',
  Phigros: 'phigros',
  喵斯快跑: 'muse'
};

function wikiOf(game) {
  const g = String(game || '').trim();
  if (WIKI_MAP[g]) return WIKI_MAP[g];
  const hit = Object.keys(WIKI_MAP).find((k) => g.includes(k));
  return hit ? WIKI_MAP[hit] : '';
}

async function getJson(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-bridge-guide/1.0' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 【重要】wiki 不存在 / 被拦截时会返回 HTML，不能当成 JSON 硬解析
    throw new Error('返回的不是 JSON（wiki 可能不存在或被拦截）');
  }
}

/** 把查询拆成词，用于给标题打分（"深渊12层" 这类没有空格的要按中英边界切） */
export function queryTokens(q) {
  const s = String(q || '').trim();
  const parts = s.split(/[\s,，、]+/).filter(Boolean);
  const out = new Set(parts);
  // 中文串里再切出连续汉字段和数字/英文段
  for (const p of parts) {
    for (const seg of p.match(/[\u4e00-\u9fff]+|[A-Za-z]+|\d+/g) || []) out.add(seg);
  }
  return [...out].filter((x) => x.length >= 2);
}

/** 在某个 wiki 里找页面并取正文：opensearch 优先，全文本搜索兜底 */
export async function fetchWikiPage(game, topic, opts = {}) {
  const wiki = opts.wiki || wikiOf(game);
  if (!wiki) return { ok: false, error: `没有 ${game} 对应的 wiki 子域` };
  const q = String(topic || game || '').trim();
  if (!q) return { ok: false, error: '缺少查询词' };
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const tokens = queryTokens(q);

  // ── ① opensearch：按前缀找标题（这个 wiki 的全文搜索排序很差，前缀最准）──
  const titles = [];
  for (const prefix of [q, ...tokens]) {
    if (!prefix || prefix.length < 2) continue;
    try {
      const direct = await getJson(
        `${API(wiki)}?action=opensearch&search=${encodeURIComponent(prefix)}&limit=8&format=json`,
        opts.timeoutMs,
      );
      for (const title of (Array.isArray(direct?.[1]) ? direct[1] : [])) {
        if (!titles.includes(title)) titles.push(title);
      }
    } catch (error) {
      log(`[wiki] opensearch 失败（${prefix}）：${error?.message ?? error}`);
    }
    if (titles.length >= 10) break;
  }

  // ── ② 全文本搜索兜底 ──
  if (!titles.length) {
    try {
      const data = await getJson(
        `${API(wiki)}?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=6&srprop=snippet`,
        opts.timeoutMs,
      );
      for (const hit of (data?.query?.search || [])) titles.push(String(hit.title));
    } catch (error) {
      log(`[wiki] 全文本搜索失败：${error?.message ?? error}`);
    }
  }
  if (!titles.length && tokens.length) {
    try {
      const data = await getJson(
        `${API(wiki)}?action=query&list=search&srsearch=${encodeURIComponent(tokens[0])}&format=json&srlimit=6`,
        opts.timeoutMs,
      );
      for (const hit of (data?.query?.search || [])) titles.push(String(hit.title));
    } catch (error) {
      log(`[wiki] 兜底搜索失败：${error?.message ?? error}`);
    }
  }
  if (!titles.length) return { ok: false, error: 'wiki 里没搜到相关页面', wiki, query: q };

  // 标题打分：命中词越多越前；"攻略/机制/打法"这类词加分
  const scoreOf = (title) => {
    const s0 = String(title);
    let s = 0;
    // 命中查询词
    for (const tk of tokens) if (s0.includes(tk)) s += 10;
    // 以查询词开头（如「钟离/攻略」）最像具体条目
    if (tokens.some((tk) => s0.startsWith(tk))) s += 12;
    // 子页面形态加分
    if (/\/攻略|\/配队|\/机制|\/打法|\/阵容/.test(s0)) s += 8;
    if (/攻略|打法|机制|阵容|配队|通关/.test(s0)) s += 4;
    // 通用模板/规范页大幅降权（「配队规范」「编辑规范」这类不是真攻略）
    if (/^(配队规范|词条|模板|编辑|分类|帮助)|规范$|模板$/.test(s0)) s -= 25;
    // 道具/图鉴/勋章这类"条目页"不是攻略，除非查询里就要它
    if (/勋章|道具|材料|图鉴|成就|立绘|语音/.test(s0) && !/勋章|道具|材料|图鉴/.test(q)) s -= 20;
    // 标题越长越可能是具体条目，但别让它压过前缀匹配
    s -= Math.min(s0.length, 30) * 0.1;
    return -s;
  };
  const ordered = [...titles].sort((a, b) => scoreOf(a) - scoreOf(b));

  // ── ③ 取正文 ──
  for (const title of ordered.slice(0, 3)) {
    try {
      const data = await getJson(
        `${API(wiki)}?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&redirects=1&disableeditsection=1`,
        opts.timeoutMs,
      );
      const html = data?.parse?.text?.['*'] || '';
      const text = htmlToText(html);
      if (text.length < 80) continue;
      return {
        ok: true,
        wiki,
        title: String(data?.parse?.title || title),
        url: `https://wiki.biligame.com/${wiki}/${encodeURIComponent(title)}`,
        text: text.slice(0, opts.maxChars || 4000),
        fetchedAt: new Date().toISOString()
      };
    } catch (error) {
      log(`[wiki] 取正文失败（${title}）：${error?.message ?? error}`);
    }
  }
  return { ok: false, error: 'wiki 页面取不到正文', wiki, query: q };
}

/** 给 guide-fetch 用的适配层：返回与它一致的 source 结构 */
export async function wikiAsSource(game, topic, opts = {}) {
  const r = await fetchWikiPage(game, topic, opts);
  if (!r.ok) return null;
  return {
    title: `【wiki】${r.title}`,
    url: r.url,
    date: '',
    excerpt: r.text.slice(0, 1200),
    fetched: true,
    kind: 'wiki'
  };
}
