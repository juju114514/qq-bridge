// 音乐账号登录（0.4.135）：网易云 / QQ音乐，二维码扫码 + 登录态检测
//
// 为什么需要：点歌走的是网易云 resolver（`netmusic_resolve.py`），它本来就支持 cookie 文件
// 一个 cookie 文件（默认 <安装盘>:\QQBot\config\netmusic-cookie.txt）—— 登录后能拿 VIP/SVIP 高音质。
// QQ音乐同理，登录态先存下来（下载链路后续接）。
//
// 两个平台的扫码协议（都是公开接口，2026-11 实测可用）：
//   网易云：unikey → 二维码内容 `https://music.163.com/login?codekey=<unikey>`
//           轮询 code 800 过期 / 801 等待 / 802 已扫 / 803 成功（回 cookies）
//   QQ音乐：ptqrshow 直接给二维码 **PNG**，同时下发 qrsig cookie
//           轮询 ptuiCB 回调：66 未失效 / 67 已失效 / 65 已扫待确认 / 0 成功
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';


/**
 * 扫码会话缓存（0.4.139）
 *
 * 实测：网易云 `unikey` 会下发 `NMTID` 会话 cookie；扫码确认后如果**不带这个 cookie** 去轮询，
 * 服务端认不出是同一个会话，会返回 `8821`（我们之前一直卡在这）。
 * 所以按 key 存起来，轮询时带上。
 */
const QR_SESSIONS = new Map();   // key -> { cookie, at }

function rememberSession(key, cookie) {
  if (!key) return;
  QR_SESSIONS.set(String(key), { cookie: String(cookie || ''), at: Date.now() });
  // 只留最近 50 条，避免无限增长
  if (QR_SESSIONS.size > 50) {
    const oldest = [...QR_SESSIONS.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) QR_SESSIONS.delete(oldest[0]);
  }
}

function sessionCookie(key) {
  return QR_SESSIONS.get(String(key))?.cookie || '';
}

const NETEASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * 网易云把「不像浏览器」的请求判成需要行为验证（8821）。
 * 这里补齐 Origin / Referer / os=pc cookie，尽量贴近真实 web 登录页的请求。
 */
function neteaseHeaders(extra = {}) {
  return {
    'user-agent': NETEASE_UA,
    origin: 'https://music.163.com',
    referer: 'https://music.163.com/',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    cookie: 'os=pc; appver=8.9.70',
    ...extra
  };
}
// 不写死盘符：由调用方（路由层）扫描盘符后传进来；这里只给一个安全的兜底
const DEFAULT_NETEASE_COOKIE = path.join(os.tmpdir(), 'qqb-netmusic-cookie.txt');

/** QQ 音乐的 ptqrtoken = hash33(qrsig) */
export function hash33(str) {
  let e = 0;
  for (const ch of String(str ?? '')) {
    e = (e << 5) + e + ch.codePointAt(0);
    while (e > 0x7fffffff) e -= 0x100000000;   // 模拟 JS 32 位溢出
  }
  return e & 0x7fffffff;
}

/** 解析 ptuiCB('0','0','<url>','0','<msg>','<nick>') */
export function parsePtuiCB(text) {
  const m = /ptuiCB\(([^)]*)\)/.exec(String(text ?? ''));
  if (!m) return { raw: String(text ?? '').slice(0, 200), code: null, message: '', nickname: '', url: '' };
  const parts = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  return {
    code: Number(parts[0]),
    subCode: Number(parts[1]),
    url: parts[2] || '',
    message: parts[4] || '',
    nickname: parts[5] || '',
    raw: ''
  };
}

/** 把 `k=v; k2=v2` 写进 resolver 认的 cookie 文件 */
export function writeCookieFile(file, cookie) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, String(cookie || '').trim(), 'utf8');
  return file;
}

function cookieObjToString(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * @param {{stateFile?:string, neteaseCookieFile?:string, fetchImpl?:Function, now?:Function}} opts
 */
export function createMusicAuth(opts = {}) {
  const stateFile = opts.stateFile || path.join('state', 'music-auth.json');
  const neteaseCookieFile = opts.neteaseCookieFile
    || process.env.QQB_NETMUSIC_COOKIE
    || path.join(process.env.QQBot_NETMUSIC_COOKIE_DIR || '', '');
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const now = opts.now || (() => Date.now());
  const ua = NETEASE_UA;

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
  };
  const writeState = (s) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8');
  };

  // ── 网易云 ──────────────────────────────────────────────────────────
  async function neteaseStart() {
    const res = await fetchImpl('https://music.163.com/api/login/qrcode/unikey?type=1', {
      headers: neteaseHeaders(),
      signal: AbortSignal.timeout(10000),
      cache: 'no-store'
    });
    const body = await res.json();
    const key = body?.unikey || body?.data?.unikey;
    if (!key) throw new Error('网易云没返回 unikey');
    // 把这次会话的 cookie 记下来，轮询时必须带（否则确认阶段会 8821）
    const setCookie = typeof res.headers?.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('; ')
      : String(res.headers?.get?.('set-cookie') || '');
    rememberSession(key, setCookie);
    return {
      provider: 'netease',
      key,
      // 二维码内容（控制台用 qrcode.min.js 本地渲染，不外传）
      qrText: `https://music.163.com/login?codekey=${key}`,
      expiresInMs: 5 * 60 * 1000
    };
  }

  async function neteasePoll(key) {
    const res = await fetchImpl(
      `https://music.163.com/api/login/qrcode/client/login?key=${encodeURIComponent(key)}&type=1`,
      {
        headers: neteaseHeaders(sessionCookie(key) ? { cookie: `os=pc; appver=8.9.70; ${sessionCookie(key)}` } : {}),
        signal: AbortSignal.timeout(10000),
        cache: 'no-store'
      }
    );
    const body = await res.json();
    const code = Number(body?.code);
    // 800 过期 / 801 等待 / 802 已扫待确认 / 803 成功
    // 8821：轮询过快或"确认中"，**必须当等待处理**（当成错误会让 803 永远等不到）
    const state = code === 803 ? 'ok'
      : code === 802 ? 'scanned'
        : code === 801 ? 'waiting'
          : code === 800 ? 'expired'
            : code === 8821 ? 'waiting' : 'unknown';
    const result = {
      provider: 'netease', code, state,
      message: body?.message || (code === 8821 ? '确认中（轮询略快，已自动放慢）' : ''),
      slowDown: code === 8821
    };

    if (state === 'ok') {
      QR_SESSIONS.delete(String(key));
      const cookie = typeof body.cookie === 'string' ? body.cookie : cookieObjToString(body.cookie);
      const s = readState();
      s.netease = { cookie, at: now(), nickname: '', userId: '' };
      // 顺手取一次昵称（失败不影响登录）
      try {
        const info = await neteaseStatus(cookie);
        if (info.loggedIn) { s.netease.nickname = info.nickname; s.netease.userId = info.userId; }
      } catch { /* ignore */ }
      writeState(s);
      result.nickname = s.netease.nickname;
      result.cookieSaved = true;
    }
    return result;
  }

  async function neteaseStatus(cookie) {
    const c = cookie || readState().netease?.cookie || '';
    if (!c) return { provider: 'netease', loggedIn: false, nickname: '', userId: '', reason: '未登录' };
    try {
      const res = await fetchImpl('https://music.163.com/api/nuser/account/get', {
        headers: neteaseHeaders({ cookie: `os=pc; appver=8.9.70; ${c}` }),
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.json();
      const profile = body?.profile || body?.account || null;
      if (!profile || (!profile.nickname && !profile.userId)) {
        return { provider: 'netease', loggedIn: false, nickname: '', userId: '', reason: 'cookie 已失效', vip: null };
      }
      // vipType: 0 普通 / 10 音乐包 / 11 黑胶 VIP；vipRights 里带具体权益
      const vipType = Number(profile.vipType ?? body?.account?.vipType ?? 0);
      const vipLabel = vipType === 11 ? '黑胶VIP' : (vipType === 10 ? '音乐包' : (vipType > 0 ? `VIP(${vipType})` : '普通'));
      return {
        provider: 'netease',
        loggedIn: true,
        nickname: String(profile.nickname || ''),
        userId: String(profile.userId || ''),
        vip: { type: vipType, label: vipLabel, isVip: vipType > 0 },
        avatar: String(profile.avatarUrl || '')
      };
    } catch (error) {
      return { provider: 'netease', loggedIn: false, nickname: '', userId: '', reason: `检测失败：${error?.message ?? error}` };
    }
  }

  // ── QQ 音乐 ─────────────────────────────────────────────────────────
  async function qqStart() {
    const t = now();
    const url = 'https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4'
      + `&t=${t}&daid=383&pt_3rd_aid=100497308`;
    const res = await fetchImpl(url, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`QQ音乐二维码接口 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const setCookie = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('; ')
      : String(res.headers.get('set-cookie') || '');
    const m = /qrsig=([^;]+)/.exec(setCookie);
    const qrsig = m ? m[1] : '';
    if (!qrsig) throw new Error('QQ音乐没下发 qrsig');
    return {
      provider: 'qq',
      key: qrsig,
      qrText: '',
      // 直接把官方返回的二维码图片给前端（data URL），不用自己编码
      qrDataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      expiresInMs: 2 * 60 * 1000
    };
  }

  async function qqPoll(qrsig) {
    const ptqrtoken = hash33(qrsig);
    const url = 'https://ssl.ptlogin2.qq.com/ptqrlogin'
      + `?ptqrtoken=${ptqrtoken}&ptredirect=1&h=1&t=1&g=1&from_ui=1&ptlang=2052`
      + `&action=0-0-${now()}&js_ver=20102616&js_type=1`
      + '&login_sig=&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin'
      + '&pt_uistyle=40&aid=716027609&daid=383&pt_3rd_aid=100497308&has_onekey=1';
    const res = await fetchImpl(url, {
      headers: { 'user-agent': ua, cookie: `qrsig=${qrsig}`, referer: 'https://xui.ptlogin2.qq.com/' },
      signal: AbortSignal.timeout(10000)
    });
    const text = await res.text();
    const parsed = parsePtuiCB(text);
    const state = parsed.code === 0 ? 'ok'
      : parsed.code === 65 ? 'scanned'
        : parsed.code === 66 ? 'waiting'
          : parsed.code === 67 ? 'expired' : 'unknown';
    const result = { provider: 'qq', code: parsed.code, state, message: parsed.message || '' };

    if (state === 'ok') {
      const setCookie = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie().join('; ')
        : String(res.headers.get('set-cookie') || '');
      const uin = (/uin=([^;]+)/.exec(setCookie) || [])[1] || (/uin=(\d+)/.exec(parsed.url) || [])[1] || '';
      const s = readState();
      const cookie = `${setCookie}; qrsig=${qrsig}`.replace(/^; /, '');
      const info = await qqUserInfo(cookie);
      s.qq = { cookie, uin, nickname: info?.nickname || parsed.nickname || '', vip: info?.vip || null, at: now() };
      writeState(s);
      result.nickname = s.qq.nickname;
      result.cookieSaved = true;
    }
    return result;
  }

  /** QQ 音乐会员信息（best-effort：拿不到就返回 null，不当成失败） */
  async function qqUserInfo(cookie) {
    if (!cookie) return null;
    try {
      const comm = { ct: 11, cv: '1003006', v: '1003006', uin: '0', format: 'json', platform: 'yqq.json' };
      const res = await fetchImpl('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': ua, referer: 'https://y.qq.com/', cookie },
        body: JSON.stringify({ comm, req_1: { module: 'music.UserInfo.userInfo', method: 'GetLoginUserInfo', param: {} } }),
        signal: AbortSignal.timeout(10000),
        cache: 'no-store'
      });
      const j = await res.json().catch(() => ({}));
      const d = j?.req_1?.data;
      if (!d) return null;
      const vipType = Number(d?.vipType ?? d?.baseInfo?.vipType ?? 0);
      const nick = String(d?.nick || d?.baseInfo?.nick || '');
      const label = vipType === 1 ? '绿钻VIP' : (vipType > 0 ? 'VIP' : '普通');
      return { nickname: nick, vip: { type: vipType, label, isVip: vipType > 0 } };
    } catch { return null; }
  }

  /**
   * 手机号 + 验证码登录（0.4.140）
   *
   * 为什么要这条路：扫码在风控下会返回 8821（行为验证），而短信登录是最稳的兜底。
   * 两步：发验证码 → 用验证码换 cookie。
   */
  async function neteaseSendCaptcha(phone) {
    const p = String(phone || '').trim();
    if (!/^\d{6,15}$/.test(p)) throw new Error('手机号格式不对');
    const res = await fetchImpl(`https://music.163.com/api/sms/captcha/sent?cellphone=${p}&ctcode=86&_t=${now()}`, {
      headers: neteaseHeaders(), signal: AbortSignal.timeout(10000), cache: 'no-store'
    });
    const body = await res.json().catch(() => ({}));
    return { ok: Number(body?.code) === 200, code: body?.code ?? null, message: body?.message || body?.msg || '' };
  }

  async function neteaseLoginByCaptcha(phone, captcha) {
    const p = String(phone || '').trim();
    const c = String(captcha || '').trim();
    if (!/^\d{6,15}$/.test(p)) throw new Error('手机号格式不对');
    if (!/^\d{4,8}$/.test(c)) throw new Error('验证码格式不对');
    const url = `https://music.163.com/api/login/cellphone?phone=${p}&captcha=${c}&countrycode=86&_t=${now()}`;
    const res = await fetchImpl(url, { headers: neteaseHeaders(), signal: AbortSignal.timeout(15000), cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    const code = Number(body?.code);
    if (code !== 200) {
      return { ok: false, code, error: body?.message || body?.msg || `登录失败（code=${code}）` };
    }
    const setCookie = typeof res.headers?.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('; ')
      : String(res.headers?.get?.('set-cookie') || '');
    const s = readState();
    s.netease = {
      cookie: setCookie,
      at: now(),
      nickname: String(body?.profile?.nickname || ''),
      userId: String(body?.account?.id || body?.profile?.userId || '')
    };
    writeState(s);
    return { ok: true, nickname: s.netease.nickname, userId: s.netease.userId };
  }

  /**
   * 直接粘贴 cookie 登录（0.4.140）
   *
   * 为什么要这条：扫码会被风控（8821），短信要等；而"在浏览器登录后复制 cookie"永远可用。
   * 存进去之后会**立刻验证一次**，验证不过就报错，不留下坏状态。
   */
  async function importCookie(provider, rawCookie) {
    const cookie = String(rawCookie || '').trim();
    if (!cookie || cookie.length < 10) throw new Error('cookie 太短，看起来不对');
    const s = readState();

    if (provider === 'netease') {
      const info = await neteaseStatus(cookie);
      if (!info.loggedIn) throw new Error(info.reason || 'cookie 无效或已过期');
      s.netease = { cookie, at: now(), nickname: info.nickname, userId: info.userId, vip: info.vip };
      writeState(s);
      return { ok: true, provider, nickname: info.nickname, userId: info.userId, vip: info.vip };
    }

    if (provider === 'qq') {
      const uin = (/\buin=o?([0-9]+)/.exec(cookie) || [])[1] || '';
      const info = await qqUserInfo(cookie);
      if (!info) throw new Error('cookie 无效（拿不到 QQ 音乐账号信息）');
      s.qq = { cookie, uin, nickname: info.nickname || '', vip: info.vip, at: now() };
      writeState(s);
      return { ok: true, provider, nickname: info.nickname || '', userId: uin, vip: info.vip };
    }

    throw new Error(`不支持的平台：${provider}`);
  }

  return {
    importCookie,
    sendCaptcha: neteaseSendCaptcha,
    loginByCaptcha: neteaseLoginByCaptcha,

    async start(provider) {
      if (provider === 'netease') return neteaseStart();
      if (provider === 'qq') return qqStart();
      throw new Error(`不支持的平台：${provider}`);
    },
    async poll(provider, key) {
      if (provider === 'netease') return neteasePoll(key);
      if (provider === 'qq') return qqPoll(key);
      throw new Error(`不支持的平台：${provider}`);
    },
    async status() {
      const s = readState();
      const n = await neteaseStatus(s.netease?.cookie || '');
      const qqCookie = s.qq?.cookie || '';
      const info = qqCookie ? await qqUserInfo(qqCookie) : null;
      return {
        netease: { ...n, at: s.netease?.at || null },
        qq: {
          provider: 'qq',
          loggedIn: Boolean(qqCookie && s.qq?.uin),
          nickname: info?.nickname || s.qq?.nickname || '',
          userId: s.qq?.uin || '',
          vip: info?.vip || null,
          reason: qqCookie ? '' : '未登录',
          at: s.qq?.at || null
        }
      };
    },
    async logout(provider) {
      const s = readState();
      if (provider === 'netease' || !provider) delete s.netease;
      if (provider === 'qq' || !provider) delete s.qq;
      writeState(s);
      return { ok: true };
    },
    /** 下载器要用的 cookie（网易云写进 resolver 认的文件） */
    async exportCookies(target = '') {
      const s = readState();
      const nc = s.netease?.cookie || '';
      if (nc && target) {
        try { writeCookieFile(target, nc); } catch { /* ignore */ }
      }
      return { netease: nc, qq: s.qq?.cookie || '' };
    }
  };
}

export { DEFAULT_NETEASE_COOKIE };
