/**
 * 群里的 /pixiv 命令（0.5.65）
 *
 *   /pixiv <tag>        搜索，回 3 条「标题 — 作者｜分级｜链接」
 *   /pixiv 发 <序号>     把上一次搜索结果里的第 N 条的第 1 张图发出来
 *   /pixiv <tag> 发      搜索 + 直接发第一条的图
 *   /pixiv 清            清掉这个会话的搜索缓存
 *
 * 分级：safe 永远能看；r18 / r18g 只有「pixiv.r18Mode 不是 off」且「该群 personaPolicy.nsfw=explicit
 * 且做过成年确认」时才会出现 —— 两个闸门都在 route/module 里，这里只负责按 effective 过滤。
 *
 * 为什么不在这里发「合并转发」：OneBot 的 forward 节点依赖网关实现（SnowLuma 未验证），
 * 先发「文字 + 图片」；网关确认支持后再换，避免一上线就发不出去。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { effectiveR18Mode, hasCookies, illustUrls, downloadImage, readCookieHeader, searchWeb } from './pixiv-web.js';
import { addToLibrary, findEntry, touch } from './pixiv-library.js';

// QQ 群图片有大小限制：超过阈值就用 ffmpeg 压到长边 1600、质量 3；没有 ffmpeg 就原样发
function compressIfBig(file, { maxBytes = 2_500_000, maxSide = 1600 } = {}) {
  return new Promise((resolve) => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return resolve(file); }
    if (size <= maxBytes) return resolve(file);
    const out = file.replace(/\.[a-z]+$/i, '') + '-small.jpg';
    try {
      execFile('ffmpeg', ['-y', '-i', file, '-vf', `scale='min(${maxSide},iw)':-2`, '-q:v', '3', out],
        { timeout: 30000, windowsHide: true }, (err) => {
          if (err) return resolve(file);
          try {
            if (fs.statSync(out).size > 0) return resolve(out);
          } catch { /* 压失败就用原图 */ }
          resolve(file);
        });
    } catch {
      // spawn 被环境拒绝（沙箱/杀软）时不能把整条图片发不出去 —— 原图照发
      resolve(file);
    }
  });
}

const MAX_LIST = 3;
const MAX_SEND_PER_CMD = 1;

/** 解析命令：返回 null 表示不是 /pixiv；否则给动作 */
export function parsePixivCommand(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/^\/pixiv(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = (m[1] || '').trim();
  if (!rest) return { action: 'help' };
  if (/^清$|^clear$/i.test(rest)) return { action: 'clear' };
  const sendMatch = rest.match(/^发\s*(\d{1,2})$/);
  if (sendMatch) return { action: 'send', index: Number(sendMatch[1]) };
  const tagSend = rest.match(/^(.+?)\s+发$/);
  if (tagSend) return { action: 'search-and-send', tag: tagSend[1].trim() };
  return { action: 'search', tag: rest };
}

export function formatList({ tag, items, effective }) {
  const lines = items.slice(0, MAX_LIST).map((it, i) => {
    const grade = it.grade === 'safe' ? '全年龄' : it.grade === 'r18' ? 'R-18' : 'R-18G';
    return `${i + 1}. ${it.title || '(无题)'} — ${it.author || '未知'}｜${grade}｜${it.link}`;
  });
  const head = `「${tag}」共 ${items.length} 条${effective === 'off' ? '（只全年龄）' : ''}：`;
  const tail = '\n要看图回：/pixiv 发 1';
  return head + '\n' + lines.join('\n') + tail;
}

/**
 * @param {{sendSegments:(key:string, segs:any[])=>Promise<any>, log:Function, stateDir:string,
 *          getCfg:()=>object, resolvePolicy:Function, readAdultList?:Function,
 *          searchImpl?:Function, urlsImpl?:Function, downloadImpl?:Function}} deps
 */
export function createPixivCommand(deps) {
  const {
    sendSegments, log, stateDir, getCfg, resolvePolicy,
    searchImpl = searchWeb, urlsImpl = illustUrls, downloadImpl = downloadImage
  } = deps;
  const cache = new Map();   // key -> { tag, items, effective, at }
  const cacheTtl = 10 * 60 * 1000;

  const policyFor = (key) => {
    try {
      const gid = key.startsWith('group:') ? key.slice(6) : '';
      let adultOk = false;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'persona-adult.json'), 'utf8'));
        adultOk = Array.isArray(raw?.confirmed) && !!gid && raw.confirmed.map(String).includes(gid);
      } catch { /* 没有名单就当没确认 */ }
      return resolvePolicy({ cfg: getCfg(), key, adultOk });
    } catch {
      return { profanity: 'off', nsfw: 'off' };
    }
  };

  async function doSearch(key, tag, { autoSend = false } = {}) {
    const cfg = getCfg();
    const policy = policyFor(key);
    const eff = effectiveR18Mode({ cfg, policy, hasCookiesNow: hasCookies(stateDir) });
    const mode = eff.mode === 'r18' ? 'r18' : 'all';
    const r = await searchImpl({ stateDir, tag, limit: 6, mode });
    const items = r.items.filter((it) => (it.grade === 'safe' ? true : eff.mode !== 'off'));
    if (!items.length) {
      await sendSegments(key, [{ type: 'text', data: { text: `「${tag}」没搜到可发的图${eff.mode === 'off' ? '（R-18 未放开）' : ''}` } }]);
      return;
    }
    cache.set(key, { tag, items, effective: eff.mode, at: Date.now() });
    await sendSegments(key, [{ type: 'text', data: { text: formatList({ tag, items, effective: eff.mode }) } }]);
    if (autoSend) await doSend(key, 1);
  }

  async function doSend(key, index) {
    const rec = cache.get(key);
    if (!rec || Date.now() - rec.at > cacheTtl) {
      await sendSegments(key, [{ type: 'text', data: { text: '先搜索一次：/pixiv <标签>（缓存 10 分钟）' } }]);
      return;
    }
    const it = rec.items[index - 1];
    if (!it) {
      await sendSegments(key, [{ type: 'text', data: { text: `只有 ${rec.items.length} 条，序号 1~${rec.items.length}` } }]);
      return;
    }
    if (it.grade !== 'safe' && rec.effective === 'off') {
      await sendSegments(key, [{ type: 'text', data: { text: '这条是 R-18，当前群没放开' } }]);
      return;
    }
    const d = await urlsImpl(stateDir, it.id);
    const urls = (d.urls || []).slice(0, MAX_SEND_PER_CMD);
    if (!urls.length) {
      await sendSegments(key, [{ type: 'text', data: { text: '没拿到原图地址（可能需要重新导 cookies）' } }]);
      return;
    }
    // 先看图库有没有（同一个作品不重复下载），命中就只更新使用时间
    const libHit = findEntry(stateDir, it.id, 1);
    if (libHit) {
      touch(stateDir, it.id, 1);
      await sendSegments(key, [
        { type: 'text', data: { text: `${it.title || '(无题)'} — ${it.author}｜${it.link}` } },
        { type: 'image', data: { file: 'file:///' + libHit.absFile.replace(/\\/g, '/') } }
      ]);
      log(`[pixiv] ${key} 命中图库 ${it.id}（hits=${(libHit.hits || 0) + 1}）`);
      return;
    }
    const outDir = path.join(stateDir, 'pixiv-cache');
    const segs = [{
      type: 'text',
      data: { text: `${it.title || '(无题)'} — ${it.author}｜${it.link}` }
    }];
    for (const u of urls) {
      try {
        const r = await downloadImpl(u, { outDir, name: `pixiv-${it.id}-${Date.now()}.jpg` });
        const sendFile = await compressIfBig(r.file);
        try {
          addToLibrary(stateDir, getCfg(), {
            srcFile: sendFile, illustId: it.id, page: 1,
            title: it.title, author: it.author, link: it.link, grade: it.grade, tags: it.tags
          });
        } catch (e) { log('[pixiv] 入库失败：' + String(e?.message ?? e).slice(0, 80)); }
        // OneBot 的 image.file 接受本地路径（file://），网关同机时最省事；不通再退回 base64
        segs.push({ type: 'image', data: { file: 'file:///' + sendFile.replace(/\\/g, '/') } });
      } catch (e) {
        log(`[pixiv] 下载失败 ${it.id}：${String(e?.message ?? e).slice(0, 80)}`);
      }
    }
    if (segs.length === 1) {
      segs.push({ type: 'text', data: { text: '图片下载失败，只给链接' } });
    }
    await sendSegments(key, segs);
    log(`[pixiv] ${key} 发送 ${it.id}（${it.grade}）`);
  }

  async function handle({ key, text }) {
    const cmd = parsePixivCommand(text);
    if (!cmd) return false;
    try {
      if (cmd.action === 'help') {
        await sendSegments(key, [{ type: 'text', data: { text:
          '用法：\n/pixiv <标签>        搜图（回标题/作者/链接）\n/pixiv 发 <序号>     发第 N 条的图\n/pixiv <标签> 发      搜完直接发第一张\n/pixiv 清            清缓存' } }]);
        return true;
      }
      if (cmd.action === 'clear') {
        cache.delete(key);
        await sendSegments(key, [{ type: 'text', data: { text: '已清掉本会话的搜索缓存' } }]);
        return true;
      }
      if (cmd.action === 'search') await doSearch(key, cmd.tag);
      else if (cmd.action === 'search-and-send') await doSearch(key, cmd.tag, { autoSend: true });
      else if (cmd.action === 'send') await doSend(key, cmd.index);
      return true;
    } catch (e) {
      log(`[pixiv] 命令失败：${String(e?.message ?? e).slice(0, 120)}`);
      try {
        await sendSegments(key, [{ type: 'text', data: { text: `出错了：${String(e?.message ?? e).slice(0, 100)}` } }]);
      } catch { /* 连报错都发不出去就算了 */ }
      return true;
    }
  }

  return { handle, parse: parsePixivCommand, formatList, _cache: cache, readCookieHeader };
}
