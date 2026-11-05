// 攻略实时检索（0.5.63）
//
// 为什么需要它：本地攻略库会过时（QQ 群里被吐槽"库比手机系统还旧"），
// 所以这里改成「搜索 → 抓正文 → 给摘要和来源与日期」的实时流程。
//
// 设计原则：
//   · 只做检索与整理，**不做结论**（结论交给模型，且必须带来源）
//   · 抓不到就如实说抓不到，绝不编
//   · 结果缓存 7 天，同样的问题不重复打论坛
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bingSearch, webSearch, loadSearchConfig } from './web-search.js';
import { wikiAsSource } from './guide-wiki.js';

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_SOURCES = 3;
const MAX_EXCERPT = 1200;
const FETCH_TIMEOUT_MS = 9000;

const PRIORITY_HOSTS = [
  'taptap.cn', 'taptap.com',
  'wiki.biligame.com', 'bwiki', 'biligame',
  'nga.cn', 'ngabbs.com',
  'bbs.mihoyo.com', 'mihoyo.com',
  'bilibili.com', 'zhihu.com'
];

function cacheKey(game, topic) {
  return crypto.createHash('sha1').update(`${game}|${topic}`).digest('hex').slice(0, 16);
}

export function cachePath(stateDir, game, topic) {
  return path.join(stateDir, 'guide-cache', `${cacheKey(game, topic)}.json`);
}

/** 极简 HTML → 纯文本（够用即可，不引第三方库） */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从正文里猜一个发布日期（论坛帖通常带时间） */
export function guessDate(text) {
  const m = String(text || '').match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function scoreResult(r) {
  const h = hostOf(r.url || '');
  const idx = PRIORITY_HOSTS.findIndex((p) => h.includes(p));
  const rank = idx === -1 ? PRIORITY_HOSTS.length : idx;
  const fresh = /20\d{2}/.test(String(r.snippet || '')) ? -1 : 0;
  return rank * 10 + fresh;
}

/**
 * 抓一批攻略来源。
 * @param {{game:string, topic?:string, stateDir:string, config?:object,
 *          fetchImpl?:Function, log?:Function, useCache?:boolean}} opts
 */
export async function fetchGuide(opts = {}) {
  const game = String(opts.game || '').trim();
  const topic = String(opts.topic || '').trim();
  const stateDir = opts.stateDir || 'state';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;

  if (!game) return { ok: false, error: '缺少 game 参数' };

  const file = cachePath(stateDir, game, topic);

  // ── 缓存 ──
  if (opts.useCache !== false) {
    try {
      const hit = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (hit && Date.now() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) {
        return { ...hit, cached: true };
      }
    } catch { /* 没缓存继续 */ }
  }

  const base = topic ? `${game} ${topic} 攻略` : `${game} 攻略 最新`;
  const query = base;
  const queries = [
    `${base} site:bbs.mihoyo.com`,
    `${base} site:taptap.cn`,
    `${base} site:wiki.biligame.com`,
    base
  ];
  const config = opts.config || loadSearchConfig(opts.root || process.cwd());

  const seen = new Set();
  let results = [];
  for (const q of queries) {
    try {
      const r = await bingSearch(q, config);
      for (const item of (Array.isArray(r) ? r : [])) {
        const url = String(item?.url || '');
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push(item);
      }
    } catch (error) {
      log(`[guide] 搜索失败（${q}）：${error?.message ?? error}`);
    }
    if (results.length >= 12) break;
    if (q !== base) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (!results.length) {
    return { ok: false, error: '搜索没有结果（可能没网/没配搜索 key）', query };
  }

  const candidates = results
    .filter((r) => r && r.url && !/\.pdf($|\?)/i.test(r.url))
    .sort((a, b) => scoreResult(a) - scoreResult(b))
    .slice(0, 8);

  // ── 先试 biligame wiki（结构化、最可靠）──
  const wikiSource = await wikiAsSource(game, topic || game, { log }).catch(() => null);

  // ── 抓正文 ──
  const sources = [];
  if (wikiSource) sources.push(wikiSource);      // wiki 排第一
  for (const r of candidates) {
    if (sources.length >= MAX_SOURCES) break;
    const item = { title: String(r.title || '').slice(0, 120), url: r.url, date: '', excerpt: '', fetched: false };
    try {
      const res = await doFetch(r.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; qq-bridge-guide/1.0)' }
      });
      if (res && res.ok) {
        const html = await res.text();
        const text = htmlToText(html);
        item.excerpt = text.slice(0, MAX_EXCERPT);
        item.date = guessDate(text) || guessDate(String(r.snippet || ''));
        item.fetched = true;
      }
    } catch (error) {
      log(`[guide] 抓取失败 ${r.url}：${error?.message ?? error}`);
    }
    // 需要 JS 才能渲染的页面、以及正文太短的，不要（对模型没用）
    const jsOnly = /enable JavaScript|需要 JavaScript|加载中/i.test(item.excerpt);
    if (jsOnly) item.excerpt = '';
    if (item.excerpt.length < 120) {
      if (!item.excerpt && r.snippet) item.excerpt = String(r.snippet).slice(0, MAX_EXCERPT);
    }
    if (item.excerpt.length >= 80 || item.fetched) sources.push(item);
    await new Promise((resolve) => setTimeout(resolve, 900));   // 别把论坛打急
  }

  const payload = {
    ok: sources.some((s) => s.excerpt),
    query,
    game,
    topic,
    fetchedAt: new Date().toISOString(),
    cached: false,
    sources,
    note: '内容来自论坛/维基的实时抓取，请以来源链接为准；日期是抓取时识别到的最后更新日。'
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`[guide] 写缓存失败：${error?.message ?? error}`);
  }
  return payload;
}

/** 给模型看的紧凑文本 */
export function formatGuide(payload, { maxExcerpt = 700 } = {}) {
  if (!payload || payload.ok === false) {
    return `没抓到「${payload?.query || ''}」的可用内容：${payload?.error || '未知原因'}。别编，直接说没查到最新资料。`;
  }
  const lines = [`查询：${payload.query}`, `抓取：${payload.fetchedAt}${payload.cached ? '（缓存）' : ''}`, ''];
  payload.sources.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title || '(无标题)'}${s.date ? ` · ${s.date}` : ''}`);
    lines.push(`   ${s.url}`);
    if (s.excerpt) lines.push(`   摘要：${s.excerpt.slice(0, maxExcerpt).replace(/\n/g, ' ')}`);
    lines.push('');
  });
  lines.push('要求：只依据以上内容作答；区分「来源说的」和「你的推断」；来源之间冲突就说明冲突。');
  return lines.join('\n');
}
