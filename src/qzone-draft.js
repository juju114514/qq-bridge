// AI 写空间（0.4.77）—— 让 agent 起草一条 QQ 空间说说
//
// 为什么不用"直接调模型"：
//   桥接里所有推理都走 DSH agent（身份、人设、记忆都在它那边）。
//   自己再开一路模型调用，等于**绕开人设**——写出来的东西不像它，还不如模板。
//   所以做法是：把请求交给它（在 owner 私聊里生成），我们再把它那句话收回来当草稿。
//
// 流程：
//   控制台点「AI 写一条」 → POST /api/qzone/draft
//     → 写 state/qzone-draft.json（pending）
//     → deliverPrompt(ownerKey, 写说说的指令)
//   agent 回复 → sendToQQ 钩子把这句话**顺手**存进 draft（仍正常发给用户）
//   控制台轮询 GET /api/qzone/draft → 填进文本框 → 用户改 → 确认发布
//
// 铁律：**绝不自动发布**。草稿只是草稿，发布必须人点。
import fs from 'node:fs';
import path from 'node:path';
import { buildStylePrompt, parseStyleReply, describeStyles, resolveStyles } from './qzone-styles.js';
import { atomicWriteJson } from './atomic-write.js';

export const DRAFT_TTL_MS = 10 * 60 * 1000;

/** 兼容旧签名：真正的 prompt 拼装在 qzone-styles.js（那里有多风格逻辑） */
export function buildDraftPrompt({ style = 'auto', styles = null, hint = '', recent = '' } = {}) {
  return buildStylePrompt({ styles: styles || style, hint, recent });
}

/** 人看的风格串 */
export function draftStyleLabel(styles) {
  return describeStyles(styles);
}

/** 从 agent 的回复里剥出正文（它偶尔会加"这是草稿："之类的前缀） */
export function cleanDraft(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(这是|以下是)?\s*(说说|草稿|空间说说)\s*[:：]\s*/u, '');
  s = s.replace(/^["“']+|["”']+$/g, '');
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '');
  return s.trim().slice(0, 300);
}

export function emptyDraft() {
  return { status: 'idle', text: '', style: 'auto', styles: ['auto'], candidates: [], at: 0, error: '' };
}

/** 读草稿；超过 TTL 的 pending 自动作废（防止几天后突然冒出一条旧草稿） */
export function readDraft(file, now = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (j.status === 'pending' && now - Number(j.at || 0) > DRAFT_TTL_MS) {
      return { ...j, status: 'expired', error: '请求超时（10 分钟没收到回复）' };
    }
    return j;
  } catch {
    return emptyDraft();
  }
}

export function writeDraft(file, draft) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJson(file, draft);
    return true;
  } catch {
    return false;
  }
}

/**
 * 收到 agent 回复时调用：如果正等草稿，就把这句话收下。
 * 返回 true 表示**吃掉了这条**（调用方据此决定是否还要正常发送）。
 * —— 默认仍照常发出去（用户在 QQ 里能看到），只是顺手存一份。
 */
export function captureReply(file, text, { now = Date.now(), keepSending = true } = {}) {
  const cur = readDraft(file, now);
  if (cur.status !== 'pending') return { captured: false, keepSending };
  const candidates = parseStyleReply(text, cur.styles || cur.style || ['auto'])
    .map((c) => ({ ...c, text: cleanDraft(c.text) }))
    .filter((c) => c.text);
  if (!candidates.length) return { captured: false, keepSending };
  // 单条时仍填 text，多候选时前端让人挑
  const first = candidates[0];
  writeDraft(file, { ...cur, status: 'ready', text: first.text, candidates, at: now, error: '' });
  return { captured: true, keepSending, text: first.text, candidates };
}

/**
 * 从表情库里挑 1~2 个"配图建议"。
 * 为什么限制 1~2 个：空间说说配 9 张图会显得像广告，1~2 张才像人发的。
 * 只做**建议**：返回描述与 id，是否真的带上由用户在页面上决定。
 */
export function suggestStickers(entries, { max = 2, seed = Date.now() } = {}) {
  // 不要求有备注：很多表情只有 id/url，没写过 desc，但照样能用
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && (e.id || e.emoji_id || e.md5 || e.url))
    .map((e) => ({
      id: String(e.id ?? e.emoji_id ?? e.md5 ?? ''),
      desc: String(e.desc || e.localNote || e.usage || '').slice(0, 40),
      url: String(e.url || '')
    }))
    .filter((e) => e.id || e.url);
  if (!list.length) return [];
  // 稳定但有点随机：按 seed 轮转，避免每次都是同一张
  const start = Math.abs(Math.trunc(seed / 1000)) % list.length;
  const picked = [];
  for (let i = 0; i < list.length && picked.length < Math.min(2, Math.max(1, max)); i += 1) {
    picked.push(list[(start + i) % list.length]);
  }
  return picked;
}
