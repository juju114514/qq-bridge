// B 站视频增强：字幕 / 元数据 / 热门评论（只读，不碰账号写操作）。
//
// 为什么单独一个模块：这三样都是"锦上添花" —— 拿不到必须**安静降级**，
// 绝不能让"看视频"因为 B 站接口抽风而失败。
// 所以这里所有函数都返回 { ok, ... }，失败只带 error，不抛。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 只允许这些 bvid 形态（防止把任意字符串拼进命令行）。 */
export const BVID_RE = /^BV[0-9A-Za-z]{8,12}$/;
export const AVID_RE = /^av(\d+)$/i;

/** 从 URL 或裸 ID 里取 bvid。 */
export function extractBvid(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/(BV[0-9A-Za-z]{8,12})/);
  if (m && BVID_RE.test(m[1])) return m[1];
  return '';
}

/**
 * 默认候选（config.biliExe / 环境变量优先，其余靠 PATH 扫）。
 * **不写死盘符**：仓库要能在别的机器/系统上跑，路径差异交给配置与环境变量。
 */
export function defaultBiliCandidates() {
  const names = process.platform === 'win32' ? ['bili.exe', 'bili.cmd', 'bili'] : ['bili'];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const out = [];
  for (const d of dirs) {
    for (const n of names) out.push(path.join(d, n));
  }
  return out;
}

/** 找到可用的 bili 可执行文件；找不到返回 ''。 */
export function resolveBili(configured = '') {
  const list = [configured, ...defaultBiliCandidates()].filter(Boolean);
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return '';
}

function runBili(exe, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const text = String(stdout ?? '').trim();
      if (!text) return resolve({ ok: false, error: error?.message || 'bili 无输出' });
      try {
        const json = JSON.parse(text);
        return resolve(json?.ok ? { ok: true, data: json.data } : { ok: false, error: json?.error?.message || 'bili 返回失败', code: json?.error?.code });
      } catch {
        return resolve({ ok: false, error: 'bili 输出不是 JSON' });
      }
    });
  });
}

/** 字幕 → 纯文本（优先中文；没有就第一条）。 */
export function pickSubtitle(data) {
  const list = Array.isArray(data) ? data : (Array.isArray(data?.subtitles) ? data.subtitles : []);
  if (!list.length) return null;
  const zh = list.find((s) => /zh|中文|chi/i.test(String(s?.lan ?? s?.lang ?? s?.language ?? ''))) || list[0];
  const body = Array.isArray(zh?.body) ? zh.body : (Array.isArray(zh?.lines) ? zh.lines : []);
  const text = body.map((b) => String(b?.content ?? b?.text ?? '')).join('\n').trim();
  if (!text) return null;
  return { lan: String(zh?.lan ?? zh?.lang ?? ''), text, lines: body.length };
}

/**
 * 评论 → 精简结构（只留高赞前 N 条）。
 *
 * bili-cli 1.2.x 的实际形状是 `{ items: [{ user: { mid, name }, content: "字符串", like }] }`，
 * 而 B 站原始接口是 `{ replies: [{ member: { uname }, content: { message } }] }` —— 两种都要认，
 * 否则用户名会变成 "[object Object]"（真实踩过）。
 */
export function pickHotComments(data, limit = 8) {
  const list = Array.isArray(data) ? data
    : (Array.isArray(data?.items) ? data.items : (Array.isArray(data?.replies) ? data.replies : []));
  return list
    .map((c) => {
      const rawUser = c?.user ?? c?.member ?? null;
      const name = typeof rawUser === 'string'
        ? rawUser
        : String(rawUser?.name ?? rawUser?.uname ?? c?.uname ?? '');
      const rawContent = c?.content;
      const text = typeof rawContent === 'string'
        ? rawContent
        : String(rawContent?.message ?? c?.text ?? '');
      return {
        user: name,
        likes: Number(c?.like ?? c?.likes ?? 0) || 0,
        text: text.replace(/\s+/g, ' ').trim()
      };
    })
    .filter((c) => c.text)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, limit);
}

/**
 * 拉取增强信息。**每一项独立降级**：字幕没登录就拿不到，评论区关了就为空，
 * 元数据失败也不影响别的。
 *
 * @returns {{ok:boolean, bvid:string, info?:object, subtitle?:object|null, comments?:Array, errors?:string[]}}
 */
export async function enrichBili(input, options = {}) {
  const bvid = extractBvid(input);
  if (!bvid) return { ok: false, error: '不是有效的 bvid 链接' };
  const exe = resolveBili(options.exePath || '');
  if (!exe) return { ok: false, error: '没找到 bili 命令（装 bili-agent 或配置 bili.exePath）' };

  const timeoutMs = Number(options.timeoutMs) || 20000;
  const errors = [];
  const out = { ok: true, bvid, info: null, subtitle: null, comments: [] };

  const info = await runBili(exe, ['video', 'info', bvid], { timeoutMs });
  if (info.ok) {
    const d = info.data || {};
    out.info = {
      title: String(d.title ?? ''),
      owner: String(d.owner?.name ?? ''),
      duration: Number(d.duration) || 0,
      pubdate: String(d.pubdate ?? ''),
      stat: d.stat ?? null,
      desc: String(d.desc ?? '').slice(0, 300)
    };
  } else errors.push(`info: ${info.error}`);

  // 字幕通常需要登录；拿不到不算错（降级到现有的 ASR）
  const sub = await runBili(exe, ['video', 'subtitle', bvid], { timeoutMs });
  if (sub.ok) {
    const picked = pickSubtitle(sub.data);
    if (picked) out.subtitle = picked;
    else errors.push('subtitle: 该视频没有字幕');
  } else {
    errors.push(`subtitle: ${sub.error}`);
  }

  const cm = await runBili(exe, ['comment', 'list', bvid], { timeoutMs }).catch(() => ({ ok: false, error: 'spawn 失败' }));
  if (cm.ok) out.comments = pickHotComments(cm.data, Number(options.commentLimit) || 8);
  else errors.push(`comments: ${cm.error}`);

  if (errors.length) out.errors = errors;
  return out;
}

/** 拼成给模型看的文本块（信息密度优先，别让它变成日志）。 */
export function formatBiliEnrich(enriched, { maxSubtitleChars = 3000 } = {}) {
  if (!enriched?.ok) return '';
  const lines = [];
  const i = enriched.info;
  if (i) {
    const stat = i.stat ? `｜播放 ${i.stat.view} · 弹幕 ${i.stat.danmaku} · 评论 ${i.stat.reply}` : '';
    lines.push(`【B站视频】${i.title || enriched.bvid}`);
    if (i.owner) lines.push(`UP：${i.owner}${stat}`);
    if (i.desc && i.desc !== '-') lines.push(`简介：${i.desc}`);
  }
  if (enriched.subtitle?.text) {
    const text = enriched.subtitle.text;
    const truncated = text.length > maxSubtitleChars ? `${text.slice(0, maxSubtitleChars)}…（字幕只取前 ${maxSubtitleChars} 字）` : text;
    lines.push(`【字幕${enriched.subtitle.lan ? `·${enriched.subtitle.lan}` : ''}】\n${truncated}`);
  }
  if (enriched.comments?.length) {
    lines.push('【高赞评论】');
    for (const c of enriched.comments) {
      lines.push(`- ${c.user}${c.likes ? `（${c.likes}赞）` : ''}：${c.text.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}
