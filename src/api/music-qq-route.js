// QQ 音乐点歌（0.4.136）
//
// 链路：soso 搜索 → musicu vkey（**需要登录态**）→ 下载 → ffmpeg 截取 → 落到语音库 music/
// 返回 clipName（相对语音库的路径），前端再调 /api/voice/send 真发出去 —— 与网易云那条链路一致。
import fs from 'node:fs';
import path from 'node:path';
import { createMusicAuth } from '../music-auth.js';
import { makeQqSongClip } from '../music-qq.js';

export async function handleMusicQqRoute(ctx = {}) {
  const { req, url, sendJson } = ctx;
  if (!url || url.pathname !== '/api/music/qq/play' || req.method !== 'POST') return false;

  const d = typeof ctx.deps === 'function' ? (ctx.deps() || {}) : (ctx.deps || {});
  const body = typeof ctx.readBody === 'function' ? await ctx.readBody() : {};
  const name = String(body?.name || '').trim();
  if (!name) { sendJson({ ok: false, error: '缺歌名' }, 400); return true; }

  const stateDir = d.stateDir || 'state';
  let cfg = {};
  try { cfg = typeof d.getCfg === 'function' ? (d.getCfg() || {}) : {}; } catch { cfg = {}; }

  const voiceDir = cfg?.runtime?.paths?.audio || cfg?.socialV2?.voice?.dir || path.join(process.cwd(), 'audio');
  const ffmpeg = process.env.FFMPEG_PATH || cfg?.socialV2?.voice?.ffmpegPath || 'ffmpeg';
  const musicDir = path.join(voiceDir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });

  const auth = createMusicAuth({ stateFile: path.join(stateDir, 'music-auth.json') });
  const { qq: qqCookie } = await auth.exportCookies('');

  try {
    const clip = await makeQqSongClip({
      name,
      outDir: musicDir,
      ffmpeg,
      seconds: Number(body?.seconds) || 40,
      quality: String(body?.quality || '普通'),
      cookie: qqCookie
    });
    sendJson({
      ok: true,
      title: clip.title,
      artist: clip.artist,
      quality: clip.quality,
      seconds: clip.seconds,
      // 相对语音库的路径，直接给 /api/voice/send 用
      file: path.join('music', path.basename(clip.file)),
      candidates: clip.candidates
    });
  } catch (error) {
    sendJson({ ok: false, reason: error?.reason || '', error: String(error?.message ?? error) }, 400);
  }
  return true;
}
