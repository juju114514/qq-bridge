// QQ 音乐点歌（0.4.136）
//
// 为什么另起一条：现有 pipeline 是 PowerShell + Python 的网易云专用链路（tools 目录，不在仓库里）。
// QQ 音乐的搜索/vkey 都是 **JSON over HTTPS**，用 Node 直接做更短，也好测：
//   搜索  POST https://u.y.qq.com/cgi-bin/musicu.fcg  module=music.search.SearchCgiService
//   取源  POST 同上                                  module=music.vkey.GetVkey
//   下载  GET  https://ws.stream.qqmusic.qq.com/<purl>
//
// 登录态（cookie，含 qm_keyst 等）可选：不登录也能拿普通音质；登录后按账号权限给高音质。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

/** 音质 → QQ 音乐的文件前缀（m4a/mp3 由返回的 purl 决定） */
export const QUALITY_PREFIX = {
  '标准': 'M500', '普通': 'M800', '高清': 'M800', '无损': 'F000', '母带': 'AI00'
};

function guid() {
  return String(Math.floor(Math.random() * 1e10));
}

/**
 * 搜索。返回 [{mid, mediaMid, name, singers, album, interval}]
 * @param {string} query
 * @param {{limit?:number, fetchImpl?:Function, cookie?:string}} opts
 */
export async function searchQqMusic(query, { limit = 5, fetchImpl = fetch, cookie = '' } = {}) {
  // 2026-11 实测：新版 musicu.fcg 的搜索会被拦（req_1.code=2001），旧的 soso 接口还能用。
  // 所以搜索走 soso，取播放地址仍走 musicu.fcg 的 GetVkey。
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
    + `?p=1&n=${Math.max(1, Math.min(20, limit))}&w=${encodeURIComponent(query)}`
    + '&format=json&cr=1&g_tk=5381&t=0';
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, referer: 'https://y.qq.com/', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  const list = json?.data?.song?.list;
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({
    mid: String(s?.songmid || s?.mid || ''),
    mediaMid: String(s?.media_mid || s?.songmid || ''),
    name: String(s?.songname || s?.name || '').replace(/<[^>]+>/g, ''),
    singers: Array.isArray(s?.singer) ? s.singer.map((x) => x?.name).filter(Boolean).join(' / ') : '',
    album: String(s?.albumname || ''),
    interval: Number(s?.interval || 0)
  })).filter((s) => s.mid && s.name);
}

/**
 * 取播放地址（purl）。不登录也可能拿到试听 30 秒；登录后按权限。
 * @returns {Promise<{url:string, quality:string, seconds:number}|null>}
 */
export async function resolveQqPlayUrl(song, { fetchImpl = fetch, cookie = '', quality = '普通' } = {}) {
  const prefix = QUALITY_PREFIX[quality] || 'M800';
  const filename = `${prefix}${song.mediaMid || song.mid}.mp3`;
  const comm = { ct: 11, cv: '1003006', v: '1003006', uin: '0', format: 'json', platform: 'yqq.json' };
  const body = {
    comm,
    req_1: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        guid: guid(),
        songmid: [song.mid],
        songtype: [0],
        uin: '0',
        loginflag: 1,
        platform: '20',
        filename: [filename]
      }
    }
  };
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, referer: 'https://y.qq.com/', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  const data = json?.req_1?.data;
  const item = Array.isArray(data?.midurlinfo) ? data.midurlinfo[0] : null;
  const purl = String(item?.purl || '').trim();
  if (!purl) {
    // 101404 = 需要登录（QQ 音乐现在几乎全曲库要求登录态）；104009 = 参数问题
    const reason = Number(item?.result) === 101404 ? 'needsLogin' : 'noSource';
    const err = new Error(reason === 'needsLogin'
      ? 'QQ 音乐需要先扫码登录才能取到播放地址'
      : `取不到播放地址（result=${item?.result ?? '?'}，可能该音质无权限）`);
    err.reason = reason;
    throw err;
  }
  return { url: `https://ws.stream.qqmusic.qq.com/${purl}`, quality, seconds: song.interval || 0 };
}

/** 下载到文件；返回字节数 */
export async function downloadQqAudio(url, outFile, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20 * 1024) throw new Error(`文件太小（${buf.length} 字节），可能只是试听片段或错误页`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return buf.length;
}

/** 用 ffmpeg 截一段（带淡入淡出），和网易云那条链路的听感保持一致 */
export function clipAudio({ ffmpeg, input, output, seconds = 40, startAt = 0, timeoutMs = 60000, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) { reject(new Error('没有 ffmpeg 路径')); return; }
    const fadeOut = Math.max(0.5, seconds - 1.2);
    const args = [
      '-y', '-v', 'error', '-ss', String(startAt), '-t', String(seconds), '-i', input,
      '-af', `afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOut}:d=1.2`,
      '-ar', '24000', '-ac', '1', '-b:a', '96k', output
    ];
    const child = spawnImpl(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error('ffmpeg 超时')); }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output)) resolve(output);
      else reject(new Error(`ffmpeg 退出码 ${code}`));
    });
  });
}

/**
 * 一条龙：搜 → 取源 → 下载 → 截取。返回 clip 的绝对路径 + 元信息。
 * @param {{name:string, outDir:string, ffmpeg:string, seconds?:number, quality?:string, cookie?:string, fetchImpl?:Function}} opts
 */
export async function makeQqSongClip(opts) {
  const { name, outDir, ffmpeg, seconds = 40, quality = '普通', cookie = '', fetchImpl = fetch } = opts;
  const candidates = await searchQqMusic(name, { fetchImpl, cookie });
  if (!candidates.length) throw new Error(`QQ 音乐没搜到「${name}」`);

  let picked = null;
  let play = null;
  // 取第一个能出源的（有的歌某音质无权限，换下一首试）
  let lastReason = '';
  for (const c of candidates.slice(0, 3)) {
    try {
      const p = await resolveQqPlayUrl(c, { fetchImpl, cookie, quality });
      if (p) { picked = c; play = p; break; }
    } catch (e) {
      lastReason = e?.reason || lastReason;
      if (e?.reason === 'needsLogin') throw e;   // 登录问题换歌也没用，直接抛
    }
  }
  if (!picked || !play) {
    const err = new Error(lastReason === 'needsLogin'
      ? 'QQ 音乐需要先扫码登录才能取到播放地址'
      : '搜索到了，但都拿不到播放地址（可能该音质无权限，换个音质试试）');
    err.reason = lastReason || 'noSource';
    throw err;
  }

  const safe = picked.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) || 'qqsong';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(8, 14);
  const fullFile = path.join(outDir, `.full-${stamp}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  const clipFile = path.join(outDir, `${safe}_${stamp}.mp3`);

  const bytes = await downloadQqAudio(play.url, fullFile, { fetchImpl });
  try {
    const dur = play.seconds || 240;
    const len = Math.min(seconds, dur || 300);
    await clipAudio({ ffmpeg, input: fullFile, output: clipFile, seconds: len });
    return {
      ok: true,
      title: picked.name,
      artist: picked.singers,
      album: picked.album,
      quality: play.quality,
      seconds: len,
      bytes,
      file: clipFile,
      candidates: candidates.slice(0, 5)
    };
  } finally {
    try { fs.rmSync(fullFile, { force: true }); } catch { /* ignore */ }
  }
}
