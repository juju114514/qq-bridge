// 音乐账号登录路由（0.4.135）
import fs from 'node:fs';
import path from 'node:path';
import { createMusicAuth } from '../music-auth.js';

/**
 * 找 resolver 认的 cookie 文件：`<盘>:\QQBot\config\netmusic-cookie.txt`
 * 不写死盘符（portability 守卫），遍历盘符；找不到就退回 state/ 下（登录照样可用，只是下载器读不到）。
 */
function findNeteaseCookieFile(stateDir = 'state') {
  for (let i = 2; i < 26; i += 1) {
    const root = `${String.fromCharCode(65 + i)}:`;
    const dir = path.join(root, 'QQBot', 'config');
    try {
      if (fs.existsSync(dir)) return path.join(dir, 'netmusic-cookie.txt');
    } catch { /* 盘不存在 */ }
  }
  return path.join(stateDir, 'netmusic-cookie.txt');
}

export async function handleMusicAuthRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || !url.pathname.startsWith('/api/music/')) return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const stateDir = d.stateDir || 'state';
  const auth = d.musicAuth || createMusicAuth({
    stateFile: path.join(stateDir, 'music-auth.json'),
    neteaseCookieFile: findNeteaseCookieFile(stateDir)
  });
  const cookieFile = findNeteaseCookieFile(stateDir);
  const log = typeof d.log === 'function' ? d.log : () => {};

  // GET /api/music/status
  if (req.method === 'GET' && url.pathname === '/api/music/status') {
    const st = await auth.status();
    sendJson({
      ok: true,
      at: Date.now(),
      cookieFile,
      cookieFileExists: fs.existsSync(cookieFile),
      ...st
    });
    return true;
  }

  // POST /api/music/login/start  { provider }
  if (req.method === 'POST' && url.pathname === '/api/music/login/start') {
    const body = typeof ctx.readBody === 'function' ? await ctx.readBody() : {};
    const provider = String(body?.provider || 'netease');
    try {
      const start = await auth.start(provider);
      log(`[music] ${provider} 扫码登录开始`);
      sendJson({ ok: true, at: Date.now(), ...start });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  // GET /api/music/login/poll?provider=&key=
  if (req.method === 'GET' && url.pathname === '/api/music/login/poll') {
    // 关键：轮询结果绝不能被缓存，否则前端永远看到第一次的 801/66
    try { ctx.res?.setHeader?.('cache-control', 'no-store, max-age=0'); } catch { /* ignore */ }
    const provider = String(url.searchParams.get('provider') || 'netease');
    const key = String(url.searchParams.get('key') || '');
    if (!key) { sendJson({ ok: false, error: '缺 key' }, 400); return true; }
    try {
      const r = await auth.poll(provider, key);
      if (r.state === 'ok') {
        const exported = await auth.exportCookies(provider === 'netease' ? cookieFile : '');
        log(`[music] ${provider} 登录成功${exported.netease && provider === 'netease' ? `，cookie 已写入 ${cookieFile}` : ''}`);
      }
      sendJson({ ok: true, at: Date.now(), ...r });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  // POST /api/music/logout  { provider }
  if (req.method === 'POST' && url.pathname === '/api/music/logout') {
    const body = typeof ctx.readBody === 'function' ? await ctx.readBody() : {};
    const provider = body?.provider ? String(body.provider) : '';
    await auth.logout(provider);
    if (!provider || provider === 'netease') {
      try { fs.rmSync(cookieFile, { force: true }); } catch { /* ignore */ }
    }
    log(`[music] ${provider || '全部'} 已退出登录`);
    sendJson({ ok: true, at: Date.now() });
    return true;
  }

  sendJson({ ok: false, error: '未知的音乐账号接口' }, 404);
  return true;
}
