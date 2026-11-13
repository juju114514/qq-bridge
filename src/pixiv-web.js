/**
 * Pixiv 取图 · 网页接口版（0.5.65）
 *
 * 为什么有这一版：App API 的 PKCE 登录流程在 2026-11 实测已断
 * （`/web/v1/users/auth/pixiv/start` 直接 404，登录后拿不到 code），
 * 官方 App 那条路暂时走不通。网页版 AJAX 接口**免登录就能搜全年龄**，
 * 带 cookies 还能搜 R-18 —— 所以先走这条。
 *
 * 两条路的分工：
 *   · 全年龄：不需要任何凭据（本文件 searchWeb 直接可用）
 *   · R-18：需要 pixiv 登录 cookies（Netscape 格式，放 state/pixiv-cookies.txt）
 *           可用 room-pet 的 export_cookies.py 从已登录的调试浏览器导出
 *
 * 分级仍然只如实返回 xRestrict（0 / 1 / 2），发不发由 personaPolicy 决定。
 */

import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.pixiv.net/';

export const COOKIE_FILE = (stateDir) => path.join(stateDir, 'pixiv-cookies.txt');

/** 读 Netscape 格式 cookies，拼成 Cookie 头；没有文件返回 ''（只能搜全年龄） */
export function readCookieHeader(stateDir) {
  const file = COOKIE_FILE(stateDir);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const parts = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    if (cols.length < 7) continue;
    if (!/pixiv\.net$/i.test(cols[0].replace(/^\./, ''))) continue;
    parts.push(`${cols[5]}=${cols[6]}`);
  }
  return parts.join('; ');
}

export function hasCookies(stateDir) {
  return readCookieHeader(stateDir).length > 0;
}

async function getJson(url, stateDir, { timeoutMs = 20000 } = {}) {
  const headers = { Referer: REFERER, 'User-Agent': UA, Accept: 'application/json' };
  const cookie = readCookieHeader(stateDir);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`pixiv 网页接口 HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data?.error) throw new Error(`pixiv 网页接口报错：${data.message || 'unknown'}`);
  return data?.body ?? {};
}

export function gradeOf(xRestrict) {
  const x = Number(xRestrict ?? 0);
  if (x >= 2) return 'r18g';
  if (x === 1) return 'r18';
  return 'safe';
}

function toItem(row) {
  return {
    id: String(row?.id ?? ''),
    title: String(row?.title ?? ''),
    author: String(row?.userName ?? ''),
    authorId: String(row?.userId ?? ''),
    grade: gradeOf(row?.xRestrict),
    tags: Array.isArray(row?.tags) ? row.tags.map(String).slice(0, 12) : [],
    pageCount: Number(row?.pageCount ?? 1),
    thumb: String(row?.url ?? ''),
    link: `https://www.pixiv.net/artworks/${row?.id ?? ''}`
  };
}

/**
 * 按 tag 搜（网页 AJAX）。
 * @param {{stateDir:string, tag:string, page?:number, mode?:'all'|'safe'|'r18', limit?:number}} opts
 */
export async function searchWeb({ stateDir, tag, page = 1, mode = 'all', limit = 10 }) {
  const word = String(tag ?? '').trim();
  if (!word) throw new Error('tag 不能为空');
  const p = Math.max(1, Math.min(50, Number(page) || 1));
  // mode: all / safe / r18 —— r18 需要 cookies，否则接口会返回空
  const url = `https://www.pixiv.net/ajax/search/illustrations/${encodeURIComponent(word)}`
    + `?word=${encodeURIComponent(word)}&order=date_d&mode=${mode === 'r18' ? 'r18' : 'all'}`
    + `&p=${p}&s_mode=s_tag_full&type=illust_and_ugoira&lang=zh`;
  const body = await getJson(url, stateDir);
  const rows = Array.isArray(body?.illust?.data) ? body.illust.data : [];
  const items = rows.map(toItem);
  return {
    tag: word,
    page: p,
    total: Number(body?.illust?.total ?? rows.length),
    items: items.slice(0, Math.max(1, Math.min(30, limit))),
    loggedIn: hasCookies(stateDir)
  };
}

/** 取作品原图地址（多页会返回多张） */
export async function illustUrls(stateDir, illustId) {
  const id = String(illustId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('作品 id 必须是纯数字');
  const body = await getJson(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, stateDir);
  const single = body?.urls?.original;
  const pages = Array.isArray(body?.pageCount) ? [] : [];
  const urls = [];
  if (single) urls.push(single);
  // 多页：/ajax/illust/<id>/pages
  if (Number(body?.pageCount ?? 1) > 1) {
    const pageBody = await getJson(`https://www.pixiv.net/ajax/illust/${id}/pages?lang=zh`, stateDir);
    for (const p of Array.isArray(pageBody) ? pageBody : []) {
      const u = p?.urls?.original;
      if (u) urls.push(u);
    }
  }
  return {
    id,
    title: String(body?.title ?? ''),
    author: String(body?.userName ?? ''),
    xRestrict: Number(body?.xRestrict ?? 0),
    pageCount: Number(body?.pageCount ?? urls.length ?? 1),
    tags: Array.isArray(body?.tags?.tags) ? body.tags.tags.map((t) => String(t?.tag ?? '')).filter(Boolean).slice(0, 12) : [],
    urls: urls.length ? urls : (pages || [])
  };
}

/** 下载（必须带 Referer，否则 403） */
export async function downloadImage(url, { outDir, name } = {}) {
  const res = await fetch(url, {
    headers: { Referer: REFERER, 'User-Agent': UA },
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(outDir, { recursive: true });
  const ext = (url.match(/\.(png|jpg|jpeg|gif|webp)(\?|$)/i) || [])[1] || 'jpg';
  const file = path.join(outDir, name || `pixiv-${Date.now()}.${ext}`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length };
}

/** 一行摘要（永远带作者 + 链接） */
export function summarize(it) {
  const grade = it.grade === 'safe' ? '全年龄' : it.grade === 'r18' ? 'R-18' : 'R-18G';
  return `${it.title || '(无题)'} — ${it.author || '未知作者'}｜${grade}｜${it.pageCount} 张｜${it.link}`;
}

/**
 * R-18 档位（控制台里是个下拉选择，不是开关）：
 *   off  只发全年龄
 *   r18  只搜 R-18（需要 cookies + 该群策略允许）
 *   all  全年龄 + R-18 都要
 *
 * 最终是否真的放开，还要过 personaPolicy：
 *   群策略 nsfw=off → 无论 pixiv.r18Mode 选什么都降级成 off（不允许偷偷绕过）
 */
export const R18_MODES = ['off', 'r18', 'all'];

export function resolveR18Mode(cfg) {
  const raw = String(cfg?.pixiv?.r18Mode || 'off').toLowerCase();
  return R18_MODES.includes(raw) ? raw : 'off';
}

export function effectiveR18Mode({ cfg, policy, hasCookiesNow = false }) {
  const mode = resolveR18Mode(cfg);
  if (mode === 'off') return { mode: 'off', reason: 'pixiv.r18Mode=off' };
  if (!hasCookiesNow) return { mode: 'off', reason: '没有 pixiv cookies（R-18 需要登录）' };
  const nsfw = String(policy?.nsfw || 'off');
  if (nsfw === 'off') return { mode: 'off', reason: '该群 personaPolicy 没开成人内容' };
  if (nsfw === 'suggestive' && mode === 'r18') return { mode: 'off', reason: '该群只到 suggestive，不搜纯 R-18' };
  return { mode, reason: '' };
}
