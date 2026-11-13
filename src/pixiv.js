/**
 * Pixiv 取图（0.5.65 起，可选功能）
 *
 * 目的：群里说「来点蓝P的 <tag>」时，按 tag 搜 Pixiv、拿到作品元数据（作者/标题/链接），
 * 再按该群的 personaPolicy 决定发全年龄图、还是（放开群）连 R-18 一起发。
 *
 * 设计取舍：
 *   · 用 **App API**（app-api.pixiv.net）+ refresh_token：比爬网页稳定，也不碰 Cloudflare
 *   · 凭据只放 state/pixiv.json（gitignore），代码里不出现任何 token
 *   · **分级交给 personaPolicy**：这里只如实返回 xRestrict（0 全年龄 / 1 R-18 / 2 R-18G），
 *     由调用方（bridge）决定发不发 —— 不在这里写第二套开关
 *   · 下载必须带 Referer，否则 403（pixiv 的反盗链）
 *
 * 没有 refresh_token 时所有函数都会抛「未登录」并提示跑 tools/pixiv-auth.mjs。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_API = 'https://app-api.pixiv.net';
const LOGIN = 'https://app-api.pixiv.net/web/v1/login';
const REFERER = 'https://app-api.pixiv.net/';
const UA = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
// 公开的 App 客户端凭据（pixiv 官方 App 内固定值，不是账号凭据）
const CLIENT_ID = 'MOBrBDS8blbauoSck0Zf';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';

export const AUTH_FILE = (stateDir) => path.join(stateDir, 'pixiv.json');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成 PKCE 对 + 登录地址（给 tools/pixiv-auth.mjs 用） */
export function createLoginChallenge() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const url = `${LOGIN}?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android`;
  return { verifier, challenge, url };
}

/** 从用户粘贴的回调地址里抠出 code（接受完整 URL 或裸 code） */
export function extractCode(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const m = raw.match(/[?&]code=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return raw;
  return '';
}

export function readAuth(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE(stateDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

export function writeAuth(stateDir, auth) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(AUTH_FILE(stateDir), JSON.stringify({ ...auth, savedAt: new Date().toISOString() }, null, 2), 'utf8');
}

async function tokenRequest(body) {
  const res = await fetch(`${APP_API}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: REFERER,
      'App-OS': 'android',
      'App-OS-Version': '11',
      'App-Version': '5.0.234'
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...body
    }).toString(),
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.response?.refresh_token) {
    const msg = data?.has_error ? `${data.errors?.system?.message || 'auth failed'}` : `HTTP ${res.status}`;
    throw new Error(`pixiv 登录失败：${msg}`);
  }
  return data.response;
}

/** 用 code + verifier 换 refresh_token（一次性） */
export async function exchangeCode({ stateDir, code, verifier }) {
  const r = await tokenRequest({
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    include_policy: 'true',
    redirect_uri: REDIRECT_URI
  });
  writeAuth(stateDir, r);
  return r;
}

/** 拿可用的 access_token（过期自动 refresh 并落盘） */
export async function accessToken(stateDir, { forceRefresh = false } = {}) {
  const auth = readAuth(stateDir);
  if (!auth?.refresh_token) {
    throw new Error('pixiv 未登录：先跑 node tools/pixiv-auth.mjs --login');
  }
  const expiresAt = Number(auth.expires_at || 0) * 1000;
  if (!forceRefresh && auth.access_token && Date.now() < expiresAt - 60_000) {
    return auth.access_token;
  }
  const r = await tokenRequest({ refresh_token: auth.refresh_token, grant_type: 'refresh_token', include_policy: 'true' });
  writeAuth(stateDir, r);
  return r.access_token;
}

async function apiGet(stateDir, pathname, params = {}) {
  const token = await accessToken(stateDir);
  const url = new URL(APP_API + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: REFERER,
      'User-Agent': UA,
      'App-OS': 'android',
      'App-OS-Version': '11',
      'App-Version': '5.0.234'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (res.status === 401) {
    // token 被吊销/过期：强刷一次再试
    await accessToken(stateDir, { forceRefresh: true });
    return apiGet(stateDir, pathname, params);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`pixiv 接口 ${pathname} 失败：HTTP ${res.status}`);
  return data;
}

/** 分级：0 全年龄 / 1 R-18 / 2 R-18G */
export function gradeOf(illust) {
  const x = Number(illust?.xRestrict ?? 0);
  if (x >= 2) return 'r18g';
  if (x === 1) return 'r18';
  return 'safe';
}

/** 统一成「够用就好」的字段，别把整坨 API 结果往提示词里塞 */
export function toItem(illust) {
  const pages = Array.isArray(illust?.meta_pages) && illust.meta_pages.length
    ? illust.meta_pages.map((p) => p?.image_urls?.original || p?.image_urls?.large).filter(Boolean)
    : [illust?.meta_single_page?.original_image_url || illust?.image_urls?.large].filter(Boolean);
  return {
    id: String(illust?.id ?? ''),
    title: String(illust?.title ?? ''),
    author: String(illust?.user?.name ?? ''),
    authorId: String(illust?.user?.id ?? ''),
    grade: gradeOf(illust),
    tags: (illust?.tags || []).map((t) => String(t?.name ?? '')).filter(Boolean).slice(0, 12),
    pageCount: Number(illust?.page_count ?? pages.length ?? 0),
    pages,
    link: `https://www.pixiv.net/artworks/${illust?.id ?? ''}`
  };
}

/**
 * 按 tag 搜作品。
 * @param {{stateDir:string, tag:string, limit?:number, sort?:string, allowR18?:boolean}} opts
 */
export async function searchByTag({ stateDir, tag, limit = 10, sort = 'popular_desc', allowR18 = false }) {
  const word = String(tag ?? '').trim();
  if (!word) throw new Error('tag 不能为空');
  const data = await apiGet(stateDir, '/v1/search/illust', {
    word,
    search_target: 'partial_match_for_tags',
    sort,
    filter: 'for_ios'
  });
  const list = Array.isArray(data?.illusts) ? data.illusts : [];
  const items = list.map(toItem);
  const safe = items.filter((i) => i.grade === 'safe');
  const r18 = items.filter((i) => i.grade !== 'safe');
  const picked = allowR18 ? [...safe, ...r18] : safe;
  return { tag: word, total: list.length, safeCount: safe.length, r18Count: r18.length, items: picked.slice(0, Math.max(1, Math.min(30, limit))) };
}

export async function detail(stateDir, illustId) {
  const data = await apiGet(stateDir, '/v1/illust/detail', { illust_id: String(illustId) });
  const illust = data?.illust;
  if (!illust) throw new Error('pixiv 没返回作品详情');
  return toItem(illust);
}

/** 下载一张图（必须带 Referer，否则 403） */
export async function downloadImage(url, { outDir, name, referer = 'https://www.pixiv.net/' } = {}) {
  const res = await fetch(url, {
    headers: { Referer: referer, 'User-Agent': UA },
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name || `pixiv-${Date.now()}.jpg`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length };
}

/** 给提示词/回复用的一行摘要 */
export function summarize(item) {
  const grade = item.grade === 'safe' ? '全年龄' : item.grade === 'r18' ? 'R-18' : 'R-18G';
  return `${item.title || '(无题)'} — ${item.author || '未知作者'}｜${grade}｜${item.pageCount} 张｜${item.link}`;
}
